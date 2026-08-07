#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ClientChannel, ConnectConfig, SFTPWrapper, Stats } from 'ssh2';
import SSH2Module from 'ssh2';
const { Client: SSHClient, utils: sshUtils } = SSH2Module as typeof import('ssh2');
import { z } from 'zod';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFile, writeFile, mkdir, stat } from 'fs/promises';
import { posix as posixPath, resolve as resolvePath } from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import net from 'net';
import type { Duplex } from 'stream';

function expandPath(input: string | undefined): string | undefined {
  if (!input) return input;
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return resolvePath(os.homedir(), input.slice(2));
  if (input.startsWith('~')) return resolvePath(os.homedir(), input.slice(1));
  return resolvePath(input);
}

const DEFAULT_TIMEOUT = 2 * 60 * 60 * 1000; // 2 hours default timeout

const HOSTS_DIR = resolvePath(os.homedir(), '.ssh-mcp');
const HOSTS_FILE = resolvePath(HOSTS_DIR, 'hosts.json');

export type StoredHost = {
  id: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  keyPath?: string;
  proxyJump?: string;
};

export type ResolvedHost = {
  config: ConnectConfig;
  /** Immediate jump host, retained for backwards compatibility. */
  jumpConfig?: ConnectConfig;
  jumpHostId?: string;
  /** Jump hosts in connection order, from the locally reachable host to the target. */
  jumpConfigs: ConnectConfig[];
  jumpHostIds: string[];
};

export const HostsSchema = z.object({
  hosts: z.array(z.object({
    id: z.string(),
    host: z.string(),
    port: z.number().int().positive().default(22),
    username: z.string(),
    password: z.string().optional(),
    keyPath: z.string().optional(),
    proxyJump: z.string().optional(),
  })).default([]),
});

async function ensureHostsFile(): Promise<void> {
  await mkdir(HOSTS_DIR, { recursive: true });
  try {
    const stats = await stat(HOSTS_FILE);
    if (!stats.isFile()) {
      throw new McpError(ErrorCode.InternalError, `${HOSTS_FILE} exists but is not a file`);
    }
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      await writeFile(HOSTS_FILE, JSON.stringify({ hosts: [] }, null, 2), 'utf8');
    } else if (err?.code !== 'EISDIR') {
      throw err;
    } else {
      throw new McpError(ErrorCode.InternalError, `${HOSTS_FILE} is a directory`);
    }
  }
}

async function readHosts(): Promise<StoredHost[]> {
  await ensureHostsFile();
  const raw = await readFile(HOSTS_FILE, 'utf8');
  const parsed = HostsSchema.safeParse(JSON.parse(raw || '{}'));
  if (!parsed.success) {
    throw new McpError(ErrorCode.InternalError, `Failed to parse hosts.json: ${parsed.error.message}`);
  }
  return parsed.data.hosts;
}

async function writeHosts(hosts: StoredHost[]): Promise<void> {
  await ensureHostsFile();
  await writeFile(HOSTS_FILE, JSON.stringify({ hosts }, null, 2), 'utf8');
}

async function buildConnectConfig(host: StoredHost, hostId: string): Promise<ConnectConfig> {
  const config: ConnectConfig = {
    host: host.host,
    port: host.port ?? 22,
    username: host.username,
    keepaliveInterval: 30 * 1000,
  };

  if (host.password) {
    config.password = host.password;
  } else if (host.keyPath) {
    const expanded = expandPath(host.keyPath);
    if (!expanded) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid key path for host '${hostId}'`);
    }
    const keyContent = await readFile(expanded, 'utf8');
    config.privateKey = keyContent;
  } else {
    if (process.env.SSH_AUTH_SOCK) {
      config.agent = process.env.SSH_AUTH_SOCK;
      config.agentForward = true;
    }
  }

  return config;
}

export async function resolveHostFromList(hostId: string, hosts: StoredHost[]): Promise<ResolvedHost> {
  const host = hosts.find((h) => h.id === hostId);
  if (!host) {
    throw new McpError(ErrorCode.InvalidParams, `Host '${hostId}' not found`);
  }

  const config = await buildConnectConfig(host, hostId);

  const immediateJumps: Array<{ id: string; config: ConnectConfig }> = [];
  const visited = new Set<string>([hostId]);
  let current = host;
  while (current.proxyJump) {
    const jumpHost = hosts.find((candidate) => candidate.id === current.proxyJump);
    if (!jumpHost) {
      throw new McpError(ErrorCode.InvalidParams, `Jump host '${current.proxyJump}' not found`);
    }
    if (visited.has(jumpHost.id)) {
      throw new McpError(ErrorCode.InvalidParams, `ProxyJump cycle detected: ${[...visited, jumpHost.id].join(' -> ')}`);
    }
    visited.add(jumpHost.id);
    immediateJumps.push({
      id: jumpHost.id,
      config: await buildConnectConfig(jumpHost, jumpHost.id),
    });
    current = jumpHost;
  }

  const jumpConfigs = immediateJumps.map((jump) => jump.config).reverse();
  const jumpHostIds = immediateJumps.map((jump) => jump.id).reverse();
  return {
    config,
    jumpConfig: immediateJumps[0]?.config,
    jumpHostId: immediateJumps[0]?.id,
    jumpConfigs,
    jumpHostIds,
  };
}

async function resolveHost(hostId: string): Promise<ResolvedHost> {
  const hosts = await readHosts();
  return resolveHostFromList(hostId, hosts);
}

type SftpConnection = {
  conn: InstanceType<typeof SSHClient>;
  jumpConns: InstanceType<typeof SSHClient>[];
  sftp: SFTPWrapper;
};

/**
 * Open an SSH connection to a configured host, hopping through every
 * configured proxyJump with ssh2 `forwardOut`. Intermediate hosts only
 * forward encrypted traffic. Resolves once the final target connection is
 * ready; ownership of the returned connections transfers to the caller.
 */
async function openSshChain(resolved: ResolvedHost): Promise<{
  conn: InstanceType<typeof SSHClient>;
  jumpConns: InstanceType<typeof SSHClient>[];
}> {
  return new Promise((resolve, reject) => {
    const targetConfig: ConnectConfig = { ...resolved.config };
    let conn: InstanceType<typeof SSHClient> | null = null;
    const jumpConns: InstanceType<typeof SSHClient>[] = [];
    let settled = false;

    const closeConnections = () => {
      conn?.end();
      for (const jumpConn of jumpConns) jumpConn.end();
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      closeConnections();
      reject(error);
    };

    const connectTarget = (sock?: any) => {
      if (sock) {
        targetConfig.sock = sock;
      }

      conn = new SSHClient();
      conn.once('ready', () => {
        if (settled) return;
        settled = true;
        resolve({ conn: conn!, jumpConns });
      });
      conn.once('error', fail);
      conn.once('end', () => fail(new Error('SSH connection closed before target was ready')));
      conn.connect(targetConfig);
    };

    if (resolved.jumpConfigs.length === 0) {
      connectTarget();
      return;
    }

    const connectJump = (index: number, sock?: any) => {
      const jumpConfig: ConnectConfig = { ...resolved.jumpConfigs[index] };
      if (sock) jumpConfig.sock = sock;

      const jumpConn = new SSHClient();
      jumpConns.push(jumpConn);
      const jumpId = resolved.jumpHostIds[index];
      jumpConn.once('ready', () => {
        const nextConfig = resolved.jumpConfigs[index + 1] ?? resolved.config;
        const nextHost = nextConfig.host;
        if (!nextHost) {
          fail(new Error('Next hop host is missing'));
          return;
        }
        jumpConn.forwardOut('127.0.0.1', 0, nextHost, nextConfig.port ?? 22, (error, stream) => {
          if (error) {
            fail(new Error(`Jump host '${jumpId}' forwarding failed: ${error.message}`));
            return;
          }
          if (index + 1 < resolved.jumpConfigs.length) {
            connectJump(index + 1, stream);
          } else {
            connectTarget(stream);
          }
        });
      });
      jumpConn.once('error', (error) => fail(new Error(`Jump host '${jumpId}' connection failed: ${error.message}`)));
      jumpConn.once('end', () => fail(new Error(`Jump host '${jumpId}' closed before target was ready`)));
      jumpConn.connect(jumpConfig);
    };
    connectJump(0);
  });
}

async function openSftpConnection(resolved: ResolvedHost): Promise<SftpConnection> {
  const { conn, jumpConns } = await openSshChain(resolved);
  return new Promise((resolve, reject) => {
    conn.sftp((error, sftp) => {
      if (error) {
        conn.end();
        for (const jumpConn of jumpConns) jumpConn.end();
        reject(new Error(`Failed to start SFTP subsystem: ${error.message}`));
        return;
      }
      resolve({ conn, jumpConns, sftp });
    });
  });
}

async function withSftpConnection<T>(resolved: ResolvedHost, action: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  const { conn, jumpConns, sftp } = await openSftpConnection(resolved);
  try {
    return await action(sftp);
  } finally {
    sftp.end();
    conn.end();
    for (const jumpConn of jumpConns) jumpConn.end();
  }
}

function fastPut(sftp: SFTPWrapper, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (error) => error ? reject(error) : resolve());
  });
}

function fastGet(sftp: SFTPWrapper, remotePath: string, localPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (error) => error ? reject(error) : resolve());
  });
}

function sftpStat(sftp: SFTPWrapper, remotePath: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (error, stats) => error ? reject(error) : resolve(stats));
  });
}

function sftpMkdir(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, { mode: 0o755 }, (error) => error ? reject(error) : resolve());
  });
}

/** Create every missing component of the remote parent directory over SFTP. */
async function ensureRemoteParentDirectory(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  const directory = posixPath.normalize(posixPath.dirname(remotePath));
  if (directory === '.' || directory === '/') return;

  const absolute = directory.startsWith('/');
  let current = absolute ? '/' : '';
  for (const component of directory.split('/').filter(Boolean)) {
    current = current ? posixPath.join(current, component) : component;
    try {
      const stats = await sftpStat(sftp, current);
      if (!stats.isDirectory()) {
        throw new Error(`Remote path '${current}' exists but is not a directory`);
      }
    } catch (statError: any) {
      if (statError?.message?.includes('is not a directory')) {
        throw statError;
      }
      try {
        await sftpMkdir(sftp, current);
      } catch (mkdirError) {
        // Another client may have created the directory between stat and mkdir.
        const stats = await sftpStat(sftp, current).catch(() => { throw mkdirError; });
        if (!stats.isDirectory()) {
          throw new Error(`Remote path '${current}' exists but is not a directory`);
        }
      }
    }
  }
}

export function validateProxyJump(hostId: string, proxyJump: string | undefined, hosts: StoredHost[]): void {
  if (!proxyJump) return;
  const path = [hostId];
  let currentId = proxyJump;
  while (currentId) {
    if (currentId === hostId) {
      if (path.length === 1) {
        throw new McpError(ErrorCode.InvalidParams, `Host '${hostId}' cannot use itself as a jump host`);
      }
      throw new McpError(ErrorCode.InvalidParams, `ProxyJump cycle detected: ${[...path, currentId].join(' -> ')}`);
    }
    const current = hosts.find((host) => host.id === currentId);
    if (!current) {
      throw new McpError(ErrorCode.InvalidParams, `Jump host '${currentId}' not found`);
    }
    if (path.includes(currentId)) {
      throw new McpError(ErrorCode.InvalidParams, `ProxyJump cycle detected: ${[...path, currentId].join(' -> ')}`);
    }
    path.push(currentId);
    currentId = current.proxyJump ?? '';
  }
}

export function formatHostLine(host: StoredHost): string {
  const auth = host.password ? 'password' : host.keyPath ? 'key' : 'agent';
  const jump = host.proxyJump ? ` jump=${host.proxyJump}` : '';
  return `id=${host.id} host=${host.host}:${host.port} user=${host.username} auth=${auth}${jump}`;
}

export type PortForwardInfo = {
  id: string;
  hostId: string;
  localBind: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  jumpHosts: string[];
  state: 'connecting' | 'active' | 'dead' | 'closed';
  activeConnections: number;
  totalConnections: number;
  lastError: string | null;
  idleMs: number | null;
};

export function validateTunnelParams(params: {
  localPort?: number;
  remotePort?: number;
  localBind?: string;
  remoteHost?: string;
}): void {
  const { localPort, remotePort, localBind, remoteHost } = params;
  if (remotePort !== undefined && (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535)) {
    throw new McpError(ErrorCode.InvalidParams, 'remote_port must be an integer between 1 and 65535');
  }
  if (localPort !== undefined && (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535)) {
    throw new McpError(ErrorCode.InvalidParams, 'local_port must be an integer between 1 and 65535');
  }
  if (localBind !== undefined && (typeof localBind !== 'string' || localBind.length === 0)) {
    throw new McpError(ErrorCode.InvalidParams, 'local_bind must be a non-empty string');
  }
  if (remoteHost !== undefined && (typeof remoteHost !== 'string' || remoteHost.length === 0)) {
    throw new McpError(ErrorCode.InvalidParams, 'remote_host must be a non-empty string');
  }
}

export function formatTunnelLine(info: PortForwardInfo): string {
  const jump = info.jumpHosts.length ? info.jumpHosts.join(' -> ') : 'direct';
  let line = `tunnel=${info.id} local=${info.localBind}:${info.localPort} -> host=${info.hostId} remote=${info.remoteHost}:${info.remotePort} jump=${jump} state=${info.state} conns=${info.activeConnections}/${info.totalConnections}`;
  if (info.state === 'dead' && info.lastError) {
    line += ` lastError=${info.lastError}`;
  } else if (info.activeConnections === 0) {
    line += ` idle=${info.idleMs}s`;
  }
  return line;
}

export type EgressInfo = {
  id: string;
  hostId: string;
  proxyBind: string;
  proxyPort: number;
  jumpHosts: string[];
  state: 'connecting' | 'active' | 'dead' | 'closed';
  activeConnections: number;
  totalConnections: number;
  lastError: string | null;
  idleMs: number | null;
};

export function validateEgressParams(params: {
  proxyPort?: number;
  proxyBind?: string;
}): void {
  const { proxyPort, proxyBind } = params;
  if (proxyPort !== undefined && (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535)) {
    throw new McpError(ErrorCode.InvalidParams, 'proxy_port must be an integer between 1 and 65535');
  }
  if (proxyBind !== undefined && (
    typeof proxyBind !== 'string'
    || net.isIP(proxyBind) === 0
    || proxyBind === '0.0.0.0'
    || proxyBind === '::'
    || proxyBind === '0:0:0:0:0:0:0:0'
  )) {
    throw new McpError(ErrorCode.InvalidParams, 'proxy_bind must be a specific IPv4 or IPv6 interface address (not a wildcard)');
  }
}

export function formatEgressLine(info: EgressInfo): string {
  const jump = info.jumpHosts.length ? info.jumpHosts.join(' -> ') : 'direct';
  let line = `egress=${info.id} host=${info.hostId} bind=${info.proxyBind}:${info.proxyPort} jump=${jump} state=${info.state} conns=${info.activeConnections}/${info.totalConnections}`;
  if (info.state === 'dead' && info.lastError) {
    line += ` lastError=${info.lastError}`;
  } else if (info.activeConnections === 0) {
    line += ` idle=${info.idleMs}s`;
  }
  return line;
}

export type ConnectFn = (host: string, port: number) => Duplex | Promise<Duplex>;

function parseTarget(target: string, headers: string[]): { host: string; port: number; path: string } | null {
  const absolute = /^https?:\/\/(\[[^\]]+\]|[^/:]+)(?::(\d+))?(\/\S*)?$/i.exec(target);
  if (absolute) {
    const [, rawHost, portText, path = '/'] = absolute;
    const host = rawHost.replace(/^\[|\]$/g, '');
    const defaultPort = /^https:/i.test(target) ? 443 : 80;
    const port = portText ? Number.parseInt(portText, 10) : defaultPort;
    if (port < 1 || port > 65535) return null;
    return { host, port, path };
  }
  if (target.startsWith('/')) {
    const hostLine = headers.find((h) => h.toLowerCase().startsWith('host:'));
    if (!hostLine) return null;
    const hostHeader = hostLine.slice(5).trim();
    let host = hostHeader;
    let port = 80;
    if (hostHeader.startsWith('[')) {
      const end = hostHeader.indexOf(']');
      if (end === -1) return null;
      host = hostHeader.slice(1, end);
      const rest = hostHeader.slice(end + 1);
      if (rest.startsWith(':')) port = Number.parseInt(rest.slice(1), 10);
    } else {
      const colon = hostHeader.lastIndexOf(':');
      if (colon !== -1 && /^\d+$/.test(hostHeader.slice(colon + 1))) {
        host = hostHeader.slice(0, colon);
        port = Number.parseInt(hostHeader.slice(colon + 1), 10);
      }
    }
    if (port < 1 || port > 65535) return null;
    return { host, port, path: target };
  }
  return null;
}

function rewriteRequest(headerBlock: string, parsed: { host: string; port: number; path: string }): string {
  const lines = headerBlock.split('\r\n');
  const parts = lines[0].split(' ');
  const method = parts[0];
  const version = parts[2] ?? 'HTTP/1.1';
  const out: string[] = [];
  let hasHost = false;
  for (const line of lines.slice(1)) {
    const name = line.split(':')[0].toLowerCase();
    if (name === 'proxy-connection' || name === 'proxy-authorization') continue;
    if (name === 'host') hasHost = true;
    out.push(line);
  }
  if (!hasHost) {
    const hostPort = parsed.port === 80 || parsed.port === 443 ? parsed.host : `${parsed.host}:${parsed.port}`;
    out.unshift(`Host: ${hostPort}`);
  }
  return `${method} ${parsed.path} ${version}\r\n${out.join('\r\n')}\r\n\r\n`;
}

export function handleProxyConnection(stream: Duplex, connect: ConnectFn): void {
  let buffer = '';
  let routed = false;

  const fail = () => stream.destroy();

  const route = (headerBlock: string, rest: string, requestLine: string, headers: string[]) => {
    const parts = requestLine.split(' ');
    if (parts.length < 3) {
      fail();
      return;
    }
    const [method, target] = parts;
    if (method.toUpperCase() === 'CONNECT') {
      const authority = target.trim();
      const colon = authority.lastIndexOf(':');
      const host = authority.slice(0, colon).replace(/^\[|\]$/g, '');
      const portText = authority.slice(colon + 1);
      const port = Number.parseInt(portText, 10);
      if (!host || !/^\d+$/.test(portText) || port < 1 || port > 65535) {
        fail();
        return;
      }
      let dialing: Duplex | Promise<Duplex>;
      try {
        dialing = connect(host, port);
      } catch {
        stream.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        stream.destroy();
        return;
      }
      Promise.resolve(dialing).then(
        (sock) => {
          stream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          wireUpstream(stream, sock, rest);
        },
        () => {
          stream.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          stream.destroy();
        }
      );
      return;
    }

    const parsed = parseTarget(target, headers);
    if (!parsed) {
      fail();
      return;
    }
    const rewritten = rewriteRequest(headerBlock, parsed);
    let dialing: Duplex | Promise<Duplex>;
    try {
      dialing = connect(parsed.host, parsed.port);
    } catch {
      stream.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      stream.destroy();
      return;
    }
    Promise.resolve(dialing).then(
      (sock) => {
        sock.write(rewritten);
        wireUpstream(stream, sock, rest);
      },
      () => {
        stream.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        stream.destroy();
      }
    );
  };

  const wireUpstream = (client: Duplex, upstream: Duplex, rest: string) => {
    if (client.destroyed) {
      upstream.destroy();
      return;
    }
    if (rest) upstream.write(rest);
    client.pipe(upstream);
    upstream.pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  };

  const onData = (chunk: Buffer) => {
    buffer += chunk.toString('latin1');
    if (routed) return;
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      if (buffer.length > 64 * 1024) stream.destroy();
      return;
    }
    routed = true;
    stream.removeListener('data', onData);
    const headerBlock = buffer.slice(0, headerEnd);
    const rest = buffer.slice(headerEnd + 4);
    const lines = headerBlock.split('\r\n');
    route(headerBlock, rest, lines[0], lines.slice(1));
  };

  stream.on('data', onData);
  stream.on('error', () => stream.destroy());
}

// Command sanitization and validation
export function sanitizeCommand(command: string): string {
  if (typeof command !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'Command must be a string');
  }
  
  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    throw new McpError(ErrorCode.InvalidParams, 'Command cannot be empty');
  }
  
  // Length check
  if (trimmedCommand.length > 15000) {
    throw new McpError(ErrorCode.InvalidParams, 'Command is too long (max 1000 characters)');
  }
  
  return trimmedCommand;
}

// Escape command for use in shell contexts (like pkill)
export function escapeCommandForShell(command: string): string {
  // Replace single quotes with escaped single quotes
  return command.replace(/'/g, "'\"'\"'");
}

export type TransferMode = 'auto' | 'direct' | 'stream' | 'hybrid';
export type TransferState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type TransferInfo = {
  id: string;
  mode: 'direct' | 'stream' | 'hybrid';
  state: TransferState;
  sourceHost: string;
  sourcePath: string;
  targetHost: string;
  targetPath: string;
  totalBytes: number | null;
  transferredBytes: number;
  percent: number | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
};

export type ExecRun = {
  run_id: string;
  session_id: string;
  command: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  output: string;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  cancelRequested: boolean;
  expiresAt: number | null;
};

export function validateTransferParams(params: {
  sourceHost: string;
  targetHost: string;
  sourcePath: string;
  targetPath: string;
  mode?: string;
  sizeThresholdMb?: number;
}): void {
  const { sourceHost, targetHost, sourcePath, targetPath, mode, sizeThresholdMb } = params;
  if (mode !== undefined && !['auto', 'direct', 'stream', 'hybrid'].includes(mode)) {
    throw new McpError(ErrorCode.InvalidParams, 'mode must be one of auto, direct, stream, hybrid');
  }
  if (typeof sourcePath !== 'string' || !sourcePath.startsWith('/')) {
    throw new McpError(ErrorCode.InvalidParams, 'source_path must be an absolute remote path');
  }
  if (typeof targetPath !== 'string' || !targetPath.startsWith('/')) {
    throw new McpError(ErrorCode.InvalidParams, 'target_path must be an absolute remote path');
  }
  if (sizeThresholdMb !== undefined && (!Number.isInteger(sizeThresholdMb) || sizeThresholdMb < 1)) {
    throw new McpError(ErrorCode.InvalidParams, 'size_threshold_mb must be a positive integer');
  }
  if (sourceHost === targetHost) {
    throw new McpError(ErrorCode.InvalidParams, 'source_host and target_host must differ');
  }
}

export function resolveTransferMode(
  requested: TransferMode,
  sizeBytes: number | null,
  thresholdBytes: number,
  isDirectory: boolean,
): 'direct' | 'stream' | 'hybrid' {
  switch (requested) {
    case 'direct':
      return 'direct';
    case 'stream':
      return 'stream';
    case 'hybrid':
      return 'hybrid';
    case 'auto':
      if (isDirectory) return 'direct';
      if (sizeBytes !== null && sizeBytes < thresholdBytes) return 'stream';
      return 'direct';
  }
}

export function parseRsyncProgress(line: string): { bytes: number; percent: number | null; speed: string | null } | null {
  const match = /([0-9][0-9,]*)\s+(\d{1,3})%\s+([0-9.]+\s*[KMG]?B\/s)?/.exec(line);
  if (!match) return null;
  const bytes = Number.parseInt(match[1].replace(/,/g, ''), 10);
  const percent = Number.parseInt(match[2], 10);
  return { bytes, percent, speed: match[3] ?? null };
}

export function quoteShellArg(input: string): string {
  return `'${input.replace(/'/g, `'\\''`)}'`;
}

export function buildDirectCommand(opts: {
  targetUser: string;
  targetHost: string;
  targetPort: number;
  sourcePath: string;
  targetPath: string;
}): string {
  const { targetUser, targetHost, targetPort, sourcePath, targetPath } = opts;
  const sshArgs = `-p ${targetPort} -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15`;
  const targetDir = posixPath.dirname(targetPath);
  const mkdirRemote = quoteShellArg(`mkdir -p ${quoteShellArg(targetDir)}`);
  const src = quoteShellArg(sourcePath);
  const rsyncRemote = quoteShellArg(`${targetUser}@${targetHost}:${targetPath}`);
  return (
    `ssh ${sshArgs} ${targetUser}@${targetHost} ${mkdirRemote} && ` +
    `rsync -a --partial --inplace --size-only --info=progress2 --no-motd -e ${quoteShellArg(`ssh ${sshArgs}`)} ${src} ${rsyncRemote}`
  );
}

export function formatTransferStatus(info: TransferInfo): Record<string, unknown> {
  return { ...info };
}

export function formatRsyncFailureMessage(message: string, stderr: string): string {
  if (/rsync/i.test(stderr) && /not found|cannot execute/i.test(stderr)) {
    return `${message}. Hint: rsync is not installed on the source host — install it (e.g. 'apk add rsync', 'apt install rsync', 'yum install rsync') or use mode=hybrid/stream.`;
  }
  return message;
}

const activeSessions = new Map<string, PersistentSession>();
const activeTunnels = new Map<string, PortForward>();
const activeEgress = new Map<string, InternetEgress>();
const activeTransfers = new Map<string, ServerTransfer>();
const activeExecRuns = new Map<string, ExecRun>();
const DEFAULT_SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

const server = new McpServer({
  name: 'SSH MCP Server',
  // Keep in sync with the "version" field in package.json.
  version: '1.0.0',
  capabilities: {
    resources: {},
    tools: {},
  },
});

server.tool(
  "add-host",
  "Persist a new SSH host configuration.",
  {
    host_id: z.string().describe("Unique identifier for the host. we recommend user@hostname"),
    host: z.string().describe("Hostname or IP address"),
    port: z.number().int().positive().default(22).describe("SSH port (default 22)"),
    username: z.string().describe("SSH username"),
    password: z.string().optional().describe("Password for authentication"),
    keyPath: z.string().optional().describe("Path to private key (defaults to SSH agent if omitted)"),
    proxyJump: z.string().optional().describe("ID of another stored host to use as a jump host"),
  },
  async ({ host_id, host, port, username, password, keyPath, proxyJump }) => {
    const hosts = await readHosts();
    if (hosts.some((h) => h.id === host_id)) {
      throw new McpError(ErrorCode.InvalidParams, `Host '${host_id}' already exists`);
    }
    validateProxyJump(host_id, proxyJump, hosts);
    hosts.push({
      id: host_id,
      host,
      port,
      username,
      password,
      keyPath,
      ...(proxyJump ? { proxyJump } : {}),
    });
    await writeHosts(hosts);
    return { content: [{ type: 'text', text: `Host '${host_id}' added` }] };
  }
);

server.tool(
  "list-hosts",
  "List all stored SSH host configurations.",
  {},
  async () => {
    const hosts = await readHosts();
    if (hosts.length === 0) {
      return { content: [{ type: 'text', text: 'No hosts configured' }] };
    }
    const lines = hosts.map((host) => formatHostLine(host));
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

server.tool(
  "remove-host",
  "Remove a stored SSH host configuration.",
  {
    host_id: z.string().describe("Identifier of the host to remove"),
  },
  async ({ host_id }) => {
    const hosts = await readHosts();
    const next = hosts.filter((host) => host.id !== host_id);
    if (next.length === hosts.length) {
      throw new McpError(ErrorCode.InvalidParams, `Host '${host_id}' does not exist`);
    }
    await writeHosts(next);
    return { content: [{ type: 'text', text: `Host '${host_id}' removed` }] };
  }
);

server.tool(
  "edit-host",
  "Edit fields of an existing host configuration.",
  {
    host_id: z.string().describe("Identifier of the host to edit"),
    host: z.string().optional(),
    port: z.number().int().positive().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    keyPath: z.string().optional(),
    proxyJump: z.string().optional().describe("ID of a jump host; empty string clears it"),
  },
  async ({ host_id, host, port, username, password, keyPath, proxyJump }) => {
    const hosts = await readHosts();
    const target = hosts.find((h) => h.id === host_id);
    if (!target) {
      throw new McpError(ErrorCode.InvalidParams, `Host '${host_id}' does not exist`);
    }
    if (host) target.host = host;
    if (port) target.port = port;
    if (username) target.username = username;
    if (password !== undefined) target.password = password;
    if (keyPath !== undefined) target.keyPath = keyPath;
    if (proxyJump !== undefined) {
      if (proxyJump === '') {
        delete target.proxyJump;
      } else {
        validateProxyJump(host_id, proxyJump, hosts);
        target.proxyJump = proxyJump;
      }
    }
    await writeHosts(hosts);
    return { content: [{ type: 'text', text: `Host '${host_id}' updated` }] };
  }
);

server.tool(
  "start-session",
  "Start a new SSH session for a stored host.",
  {
    host_id: z.string().describe("Identifier of the host to connect"),
    sessionId: z.string().optional().describe("Optional session identifier; generated if omitted"),
  },
  async ({ host_id, sessionId }) => {
    const resolved = await resolveHost(host_id);
    const id = sessionId && sessionId.trim() ? sessionId.trim() : randomUUID();
    if (activeSessions.has(id)) {
      throw new McpError(ErrorCode.InvalidParams, `Session '${id}' already exists`);
    }
    await getOrCreateSession(id, resolved, true);
    return { content: [{ type: 'text', text: id }] };
  }
);

server.tool(
  "upload-file",
  "Upload a local file to a stored SSH host over SFTP. Uses the host's proxyJump tunnel when configured and overwrites the remote destination if it already exists.",
  {
    host_id: z.string().describe("Identifier of the destination host"),
    local_path: z.string().describe("Path to the local source file (absolute or relative to the MCP server process)"),
    remote_path: z.string().min(1).describe("Destination path on the remote host"),
  },
  async ({ host_id, local_path, remote_path }) => {
    const resolvedLocalPath = resolvePath(local_path);
    let localStats;
    try {
      localStats = await stat(resolvedLocalPath);
    } catch (error: any) {
      throw new McpError(ErrorCode.InvalidParams, `Local file '${resolvedLocalPath}' cannot be read: ${error.message}`);
    }
    if (!localStats.isFile()) {
      throw new McpError(ErrorCode.InvalidParams, `Local path '${resolvedLocalPath}' is not a file`);
    }

    const resolved = await resolveHost(host_id);
    try {
      await withSftpConnection(resolved, async (sftp) => {
        await ensureRemoteParentDirectory(sftp, remote_path);
        await fastPut(sftp, resolvedLocalPath, remote_path);
      });
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Upload to '${host_id}:${remote_path}' failed: ${error.message}`);
    }

    const jump = resolved.jumpHostId ? ` via jump host '${resolved.jumpHostId}'` : '';
    return {
      content: [{ type: 'text', text: `Uploaded ${localStats.size} bytes: '${resolvedLocalPath}' -> '${host_id}:${remote_path}'${jump}` }],
    };
  }
);

server.tool(
  "download-file",
  "Download a file from a stored SSH host over SFTP. Uses the host's proxyJump tunnel when configured and overwrites the local destination if it already exists.",
  {
    host_id: z.string().describe("Identifier of the source host"),
    remote_path: z.string().min(1).describe("Path to the source file on the remote host"),
    local_path: z.string().describe("Destination path on the MCP server machine (absolute or relative to its working directory)"),
  },
  async ({ host_id, remote_path, local_path }) => {
    const resolvedLocalPath = resolvePath(local_path);
    const resolved = await resolveHost(host_id);
    try {
      await withSftpConnection(resolved, (sftp) => fastGet(sftp, remote_path, resolvedLocalPath));
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Download from '${host_id}:${remote_path}' failed: ${error.message}`);
    }

    const localStats = await stat(resolvedLocalPath);
    const jump = resolved.jumpHostId ? ` via jump host '${resolved.jumpHostId}'` : '';
    return {
      content: [{ type: 'text', text: `Downloaded ${localStats.size} bytes: '${host_id}:${remote_path}' -> '${resolvedLocalPath}'${jump}` }],
    };
  }
);

server.tool(
  "exec",
  "Execute a shell command on an existing SSH session.",
  {
    session_id: z.string().describe("Identifier of the session to use"),
    command: z.string().describe("Command to execute"),
  },
  async ({ session_id, command }) => {
    const sanitizedCommand = sanitizeCommand(command);
    const session = activeSessions.get(session_id);
    if (!session) {
      throw new McpError(ErrorCode.InvalidParams, `Session '${session_id}' does not exist`);
    }
    const { output, exitCode } = await session.execute(sanitizedCommand);
    if (exitCode !== 0) {
      throw new McpError(ErrorCode.InternalError, `Error (code ${exitCode}):\n${output}`);
    }
    return {
      content: [{ type: 'text', text: output }],
    };
  }
);

server.tool(
  "start-exec",
  "Execute a shell command on an existing SSH session in the background. Returns immediately with a run id; poll exec-status for the result and exec-logs for incremental output. Use this for long-running commands that would time out the synchronous exec tool.",
  {
    session_id: z.string().describe("Identifier of the session to use"),
    command: z.string().describe("Command to execute"),
  },
  async ({ session_id, command }) => {
    const session = activeSessions.get(session_id);
    if (!session) {
      throw new McpError(ErrorCode.InvalidParams, `Session '${session_id}' does not exist`);
    }
    pruneExpiredExecRuns(activeExecRuns, Date.now());
    const sanitizedCommand = sanitizeCommand(command);
    const run_id = randomUUID();
    const run: ExecRun = {
      run_id,
      session_id,
      command: sanitizedCommand,
      state: 'running',
      output: '',
      exitCode: null,
      startedAt: Date.now(),
      finishedAt: null,
      cancelRequested: false,
      expiresAt: null,
    };
    activeExecRuns.set(run_id, run);
    try {
      session.launch(sanitizedCommand, {
        onData: (chunk) => {
          run.output += chunk.replace(/\r/g, '');
        },
        onDone: (result) => {
          run.output = result.output;
          run.exitCode = result.exitCode;
          run.state = resolveExecFinishState(run.cancelRequested, result.exitCode);
          run.finishedAt = Date.now();
          run.expiresAt = run.finishedAt + 10 * 60 * 1000;
        },
        onError: () => {
          run.state = 'failed';
          run.finishedAt = Date.now();
          run.expiresAt = run.finishedAt + 10 * 60 * 1000;
        },
      });
    } catch (error: any) {
      activeExecRuns.delete(run_id);
      throw new McpError(ErrorCode.InternalError, `Failed to start command: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      content: [{ type: 'text', text: `Command '${run_id}' started on session '${session_id}'` }],
    };
  }
);

server.tool(
  "exec-status",
  "Query the status and full output of a background command run.",
  {
    run_id: z.string().describe("Identifier of the command run"),
  },
  async ({ run_id }) => {
    pruneExpiredExecRuns(activeExecRuns, Date.now());
    const run = activeExecRuns.get(run_id);
    if (!run) {
      throw new McpError(ErrorCode.InvalidParams, `Run '${run_id}' does not exist`);
    }
    const resolved = resolveExecRunSessionFailure(run, activeSessions.has(run.session_id));
    return {
      content: [{ type: 'text', text: JSON.stringify(formatExecStatus(resolved), null, 2) }],
    };
  }
);

server.tool(
  "exec-logs",
  "Read incremental output from a background command run, starting at a character offset.",
  {
    run_id: z.string().describe("Identifier of the command run"),
    offset: z.number().int().min(0).default(0).describe("Character offset into the accumulated output to read from (default 0)"),
  },
  async ({ run_id, offset }) => {
    pruneExpiredExecRuns(activeExecRuns, Date.now());
    const run = activeExecRuns.get(run_id);
    if (!run) {
      throw new McpError(ErrorCode.InvalidParams, `Run '${run_id}' does not exist`);
    }
    const resolved = resolveExecRunSessionFailure(run, activeSessions.has(run.session_id));
    return {
      content: [{ type: 'text', text: JSON.stringify(formatExecLogs(resolved, offset), null, 2) }],
    };
  }
);

server.tool(
  "exec-cancel",
  "Cancel a running background command by sending Ctrl-C to its session shell.",
  {
    run_id: z.string().describe("Identifier of the command run to cancel"),
  },
  async ({ run_id }) => {
    const run = activeExecRuns.get(run_id);
    if (!run) {
      throw new McpError(ErrorCode.InvalidParams, `Run '${run_id}' does not exist`);
    }
    if (run.state !== 'running') {
      throw new McpError(ErrorCode.InvalidParams, `Run '${run_id}' is already ${run.state}`);
    }
    const session = activeSessions.get(run.session_id);
    if (!session) {
      throw new McpError(ErrorCode.InternalError, `Session '${run.session_id}' no longer exists`);
    }
    session.interrupt();
    run.cancelRequested = true;
    return { content: [{ type: 'text', text: `Cancellation requested for run '${run_id}'` }] };
  }
);

server.tool(
  "close-session",
  "Close an existing persistent SSH session.",
  {
    sessionId: z.string().describe("Identifier of the session to close"),
  },
  async ({ sessionId }) => {
    const session = activeSessions.get(sessionId);
    if (!session) {
      throw new McpError(ErrorCode.InvalidParams, `Session '${sessionId}' does not exist`);
    }
    session.dispose();
    activeSessions.delete(sessionId);
    return { content: [{ type: 'text', text: `Session '${sessionId}' closed` }] };
  }
);

server.tool(
  "list-sessions",
  "List all active SSH sessions with metadata.",
  {},
  async () => {
    if (activeSessions.size === 0) {
      return { content: [{ type: 'text', text: 'No active sessions' }] };
    }

    const lines: string[] = [];
    for (const [id, session] of activeSessions.entries()) {
      const info = session.getInfo();
      const uptimeMs = Date.now() - info.createdAt;
      const minutes = Math.floor(uptimeMs / 60000);
      const seconds = Math.floor((uptimeMs % 60000) / 1000);
      lines.push(
        `session=${id} host=${info.host}:${info.port} user=${info.username} jump=${info.jumpHost} uptime=${minutes}m${seconds}s lastCommand=${info.lastCommand ?? 'n/a'}`
      );
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  }
);

server.tool(
  "open-tunnel",
  "Expose an internal service port reachable from a stored host to the local machine over an SSH tunnel. Traverses the host's proxyJump chain (multi-hop supported); the chain's final hop opens the connection to the service.",
  {
    host_id: z.string().describe("Identifier of the host whose SSH chain forwards to the service"),
    remote_port: z.number().int().describe("Port of the internal service, 1-65535"),
    remote_host: z.string().default('127.0.0.1').describe("Address of the internal service as reachable from the chain's final hop (default 127.0.0.1)"),
    local_port: z.number().int().optional().describe("Local port to listen on; a free port is chosen automatically when omitted"),
    local_bind: z.string().default('127.0.0.1').describe("Local address to bind (default 127.0.0.1)"),
    tunnel_id: z.string().optional().describe("Optional tunnel identifier; generated if omitted"),
  },
  async ({ host_id, remote_port, remote_host, local_port, local_bind, tunnel_id }) => {
    validateTunnelParams({ localPort: local_port, remotePort: remote_port, localBind: local_bind, remoteHost: remote_host });
    const id = tunnel_id && tunnel_id.trim() ? tunnel_id.trim() : randomUUID();
    if (activeTunnels.has(id)) {
      throw new McpError(ErrorCode.InvalidParams, `Tunnel '${id}' already exists`);
    }

    const resolved = await resolveHost(host_id);
    let tunnel: PortForward;
    try {
      const { conn, jumpConns } = await openSshChain(resolved);
      tunnel = new PortForward(
        id,
        host_id,
        local_bind,
        local_port ?? 0,
        remote_host,
        remote_port,
        resolved.jumpHostIds,
        conn,
        jumpConns,
        undefined,
        (disposedId) => {
          if (activeTunnels.get(disposedId) === tunnel) {
            activeTunnels.delete(disposedId);
          }
        }
      );
      await tunnel.start();
    } catch (error: any) {
      throw error instanceof McpError
        ? error
        : new McpError(ErrorCode.InternalError, `Failed to open tunnel to '${host_id}': ${error instanceof Error ? error.message : String(error)}`);
    }

    if (activeTunnels.has(id)) {
      tunnel.dispose();
      throw new McpError(ErrorCode.InvalidParams, `Tunnel '${id}' already exists`);
    }

    activeTunnels.set(id, tunnel);
    if (local_bind !== '127.0.0.1' && local_bind !== 'localhost' && local_bind !== '::1') {
      console.error(`Warning: tunnel '${id}' binds ${local_bind} — it is reachable beyond localhost`);
    }
    const chain = resolved.jumpHostIds.length ? ` -> ${resolved.jumpHostIds.join(' -> ')}` : '';
    return {
      content: [{
        type: 'text',
        text: `Tunnel '${id}' listening on ${local_bind}:${tunnel.getInfo().localPort}${chain} -> ${remote_host}:${remote_port}`,
      }],
    };
  }
);

server.tool(
  "close-tunnel",
  "Close an existing SSH tunnel, destroying its local listener and SSH connections.",
  {
    tunnel_id: z.string().describe("Identifier of the tunnel to close"),
  },
  async ({ tunnel_id }) => {
    const tunnel = activeTunnels.get(tunnel_id);
    if (!tunnel) {
      throw new McpError(ErrorCode.InvalidParams, `Tunnel '${tunnel_id}' does not exist`);
    }
    tunnel.dispose();
    activeTunnels.delete(tunnel_id);
    return { content: [{ type: 'text', text: `Tunnel '${tunnel_id}' closed` }] };
  }
);

server.tool(
  "list-tunnels",
  "List all SSH tunnels (active or dead) with metadata.",
  {},
  async () => {
    if (activeTunnels.size === 0) {
      return { content: [{ type: 'text', text: 'No active tunnels' }] };
    }
    const lines = [...activeTunnels.values()].map((tunnel) => formatTunnelLine(tunnel.getInfo()));
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

server.tool(
  "open-egress",
  "Let internal servers on the host's network reach the internet through the local machine. Opens an HTTP forward proxy port on the host via remote port forwarding; point other machines at http://<proxy_bind>:<proxy_port>. The host's sshd must allow TCP forwarding (AllowTcpForwarding yes) and, for a non-loopback bind, GatewayPorts clientspecified (or yes).",
  {
    host_id: z.string().describe("Identifier of the host (A) on which to open the proxy port"),
    proxy_port: z.number().int().describe("Port to listen on the host, 1-65535"),
    proxy_bind: z.string().describe("Specific interface IP address on the host to bind (must be reachable by the machines that will use the proxy; a wildcard like 0.0.0.0 is not allowed)"),
    egress_id: z.string().optional().describe("Optional egress identifier; generated if omitted"),
  },
  async ({ host_id, proxy_port, proxy_bind, egress_id }) => {
    validateEgressParams({ proxyPort: proxy_port, proxyBind: proxy_bind });
    const id = egress_id && egress_id.trim() ? egress_id.trim() : randomUUID();
    if (activeEgress.has(id)) {
      throw new McpError(ErrorCode.InvalidParams, `Egress '${id}' already exists`);
    }

    const resolved = await resolveHost(host_id);
    let egress: InternetEgress;
    try {
      const { conn, jumpConns } = await openSshChain(resolved);
      egress = new InternetEgress(
        id,
        host_id,
        proxy_bind,
        proxy_port,
        resolved.jumpHostIds,
        conn,
        jumpConns,
        undefined,
        (disposedId) => {
          if (activeEgress.get(disposedId) === egress) {
            activeEgress.delete(disposedId);
          }
        }
      );
      await egress.start();
    } catch (error: any) {
      throw error instanceof McpError
        ? error
        : new McpError(ErrorCode.InternalError, `Failed to open egress on '${host_id}': ${error instanceof Error ? error.message : String(error)}`);
    }

    if (activeEgress.has(id)) {
      egress.dispose();
      throw new McpError(ErrorCode.InvalidParams, `Egress '${id}' already exists`);
    }

    activeEgress.set(id, egress);
    if (proxy_bind !== '127.0.0.1' && proxy_bind !== 'localhost' && proxy_bind !== '::1') {
      console.error(`Warning: egress '${id}' opens an unauthenticated HTTP proxy on ${proxy_bind}:${proxy_port} — any machine that can reach it can use the local machine as an internet egress`);
    }
    const chain = resolved.jumpHostIds.length ? ` -> ${resolved.jumpHostIds.join(' -> ')}` : '';
    return {
      content: [{
        type: 'text',
        text: `Egress '${id}' on ${host_id}:${proxy_bind}:${proxy_port}${chain} -> local internet egress`,
      }],
    };
  }
);

server.tool(
  "close-egress",
  "Close an existing internet egress, removing the proxy listener from the host and tearing down its SSH connections.",
  {
    egress_id: z.string().describe("Identifier of the egress to close"),
  },
  async ({ egress_id }) => {
    const egress = activeEgress.get(egress_id);
    if (!egress) {
      throw new McpError(ErrorCode.InvalidParams, `Egress '${egress_id}' does not exist`);
    }
    egress.dispose();
    activeEgress.delete(egress_id);
    return { content: [{ type: 'text', text: `Egress '${egress_id}' closed` }] };
  }
);

server.tool(
  "list-egress",
  "List all internet egress tunnels (active or dead) with metadata.",
  {},
  async () => {
    if (activeEgress.size === 0) {
      return { content: [{ type: 'text', text: 'No active egress' }] };
    }
    const lines = [...activeEgress.values()].map((egress) => formatEgressLine(egress.getInfo()));
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

server.tool(
  "start-transfer",
  "Copy a file or directory between two stored hosts. Mode 'direct' runs rsync on the source host (zero local bandwidth; requires rsync and non-interactive ssh access to the target on the source host). Mode 'stream' pipes the file through the local machine over two SFTP channels (single files only). 'hybrid' tries direct then falls back to stream; 'auto' (default) uses a size threshold.",
  {
    source_host: z.string().describe("Identifier of the source host in hosts.json"),
    source_path: z.string().describe("Absolute path of the source file or directory on the source host"),
    target_host: z.string().describe("Identifier of the target host in hosts.json"),
    target_path: z.string().describe("Absolute destination path on the target host"),
    mode: z.enum(['auto', 'direct', 'stream', 'hybrid']).default('auto').describe("Transfer mode (default auto)"),
    size_threshold_mb: z.number().int().default(100).describe("Files smaller than this (MB) use stream mode in 'auto' (default 100)"),
    transfer_id: z.string().optional().describe("Optional transfer identifier; generated if omitted"),
  },
  async ({ source_host, source_path, target_host, target_path, mode, size_threshold_mb, transfer_id }) => {
    validateTransferParams({
      sourceHost: source_host,
      targetHost: target_host,
      sourcePath: source_path,
      targetPath: target_path,
      mode,
      sizeThresholdMb: size_threshold_mb,
    });
    const id = transfer_id && transfer_id.trim() ? transfer_id.trim() : randomUUID();
    if (activeTransfers.has(id)) {
      throw new McpError(ErrorCode.InvalidParams, `Transfer '${id}' already exists`);
    }

    const sourceResolved = await resolveHost(source_host);
    const targetResolved = await resolveHost(target_host);

    let sourceConn: { conn: InstanceType<typeof SSHClient>; jumpConns: InstanceType<typeof SSHClient>[]; sftp: SFTPWrapper };
    try {
      sourceConn = await openSftpConnection(sourceResolved);
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to connect to source host '${source_host}': ${error instanceof Error ? error.message : String(error)}`);
    }

    let stats: Stats | null = null;
    try {
      stats = await sftpStat(sourceConn.sftp, source_path);
    } catch {
      // stat failure surfaces as a failed transfer
    }

    let decided: 'direct' | 'stream' | 'hybrid';
    if (mode === 'auto') {
      decided = resolveTransferMode('auto', stats && !stats.isDirectory() ? stats.size : null, size_threshold_mb * 1024 * 1024, stats?.isDirectory() ?? false);
    } else if (mode === 'hybrid') {
      decided = 'hybrid';
    } else {
      decided = mode;
    }

    let transfer: ServerTransfer;
    let targetConn: { conn: InstanceType<typeof SSHClient>; jumpConns: InstanceType<typeof SSHClient>[]; sftp: SFTPWrapper } | null = null;
    try {
      if (decided === 'stream' || decided === 'hybrid') {
        targetConn = await openSftpConnection(targetResolved);
        transfer = new ServerTransfer(
          id, source_host, target_host, sourceResolved, targetResolved,
          source_path, target_path, decided,
          {
            source: sourceConn,
            target: targetConn,
          },
        );
      } else {
        transfer = new ServerTransfer(
          id, source_host, target_host, sourceResolved, targetResolved,
          source_path, target_path, decided,
          { source: sourceConn },
        );
      }
    } catch (error: any) {
      sourceConn.sftp.end();
      sourceConn.conn.end();
      for (const jumpConn of sourceConn.jumpConns) jumpConn.end();
      if (targetConn) {
        targetConn.sftp.end();
        targetConn.conn.end();
        for (const jumpConn of targetConn.jumpConns) jumpConn.end();
      }
      throw error instanceof McpError
        ? error
        : new McpError(ErrorCode.InternalError, `Failed to start transfer: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (activeTransfers.has(id)) {
      transfer.dispose();
      throw new McpError(ErrorCode.InvalidParams, `Transfer '${id}' already exists`);
    }
    activeTransfers.set(id, transfer);
    transfer.start().catch(() => {
      // start() records failures internally; nothing further to do.
    });
    return {
      content: [{
        type: 'text',
        text: `Transfer '${id}' started: ${source_host}:${source_path} -> ${target_host}:${target_path} (mode=${mode}->${decided})`,
      }],
    };
  }
);

server.tool(
  "transfer-status",
  "Query the status and progress of a server-to-server transfer.",
  {
    transfer_id: z.string().describe("Identifier of the transfer"),
  },
  async ({ transfer_id }) => {
    const transfer = activeTransfers.get(transfer_id);
    if (!transfer) {
      throw new McpError(ErrorCode.InvalidParams, `Transfer '${transfer_id}' does not exist`);
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(formatTransferStatus(transfer.getInfo()), null, 2) }],
    };
  }
);

server.tool(
  "transfer-cancel",
  "Cancel a running server-to-server transfer.",
  {
    transfer_id: z.string().describe("Identifier of the transfer to cancel"),
  },
  async ({ transfer_id }) => {
    const transfer = activeTransfers.get(transfer_id);
    if (!transfer) {
      throw new McpError(ErrorCode.InvalidParams, `Transfer '${transfer_id}' does not exist`);
    }
    await transfer.cancel();
    return { content: [{ type: 'text', text: `Transfer '${transfer_id}' cancelled` }] };
  }
);

export async function execSshCommand(hostId: string, command: string, sessionId = 'legacy') {
  const resolved = await resolveHost(hostId);
  const session = await getOrCreateSession(sessionId, resolved);
  const { output, exitCode } = await session.execute(command);
  if (exitCode !== 0) {
    throw new McpError(ErrorCode.InternalError, `Error (code ${exitCode}):\n${output}`);
  }
  return {
    content: [{ type: 'text', text: output }],
  };
}

async function getOrCreateSession(id: string, resolved: ResolvedHost, forceNew = false): Promise<PersistentSession> {
  let session = activeSessions.get(id);
  if (session && forceNew) {
    session.dispose();
    activeSessions.delete(id);
    session = undefined;
  }

  if (!session) {
    session = new PersistentSession(id, resolved, DEFAULT_SESSION_TTL_MS, (disposedId) => {
      if (activeSessions.get(disposedId) === session) {
        activeSessions.delete(disposedId);
      }
    });
    activeSessions.set(id, session);
  }

  await session.ensureConnected();
  return session;
}

export type CommandCallbacks = {
  onData?: (chunk: string) => void;
  onDone?: (result: { output: string; exitCode: number }) => void;
  onError?: (error: Error) => void;
};

/**
 * Serialises shell command execution over a single shell stream: one command at
 * a time, completion detected via a `__MCP_DONE__{uuid}__` marker, output
 * streamed incrementally through onData until the marker is consumed.
 */
export class ShellCommandQueue {
  private buffer = '';
  private pending: {
    marker: string;
    onData?: (chunk: string) => void;
    onDone?: (result: { output: string; exitCode: number }) => void;
    onError?: (error: Error) => void;
    pushedUntil: number;
  } | null = null;

  constructor(private readonly shell: { write(data: string, cb?: (err: Error | null | undefined) => void): void }) {}

  get hasPending(): boolean {
    return this.pending !== null;
  }

  launch(command: string, callbacks: CommandCallbacks): void {
    if (this.pending) {
      throw new Error('Another command is still running in this session');
    }
    const token = randomUUID();
    const marker = `__MCP_DONE__${token}__`;
    this.pending = {
      marker,
      onData: callbacks.onData,
      onDone: callbacks.onDone,
      onError: callbacks.onError,
      pushedUntil: 0,
    };
    const commandWithNewline = command.endsWith('\n') ? command : command + '\n';
    this.shell.write(commandWithNewline, (err) => {
      if (err) {
        this.rejectPending(err);
        return;
      }
      this.shell.write(`printf '${marker}%d\n' $?\n`, (printfErr) => {
        if (printfErr) {
          this.rejectPending(printfErr);
        }
      });
    });
  }

  handleData(data: string): void {
    if (!this.pending) {
      this.buffer = '';
      return;
    }
    this.buffer += data;
    this.processPending();
  }

  handleClose(): void {
    this.rejectPending(new Error('SSH session closed'));
  }

  sendInput(text: string): void {
    this.shell.write(text);
  }

  interrupt(): void {
    this.shell.write('\u0003');
    if (this.pending) {
      this.shell.write(`printf '${this.pending.marker}%d\n' $?\n`);
    }
  }

  private processPending(): void {
    if (!this.pending) {
      return;
    }
    const { marker } = this.pending;
    const markerIndex = this.buffer.indexOf(marker);
    if (markerIndex === -1) {
      this.pushIncrement(this.buffer.length);
      return;
    }
    const afterMarker = this.buffer.slice(markerIndex + marker.length);
    const newlineIndex = afterMarker.indexOf('\n');
    if (newlineIndex === -1) {
      this.pushIncrement(markerIndex);
      return;
    }
    this.pushIncrement(markerIndex);
    const exitCodeText = afterMarker.slice(0, newlineIndex).trim();
    const remaining = afterMarker.slice(newlineIndex + 1);
    const output = this.buffer.slice(0, markerIndex).replace(/\r/g, '');
    const exitCode = Number.parseInt(exitCodeText, 10);
    this.buffer = remaining;
    if (this.buffer.startsWith('__MCP_DONE__') || /^\s*$/.test(this.buffer)) {
      this.buffer = '';
    }
    const pending = this.pending;
    this.pending = null;
    const finalOutput = output.replace(/__MCP_READY__\s*/g, '').replace(/\s+$/, '');
    pending.onDone?.({ output: finalOutput, exitCode: Number.isNaN(exitCode) ? 0 : exitCode });
  }

  private pushIncrement(upTo: number): void {
    if (!this.pending) {
      return;
    }
    if (this.pending.onData && this.pending.pushedUntil < upTo) {
      this.pending.onData(this.buffer.slice(this.pending.pushedUntil, upTo));
    }
    this.pending.pushedUntil = Math.max(this.pending.pushedUntil, upTo);
  }

  private rejectPending(error: Error): void {
    if (!this.pending) {
      return;
    }
    const pending = this.pending;
    this.pending = null;
    pending.onError?.(error);
  }
}

export function resolveExecFinishState(cancelRequested: boolean, exitCode: number): 'completed' | 'failed' | 'cancelled' {
  if (cancelRequested) {
    return 'cancelled';
  }
  return exitCode === 0 ? 'completed' : 'failed';
}

export function formatExecStatus(run: ExecRun): Record<string, unknown> {
  return { ...run };
}

export function formatExecLogs(run: ExecRun, offset: number): Record<string, unknown> {
  const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const output = run.output.slice(safeOffset);
  return {
    run_id: run.run_id,
    state: run.state,
    output,
    nextOffset: run.output.length,
    exitCode: run.exitCode,
  };
}

export function pruneExpiredExecRuns(runs: Map<string, ExecRun>, now: number): void {
  for (const [id, run] of runs) {
    if (run.expiresAt !== null && run.expiresAt <= now) {
      runs.delete(id);
    }
  }
}

export function resolveExecRunSessionFailure(run: ExecRun, sessionExists: boolean): ExecRun {
  if (run.state !== 'running' || sessionExists) {
    return run;
  }
  const finishedAt = Date.now();
  return {
    ...run,
    state: 'failed',
    finishedAt,
    expiresAt: finishedAt + 10 * 60 * 1000,
  };
}

export class PersistentSession {
  private conn: InstanceType<typeof SSHClient> | null = null;
  private jumpConns: InstanceType<typeof SSHClient>[] = [];
  private shell: ClientChannel | null = null;
  private commandQueue: ShellCommandQueue | null = null;
  private inactivityTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private readonly createdAt = Date.now();
  private lastCommand: string | null = null;

  constructor(
    private readonly id: string,
    private readonly resolved: ResolvedHost,
    private readonly timeoutMs = DEFAULT_SESSION_TTL_MS,
    private readonly onDispose?: (id: string) => void,
  ) {}

  getInfo() {
    return {
      id: this.id,
      host: this.resolved.config.host ?? 'unknown',
      port: this.resolved.config.port ?? 22,
      username: this.resolved.config.username ?? 'unknown',
      jumpHost: this.resolved.jumpHostIds.length ? this.resolved.jumpHostIds.join(' -> ') : 'direct',
      createdAt: this.createdAt,
      lastCommand: this.lastCommand,
      disposed: this.disposed,
    };
  }

  async ensureConnected(): Promise<void> {
    if (this.disposed) {
      throw new McpError(ErrorCode.InternalError, `Session ${this.id} has been disposed`);
    }
    if (this.conn && this.shell) {
      return;
    }

    const { conn, jumpConns } = await openSshChain(this.resolved);
    if (this.disposed) {
      conn.end();
      for (const jumpConn of jumpConns) jumpConn.end();
      return;
    }
    this.conn = conn;
    this.jumpConns = jumpConns;

    for (const jumpConn of jumpConns) {
      jumpConn.once('error', (err) => this.cleanup(err));
      jumpConn.once('end', () => this.cleanup());
    }

    await new Promise<void>((resolve, reject) => {
      const handleError = (err: Error) => {
        this.cleanup(err);
        reject(err);
      };

      conn.once('error', handleError);
      conn.once('end', () => this.cleanup());

      conn.shell({ term: 'xterm', rows: 40, cols: 120 }, (err, stream) => {
        if (err) {
          handleError(err);
          return;
        }

        this.shell = stream;
        stream.setEncoding('utf8');
        this.commandQueue = new ShellCommandQueue(stream);
        stream.on('data', (data: string) => {
          this.commandQueue?.handleData(data);
        });
        stream.on('close', () => {
          this.commandQueue?.handleClose();
          this.cleanup();
        });
        stream.stderr?.on('data', (data: string) => {
          this.commandQueue?.handleData(data);
        });

        stream.write('export PS1=""\n');
        stream.write('stty -echo 2>/dev/null\n');
        resolve();
      });
    });

    this.resetInactivityTimer();
  }

  async execute(command: string): Promise<{ output: string; exitCode: number }> {
    await this.ensureConnected();
    if (!this.commandQueue) {
      throw new McpError(ErrorCode.InternalError, 'SSH shell not ready');
    }
    return new Promise((resolve, reject) => {
      this.launch(command, {
        onDone: resolve,
        onError: reject,
      });
    });
  }

  launch(command: string, callbacks: CommandCallbacks): void {
    if (!this.commandQueue) {
      throw new McpError(ErrorCode.InternalError, 'SSH shell not ready');
    }
    this.commandQueue.launch(command, {
      onData: (chunk) => {
        callbacks.onData?.(chunk);
        this.resetInactivityTimer();
      },
      onDone: (result) => {
        callbacks.onDone?.(result);
        this.resetInactivityTimer();
      },
      onError: (error) => {
        callbacks.onError?.(error);
        this.resetInactivityTimer();
      },
    });
    this.lastCommand = command;
    this.resetInactivityTimer();
  }

  sendInput(text: string): void {
    if (!this.commandQueue) {
      throw new McpError(ErrorCode.InternalError, 'SSH shell not ready');
    }
    this.commandQueue.sendInput(text);
  }

  interrupt(): void {
    if (!this.commandQueue) {
      throw new McpError(ErrorCode.InternalError, 'SSH shell not ready');
    }
    this.commandQueue.interrupt();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cleanup();
  }

  private resetInactivityTimer(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
    }

    this.inactivityTimer = setTimeout(() => {
      this.dispose();
    }, this.timeoutMs);
  }

  private cleanup(error?: Error): void {
    this.commandQueue?.handleClose();

    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    if (this.shell) {
      this.shell.removeAllListeners();
      this.shell.end();
      this.shell = null;
    }
    this.commandQueue = null;

    if (this.conn) {
      this.conn.removeAllListeners();
      this.conn.end();
      this.conn = null;
    }

    for (const jumpConn of this.jumpConns) {
      jumpConn.removeAllListeners();
      jumpConn.end();
    }
    this.jumpConns = [];

    if (this.disposed) {
      this.onDispose?.(this.id);
    }
  }
}

export class PortForward {
  private server: net.Server | null = null;
  private readonly activeSockets = new Set<net.Socket>();
  private totalConnections = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private idleStartAt: number | null = null;
  private state: PortForwardInfo['state'] = 'connecting';
  private lastError: string | null = null;
  private boundPort: number;
  private disposed = false;

  constructor(
    private readonly id: string,
    private readonly hostId: string,
    private readonly localBind: string,
    localPort: number,
    private readonly remoteHost: string,
    private readonly remotePort: number,
    private readonly jumpHostIds: string[],
    private readonly conn: InstanceType<typeof SSHClient>,
    private readonly jumpConns: InstanceType<typeof SSHClient>[],
    private readonly timeoutMs = DEFAULT_SESSION_TTL_MS,
    private readonly onDispose?: (id: string) => void,
  ) {
    this.boundPort = localPort;
    conn.once('error', (error: Error) => this.markDead(error));
    conn.once('end', () => this.markDead(new Error('SSH connection ended')));
    conn.once('close', () => this.markDead(new Error('SSH connection closed')));
    for (const jumpConn of jumpConns) {
      jumpConn.once('error', (error: Error) => this.markDead(error));
      jumpConn.once('end', () => this.markDead(new Error('Jump connection ended')));
    }
  }

  async start(): Promise<void> {
    if (this.disposed) {
      throw new McpError(ErrorCode.InternalError, `Tunnel ${this.id} has been disposed`);
    }
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.handleConnection(socket));
      this.server.on('error', (error: NodeJS.ErrnoException) => {
        this.closeConnections();
        this.server = null;
        this.state = 'closed';
        if (error.code === 'EADDRINUSE') {
          reject(new McpError(ErrorCode.InvalidParams, `Local port ${this.boundPort} is already in use`));
        } else {
          reject(new McpError(ErrorCode.InternalError, `Failed to bind ${this.localBind}:${this.boundPort}: ${error.message}`));
        }
      });
      this.server.listen(this.boundPort, this.localBind, () => {
        if (this.state === 'dead' || this.disposed) {
          this.closeServer();
          this.closeConnections();
          reject(new Error('SSH chain closed before the tunnel could start'));
          return;
        }
        const address = this.server!.address() as net.AddressInfo;
        this.boundPort = address.port;
        this.state = 'active';
        this.startIdleTimer();
        resolve();
      });
    });
  }

  getInfo(): PortForwardInfo {
    const idleMs = this.idleStartAt !== null
      ? Math.max(0, Math.floor((Date.now() - this.idleStartAt) / 1000))
      : null;
    return {
      id: this.id,
      hostId: this.hostId,
      localBind: this.localBind,
      localPort: this.boundPort,
      remoteHost: this.remoteHost,
      remotePort: this.remotePort,
      jumpHosts: [...this.jumpHostIds],
      state: this.state,
      activeConnections: this.activeSockets.size,
      totalConnections: this.totalConnections,
      lastError: this.lastError,
      idleMs,
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearIdleTimer();
    this.closeServer();
    this.destroySockets();
    this.closeConnections();
    this.state = 'closed';
    this.onDispose?.(this.id);
  }

  private handleConnection(socket: net.Socket): void {
    if (this.state !== 'active') {
      socket.destroy();
      return;
    }
    this.activeSockets.add(socket);
    this.totalConnections += 1;
    this.clearIdleTimer();
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      this.activeSockets.delete(socket);
      if (this.activeSockets.size === 0) {
        this.startIdleTimer();
      }
    });

    this.conn.forwardOut('127.0.0.1', 0, this.remoteHost, this.remotePort, (error, stream) => {
      if (error) {
        this.lastError = `forwardOut to ${this.remoteHost}:${this.remotePort} failed: ${error.message}`;
        socket.destroy();
        return;
      }
      if (socket.destroyed) {
        stream.destroy();
        return;
      }
      socket.pipe(stream);
      stream.pipe(socket);
      socket.on('close', () => stream.destroy());
      stream.on('close', () => socket.destroy());
      stream.on('error', () => socket.destroy());
    });
  }

  private startIdleTimer(): void {
    if (this.disposed || this.state !== 'active' || this.idleTimer) {
      return;
    }
    this.idleStartAt = Date.now();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.dispose();
    }, this.timeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.idleStartAt = null;
  }

  private markDead(error: Error): void {
    if (this.disposed || this.state === 'dead' || this.state === 'closed') {
      return;
    }
    this.state = 'dead';
    this.lastError = error.message;
    this.clearIdleTimer();
    this.closeServer();
    this.destroySockets();
    this.closeConnections();
  }

  private closeServer(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private destroySockets(): void {
    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    this.activeSockets.clear();
  }

  private closeConnections(): void {
    this.conn.end();
    for (const jumpConn of this.jumpConns) {
      jumpConn.end();
    }
  }
}

export class InternetEgress {
  private idleTimer: NodeJS.Timeout | null = null;
  private idleStartAt: number | null = null;
  private readonly activeStreams = new Set<Duplex>();
  private totalConnections = 0;
  private state: EgressInfo['state'] = 'connecting';
  private lastError: string | null = null;
  private disposed = false;

  constructor(
    private readonly id: string,
    private readonly hostId: string,
    private readonly proxyBind: string,
    private readonly proxyPort: number,
    private readonly jumpHostIds: string[],
    private readonly conn: InstanceType<typeof SSHClient>,
    private readonly jumpConns: InstanceType<typeof SSHClient>[],
    private readonly timeoutMs = DEFAULT_SESSION_TTL_MS,
    private readonly onDispose?: (id: string) => void,
  ) {
    conn.once('error', (error: Error) => this.markDead(error));
    conn.once('end', () => this.markDead(new Error('SSH connection ended')));
    conn.once('close', () => this.markDead(new Error('SSH connection closed')));
    for (const jumpConn of jumpConns) {
      jumpConn.once('error', (error: Error) => this.markDead(error));
      jumpConn.once('end', () => this.markDead(new Error('Jump connection ended')));
    }
    conn.on('tcp connection', (info: any, accept: any) => {
      if (this.state !== 'active') {
        try {
          accept()?.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      let stream: Duplex;
      try {
        stream = accept();
      } catch {
        return;
      }
      this.handleStream(stream);
    });
  }

  async start(): Promise<void> {
    if (this.disposed) {
      throw new McpError(ErrorCode.InternalError, `Egress ${this.id} has been disposed`);
    }
    return new Promise((resolve, reject) => {
      this.conn.forwardIn(this.proxyBind, this.proxyPort, (error) => {
        if (error) {
          this.closeConnections();
          this.state = 'closed';
          reject(new McpError(ErrorCode.InternalError, `Failed to listen on ${this.proxyBind}:${this.proxyPort} on host '${this.hostId}': ${error.message}`));
          return;
        }
        if (this.state === 'dead' || this.disposed) {
          this.closeConnections();
          reject(new Error('SSH chain closed before the egress could start'));
          return;
        }
        this.state = 'active';
        this.startIdleTimer();
        resolve();
      });
    });
  }

  getInfo(): EgressInfo {
    const idleMs = this.idleStartAt !== null
      ? Math.max(0, Math.floor((Date.now() - this.idleStartAt) / 1000))
      : null;
    return {
      id: this.id,
      hostId: this.hostId,
      proxyBind: this.proxyBind,
      proxyPort: this.proxyPort,
      jumpHosts: [...this.jumpHostIds],
      state: this.state,
      activeConnections: this.activeStreams.size,
      totalConnections: this.totalConnections,
      lastError: this.lastError,
      idleMs,
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearIdleTimer();
    try {
      this.conn.unforwardIn(this.proxyBind, this.proxyPort);
    } catch {
      /* best effort */
    }
    this.destroyStreams();
    this.closeConnections();
    this.state = 'closed';
    this.onDispose?.(this.id);
  }

  private handleStream(stream: Duplex): void {
    this.activeStreams.add(stream);
    this.totalConnections += 1;
    this.clearIdleTimer();
    stream.on('error', () => stream.destroy());
    stream.on('close', () => {
      this.activeStreams.delete(stream);
      if (this.activeStreams.size === 0) {
        this.startIdleTimer();
      }
    });
    handleProxyConnection(stream, (host, port) =>
      new Promise<Duplex>((resolve, reject) => {
        const sock = net.connect({ host, port });
        sock.once('connect', () => resolve(sock));
        sock.once('error', reject);
      })
    );
  }

  private startIdleTimer(): void {
    if (this.disposed || this.state !== 'active' || this.idleTimer) {
      return;
    }
    this.idleStartAt = Date.now();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.dispose();
    }, this.timeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.idleStartAt = null;
  }

  private markDead(error: Error): void {
    if (this.disposed || this.state === 'dead' || this.state === 'closed') {
      return;
    }
    this.state = 'dead';
    this.lastError = error.message;
    this.clearIdleTimer();
    this.destroyStreams();
    this.closeConnections();
  }

  private destroyStreams(): void {
    for (const stream of this.activeStreams) {
      stream.destroy();
    }
    this.activeStreams.clear();
  }

  private closeConnections(): void {
    this.conn.end();
    for (const jumpConn of this.jumpConns) {
      jumpConn.end();
    }
  }
}

type TransferConnections = {
  source: {
    conn: InstanceType<typeof SSHClient>;
    jumpConns: InstanceType<typeof SSHClient>[];
    sftp?: SFTPWrapper;
  };
  target?: {
    conn: InstanceType<typeof SSHClient>;
    jumpConns: InstanceType<typeof SSHClient>[];
    sftp?: SFTPWrapper;
  };
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ServerTransfer {
  private state: TransferState = 'pending';
  private transferredBytes = 0;
  private totalBytes: number | null = null;
  private error: string | null = null;
  private readonly createdAt = Date.now();
  private finishedAt: number | null = null;
  private cancelled = false;
  private disposed = false;
  private streams: Array<NodeJS.ReadableStream | NodeJS.WritableStream> = [];
  private execChannel: ClientChannel | null = null;
  private lastStderr = '';

  constructor(
    private readonly id: string,
    private readonly sourceHostId: string,
    private readonly targetHostId: string,
    private readonly sourceResolved: ResolvedHost,
    private readonly targetResolved: ResolvedHost,
    private readonly sourcePath: string,
    private readonly targetPath: string,
    private readonly mode: 'direct' | 'stream' | 'hybrid',
    private readonly conns: TransferConnections,
  ) {
    const source = conns.source;
    source.conn.once?.('error', (error: Error) => this.markFailed(error.message));
    source.conn.once?.('end', () => this.markFailed('SSH connection ended'));
    source.conn.once?.('close', () => this.markFailed('SSH connection closed'));
    for (const jumpConn of source.jumpConns) {
      jumpConn.once?.('error', (error: Error) => this.markFailed(error.message));
      jumpConn.once?.('end', () => this.markFailed('Jump connection ended'));
    }
    const target = conns.target;
    if (target) {
      target.conn.once?.('error', (error: Error) => this.markFailed(error.message));
      target.conn.once?.('end', () => this.markFailed('SSH connection ended'));
      target.conn.once?.('close', () => this.markFailed('SSH connection closed'));
      for (const jumpConn of target.jumpConns) {
        jumpConn.once?.('error', (error: Error) => this.markFailed(error.message));
        jumpConn.once?.('end', () => this.markFailed('Jump connection ended'));
      }
    }
  }

  async start(): Promise<void> {
    if (this.disposed) {
      throw new McpError(ErrorCode.InternalError, `Transfer ${this.id} has been disposed`);
    }
    this.state = 'running';
    if (this.mode === 'stream') {
      try {
        await this.runStream();
      } catch (error: any) {
        if (!this.cancelled) this.finish('failed', errorMessage(error));
      }
      return;
    }
    if (this.mode === 'direct') {
      try {
        await this.runDirect();
      } catch (error: any) {
        if (!this.cancelled) this.finish('failed', errorMessage(error));
      }
      return;
    }
    let directError: unknown = null;
    try {
      await this.runDirect();
      return;
    } catch (error: any) {
      directError = error;
    }
    if (this.cancelled) return;
    try {
      await this.runStream();
    } catch (streamError: any) {
      if (!this.cancelled) {
        this.finish('failed', `direct: ${errorMessage(directError)}; stream fallback: ${errorMessage(streamError)}`);
      }
    }
  }

  getInfo(): TransferInfo {
    const percent = this.totalBytes && this.totalBytes > 0
      ? Math.min(100, Math.round((this.transferredBytes / this.totalBytes) * 100))
      : null;
    return {
      id: this.id,
      mode: this.mode,
      state: this.state,
      sourceHost: this.sourceHostId,
      sourcePath: this.sourcePath,
      targetHost: this.targetHostId,
      targetPath: this.targetPath,
      totalBytes: this.totalBytes,
      transferredBytes: this.transferredBytes,
      percent,
      error: this.error,
      createdAt: this.createdAt,
      finishedAt: this.finishedAt,
    };
  }

  async cancel(): Promise<void> {
    if (this.state === 'completed' || this.state === 'failed' || this.state === 'cancelled') {
      throw new McpError(ErrorCode.InvalidParams, `Transfer ${this.id} is already ${this.state}`);
    }
    this.cancelled = true;
    for (const stream of this.streams) (stream as any).destroy();
    if (this.execChannel) {
      try {
        this.execChannel.close();
      } catch {
        /* ignore */
      }
    }
    this.finish('cancelled', null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const stream of this.streams) (stream as any).destroy();
    if (this.execChannel) {
      try {
        this.execChannel.close();
      } catch {
        /* ignore */
      }
    }
    this.execChannel = null;
    const source = this.conns.source;
    source.sftp?.end();
    source.conn.end();
    for (const jumpConn of source.jumpConns) jumpConn.end();
    const target = this.conns.target;
    if (target) {
      target.sftp?.end();
      target.conn.end();
      for (const jumpConn of target.jumpConns) jumpConn.end();
    }
  }

  private complete(): void {
    if (this.cancelled) return;
    this.finish('completed', null);
  }

  private markFailed(message: string): void {
    if (this.state === 'completed' || this.state === 'failed' || this.state === 'cancelled') {
      return;
    }
    this.finish('failed', message);
  }

  private finish(state: TransferState, error: string | null): void {
    if (this.state === 'completed' || this.state === 'failed' || this.state === 'cancelled') {
      return;
    }
    this.state = state;
    this.error = error;
    this.finishedAt = Date.now();
    this.dispose();
  }

  private async runStream(): Promise<void> {
    this.transferredBytes = 0;
    this.totalBytes = null;
    const sourceConn = this.conns.source;
    const targetConn = this.conns.target;
    if (!targetConn?.sftp || !sourceConn.sftp) {
      throw new Error('stream mode requires both source and target SFTP connections');
    }
    const stats = await sftpStat(sourceConn.sftp, this.sourcePath);
    if (stats.isDirectory()) {
      throw new Error('stream mode supports single files only; source is a directory');
    }
    this.totalBytes = stats.size;
    await ensureRemoteParentDirectory(targetConn.sftp, this.targetPath);
    const read = sourceConn.sftp.createReadStream(this.sourcePath);
    const write = targetConn.sftp.createWriteStream(this.targetPath, { flags: 'w' });
    this.streams = [read, write];
    read.on('data', (chunk: Buffer) => {
      this.transferredBytes += chunk.length;
    });
    read.pipe(write);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const once = (fn: (...args: any[]) => void) => (...args: any[]) => { if (!settled) { settled = true; fn(...args); } };
      write.on('finish', once(resolve));
      write.on('close', once(resolve));
      read.on('error', once((error: Error) => reject(error)));
      write.on('error', once((error: Error) => reject(error)));
    });
    this.complete();
  }

  private async runDirect(): Promise<void> {
    const cfg = this.targetResolved.config;
    if (!cfg.host || !cfg.username) {
      throw new Error('target host configuration is incomplete');
    }
    const command = buildDirectCommand({
      targetUser: cfg.username,
      targetHost: cfg.host,
      targetPort: cfg.port ?? 22,
      sourcePath: this.sourcePath,
      targetPath: this.targetPath,
    });
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      this.conns.source.conn.exec(command, (error, stream) => {
        if (error) reject(error);
        else resolve(stream);
      });
    });
    this.execChannel = channel;
    let exitCode: number | undefined;
    channel.on('exit', (code: number | undefined) => {
      exitCode = code;
    });
    channel.stderr?.on('data', (data: Buffer) => {
      this.lastStderr += data.toString('utf8');
    });
    channel.on('data', (data: Buffer) => {
      for (const record of data.toString('utf8').split('\r')) {
        const parsed = parseRsyncProgress(record.trim());
        if (parsed) {
          this.transferredBytes = Math.max(this.transferredBytes, parsed.bytes);
          if (parsed.percent !== null && parsed.percent > 0 && this.totalBytes === null && parsed.bytes > 0) {
            this.totalBytes = Math.round((parsed.bytes * 100) / parsed.percent);
          }
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      channel.on('close', () => resolve());
      channel.on('error', (error: Error) => reject(error));
    });
    this.execChannel = null;
    if (this.cancelled) {
      this.finish('cancelled', null);
      return;
    }
    const channelAny = channel as any;
    const finalExitCode = exitCode ?? channelAny.exitCode;
    if (finalExitCode === undefined) {
      throw new Error('rsync channel ended without an exit code (the SSH connection may have dropped)');
    }
    if (finalExitCode !== 0) {
      throw new Error(
        formatRsyncFailureMessage(
          `rsync exited with code ${finalExitCode}${this.lastStderr ? `: ${this.lastStderr.trim()}` : ''}`,
          this.lastStderr,
        )
      );
    }
    this.complete();
  }
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SSH MCP Server running on stdio");
}

if (process.env.SSH_MCP_DISABLE_MAIN !== '1') {
  main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
  });
}

export {};
