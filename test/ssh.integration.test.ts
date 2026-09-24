import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import net from 'net';
import type { Duplex } from 'stream';
import type { ConnectConfig, SFTPWrapper } from 'ssh2';
import SSH2Module from 'ssh2';
import type { ResolvedHost, SftpConnection } from '../src/index.js';

const { Client: SSHClient } = SSH2Module as typeof import('ssh2');
type SshClient = InstanceType<typeof SSHClient>;

const integrationEnabled = process.env.SSH_MCP_INTEGRATION === '1';
const integration = integrationEnabled ? describe : describe.skip;

type Runtime = typeof import('../src/index.js');

let runtime: Runtime;
let directHost: ResolvedHost;
let proxiedHost: ResolvedHost;
let workDir: string;
const remoteRoot = `/tmp/ssh-mcp-toolkit-integration-${process.pid}`;

function configFor(host: string, port: number, username: string, password: string, privateKey?: string): ConnectConfig {
  return {
    host,
    port,
    username,
    keepaliveInterval: 5_000,
    ...(privateKey ? { privateKey } : { password }),
  };
}

function connectClient(config: ConnectConfig): Promise<SshClient> {
  return new Promise((resolve, reject) => {
    const client = new SSHClient();
    let ready = false;
    const fail = (error: Error) => {
      if (!ready) {
        ready = true;
        client.end();
        reject(error);
      }
    };
    client.once('ready', () => {
      ready = true;
      resolve(client);
    });
    client.once('error', fail);
    client.once('end', () => fail(new Error('SSH connection ended before ready')));
    client.connect(config);
  });
}

function forwardOut(client: SshClient, host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (error, stream) => {
      if (error) reject(error);
      else resolve(stream as Duplex);
    });
  });
}

async function openChain(resolved: ResolvedHost): Promise<{ conn: SshClient; jumpConns: SshClient[] }> {
  const jumpConns: SshClient[] = [];
  let socket: Duplex | undefined;
  try {
    for (let index = 0; index < resolved.jumpConfigs.length; index += 1) {
      const jumpConfig = { ...resolved.jumpConfigs[index] };
      if (socket) jumpConfig.sock = socket;
      const jumpConn = await connectClient(jumpConfig);
      jumpConns.push(jumpConn);
      const nextConfig = resolved.jumpConfigs[index + 1] ?? resolved.config;
      if (!nextConfig.host) throw new Error('integration target host is missing');
      socket = await forwardOut(jumpConn, nextConfig.host, nextConfig.port ?? 22);
    }

    const targetConfig = { ...resolved.config };
    if (socket) targetConfig.sock = socket;
    const conn = await connectClient(targetConfig);
    return { conn, jumpConns };
  } catch (error) {
    for (const jumpConn of jumpConns) jumpConn.end();
    throw error;
  }
}

async function openSftp(resolved: ResolvedHost): Promise<SftpConnection> {
  const chain = await openChain(resolved);
  try {
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      chain.conn.sftp((error, value) => error ? reject(error) : resolve(value));
    });
    return { ...chain, sftp };
  } catch (error) {
    chain.conn.end();
    for (const jumpConn of chain.jumpConns) jumpConn.end();
    throw error;
  }
}

function closeSftp(connection: SftpConnection): void {
  connection.sftp.end();
  connection.conn.end();
  for (const jumpConn of connection.jumpConns) jumpConn.end();
}

function readRemoteFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = sftp.createReadStream(path);
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(Buffer.concat(chunks)));
  });
}

function readTunnelBanner(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback();
    };
    socket.once('error', (error: Error) => finish(() => reject(error)));
    socket.once('data', (data: Buffer) => finish(() => resolve(data.toString('utf8'))));
    socket.connect(port, '127.0.0.1');
  });
}

integration('real SSH/SFTP container integration', () => {
  beforeAll(async () => {
    runtime = await import('../src/index.js');
    workDir = await mkdtemp(join(tmpdir(), 'ssh-mcp-toolkit-integration-'));

    const host = process.env.SSH_MCP_INTEGRATION_HOST ?? 'ssh';
    const jumpHost = process.env.SSH_MCP_INTEGRATION_JUMP_HOST ?? 'ssh-jump';
    const port = Number(process.env.SSH_MCP_INTEGRATION_PORT ?? '2222');
    const username = process.env.SSH_MCP_INTEGRATION_USER ?? 'test';
    const password = process.env.SSH_MCP_INTEGRATION_PASSWORD ?? 'secret';
    const privateKeyPath = process.env.SSH_MCP_INTEGRATION_PRIVATE_KEY;
    const privateKey = privateKeyPath ? await readFile(privateKeyPath, 'utf8') : undefined;
    const targetConfig = configFor(host, port, username, password, privateKey);
    const jumpConfig = configFor(jumpHost, port, username, password, privateKey);

    directHost = {
      config: targetConfig,
      jumpConfigs: [],
      jumpHostIds: [],
    };
    proxiedHost = {
      config: targetConfig,
      jumpConfig,
      jumpHostId: 'jump',
      jumpConfigs: [jumpConfig],
      jumpHostIds: ['jump'],
    };
  });

  afterAll(async () => {
    if (proxiedHost) {
      const cleanup = new runtime.PersistentSession('integration-cleanup', proxiedHost, 15_000);
      try {
        await cleanup.execute(`rm -rf '${remoteRoot}'`);
      } catch {
        // Preserve the original test failure if the remote cleanup cannot run.
      } finally {
        cleanup.dispose();
      }
    }
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it('runs shell commands directly and through a real ProxyJump chain', async () => {
    const direct = new runtime.PersistentSession('integration-direct', directHost, 15_000);
    try {
      const result = await direct.execute("printf 'direct-ssh-ok'");
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('direct-ssh-ok');
      expect(direct.getInfo().jumpHost).toBe('direct');
    } finally {
      direct.dispose();
    }

    const proxied = new runtime.PersistentSession('integration-proxyjump', proxiedHost, 15_000);
    try {
      const result = await proxied.execute("printf 'proxyjump-ssh-ok'");
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('proxyjump-ssh-ok');
      expect(proxied.getInfo().jumpHost).toBe('jump');
    } finally {
      proxied.dispose();
    }
  }, 60_000);

  it('transfers files and server-to-server data over real SFTP', async () => {
    const sourcePath = join(workDir, 'source.bin');
    const downloadPath = join(workDir, 'download.bin');
    const payload = Buffer.alloc(96 * 1024);
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
    await writeFile(sourcePath, payload);
    const remotePath = `${remoteRoot}/source.bin`;
    const copiedRemotePath = `${remoteRoot}/copied.bin`;

    const upload = new runtime.FileTransfer(
      'integration-upload', 'target', sourcePath, remotePath, 'upload', await openSftp(proxiedHost),
      {
        chunkThreads: 2,
        chunkSize: 16 * 1024,
        chunkThreshold: 1,
        parallelConnectionFactory: () => openSftp(proxiedHost),
      },
    );
    await upload.start();
    expect(upload.getInfo().state, upload.getInfo().error ?? 'upload failed').toBe('completed');

    const download = new runtime.FileTransfer(
      'integration-download', 'target', downloadPath, remotePath, 'download', await openSftp(proxiedHost),
      {
        chunkThreads: 2,
        chunkSize: 16 * 1024,
        chunkThreshold: 1,
        parallelConnectionFactory: () => openSftp(proxiedHost),
      },
    );
    await download.start();
    expect(download.getInfo().state, download.getInfo().error ?? 'download failed').toBe('completed');
    expect(await readFile(downloadPath)).toEqual(payload);

    const serverTransfer = new runtime.ServerTransfer(
      'integration-server-transfer', 'source', 'target', directHost, proxiedHost,
      remotePath, copiedRemotePath, 'stream',
      { source: await openSftp(directHost), target: await openSftp(proxiedHost) },
    );
    await serverTransfer.start();
    expect(serverTransfer.getInfo().state, serverTransfer.getInfo().error ?? 'server transfer failed').toBe('completed');

    const verify = await openSftp(proxiedHost);
    try {
      expect(await readRemoteFile(verify.sftp, copiedRemotePath)).toEqual(payload);
    } finally {
      closeSftp(verify);
    }
  }, 60_000);

  it('transfers a directory and opens a real local port tunnel', async () => {
    const sourceDir = join(workDir, 'directory-source');
    const downloadDir = join(workDir, 'directory-download');
    await mkdir(join(sourceDir, 'nested'), { recursive: true });
    await writeFile(join(sourceDir, 'root.txt'), 'root file\n');
    await writeFile(join(sourceDir, 'nested', 'child.txt'), 'nested file\n');
    await mkdir(join(sourceDir, 'empty'));
    const remoteDir = `${remoteRoot}/directory`;

    const uploadDir = new runtime.DirectoryTransfer(
      'integration-upload-dir', 'target', remoteDir, sourceDir, 'upload-dir', await openSftp(proxiedHost),
      { concurrency: 2, chunkThreads: 2, chunkThreshold: 1, chunkSize: 16 * 1024 },
    );
    await uploadDir.start();
    expect(uploadDir.getInfo().state, uploadDir.getInfo().error ?? 'directory upload failed').toBe('completed');

    const downloadDirTransfer = new runtime.DirectoryTransfer(
      'integration-download-dir', 'target', remoteDir, downloadDir, 'download-dir', await openSftp(proxiedHost),
      { concurrency: 2, chunkThreads: 2, chunkThreshold: 1, chunkSize: 16 * 1024 },
    );
    await downloadDirTransfer.start();
    expect(downloadDirTransfer.getInfo().state, downloadDirTransfer.getInfo().error ?? 'directory download failed').toBe('completed');
    expect(await readFile(join(downloadDir, 'root.txt'))).toEqual(Buffer.from('root file\n'));
    expect(await readFile(join(downloadDir, 'nested', 'child.txt'))).toEqual(Buffer.from('nested file\n'));
    expect((await stat(join(downloadDir, 'empty'))).isDirectory()).toBe(true);

    const chain = await openChain(proxiedHost);
    const tunnel = new runtime.PortForward(
      'integration-tunnel', 'target', '127.0.0.1', 0, '127.0.0.1', 2222,
      ['jump'], chain.conn, chain.jumpConns, 15_000,
    );
    try {
      await tunnel.start();
      expect(tunnel.getInfo().state).toBe('active');
      expect(await readTunnelBanner(tunnel.getInfo().localPort)).toMatch(/^SSH-2\.0-/);
    } finally {
      tunnel.dispose();
    }
  }, 60_000);

  it('opens and closes a real reverse SSH listener for Internet Egress', async () => {
    const chain = await openChain(proxiedHost);
    const remotePort = 20_000 + (process.pid % 1_000);
    const egress = new runtime.InternetEgress(
      'integration-egress', 'target', '127.0.0.1', remotePort,
      ['jump'], chain.conn, chain.jumpConns, 15_000,
    );
    try {
      await egress.start();
      expect(egress.getInfo().state).toBe('active');
      expect(egress.getInfo().proxyPort).toBe(remotePort);
    } finally {
      egress.dispose();
    }
  }, 60_000);
});
