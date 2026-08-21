#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ClientChannel, ConnectConfig, OpenMode, SFTPWrapper, Stats } from 'ssh2';
import SSH2Module from 'ssh2';
const { Client: SSHClient, utils: sshUtils } = SSH2Module as typeof import('ssh2');
import { z } from 'zod';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFile, writeFile, mkdir, stat, lstat, rename, rm, open, readdir } from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { posix as posixPath, relative as relativePath, resolve as resolvePath, sep as pathSeparator } from 'path';
import os from 'os';
import { randomUUID, createHash } from 'crypto';
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

export type SftpConnection = {
  conn: InstanceType<typeof SSHClient>;
  jumpConns: InstanceType<typeof SSHClient>[];
  sftp: SFTPWrapper;
};

export type ParallelSftpConnectionFactory = () => Promise<SftpConnection>;

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

function closeSftpConnection(connection: SftpConnection): void {
  connection.sftp.end();
  connection.conn.end();
  for (const jumpConn of connection.jumpConns) jumpConn.end();
}

async function withSftpConnection<T>(resolved: ResolvedHost, action: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  const { conn, jumpConns, sftp } = await openSftpConnection(resolved);
  try {
    return await action(sftp);
  } finally {
    closeSftpConnection({ conn, jumpConns, sftp });
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

function sftpLstat(sftp: SFTPWrapper, remotePath: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.lstat(remotePath, (error, stats) => error ? reject(error) : resolve(stats));
  });
}

function isMissingPathError(error: any): boolean {
  return error?.code === 'ENOENT' || /(?:ENOENT|no such file|not found)/i.test(String(error?.message ?? error));
}

function sftpRename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => err ? reject(err) : resolve());
  });
}

function sftpMkdir(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, { mode: 0o755 }, (error) => error ? reject(error) : resolve());
  });
}

/**
 * Create every missing component of the remote parent directory over SFTP.
 * When `rejectSymlinks` is set (directory transfers), intermediate components
 * that are symlinks are rejected instead of written through, preventing a
 * write escape (e.g. `/tmp/out/sub -> /etc`). Single-file transfers keep the
 * legacy follow-symlink behavior.
 */
async function ensureRemoteParentDirectory(
  sftp: SFTPWrapper,
  remotePath: string,
  rejectSymlinks = false,
): Promise<void> {
  const directory = posixPath.normalize(posixPath.dirname(remotePath));
  if (directory === '.' || directory === '/') return;

  const statPath = rejectSymlinks ? sftpLstat : sftpStat;
  const absolute = directory.startsWith('/');
  let current = absolute ? '/' : '';
  for (const component of directory.split('/').filter(Boolean)) {
    current = current ? posixPath.join(current, component) : component;
    try {
      const stats = await statPath(sftp, current);
      if (rejectSymlinks && stats.isSymbolicLink()) {
        throw new Error(`Remote path '${current}' is a symlink; refusing to write through it`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`Remote path '${current}' exists but is not a directory`);
      }
    } catch (statError: any) {
      if (
        statError?.message?.includes('is not a directory')
        || statError?.message?.includes('is a symlink')
      ) {
        throw statError;
      }
      try {
        await sftpMkdir(sftp, current);
      } catch (mkdirError) {
        // Another client may have created the directory between stat and mkdir.
        const stats = await statPath(sftp, current).catch(() => { throw mkdirError; });
        if (rejectSymlinks && stats.isSymbolicLink()) {
          throw new Error(`Remote path '${current}' is a symlink; refusing to write through it`);
        }
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
  mode: 'direct' | 'stream' | 'hybrid' | 'single';
  kind: 'server' | 'download' | 'upload' | 'download-dir' | 'upload-dir';
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
  filesDone?: number;
  filesTotal?: number;
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
  interactive: boolean;
};

export function partPathFor(targetPath: string): string {
  return `${targetPath}.part`;
}

export function resolveResumeOffset(partSize: number | null, sourceSize: number): number {
  if (partSize === null || partSize > sourceSize) {
    return 0;
  }
  return partSize;
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk: Buffer | string) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function sha256Remote(sftp: SFTPWrapper, remotePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = sftp.createReadStream(remotePath);
    stream.on('data', (chunk: Buffer | string) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export type DirEntry = {
  relPath: string;
  size: number;
  isDir?: boolean;
};

export const DEFAULT_CHUNK_THRESHOLD_BYTES = 400 * 1024 * 1024;
/** Directory transfers share one primary SFTP connection plus chunk sessions. */
export const MAX_DIRECTORY_PARALLEL_CONNECTIONS = 16;
export const MAX_DIRECTORY_ENTRIES = 100_000;

export function resolveDirectoryChunkThreads(
  concurrency: number,
  requestedThreads: number,
  maxConnections = MAX_DIRECTORY_PARALLEL_CONNECTIONS,
): number {
  const safeConcurrency = Math.max(1, Math.floor(concurrency));
  const safeRequested = Math.max(1, Math.floor(requestedThreads));
  const safeMaxConnections = Math.max(1, Math.floor(maxConnections));
  const maxThreads = Math.max(1, Math.floor((safeMaxConnections - 1) / safeConcurrency) + 1);
  return Math.min(safeRequested, maxThreads);
}

export function dirEntriesToTotal(entries: DirEntry[]): { filesTotal: number; totalBytes: number } {
  let filesTotal = 0;
  let totalBytes = 0;
  for (const e of entries) {
    if (e.isDir) continue;
    filesTotal += 1;
    totalBytes += e.size;
  }
  return { filesTotal, totalBytes };
}

export function resolveDirSkip(
  entry: DirEntry,
  localSize: number | null,
  localHash: string | null,
  remoteHash: string | null,
): boolean {
  if (localSize === null || localHash === null || remoteHash === null) {
    return false;
  }
  return localSize === entry.size && localHash === remoteHash;
}

export function chunkSegments(
  fileSize: number,
  offset: number,
  chunkSize: number,
  threads: number,
): Array<{ start: number; end: number }> {
  const remaining = fileSize - offset;
  if (remaining <= 0) {
    return [];
  }
  const t = Math.max(1, Math.floor(threads));
  if (chunkSize <= 0 || t <= 1 || remaining < chunkSize) {
    return [{ start: offset, end: fileSize }];
  }
  const segCount = Math.min(t, Math.floor(remaining / chunkSize));
  const segBytesBase = Math.floor(remaining / segCount);
  const extra = remaining % segCount;
  const segs: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < segCount; i++) {
    const segLen = segBytesBase + (i < extra ? 1 : 0);
    const start = offset + (i === 0 ? 0 : segs[i - 1].end - offset);
    const end = start + segLen;
    segs.push({ start, end });
  }
  return segs;
}

export function shouldUseChunking(fileSize: number, offset: number, threshold: number, threads: number): boolean {
  return offset === 0 && threads > 1 && fileSize >= threshold;
}

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

export function resolveLocalStatError(error: any, localPath: string): McpError {
  if (error instanceof McpError) {
    return error;
  }
  if (error?.code === 'EACCES' || error?.code === 'EPERM') {
    return new McpError(ErrorCode.InternalError, `Local file '${localPath}' cannot be read (permission denied)`);
  }
  return new McpError(ErrorCode.InvalidParams, `Local file '${localPath}' cannot be read: ${error.message}`);
}

export async function assertLocalDestinationParent(parent: string): Promise<void> {
  let parentStats;
  try {
    parentStats = await stat(parent);
  } catch (error: any) {
    throw new McpError(ErrorCode.InvalidParams, `Local destination directory '${parent}' does not exist`);
  }
  if (!parentStats.isDirectory()) {
    throw new McpError(ErrorCode.InvalidParams, `Local destination parent '${parent}' is not a directory`);
  }
}

/** Refuse to create or use a directory root that is a symlink. */
async function ensureLocalDirectoryRoot(directory: string): Promise<void> {
  try {
    const stats = await lstat(directory);
    if (stats.isSymbolicLink()) {
      throw new McpError(ErrorCode.InvalidParams, `Local directory '${directory}' is a symlink; refusing to follow it`);
    }
    if (!stats.isDirectory()) {
      throw new McpError(ErrorCode.InvalidParams, `Local path '${directory}' is not a directory`);
    }
  } catch (error: any) {
    if (error instanceof McpError) throw error;
    if (error?.code === 'ENOENT') {
      await mkdir(directory, { recursive: true });
      return;
    }
    throw resolveLocalStatError(error, directory);
  }
}

/** Ensure a local directory path stays inside a checked, non-symlink root. */
async function ensureLocalDirectoryPath(root: string, directory: string): Promise<void> {
  const resolvedRoot = resolvePath(root);
  const resolvedDirectory = resolvePath(directory);
  const relative = relativePath(resolvedRoot, resolvedDirectory);
  if (relative === '..' || relative.startsWith(`..${pathSeparator}`) || relativePath(resolvedRoot, resolvedDirectory).startsWith(pathSeparator)) {
    throw new McpError(ErrorCode.InvalidParams, `Local path '${directory}' escapes destination root '${root}'`);
  }
  await ensureLocalDirectoryRoot(resolvedRoot);
  let current = resolvedRoot;
  for (const component of relative.split(pathSeparator).filter(Boolean)) {
    current = resolvePath(current, component);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new McpError(ErrorCode.InvalidParams, `Local directory '${current}' is a symlink; refusing to follow it`);
      }
      if (!stats.isDirectory()) {
        throw new McpError(ErrorCode.InvalidParams, `Local path '${current}' is not a directory`);
      }
    } catch (error: any) {
      if (error instanceof McpError) throw error;
      if (error?.code !== 'ENOENT') throw resolveLocalStatError(error, current);
      await mkdir(current);
    }
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

export interface ActiveTransfer {
  getInfo(): TransferInfo;
  cancel(): Promise<void>;
}

const activeSessions = new Map<string, PersistentSession>();
const activeTunnels = new Map<string, PortForward>();
const activeEgress = new Map<string, InternetEgress>();
const activeTransfers = new Map<string, ActiveTransfer>();
const activeExecRuns = new Map<string, ExecRun>();
const DEFAULT_SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

const server = new McpServer({
  name: 'SSH MCP Server',
  // Keep in sync with the "version" field in package.json.
  version: '1.0.4',
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
  "Execute a shell command on an existing SSH session in the background. Returns immediately with a run id; poll exec-status for the result and exec-logs for incremental output. Use this for long-running commands that would time out the synchronous exec tool. For stdin-reading programs (menus, REPLs), pass interactive:true to omit the completion marker; the run stays running until exec-cancel or session close.",
  {
    session_id: z.string().describe("Identifier of the session to use"),
    command: z.string().describe("Command to execute"),
    interactive: z.boolean().default(false).describe("Launch in interactive mode (default false): writes only the command without the completion marker, so stdin-reading programs like menus are not fed the marker line. The run stays running until exec-cancel or session close. Use with exec-input."),
  },
  async ({ session_id, command, interactive }) => {
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
      interactive,
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
      }, { interactive });
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
  "exec-input",
  "Send input to the stdin of a running interactive background command (one launched with interactive:true, e.g. selecting an option in a jump-host asset menu). Rejects runs launched without interactive:true — for a non-interactive run the command may have finished and the text would then be executed at the shell prompt. Returns the incremental output produced after the input, sliced from the given character offset. Pass the returned nextOffset as the next offset to step through an interactive session.",
  {
    run_id: z.string().describe("Identifier of the command run to send input to"),
    text: z.string().describe("Input to write to the command's stdin (include a newline/return as needed, e.g. '1\\n')"),
    offset: z.number().int().min(0).default(0).describe("Character offset into the accumulated output to return from (default 0)"),
    wait_ms: z.number().int().min(0).max(30000).default(400).describe("Milliseconds to wait for output produced by this input (default 400)"),
  },
  async ({ run_id, text, offset, wait_ms }) => {
    pruneExpiredExecRuns(activeExecRuns, Date.now());
    const run = activeExecRuns.get(run_id);
    if (!run) {
      throw new McpError(ErrorCode.InvalidParams, `Run '${run_id}' does not exist`);
    }
    const resolved = resolveExecRunSessionFailure(run, activeSessions.has(run.session_id));
    if (resolved.state !== 'running') {
      throw new McpError(ErrorCode.InvalidParams, `Run '${run_id}' is already ${resolved.state}`);
    }
    if (!resolved.interactive) {
      throw new McpError(ErrorCode.InvalidParams, `Run '${run_id}' is not interactive (start it with interactive:true to send input)`);
    }
    const session = activeSessions.get(run.session_id);
    if (!session) {
      throw new McpError(ErrorCode.InternalError, `Session '${run.session_id}' no longer exists`);
    }
    session.sendInput(text);
    if (wait_ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait_ms));
    }
    const afterInput = resolveExecRunSessionFailure(run, activeSessions.has(run.session_id));
    validateExecInputPostState(afterInput, run_id);
    return {
      content: [{ type: 'text', text: JSON.stringify(formatExecInputResult(afterInput, offset), null, 2) }],
    };
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
  "session-output",
  "Read incremental output from an SSH session's shell (e.g. a bastion host's interactive login menu). Returns the output from the given character offset plus the next offset to continue from. Unlike exec-logs, this works on the session itself, not a background run — use it to read a login-time menu that start-session already produced.",
  {
    session_id: z.string().describe("Identifier of the session"),
    offset: z.number().int().min(0).default(0).describe("Character offset into the session output to read from (default 0)"),
  },
  async ({ session_id, offset }) => {
    const session = activeSessions.get(session_id);
    if (!session) {
      throw new McpError(ErrorCode.InvalidParams, `Session '${session_id}' does not exist`);
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(formatSessionOutput(session.getSessionOutput(), offset), null, 2) }],
    };
  }
);

server.tool(
  "session-input",
  "Write input to an SSH session's shell to drive a login-time menu (e.g. selecting an option in a bastion host's login menu) and return the incremental output it triggers. Unlike exec-input, this works on the session itself — use it only at the idle shell prompt. Do not use it while a background command (start-exec/exec) is running in this session: the session-input tool rejects that, because the text would be delivered to the running program or executed at the prompt. Pass the returned nextOffset as the next offset to step through the menu.",
  {
    session_id: z.string().describe("Identifier of the session"),
    text: z.string().describe("Input to write to the session's shell stdin (include a newline/return as needed, e.g. '1\\n')"),
    offset: z.number().int().min(0).default(0).describe("Character offset into the session output to return from (default 0)"),
    wait_ms: z.number().int().min(0).max(30000).default(400).describe("Milliseconds to wait for output produced by this input (default 400)"),
  },
  async ({ session_id, text, offset, wait_ms }) => {
    const session = activeSessions.get(session_id);
    if (!session) {
      throw new McpError(ErrorCode.InvalidParams, `Session '${session_id}' does not exist`);
    }
    session.writeInput(text);
    if (wait_ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait_ms));
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(formatSessionOutput(session.getSessionOutput(), offset), null, 2) }],
    };
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
  "Query the status and progress of an active transfer (server-to-server, download, or upload).",
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
  "Cancel a running transfer (server-to-server, download, or upload).",
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

server.tool(
  "start-download-dir",
  "Recursively download a directory from a stored SSH host over SFTP in the background. Returns immediately with a transfer id; poll transfer-status for progress (filesDone/filesTotal) and cancel with transfer-cancel. Re-running resumes: already-complete files (size + sha256 match) are skipped. Use for model/data directories.",
  {
    host_id: z.string().describe("Identifier of the source host"),
    remote_dir: z.string().min(1).describe("Remote source directory"),
    local_dir: z.string().min(1).describe("Local destination directory (created if missing)"),
    concurrency: z.number().int().min(1).max(16).default(4).describe("Max concurrent files to transfer (default 4)"),
    chunk_threads: z.number().int().min(1).max(16).default(4).describe("Max parallel segments per large file (default 4)"),
    chunk_size_mb: z.number().int().min(1).default(8).describe("Minimum size of each parallel segment in MB (default 8)"),
    chunk_threshold_mb: z.number().int().min(1).default(400).describe("Only files at least this many MB are chunked (default 400)"),
  },
  async ({ host_id, remote_dir, local_dir, concurrency, chunk_threads, chunk_size_mb, chunk_threshold_mb }) => {
    const resolvedLocalDir = resolvePath(local_dir);
    const id = randomUUID();
    const resolved = await resolveHost(host_id);
    await ensureLocalDirectoryRoot(resolvedLocalDir);
    let conn: { conn: InstanceType<typeof SSHClient>; jumpConns: InstanceType<typeof SSHClient>[]; sftp: SFTPWrapper };
    try {
      conn = await openSftpConnection(resolved);
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to connect to host '${host_id}': ${error instanceof Error ? error.message : String(error)}`);
    }
    const transfer = new DirectoryTransfer(id, host_id, remote_dir, resolvedLocalDir, 'download-dir',
      conn, {
        concurrency,
        chunkThreads: chunk_threads,
        chunkSize: chunk_size_mb * 1024 * 1024,
        chunkThreshold: chunk_threshold_mb * 1024 * 1024,
        parallelConnectionFactory: () => openSftpConnection(resolved),
      });
    activeTransfers.set(id, transfer);
    transfer.start().catch(() => {});
    return {
      content: [{ type: 'text', text: `Directory download '${id}' started: ${host_id}:${remote_dir} -> '${resolvedLocalDir}'` }],
    };
  }
);

server.tool(
  "start-upload-dir",
  "Recursively upload a directory to a stored SSH host over SFTP in the background. Returns immediately with a transfer id; poll transfer-status for progress (filesDone/filesTotal) and cancel with transfer-cancel. Re-running resumes: already-complete files (size + sha256 match) are skipped.",
  {
    host_id: z.string().describe("Identifier of the destination host"),
    local_dir: z.string().min(1).describe("Local source directory"),
    remote_dir: z.string().min(1).describe("Remote destination directory (created if missing)"),
    concurrency: z.number().int().min(1).max(16).default(4).describe("Max concurrent files to transfer (default 4)"),
    chunk_threads: z.number().int().min(1).max(16).default(4).describe("Max parallel segments per large file (default 4)"),
    chunk_size_mb: z.number().int().min(1).default(8).describe("Minimum size of each parallel segment in MB (default 8)"),
    chunk_threshold_mb: z.number().int().min(1).default(400).describe("Only files at least this many MB are chunked (default 400)"),
  },
  async ({ host_id, local_dir, remote_dir, concurrency, chunk_threads, chunk_size_mb, chunk_threshold_mb }) => {
    const resolvedLocalDir = resolvePath(local_dir);
    const id = randomUUID();
    const resolved = await resolveHost(host_id);
    try {
      const localStats = await lstat(resolvedLocalDir);
      if (localStats.isSymbolicLink()) {
        throw new McpError(ErrorCode.InvalidParams, `Local path '${resolvedLocalDir}' is a symlink; refusing to follow it for upload`);
      }
      if (!localStats.isDirectory()) {
        throw new McpError(ErrorCode.InvalidParams, `Local path '${resolvedLocalDir}' is not a directory`);
      }
    } catch (error: any) {
      throw resolveLocalStatError(error, resolvedLocalDir);
    }
    let conn: { conn: InstanceType<typeof SSHClient>; jumpConns: InstanceType<typeof SSHClient>[]; sftp: SFTPWrapper };
    try {
      conn = await openSftpConnection(resolved);
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to connect to host '${host_id}': ${error instanceof Error ? error.message : String(error)}`);
    }
    const transfer = new DirectoryTransfer(id, host_id, remote_dir, resolvedLocalDir, 'upload-dir',
      conn, {
        concurrency,
        chunkThreads: chunk_threads,
        chunkSize: chunk_size_mb * 1024 * 1024,
        chunkThreshold: chunk_threshold_mb * 1024 * 1024,
        parallelConnectionFactory: () => openSftpConnection(resolved),
      });
    activeTransfers.set(id, transfer);
    transfer.start().catch(() => {});
    return {
      content: [{ type: 'text', text: `Directory upload '${id}' started: '${resolvedLocalDir}' -> ${host_id}:${remote_dir}` }],
    };
  }
);

server.tool(
  "start-download",
  "Download a file from a stored SSH host over SFTP in the background. Returns immediately with a transfer id; poll transfer-status for progress and cancel with transfer-cancel. Use this for large files that would time out the synchronous download-file tool.",
  {
    host_id: z.string().describe("Identifier of the source host"),
    remote_path: z.string().min(1).describe("Path to the source file on the remote host"),
    local_path: z.string().min(1).describe("Destination path on the MCP server machine (absolute or relative to its working directory)"),
    chunk_threads: z.number().int().min(1).max(16).default(4).describe("Max parallel segments for files above the chunk threshold (default 4)"),
    chunk_size_mb: z.number().int().min(1).default(8).describe("Minimum size of each parallel segment in MB (default 8)"),
    chunk_threshold_mb: z.number().int().min(1).default(400).describe("Only files at least this many MB are chunked (default 400)"),
  },
  async ({ host_id, remote_path, local_path, chunk_threads, chunk_size_mb, chunk_threshold_mb }) => {
    const resolvedLocalPath = resolvePath(local_path);
    await assertLocalDestinationParent(posixPath.dirname(resolvedLocalPath));
    const id = randomUUID();
    const resolved = await resolveHost(host_id);
    let conn: { conn: InstanceType<typeof SSHClient>; jumpConns: InstanceType<typeof SSHClient>[]; sftp: SFTPWrapper };
    try {
      conn = await openSftpConnection(resolved);
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to connect to host '${host_id}': ${error instanceof Error ? error.message : String(error)}`);
    }
    const transfer = new FileTransfer(id, host_id, resolvedLocalPath, remote_path, 'download', conn,
      {
        chunkThreads: chunk_threads,
        chunkSize: chunk_size_mb * 1024 * 1024,
        chunkThreshold: chunk_threshold_mb * 1024 * 1024,
        parallelConnectionFactory: () => openSftpConnection(resolved),
      });
    activeTransfers.set(id, transfer);
    transfer.start().catch(() => {
      // start() records failures internally; nothing further to do.
    });
    return {
      content: [{
        type: 'text',
        text: `Download '${id}' started: ${host_id}:${remote_path} -> '${resolvedLocalPath}'`,
      }],
    };
  }
);

server.tool(
  "start-upload",
  "Upload a local file to a stored SSH host over SFTP in the background. Returns immediately with a transfer id; poll transfer-status for progress and cancel with transfer-cancel. Use this for large files that would time out the synchronous upload-file tool.",
  {
    host_id: z.string().describe("Identifier of the destination host"),
    local_path: z.string().describe("Path to the local source file (absolute or relative to the MCP server process)"),
    remote_path: z.string().min(1).describe("Destination path on the remote host"),
    chunk_threads: z.number().int().min(1).max(16).default(4).describe("Max parallel segments for files above the chunk threshold (default 4)"),
    chunk_size_mb: z.number().int().min(1).default(8).describe("Minimum size of each parallel segment in MB (default 8)"),
    chunk_threshold_mb: z.number().int().min(1).default(400).describe("Only files at least this many MB are chunked (default 400)"),
  },
  async ({ host_id, local_path, remote_path, chunk_threads, chunk_size_mb, chunk_threshold_mb }) => {
    const resolvedLocalPath = resolvePath(local_path);
    try {
      const localStats = await stat(resolvedLocalPath);
      if (!localStats.isFile()) {
        throw new McpError(ErrorCode.InvalidParams, `Local path '${resolvedLocalPath}' is not a file`);
      }
    } catch (error: any) {
      throw resolveLocalStatError(error, resolvedLocalPath);
    }
    const id = randomUUID();
    const resolved = await resolveHost(host_id);
    let conn: { conn: InstanceType<typeof SSHClient>; jumpConns: InstanceType<typeof SSHClient>[]; sftp: SFTPWrapper };
    try {
      conn = await openSftpConnection(resolved);
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to connect to host '${host_id}': ${error instanceof Error ? error.message : String(error)}`);
    }
    const transfer = new FileTransfer(id, host_id, resolvedLocalPath, remote_path, 'upload', conn,
      {
        chunkThreads: chunk_threads,
        chunkSize: chunk_size_mb * 1024 * 1024,
        chunkThreshold: chunk_threshold_mb * 1024 * 1024,
        parallelConnectionFactory: () => openSftpConnection(resolved),
      });
    activeTransfers.set(id, transfer);
    transfer.start().catch(() => {
      // start() records failures internally; nothing further to do.
    });
    return {
      content: [{
        type: 'text',
        text: `Upload '${id}' started: '${resolvedLocalPath}' -> ${host_id}:${remote_path}`,
      }],
    };
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
 * Remote shell flavour. Drives both the PS1/prompt cleanup on session start
 * and the completion-marker command injected by `ShellCommandQueue` after
 * each command. POSIX (bash/zsh/sh) uses `printf` + `$?`; cmd.exe uses
 * `echo` + `%ERRORLEVEL%` (cmd has no `printf` and `$?` is POSIX-specific);
 * PowerShell uses `echo` plus a numeric projection of `$?` because
 * `$LASTEXITCODE` can be stale or empty for PowerShell cmdlets.
 */
export type ShellType = 'posix' | 'cmd' | 'pwsh';

/**
 * Build the completion-marker line that the queue writes after each command.
 * The marker must be a single line whose suffix is the last command's exit
 * code; the queue's parser (`processPending`) strips the marker from the
 * output buffer and reads the trailing digits as the exit code.
 *
 * Exported for unit testing; see `test/exec-async.test.ts`.
 */
export function buildMarkerCommand(shellType: ShellType, marker: string): string {
  if (shellType === 'cmd') {
    return `echo ${marker}%ERRORLEVEL%\n`;
  }
  if (shellType === 'pwsh') {
    return `echo "${marker}$([int](-not $?))"\n`;
  }
  return `printf '${marker}%d\\n' $?\n`;
}

/**
 * Classify the remote shell from the two probe responses captured between
 * `__MCP_PROBE_<uuid>__` markers. The probes are:
 *
 *   1. `echo <m1>$(uname -s 2>/dev/null)` — distinguishes Unix-like shells
 *      from Windows shells.
 *   2. `echo <m2>$Host.Name` — distinguishes cmd.exe from PowerShell.
 *
 * Classification order:
 *   - uname returns `Linux`/`Darwin`/`FreeBSD`/...          → 'posix'
 *   - $Host.Name expands to `ConsoleHost`/`ServerHost`/...   → 'pwsh'
 *   - uname echoes literally / 'is not recognized' AND/OR
 *     $Host.Name echoes as the literal `$Host.Name`           → 'cmd'
 *   - otherwise (both empty / ambiguous)                      → 'posix'
 *
 * 'posix' is the safe fallback because every successfully-running `uname`
 * (including macOS, BSDs, WSL, msys) keeps the legacy behaviour.
 */
export function detectShellTypeFromProbe(unameProbe: string, hostProbe: string): ShellType {
  const uname = unameProbe.trim();
  const host = hostProbe.trim();
  if (/\b(Linux|Darwin|FreeBSD|OpenBSD|NetBSD)\b/i.test(uname)) {
    return 'posix';
  }
  if (/^(ConsoleHost|ServerHost|Visual Studio Code Host|IseHost)$/i.test(host)) {
    return 'pwsh';
  }
  if (
    uname.includes('$(') ||
    /is not recognized/i.test(uname) ||
    host === '$Host.Name'
  ) {
    return 'cmd';
  }
  return 'posix';
}

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
    /**
     * Whether a marker may appear in the output for this pending run.
     * - Non-interactive runs inject the marker at launch → true from the start.
     * - Interactive runs do NOT inject a marker → false until `interrupt()`
     *   re-injects one (which flips this to true).
     * Used to gate buffer trimming in `pushIncrement`: the completion path
     * in `processPending` reads `buffer.slice(0, markerIndex)` AFTER calling
     * `pushIncrement(markerIndex)`, so trim must be skipped whenever a
     * marker could be present.
     */
    markerExpected: boolean;
  } | null = null;

  constructor(
    private readonly shell: { write(data: string, cb?: (err: Error | null | undefined) => void): void },
    options?: { shellType?: ShellType },
  ) {
    this.shellType = options?.shellType ?? 'posix';
  }

  private shellType: ShellType;

  /**
   * Switch the shell flavour used to emit the completion marker. Called by
   * `PersistentSession.ensureConnected` once it has detected whether the
   * remote shell is POSIX (bash/zsh/sh) or Windows (cmd.exe). Changing this
   * mid-session is safe because each `launch` reads `shellType` at the
   * moment the marker is written.
   */
  setShellType(shellType: ShellType): void {
    this.shellType = shellType;
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }

  launch(command: string, callbacks: CommandCallbacks, options?: { interactive?: boolean }): void {
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
      markerExpected: !options?.interactive,
    };
    const commandWithNewline = command.endsWith('\n') ? command : command + '\n';
    this.shell.write(commandWithNewline, (err) => {
      if (err) {
        this.rejectPending(err);
        return;
      }
      if (options?.interactive) {
        return;
      }
      this.shell.write(buildMarkerCommand(this.shellType, marker), (markerErr) => {
        if (markerErr) {
          this.rejectPending(markerErr);
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
      // We just re-injected the marker, so a marker may now appear in
      // subsequent output. Trim is now unsafe (see pending.markerExpected).
      this.pending.markerExpected = true;
      this.shell.write('\n');
      this.shell.write(buildMarkerCommand(this.shellType, this.pending.marker));
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
    // The completion path is only safe when a marker was actually injected
    // for this run (non-interactive launch, or post-interrupt). Otherwise,
    // any `__MCP_DONE__{uuid}__` text that happens to appear in interactive
    // program output (e.g. user-pasted UUIDs) is treated as ordinary data —
    // reaching the completion path here would also trigger `pushIncrement`'s
    // buffer trim with `!markerExpected`, leaving `buffer.slice(0, markerIndex)`
    // to return garbage as `run.output`.
    if (!this.pending.markerExpected) {
      this.pushIncrement(this.buffer.length);
      return;
    }
    const afterMarker = this.buffer.slice(markerIndex + marker.length);
    // Match the exit code as one or more digits immediately after the
    // marker. POSIX `printf '%d\n' $?` ends with a single `\n`; cmd's
    // `echo marker%ERRORLEVEL%` ends with a trailing space (and possibly a
    // `\r\n` that the channel layer has not yet delivered). Accepting the
    // exit code as soon as `\d+` is present lets both formats complete
    // without waiting for a newline that may never arrive over cmd.
    const codeMatch = /^(\d+)/.exec(afterMarker);
    if (!codeMatch) {
      this.pushIncrement(markerIndex);
      return;
    }
    const exitCode = Number.parseInt(codeMatch[1], 10);
    const codeLen = codeMatch[1].length;
    // Consume any trailing whitespace (newline / space / CRLF) so the
    // remainder of `buffer` starts cleanly at the next command's output.
    const trailingMatch = /^[\s\r\n]*/.exec(afterMarker.slice(codeLen));
    const trailingLen = trailingMatch?.[0].length ?? 0;
    const consumedInBuffer = markerIndex + marker.length + codeLen + trailingLen;
    // Flush the pre-marker chunk to the consumer first (pushIncrement in
    // non-interactive mode just advances pushedUntil without trimming the
    // buffer — the marker line itself is protocol data and must not be
    // surfaced as command output).
    this.pushIncrement(markerIndex);
    const output = this.buffer.slice(0, markerIndex).replace(/\r/g, '');
    this.buffer = this.buffer.slice(consumedInBuffer);
    this.pending.pushedUntil = Math.max(0, this.pending.pushedUntil - consumedInBuffer);
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
    // Bound the buffer for runs where no marker is expected (interactive
    // launches that have not been interrupted yet). Safe to trim here
    // because `processPending` can only reach the marker-completion path
    // when `markerExpected` is true, and that path does
    // `this.buffer.slice(0, markerIndex)` *after* this call — if we trimmed
    // while a marker might be present, that slice would return the marker
    // prefix. See `pending.markerExpected`.
    if (!this.pending.markerExpected && upTo > 0) {
      this.buffer = this.buffer.slice(upTo);
      this.pending.pushedUntil = 0;
    }
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

export function formatExecInputResult(run: ExecRun, offset: number): Record<string, unknown> {
  return formatExecLogs(run, offset);
}

export function formatSessionOutput(rawOutput: string, offset: number): Record<string, unknown> {
  const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  return {
    output: rawOutput.slice(safeOffset),
    nextOffset: rawOutput.length,
  };
}

/**
 * Verify the state of an exec run after a synchronous input was delivered
 * via `exec-input`. If the run has transitioned out of `running` to a
 * terminal-failure state (`cancelled` or `failed`), the input text was
 * already written to the shell and may have been executed as a command —
 * the exact risk the `interactive:true` gate exists to prevent. A
 * `completed` state is fine (the program consumed the input and exited
 * normally), and `running` is fine (no race).
 */
export function validateExecInputPostState(run: ExecRun, runId: string): void {
  if (run.state !== 'running' && run.state !== 'completed') {
    throw new McpError(
      ErrorCode.InternalError,
      `Run '${runId}' state changed to '${run.state}' during exec-input; the text was delivered to the shell and may have been executed as a command`,
    );
  }
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
  private sessionOutput = '';
  private shellType: ShellType = 'posix';
  /** True while the initial shell-type probe is in flight. */
  private shellProbeActive = false;
  /** Per-probe marker keys; cleared as responses arrive. */
  private shellProbeUname: string | null = null;
  private shellProbeHost: string | null = null;
  /** Captured response text for each probe (between marker and newline). */
  private probeResponses: { uname?: string; host?: string } = {};
  /** Timeout handle for the shell-type probe fallback (defaults to posix). */
  private shellProbeTimer: NodeJS.Timeout | null = null;
  /** Preserve probe lines that arrive split across SSH data events. */
  private shellProbeBuffer = '';
  /** First commands must wait until shell probing and setup are complete. */
  private shellProbeReady: Promise<void> | null = null;
  private resolveShellProbeReady: (() => void) | null = null;
  private rejectShellProbeReady: ((error: Error) => void) | null = null;

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

  get sessionOutputLength(): number {
    return this.sessionOutput.length;
  }

  getSessionOutput(): string {
    return this.sessionOutput;
  }

  readSessionOutput(offset: number): string {
    return this.sessionOutput.slice(offset);
  }

  writeInput(text: string): void {
    if (!this.shell) {
      throw new McpError(ErrorCode.InternalError, 'SSH shell not ready');
    }
    if (this.commandQueue?.hasPending) {
      throw new McpError(ErrorCode.InternalError, 'Another command is still running in this session');
    }
    this.shell.write(text);
    this.resetInactivityTimer();
  }

  private onSessionData(data: string): void {
    this.sessionOutput += data;
    if (this.sessionOutput.length > 1024 * 1024) {
      this.sessionOutput = this.sessionOutput.slice(this.sessionOutput.length - 1024 * 1024);
    }
    this.commandQueue?.handleData(data);
  }

  /**
   * Route shell output. While the initial shell-type probe is in flight the
   * raw data is also fed into the probe handler so we can decide whether the
   * remote is POSIX / cmd / PowerShell before any user-visible command
   * runs. After the probe resolves, behaves identically to `onSessionData`.
   */
  private handleShellData(data: string): void {
    if (this.shellProbeActive) {
      const captured = this.consumeProbeResponses(data);
      if (captured.before) {
        this.onSessionData(captured.before);
      }
      if (captured.complete) {
        this.finaliseShellTypeProbe(
          detectShellTypeFromProbe(
            this.probeResponses.uname ?? '',
            this.probeResponses.host ?? '',
          ),
        );
      }
      return;
    }
    this.onSessionData(data);
  }

  /**
   * Scan complete lines from the probe buffer and record marker responses.
   * SSH data events do not preserve line boundaries, so a marker or response
   * may be split across multiple chunks. Incomplete lines remain buffered
   * until the next event instead of being forwarded or discarded.
   */
  private consumeProbeResponses(data: string): { before: string; complete: boolean } {
    this.shellProbeBuffer += data;
    let before = '';
    while (true) {
      const lineEnd = this.shellProbeBuffer.indexOf('\n');
      if (lineEnd === -1) break;
      const line = this.shellProbeBuffer.slice(0, lineEnd).replace(/\r$/, '');
      this.shellProbeBuffer = this.shellProbeBuffer.slice(lineEnd + 1);

      const unameIndex = this.shellProbeUname ? line.indexOf(this.shellProbeUname) : -1;
      const hostIndex = this.shellProbeHost ? line.indexOf(this.shellProbeHost) : -1;
      const markerIndex = unameIndex !== -1 && (hostIndex === -1 || unameIndex < hostIndex)
        ? unameIndex
        : hostIndex;
      const markerKey = markerIndex === unameIndex ? this.shellProbeUname : this.shellProbeHost;

      if (markerIndex === -1 || !markerKey) {
        before += `${line}\n`;
        continue;
      }

      const prefix = line.slice(0, markerIndex);
      // PTY echo often returns the probe command itself before its output.
      // Ignore that copy; otherwise the literal `$(uname ...)` or
      // `$Host.Name` from the command would be mistaken for the response.
      if (/(?:^|[>$#])\s*echo\s+$/i.test(prefix)) {
        continue;
      }
      before += prefix;
      const response = line.slice(markerIndex + markerKey.length);
      if (markerKey === this.shellProbeUname) {
        this.probeResponses.uname = response;
        this.shellProbeUname = null;
      } else {
        this.probeResponses.host = response;
        this.shellProbeHost = null;
      }

      if (!this.shellProbeUname && !this.shellProbeHost) {
        before += this.shellProbeBuffer;
        this.shellProbeBuffer = '';
        return { before, complete: true };
      }
    }
    return { before, complete: false };
  }

  private beginShellTypeProbe(): void {
    this.shellProbeUname = `__MCP_PROBE_UNAME_${randomUUID()}__`;
    this.shellProbeHost = `__MCP_PROBE_HOST_${randomUUID()}__`;
    this.probeResponses = {};
    this.shellProbeBuffer = '';
    this.shellProbeActive = true;
    this.shellProbeReady = new Promise<void>((resolve, reject) => {
      this.resolveShellProbeReady = resolve;
      this.rejectShellProbeReady = reject;
    });
    // Two probes:
    //  - `uname -s` distinguishes Unix-like shells from Windows shells.
    //  - `$Host.Name` (only PowerShell expands) distinguishes cmd from pwsh.
    this.shell?.write(`echo ${this.shellProbeUname}$(uname -s 2>/dev/null)\n`);
    this.shell?.write(`echo ${this.shellProbeHost}$Host.Name\n`);
    // 1.5 s fallback so a slow or noisy shell does not block first command.
    this.shellProbeTimer = setTimeout(() => {
      if (this.shellProbeActive) {
        this.finaliseShellTypeProbe('posix');
      }
    }, 1500);
  }

  private finaliseShellTypeProbe(detected: ShellType): void {
    if (!this.shellProbeActive) {
      return;
    }
    this.shellType = detected;
    this.commandQueue?.setShellType(detected);
    this.shellProbeActive = false;
    this.shellProbeUname = null;
    this.shellProbeHost = null;
    this.shellProbeBuffer = '';
    if (this.shellProbeTimer) {
      clearTimeout(this.shellProbeTimer);
      this.shellProbeTimer = null;
    }
    this.applyShellSetup(detected);
    this.resolveShellProbeReady?.();
    this.resolveShellProbeReady = null;
    this.rejectShellProbeReady = null;
  }

  /**
   * Emit shell-specific PS1 / prompt cleanup commands. POSIX uses
   * `export PS1=""` to silence the prompt and `stty -echo` to suppress
   * terminal echo of typed input. cmd.exe does not understand either
   * command, so we skip setup entirely and let the default cmd prompt
   * and echo behaviour stand. PowerShell uses `function prompt { '' }`
   * to override the default prompt with an empty string.
   */
  private applyShellSetup(shellType: ShellType): void {
    if (!this.shell) {
      return;
    }
    if (shellType === 'posix') {
      this.shell.write('export PS1=""\n');
      this.shell.write('stty -echo 2>/dev/null\n');
    } else if (shellType === 'pwsh') {
      this.shell.write("function prompt { '' }\n");
    }
    // For 'cmd' we intentionally write nothing: cmd.exe's default prompt
    // and echo behaviour are left in place so the first user command is
    // not preceded by an 'is not recognized' error.
  }

  async ensureConnected(): Promise<void> {
    if (this.disposed) {
      throw new McpError(ErrorCode.InternalError, `Session ${this.id} has been disposed`);
    }
    if (this.conn && this.shell) {
      if (this.shellProbeReady) {
        await this.shellProbeReady;
      }
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
          this.handleShellData(data);
        });
        stream.on('close', () => {
          this.commandQueue?.handleClose();
          this.cleanup();
        });
        stream.stderr?.on('data', (data: string) => {
          this.onSessionData(data);
        });

        // Defer session-output routing for the in-flight probe chunk so it
        // doesn't bleed into the user-visible session output buffer.
        this.beginShellTypeProbe();
        resolve();
      });
    });

    if (this.shellProbeReady) {
      await this.shellProbeReady;
    }

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

  launch(command: string, callbacks: CommandCallbacks, options?: { interactive?: boolean }): void {
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
    }, options);
    this.lastCommand = command;
    this.resetInactivityTimer();
  }

  sendInput(text: string): void {
    if (!this.commandQueue) {
      throw new McpError(ErrorCode.InternalError, 'SSH shell not ready');
    }
    this.commandQueue.sendInput(text);
    this.resetInactivityTimer();
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
    if (this.shellProbeActive) {
      this.shellProbeActive = false;
      this.shellProbeUname = null;
      this.shellProbeHost = null;
      this.shellProbeBuffer = '';
      if (this.shellProbeTimer) {
        clearTimeout(this.shellProbeTimer);
        this.shellProbeTimer = null;
      }
      this.rejectShellProbeReady?.(error ?? new Error('SSH session closed during shell detection'));
      this.resolveShellProbeReady = null;
      this.rejectShellProbeReady = null;
    }
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
    this.sessionOutput = '';

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
      kind: 'server',
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

export class FileTransfer {
  private state: TransferState = 'pending';
  private transferredBytes = 0;
  private totalBytes: number | null = null;
  private error: string | null = null;
  private readonly createdAt = Date.now();
  private finishedAt: number | null = null;
  private cancelled = false;
  private disposed = false;
  private streams: Array<NodeJS.ReadableStream | NodeJS.WritableStream> = [];
  private partPath: string;
  private readonly chunkThreads: number;
  private readonly chunkSize: number;
  private readonly chunkThreshold: number;
  private readonly parallelConnectionFactory?: ParallelSftpConnectionFactory;
  private readonly parallelConnections = new Set<SftpConnection>();
  private readonly rejectRemoteSymlinks: boolean;
  private readonly rejectLocalSymlinks: boolean;
  private chunked = false;

  constructor(
    private readonly id: string,
    private readonly hostId: string,
    private readonly localPath: string,
    private readonly remotePath: string,
    private readonly direction: 'download' | 'upload',
    private conns: SftpConnection,
    options?: { chunkThreads?: number; chunkSize?: number; chunkThreshold?: number; parallelConnectionFactory?: ParallelSftpConnectionFactory; rejectRemoteSymlinks?: boolean; rejectLocalSymlinks?: boolean },
  ) {
    this.chunkThreads = Math.max(1, Math.floor(options?.chunkThreads ?? 4));
    this.chunkSize = options?.chunkSize ?? 8 * 1024 * 1024;
    this.chunkThreshold = options?.chunkThreshold ?? DEFAULT_CHUNK_THRESHOLD_BYTES;
    this.parallelConnectionFactory = options?.parallelConnectionFactory;
    this.rejectRemoteSymlinks = options?.rejectRemoteSymlinks ?? false;
    this.rejectLocalSymlinks = options?.rejectLocalSymlinks ?? false;
    this.partPath = direction === 'download'
      ? partPathFor(localPath)
      : partPathFor(remotePath);
    conns.conn.once?.('error', (error: Error) => this.markFailed(error.message));
    conns.conn.once?.('end', () => this.markFailed('SSH connection ended'));
    conns.conn.once?.('close', () => this.markFailed('SSH connection closed'));
    for (const jumpConn of conns.jumpConns) {
      jumpConn.once?.('error', (error: Error) => this.markFailed(error.message));
      jumpConn.once?.('end', () => this.markFailed('Jump connection ended'));
    }
  }

  async start(): Promise<void> {
    if (this.disposed) {
      throw new McpError(ErrorCode.InternalError, `Transfer ${this.id} has been disposed`);
    }
    this.state = 'running';
    try {
      if (this.direction === 'download') {
        await this.runDownload();
      } else {
        await this.runUpload();
      }
    } catch (error: any) {
      if (!this.cancelled) this.finish('failed', errorMessage(error));
    }
  }

  getInfo(): TransferInfo {
    const percent = this.totalBytes && this.totalBytes > 0
      ? Math.min(100, Math.round((this.transferredBytes / this.totalBytes) * 100))
      : null;
    const download = this.direction === 'download';
    return {
      id: this.id,
      mode: 'single',
      kind: this.direction,
      state: this.state,
      sourceHost: download ? this.hostId : 'local',
      sourcePath: download ? this.remotePath : this.localPath,
      targetHost: download ? 'local' : this.hostId,
      targetPath: download ? this.localPath : this.remotePath,
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
    if (this.direction === 'upload' && this.chunked && this.conns) {
      // A cancelled chunked upload may have a sparse (multi-segment) .part;
      // remove it while the SFTP channel is still alive so a re-run does not
      // resume from a holey prefix and fail its sha256 check forever. Linear
      // uploads keep their .part as a valid resume point. dispose() closes the
      // channel below, so this must happen before finish() -> dispose().
      await new Promise<void>((resolve) => this.conns.sftp.unlink(this.partPath, () => resolve()));
    }
    this.finish('cancelled', null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const stream of this.streams) (stream as any).destroy();
    this.closeParallelConnections();
    closeSftpConnection(this.conns);
    this.streams = [];
    this.conns = null as any;
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

  private async runDownload(): Promise<void> {
    this.transferredBytes = 0;
    this.totalBytes = null;
    const stats = this.rejectRemoteSymlinks
      ? await sftpLstat(this.conns.sftp, this.remotePath)
      : await sftpStat(this.conns.sftp, this.remotePath);
    if (this.disposed || this.cancelled) {
      throw new Error('transfer cancelled');
    }
    if (stats.isDirectory()) {
      throw new Error('download supports single files only; remote source is a directory');
    }
    if (this.rejectRemoteSymlinks && stats.isSymbolicLink()) {
      throw new Error(`Remote path '${this.remotePath}' is a symlink; refusing to follow it`);
    }
    this.totalBytes = stats.size;
    let partSize: number | null = null;
    try {
      const partStats = await (this.rejectLocalSymlinks ? lstat(this.partPath) : stat(this.partPath));
      if (this.rejectLocalSymlinks && partStats.isSymbolicLink()) {
        throw new Error(`Local partial path '${this.partPath}' is a symlink; refusing to follow it`);
      }
      partSize = partStats.size;
    } catch (error: any) {
      if (!isMissingPathError(error)) throw error;
      partSize = null;
    }
    const offset = resolveResumeOffset(partSize, stats.size);
    if (partSize !== null && partSize > stats.size) {
      await rm(this.partPath, { force: true });
      partSize = null;
    }
    if (offset === stats.size && partSize === null && stats.size === 0) {
      await writeFile(this.partPath, '');
    }
    this.transferredBytes = offset;
    if (offset < stats.size) {
      const segs = shouldUseChunking(stats.size, offset, this.chunkThreshold, this.chunkThreads)
        ? chunkSegments(stats.size, offset, this.chunkSize, this.chunkThreads)
        : [];
      if (segs.length > 1) {
        try {
          await this.downloadChunks(segs);
        } catch (error) {
          await rm(this.partPath, { force: true });
          throw error;
        }
        if (this.disposed || this.cancelled) {
          await rm(this.partPath, { force: true });
          throw new Error('transfer cancelled');
        }
      } else {
        if (this.rejectLocalSymlinks) {
          try {
            const existingPart = await lstat(this.partPath);
            if (existingPart.isSymbolicLink()) {
              throw new Error(`Local partial path '${this.partPath}' is a symlink; refusing to follow it`);
            }
          } catch (error: any) {
            if (!isMissingPathError(error)) throw error;
          }
        }
        const read = this.conns.sftp.createReadStream(this.remotePath, { start: offset });
        const write = createWriteStream(this.partPath, { flags: offset > 0 ? 'a' : 'w' });
        this.streams = [read, write];
        if (this.cancelled || this.disposed) {
          read.destroy();
          write.destroy();
          throw new Error('transfer cancelled');
        }
        read.on('data', (chunk: Buffer) => {
          this.transferredBytes += chunk.length;
        });
        read.pipe(write);
        await this.awaitStreams(read, write);
      }
    }
    if (this.disposed || this.cancelled) {
      throw new Error('transfer cancelled');
    }
    const partStats = await (this.rejectLocalSymlinks ? lstat(this.partPath) : stat(this.partPath));
    if (this.rejectLocalSymlinks && partStats.isSymbolicLink()) {
      throw new Error(`Local partial path '${this.partPath}' is a symlink; refusing to follow it`);
    }
    if (partStats.size !== stats.size) {
      throw new Error(`size mismatch: expected ${stats.size}, got ${partStats.size}`);
    }
    const partHash = await sha256File(this.partPath);
    const remoteHash = await sha256Remote(this.conns.sftp, this.remotePath);
    if (partHash !== remoteHash) {
      throw new Error(`sha256 mismatch: expected ${remoteHash}, got ${partHash}`);
    }
    if (this.rejectLocalSymlinks) {
      try {
        const existingTarget = await lstat(this.localPath);
        if (existingTarget.isSymbolicLink()) {
          throw new Error(`Local destination '${this.localPath}' is a symlink; refusing to replace it`);
        }
      } catch (error: any) {
        if (!isMissingPathError(error)) throw error;
      }
    }
    await rename(this.partPath, this.localPath);
    this.complete();
  }

  private async runUpload(): Promise<void> {
    this.transferredBytes = 0;
    this.totalBytes = null;
    const localStats = await (this.rejectLocalSymlinks ? lstat(this.localPath) : stat(this.localPath));
    if (this.disposed || this.cancelled) {
      throw new Error('transfer cancelled');
    }
    if (!localStats.isFile()) {
      throw new Error('upload source is not a file');
    }
    if (this.rejectLocalSymlinks && localStats.isSymbolicLink()) {
      throw new Error(`Local source '${this.localPath}' is a symlink; refusing to follow it`);
    }
    this.totalBytes = localStats.size;
    await ensureRemoteParentDirectory(this.conns.sftp, this.remotePath, this.rejectRemoteSymlinks);
    if (this.disposed || this.cancelled) {
      throw new Error('transfer cancelled');
    }
    let partSize: number | null = null;
    try {
      const partStats = this.rejectRemoteSymlinks
        ? await sftpLstat(this.conns.sftp, this.partPath)
        : await sftpStat(this.conns.sftp, this.partPath);
      if (this.rejectRemoteSymlinks && partStats.isSymbolicLink()) {
        throw new Error(`Remote partial path '${this.partPath}' is a symlink; refusing to follow it`);
      }
      partSize = partStats.size;
    } catch (error: any) {
      if (!isMissingPathError(error)) throw error;
      partSize = null;
    }
    const offset = resolveResumeOffset(partSize, localStats.size);
    if (partSize !== null && partSize > localStats.size) {
      await this.removeRemotePart();
    }
    this.transferredBytes = offset;
    const segs = shouldUseChunking(localStats.size, offset, this.chunkThreshold, this.chunkThreads)
      ? chunkSegments(localStats.size, offset, this.chunkSize, this.chunkThreads)
      : [];
    if (segs.length > 1) {
      this.chunked = true;
      try {
        await this.uploadChunks(segs);
      } catch (error) {
        if (this.conns) {
          await this.removeRemotePart();
        }
        throw error;
      }
      if (this.disposed || this.cancelled) {
        if (this.conns) {
          await this.removeRemotePart();
        }
        throw new Error('transfer cancelled');
      }
    } else {
      await this.uploadWithOffset(this.localPath, this.partPath, offset);
    }
    if (this.disposed || this.cancelled) {
      throw new Error('transfer cancelled');
    }
    const remoteStats = await sftpStat(this.conns.sftp, this.partPath);
    if (remoteStats.size !== localStats.size) {
      throw new Error(`size mismatch: expected ${localStats.size}, got ${remoteStats.size}`);
    }
    const localHash = await sha256File(this.localPath);
    const remoteHash = await sha256Remote(this.conns.sftp, this.partPath);
    if (localHash !== remoteHash) {
      throw new Error(`sha256 mismatch: expected ${localHash}, got ${remoteHash}`);
    }
    await sftpRename(this.conns.sftp, this.partPath, this.remotePath);
    this.complete();
  }

  private async uploadWithOffset(localPath: string, remotePartPath: string, offset: number): Promise<void> {
    const handle = await new Promise<Buffer>((resolve, reject) => {
      this.conns.sftp.open(remotePartPath, offset > 0 ? 'a' : 'w', (err, h) => err ? reject(err) : resolve(h));
    });
    try {
      const localRead = createReadStream(localPath, { start: offset });
      this.streams = [localRead];
      localRead.on('data', (chunk: string | Buffer) => {
        this.transferredBytes += chunk.length;
      });
      let position = offset;
      let streamEnded = false;
      let pendingWrites = 0;
      let writeError: Error | null = null;
      await new Promise<void>((resolve, reject) => {
        const maybeResolve = () => {
          if (streamEnded && pendingWrites === 0 && !writeError) {
            resolve();
          }
        };
        localRead.on('error', (err: Error) => {
          writeError = err;
          reject(err);
        });
        localRead.on('close', () => {
          streamEnded = true;
          if (writeError) return;
          maybeResolve();
        });
        localRead.on('end', () => {
          streamEnded = true;
          if (writeError) return;
          maybeResolve();
        });
        const MAX_INFLIGHT = 64;
        localRead.on('data', (chunk: string | Buffer) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          pendingWrites += 1;
          this.conns.sftp.write(handle, buf, 0, buf.length, position, (err) => {
            pendingWrites -= 1;
            if (err) {
              writeError = err;
              localRead.destroy();
              reject(err);
              return;
            }
            if (pendingWrites < MAX_INFLIGHT) {
              localRead.resume();
            }
            maybeResolve();
          });
          position += buf.length;
          if (pendingWrites >= MAX_INFLIGHT) {
            localRead.pause();
          }
        });
      });
    } finally {
      if (this.conns) {
        await new Promise<void>((resolve) => this.conns.sftp.close(handle, () => resolve()));
      }
    }
  }

  private awaitStreams(read: NodeJS.ReadableStream, write: NodeJS.WritableStream): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const once = (fn: (...args: any[]) => void) => (...args: any[]) => { if (!settled) { settled = true; fn(...args); } };
      (write as any).on('finish', once(resolve));
      (write as any).on('close', once(resolve));
      (read as any).on('error', once((error: Error) => reject(error)));
      (write as any).on('error', once((error: Error) => reject(error)));
    });
  }

  private async openChunkConnections(count: number): Promise<SftpConnection[]> {
    const connections = [this.conns];
    const factory = this.parallelConnectionFactory;
    if (!factory) return connections;
    const results = await Promise.allSettled(
      Array.from({ length: Math.max(0, count - 1) }, () => factory()),
    );
    const extras: SftpConnection[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        extras.push(result.value);
      }
    }
    for (const connection of extras) {
      this.parallelConnections.add(connection);
      connections.push(connection);
    }
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) {
      // allSettled ensures every factory has finished before cleanup, so no
      // late-resolving connection can escape the set and leak after failure.
      this.closeParallelConnections();
      throw rejected.reason;
    }
    try {
      if (this.disposed || this.cancelled) {
        this.closeParallelConnections();
        throw new Error('transfer cancelled');
      }
      return connections;
    } catch (error) {
      this.closeParallelConnections();
      throw error;
    }
  }

  private closeParallelConnections(): void {
    for (const connection of this.parallelConnections) {
      try {
        closeSftpConnection(connection);
      } catch {
        // Best-effort cleanup for connections that may already be closed.
      }
    }
    this.parallelConnections.clear();
  }

  private openRemoteFile(sftp: SFTPWrapper, path: string, flags: OpenMode): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      sftp.open(path, flags, (err, handle) => err ? reject(err) : resolve(handle));
    });
  }

  private closeRemoteFile(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
    return new Promise((resolve) => sftp.close(handle, () => resolve()));
  }

  private async downloadChunks(segs: Array<{ start: number; end: number }>): Promise<void> {
    const fd = await open(this.partPath, 'w');
    const reads: Array<NodeJS.ReadableStream> = [];
    try {
      const connections = await this.openChunkConnections(segs.length);
      const tasks = segs.map(async (seg, index) => {
        const read = connections[index % connections.length].sftp.createReadStream(this.remotePath, { start: seg.start, end: seg.end - 1 });
        reads.push(read);
        this.streams.push(read);
        let position = seg.start;
        let streamEnded = false;
        let pendingWrites = 0;
        let writeError: Error | null = null;
        const MAX_INFLIGHT = 64;
        await new Promise<void>((resolve, reject) => {
          const maybeResolve = () => {
            if (streamEnded && pendingWrites === 0 && !writeError) {
              resolve();
            }
          };
          read.on('error', (err: Error) => {
            writeError = err;
            reject(err);
          });
          read.on('close', () => {
            streamEnded = true;
            if (writeError) return;
            maybeResolve();
          });
          read.on('end', () => {
            streamEnded = true;
            if (writeError) return;
            maybeResolve();
          });
          read.on('data', (chunk: string | Buffer) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            pendingWrites += 1;
            this.transferredBytes += buf.length;
            const pos = position;
            position += buf.length;
            void fd.write(buf, 0, buf.length, pos).then(
              () => {
                pendingWrites -= 1;
                if (pendingWrites < MAX_INFLIGHT) {
                  read.resume();
                }
                maybeResolve();
              },
              (err: Error) => {
                pendingWrites -= 1;
                writeError = err;
                read.destroy();
                reject(err);
              },
            );
            if (pendingWrites >= MAX_INFLIGHT) {
              read.pause();
            }
          });
        });
      });
      try {
        await Promise.all(tasks);
      } catch (error) {
        reads.forEach((read) => (read as any).destroy());
        await Promise.allSettled(tasks);
        throw error;
      }
    } catch (err) {
      throw err;
    } finally {
      await fd.close();
      this.closeParallelConnections();
    }
  }

  private async uploadChunks(segs: Array<{ start: number; end: number }>): Promise<void> {
    const reads: Array<NodeJS.ReadableStream> = [];
    try {
      const connections = await this.openChunkConnections(segs.length);
      const primarySftp = this.conns.sftp;
      const initialHandle = await this.openRemoteFile(primarySftp, this.partPath, 'w');
      await this.closeRemoteFile(primarySftp, initialHandle);
      const tasks = segs.map(async (seg, index) => {
        const sftp = connections[index % connections.length].sftp;
        const handle = await this.openRemoteFile(sftp, this.partPath, 'r+');
        try {
          const localRead = createReadStream(this.localPath, { start: seg.start, end: seg.end - 1 });
          reads.push(localRead);
          this.streams.push(localRead);
          let position = seg.start;
          let streamEnded = false;
          let pendingWrites = 0;
          let writeError: Error | null = null;
          const MAX_INFLIGHT = 64;
          await new Promise<void>((resolve, reject) => {
            const maybeResolve = () => {
              if (streamEnded && pendingWrites === 0 && !writeError) {
                resolve();
              }
            };
            localRead.on('error', (err: Error) => {
              writeError = err;
              reject(err);
            });
            localRead.on('close', () => {
              streamEnded = true;
              if (writeError) return;
              maybeResolve();
            });
            localRead.on('end', () => {
              streamEnded = true;
              if (writeError) return;
              maybeResolve();
            });
            localRead.on('data', (chunk: string | Buffer) => {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              pendingWrites += 1;
              this.transferredBytes += buf.length;
              const pos = position;
              position += buf.length;
              sftp.write(handle, buf, 0, buf.length, pos, (err) => {
                pendingWrites -= 1;
                if (err) {
                  writeError = err;
                  localRead.destroy();
                  reject(err);
                  return;
                }
                if (pendingWrites < MAX_INFLIGHT) {
                  localRead.resume();
                }
                maybeResolve();
              });
              if (pendingWrites >= MAX_INFLIGHT) {
                localRead.pause();
              }
            });
          });
        } finally {
          if (!this.disposed) {
            await this.closeRemoteFile(sftp, handle);
          }
        }
      });
      try {
        await Promise.all(tasks);
      } catch (error) {
        reads.forEach((read) => (read as any).destroy());
        await Promise.allSettled(tasks);
        throw error;
      }
    } catch (err) {
      throw err;
    } finally {
      this.closeParallelConnections();
    }
  }

  private async removeRemotePart(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.conns.sftp.unlink(this.partPath, () => resolve());
    });
  }
}

export class DirectoryTransfer {
  private state: TransferState = 'pending';
  private transferredBytes = 0;
  private totalBytes: number | null = null;
  private filesDone = 0;
  private filesTotal = 0;
  private error: string | null = null;
  private readonly createdAt = Date.now();
  private finishedAt: number | null = null;
  private cancelled = false;
  private disposed = false;
  private readonly subTransfers = new Set<FileTransfer>();

  constructor(
    private readonly id: string,
    private readonly hostId: string,
    private readonly sourcePath: string,
    private readonly targetPath: string,
    private readonly direction: 'download-dir' | 'upload-dir',
    private conns: SftpConnection,
    options?: {
      concurrency?: number;
      chunkThreads?: number;
      chunkSize?: number;
      chunkThreshold?: number;
      parallelConnectionFactory?: ParallelSftpConnectionFactory;
    },
  ) {
    this.concurrency = Math.max(1, options?.concurrency ?? 4);
    this.chunkThreads = resolveDirectoryChunkThreads(this.concurrency, options?.chunkThreads ?? 4);
    this.chunkSize = options?.chunkSize ?? 8 * 1024 * 1024;
    this.chunkThreshold = options?.chunkThreshold ?? DEFAULT_CHUNK_THRESHOLD_BYTES;
    this.parallelConnectionFactory = options?.parallelConnectionFactory;
    conns.conn.once?.('error', (error: Error) => this.markFailed(error.message));
    conns.conn.once?.('end', () => this.markFailed('SSH connection ended'));
    conns.conn.once?.('close', () => this.markFailed('SSH connection closed'));
    for (const jumpConn of conns.jumpConns) {
      jumpConn.once?.('error', (error: Error) => this.markFailed(error.message));
      jumpConn.once?.('end', () => this.markFailed('Jump connection ended'));
    }
  }

  private readonly concurrency: number;
  private readonly chunkThreads: number;
  private readonly chunkSize: number;
  private readonly chunkThreshold: number;
  private readonly parallelConnectionFactory?: ParallelSftpConnectionFactory;

  async start(): Promise<void> {
    if (this.disposed) {
      throw new McpError(ErrorCode.InternalError, `Transfer ${this.id} has been disposed`);
    }
    this.state = 'running';
    try {
      if (this.direction === 'upload-dir') {
        await ensureLocalDirectoryRoot(this.targetPath);
      }
      const entries = this.direction === 'upload-dir'
        ? await this.listLocalFiles(this.targetPath)
        : await this.listFiles(this.sourcePath);
      const { filesTotal, totalBytes } = dirEntriesToTotal(entries);
      this.filesTotal = filesTotal;
      this.totalBytes = totalBytes;
      if (this.direction === 'download-dir') {
        await ensureLocalDirectoryRoot(this.targetPath);
      } else {
        await ensureRemoteParentDirectory(this.conns.sftp, posixPath.join(this.sourcePath, '.mkdir'), true);
      }
      await this.runConcurrent(entries);
      if (this.disposed || this.cancelled) {
        throw new Error('transfer cancelled');
      }
      this.complete();
    } catch (error: any) {
      if (!this.cancelled) this.finish('failed', errorMessage(error));
    }
  }

  private async runConcurrent(entries: DirEntry[]): Promise<void> {
    const workers = Math.min(Math.max(1, this.concurrency), Math.max(1, entries.length));
    let index = 0;
    let doneBytes = 0;
    let failed = false;
    let failure: unknown;
    const worker = async () => {
      while (true) {
        if (failed || this.disposed || this.cancelled) {
          throw new Error('transfer cancelled');
        }
        const i = index;
        index += 1;
        if (i >= entries.length) break;
        try {
          const entry = entries[i];
          const relPath = entry.relPath;
          const source = this.direction === 'download-dir'
            ? posixPath.join(this.sourcePath, relPath)
            : posixPath.join(this.targetPath, relPath);
          const target = this.direction === 'download-dir'
            ? posixPath.join(this.targetPath, relPath)
            : posixPath.join(this.sourcePath, relPath);
          if (entry.isDir) {
            if (this.direction === 'download-dir') {
              await ensureLocalDirectoryPath(this.targetPath, target);
            } else {
              await ensureRemoteParentDirectory(this.conns.sftp, posixPath.join(target, '.mkdir'), true);
            }
            continue;
          }
          if (this.direction === 'download-dir') {
            await ensureLocalDirectoryPath(this.targetPath, posixPath.dirname(target));
          }
          const skipped = await this.maybeSkip(entry, source, target);
          if (skipped) {
            doneBytes += entry.size;
            this.filesDone += 1;
            this.transferredBytes = doneBytes;
            continue;
          }
          if (failed || this.disposed || this.cancelled) {
            throw new Error('transfer cancelled');
          }
          const transferred = await this.transferOne(source, target, entry.size);
          doneBytes += transferred;
          this.filesDone += 1;
          this.transferredBytes = doneBytes;
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
            await this.cancelSubTransfers();
          }
          throw error;
        }
      }
    };
    const pool = Array.from({ length: workers }, () => worker());
    await Promise.allSettled(pool);
    if (failed) throw failure;
  }

  private async listFiles(rootPath: string): Promise<DirEntry[]> {
    const rootStats = await sftpLstat(this.conns.sftp, rootPath);
    if (rootStats.isSymbolicLink()) {
      throw new McpError(ErrorCode.InvalidParams, `Remote path '${rootPath}' is a symlink; refusing to follow it for download`);
    }
    const out: DirEntry[] = [];
    const walk = async (dirPath: string, relDir: string) => {
      const handle = await new Promise<Buffer>((resolve, reject) => {
        this.conns.sftp.opendir(dirPath, (err, h) => err ? reject(err) : resolve(h));
      });
      try {
        let list: any[] = [];
        while (true) {
          const page = await new Promise<any[]>((resolve, reject) => {
            this.conns.sftp.readdir(handle, (err, l) => {
              if (err && (err as any).code === 1) { resolve([]); return; }
              if (err) { reject(err); return; }
              resolve(l ?? []);
            });
          });
          if (page.length === 0) break;
          list = list.concat(page);
        }
        for (const item of list) {
          const name = item.filename;
          if (name === '.' || name === '..') continue;
          if (item.attrs.isSymbolicLink()) {
            // Never follow remote symlinks: they may point outside the tree.
            // The download manifest must contain only real files and dirs.
            continue;
          }
          const relPath = relDir ? `${relDir}/${name}` : name;
          if (item.attrs.isDirectory()) {
            out.push({ relPath, size: 0, isDir: true });
            if (out.length > MAX_DIRECTORY_ENTRIES) {
              throw new McpError(ErrorCode.InvalidParams, `Directory contains more than ${MAX_DIRECTORY_ENTRIES} entries`);
            }
            await walk(`${dirPath}/${name}`, relPath);
          } else {
            out.push({ relPath, size: item.attrs.size ?? 0 });
            if (out.length > MAX_DIRECTORY_ENTRIES) {
              throw new McpError(ErrorCode.InvalidParams, `Directory contains more than ${MAX_DIRECTORY_ENTRIES} entries`);
            }
          }
        }
      } finally {
        await new Promise<void>((resolve) => this.conns.sftp.close(handle, () => resolve()));
      }
    };
    await walk(rootPath, '');
    return out;
  }

  private async listLocalFiles(rootPath: string): Promise<DirEntry[]> {
    const out: DirEntry[] = [];
    const walk = async (dirPath: string, relDir: string) => {
      let dirents: import('fs').Dirent[];
      try {
        dirents = await readdir(dirPath, { withFileTypes: true });
      } catch (error: any) {
        throw new McpError(ErrorCode.InvalidParams, `Local directory '${dirPath}' cannot be read: ${error.message}`);
      }
      for (const dirent of dirents) {
        const name = dirent.name;
        const relPath = relDir ? `${relDir}/${name}` : name;
        const fullPath = posixPath.join(dirPath, name);
        if (dirent.isDirectory()) {
          out.push({ relPath, size: 0, isDir: true });
          if (out.length > MAX_DIRECTORY_ENTRIES) {
            throw new McpError(ErrorCode.InvalidParams, `Directory contains more than ${MAX_DIRECTORY_ENTRIES} entries`);
          }
          await walk(fullPath, relPath);
        } else if (dirent.isFile()) {
          const st = await stat(fullPath);
          out.push({ relPath, size: st.size });
          if (out.length > MAX_DIRECTORY_ENTRIES) {
            throw new McpError(ErrorCode.InvalidParams, `Directory contains more than ${MAX_DIRECTORY_ENTRIES} entries`);
          }
        }
      }
    };
    await walk(rootPath, '');
    return out;
  }

  private async maybeSkip(entry: DirEntry, sourcePath: string, targetPath: string): Promise<boolean> {
    if (this.direction === 'download-dir') {
      try {
        const localStats = await lstat(targetPath);
        if (localStats.isSymbolicLink()) {
          return false;
        }
        const localHash = await sha256File(targetPath);
        const remoteHash = await sha256Remote(this.conns.sftp, sourcePath);
        return resolveDirSkip(entry, localStats.size, localHash, remoteHash);
      } catch {
        return false;
      }
    }
    try {
      const remoteStats = await sftpStat(this.conns.sftp, targetPath);
      const localHash = await sha256File(sourcePath);
      const remoteHash = await sha256Remote(this.conns.sftp, targetPath);
      return resolveDirSkip(entry, remoteStats.size, localHash, remoteHash);
    } catch {
      return false;
    }
  }

  private async transferOne(sourcePath: string, targetPath: string, size: number): Promise<number> {
    const download = this.direction === 'download-dir';
    // Sub-transfers share the parent's SFTP connection; the parent owns the
    // lifecycle (error/end/close handling, final dispose). Shadow listener
    // registration and end() so each FileTransfer neither closes the shared
    // connection nor accumulates redundant listeners on it.
    const subProxy = (target: any) => new Proxy(target, {
      get(t, prop) {
        if (prop === 'end') return () => {};
        if (prop === 'once' || prop === 'on' || prop === 'addListener'
            || prop === 'prependListener' || prop === 'removeListener'
            || prop === 'removeAllListeners') {
          return () => {};
        }
        const v = Reflect.get(t, prop);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const ft = new FileTransfer(
      `sub-${this.id}`,
      this.hostId,
      download ? targetPath : sourcePath,
      download ? sourcePath : targetPath,
      download ? 'download' : 'upload',
      {
        conn: subProxy(this.conns.conn),
        jumpConns: [],
        sftp: subProxy(this.conns.sftp),
      } as any,
      {
        chunkThreads: this.chunkThreads,
        chunkSize: this.chunkSize,
        chunkThreshold: this.chunkThreshold,
        parallelConnectionFactory: this.parallelConnectionFactory,
        rejectRemoteSymlinks: true,
        rejectLocalSymlinks: this.direction === 'download-dir',
      },
    );
    this.subTransfers.add(ft);
    try {
      await ft.start();
      const info = ft.getInfo();
      if (info.state !== 'completed') {
        throw new Error(info.error ?? 'file transfer failed');
      }
      return size;
    } finally {
      this.subTransfers.delete(ft);
    }
  }

  private async cancelSubTransfers(): Promise<void> {
    await Promise.all([...this.subTransfers].map(async (transfer) => {
      try {
        await transfer.cancel();
      } catch {
        // A sibling may have completed between the snapshot and cancellation.
      }
    }));
  }

  getInfo(): TransferInfo {
    const percent = this.totalBytes && this.totalBytes > 0
      ? Math.min(100, Math.round((this.transferredBytes / this.totalBytes) * 100))
      : null;
    const download = this.direction === 'download-dir';
    return {
      id: this.id,
      mode: 'single',
      kind: this.direction,
      state: this.state,
      sourceHost: download ? this.hostId : 'local',
      sourcePath: download ? this.sourcePath : this.targetPath,
      targetHost: download ? 'local' : this.hostId,
      targetPath: download ? this.targetPath : this.sourcePath,
      totalBytes: this.totalBytes,
      transferredBytes: this.transferredBytes,
      percent,
      error: this.error,
      createdAt: this.createdAt,
      finishedAt: this.finishedAt,
      filesDone: this.filesDone,
      filesTotal: this.filesTotal,
    };
  }

  async cancel(): Promise<void> {
    if (this.state === 'completed' || this.state === 'failed' || this.state === 'cancelled') {
      throw new McpError(ErrorCode.InvalidParams, `Transfer ${this.id} is already ${this.state}`);
    }
    this.cancelled = true;
    await this.cancelSubTransfers();
    this.finish('cancelled', null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    closeSftpConnection(this.conns);
    this.conns = null as any;
  }

  private complete(): void {
    if (this.cancelled) return;
    this.finish('completed', null);
  }

  private markFailed(message: string): void {
    if (this.state === 'completed' || this.state === 'failed' || this.state === 'cancelled') return;
    this.finish('failed', message);
  }

  private finish(state: TransferState, error: string | null): void {
    if (this.state === 'completed' || this.state === 'failed' || this.state === 'cancelled') return;
    this.state = state;
    this.error = error;
    this.finishedAt = Date.now();
    this.dispose();
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
