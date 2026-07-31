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

const activeSessions = new Map<string, PersistentSession>();
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

class PersistentSession {
  private conn: InstanceType<typeof SSHClient> | null = null;
  private jumpConns: InstanceType<typeof SSHClient>[] = [];
  private shell: ClientChannel | null = null;
  private buffer = '';
  private pendingCommand: {
    resolve: (result: { output: string; exitCode: number }) => void;
    reject: (error: Error) => void;
    marker: string;
  } | null = null;
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
        stream.on('data', (data: string) => {
          this.buffer += data;
          this.processPending();
        });
        stream.on('close', () => {
          this.cleanup();
        });
        stream.stderr?.on('data', (data: string) => {
          this.buffer += data;
          this.processPending();
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

    if (!this.shell) {
      throw new McpError(ErrorCode.InternalError, 'SSH shell not ready');
    }
    if (this.pendingCommand) {
      throw new McpError(ErrorCode.InternalError, 'Another command is still running in this session');
    }

    this.lastCommand = command;
    this.resetInactivityTimer();

    const token = randomUUID();
    const marker = `__MCP_DONE__${token}__`;

    return new Promise((resolve, reject) => {
      this.pendingCommand = {
        marker,
        resolve,
        reject,
      };

      const commandWithNewline = command.endsWith('\n') ? command : command + '\n';
      this.shell!.write(commandWithNewline, (err) => {
        if (err) {
          this.rejectPending(err);
          return;
        }
        this.shell!.write(`printf '${marker}%d\n' $?\n`, (printfErr) => {
          if (printfErr) {
            this.rejectPending(printfErr);
          }
        });
      });
    });
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

  private processPending(): void {
    if (!this.pendingCommand) {
      return;
    }

    const { marker, resolve } = this.pendingCommand;
    const markerIndex = this.buffer.indexOf(marker);
    if (markerIndex === -1) {
      return;
    }

    const afterMarker = this.buffer.slice(markerIndex + marker.length);
    const newlineIndex = afterMarker.indexOf('\n');
    if (newlineIndex === -1) {
      return;
    }

    const exitCodeText = afterMarker.slice(0, newlineIndex).trim();
    const remaining = afterMarker.slice(newlineIndex + 1);

    const output = this.buffer.slice(0, markerIndex).replace(/\r/g, '');
    const exitCode = Number.parseInt(exitCodeText, 10);

    this.buffer = remaining;
    this.pendingCommand = null;

    const finalOutput = output.replace(/__MCP_READY__\s*/g, '').replace(/\s+$/, '');

    resolve({ output: finalOutput, exitCode: Number.isNaN(exitCode) ? 0 : exitCode });
    this.resetInactivityTimer();
  }

  private rejectPending(error: Error): void {
    if (!this.pendingCommand) {
      return;
    }
    this.pendingCommand.reject(error);
    this.pendingCommand = null;
  }

  private cleanup(error?: Error): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    if (this.shell) {
      this.shell.removeAllListeners();
      this.shell.end();
      this.shell = null;
    }

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

    if (this.pendingCommand) {
      this.pendingCommand.reject(error ?? new Error('SSH session closed'));
      this.pendingCommand = null;
    }

    this.buffer = '';

    if (this.disposed) {
      this.onDispose?.(this.id);
    }
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
