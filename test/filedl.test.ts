import { describe, it, expect } from 'vitest';
import { PassThrough, Writable, EventEmitter } from 'stream';
import { mkdtemp, writeFile, readFile, rm, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

function makeFakeSftp(size: number, isDir = false) {
  const calls = { stat: [] as string[], read: [] as string[], write: [] as string[], open: [] as string[], mkdir: [] as string[], end: 0 };
  const writeChunks: Buffer[] = [];
  const recorded: Buffer[] = [];
  let readStream: PassThrough | null = null;
  let readCount = 0;
  const sftp = {
    stat(path: string, cb: (error: Error | null, stats?: any) => void) {
      calls.stat.push(path);
      cb(null, { size, isDirectory: () => isDir });
    },
    createReadStream(path: string, opts?: any) {
      calls.read.push(path);
      readCount += 1;
      readStream = new PassThrough();
      if (readCount > 1) {
        const start = opts?.start ?? 0;
        const data = Buffer.concat(recorded).subarray(start);
        setImmediate(() => readStream!.end(data));
      } else {
        readStream.on('data', (chunk: Buffer) => recorded.push(chunk));
      }
      return readStream;
    },
    createWriteStream(path: string) {
      calls.write.push(path);
      return new Writable({
        write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
          writeChunks.push(chunk);
          done();
        },
      });
    },
    open(path: string, flags: string, cb: (error: Error | null, handle?: Buffer) => void) {
      calls.open.push(path);
      cb(null, Buffer.from([1]));
    },
    write(handle: Buffer, buf: Buffer, offset: number, length: number, position: number, cb: (error: Error | null) => void) {
      writeChunks.push(buf.subarray(offset, offset + length));
      cb(null);
    },
    close(handle: Buffer, cb: (error: Error | null) => void) {
      cb(null);
    },
    rename(from: string, to: string, cb: (error: Error | null) => void) {
      cb(null);
    },
    unlink(path: string, cb: (error: Error | null) => void) {
      cb(null);
    },
    mkdir(path: string, _opts: any, cb: (error: Error | null) => void) {
      calls.mkdir.push(path);
      cb(null);
    },
    end() {
      calls.end += 1;
    },
  };
  return { sftp, calls, writeChunks, getReadStream: () => readStream };
}

async function waitForReadStream(source: ReturnType<typeof makeFakeSftp>): Promise<PassThrough> {
  for (let i = 0; i < 200; i++) {
    const rs = source.getReadStream();
    if (rs) return rs;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('read stream never created');
}

function makeDirCreatingSftp() {
  const calls = { mkdir: [] as string[], open: [] as string[] };
  const writeChunks: Buffer[] = [];
  const existing = new Set<string>(['/']);
  const files = new Map<string, Buffer>();
  const handles = new Map<Buffer, string>();
  const sftp = {
    stat(path: string, cb: (error: Error | null, stats?: any) => void) {
      if (files.has(path)) {
        cb(null, { size: files.get(path)!.length, isDirectory: () => false });
      } else if (existing.has(path)) {
        cb(null, { size: 0, isDirectory: () => true });
      } else {
        const err: any = new Error('No such file');
        err.code = 'ENOENT';
        cb(err);
      }
    },
    mkdir(path: string, _opts: any, cb: (error: Error | null) => void) {
      existing.add(path);
      calls.mkdir.push(path);
      cb(null);
    },
    open(path: string, flags: string, cb: (error: Error | null, handle?: Buffer) => void) {
      calls.open.push(path);
      const handle = Buffer.from([1]);
      handles.set(handle, path);
      cb(null, handle);
    },
    write(handle: Buffer, buf: Buffer, offset: number, length: number, position: number, cb: (error: Error | null) => void) {
      const path = handles.get(handle) ?? '';
      const chunk = buf.subarray(offset, offset + length);
      writeChunks.push(chunk);
      const prev = files.get(path) ?? Buffer.alloc(0);
      const next = Buffer.alloc(position + chunk.length);
      prev.copy(next);
      chunk.copy(next, position);
      files.set(path, next);
      cb(null);
    },
    close(handle: Buffer, cb: (error: Error | null) => void) {
      cb(null);
    },
    rename(from: string, to: string, cb: (error: Error | null) => void) {
      const data = files.get(from);
      if (data !== undefined) files.set(to, data);
      files.delete(from);
      cb(null);
    },
    unlink(path: string, cb: (error: Error | null) => void) {
      files.delete(path);
      cb(null);
    },
    createReadStream(path: string) {
      const data = files.get(path) ?? Buffer.alloc(0);
      const rs = new PassThrough();
      setImmediate(() => rs.end(data));
      return rs;
    },
    end() {},
  };
  return { sftp, calls, writeChunks };
}

describe('FileTransfer', () => {
  it('download mode completes, counts bytes, and writes the local file', async () => {
    const { FileTransfer } = await import('../src/index.js');
    const source = makeFakeSftp(5);
    const dir = await mkdtemp(join(tmpdir(), 'mcp-dl-'));
    const local = join(dir, 'out.bin');
    const transfer = new FileTransfer('f1', 'A', local, '/data/big.bin', 'download',
      { conn: { end() {} } as any, jumpConns: [], sftp: source.sftp as any },
    );
    const p = transfer.start();
    const rs = await waitForReadStream(source);
    rs.write('hello');
    rs.end();
    await p;
    const info = transfer.getInfo();
    expect(info.state).toBe('completed');
    expect(info.kind).toBe('download');
    expect(info.sourceHost).toBe('A');
    expect(info.targetHost).toBe('local');
    expect(info.sourcePath).toBe('/data/big.bin');
    expect(info.targetPath).toBe(local);
    expect(info.mode).toBe('single');
    expect(info.transferredBytes).toBe(5);
    expect(info.totalBytes).toBe(5);
    expect(info.percent).toBe(100);
    expect(await readFile(local, 'utf8')).toBe('hello');
    await expect(stat(join(dir, 'out.bin.part'))).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });

  it('upload mode completes, creates the remote parent directory, and counts bytes', async () => {
    const { FileTransfer } = await import('../src/index.js');
    const target = makeDirCreatingSftp();
    const dir = await mkdtemp(join(tmpdir(), 'mcp-up-'));
    const local = join(dir, 'src.txt');
    await writeFile(local, 'hello', 'utf8');
    const transfer = new FileTransfer('f2', 'A', local, '/data/dir/src.txt', 'upload',
      { conn: { end() {} } as any, jumpConns: [], sftp: target.sftp as any },
    );
    const p = transfer.start();
    await p;
    const info = transfer.getInfo();
    expect(info.state).toBe('completed');
    expect(info.kind).toBe('upload');
    expect(info.sourceHost).toBe('local');
    expect(info.targetHost).toBe('A');
    expect(info.sourcePath).toBe(local);
    expect(info.targetPath).toBe('/data/dir/src.txt');
    expect(info.transferredBytes).toBe(5);
    expect(info.totalBytes).toBe(5);
    expect(target.calls.mkdir).toEqual(['/data', '/data/dir']);
    expect(target.writeChunks.join('')).toBe('hello');
    await rm(dir, { recursive: true, force: true });
  });

  it('can be cancelled mid-transfer', async () => {
    const { FileTransfer } = await import('../src/index.js');
    const source = makeFakeSftp(100);
    const dir = await mkdtemp(join(tmpdir(), 'mcp-dl2-'));
    const local = join(dir, 'out.bin');
    const transfer = new FileTransfer('f3', 'A', local, '/data/big.bin', 'download',
      { conn: { end() {} } as any, jumpConns: [], sftp: source.sftp as any },
    );
    const p = transfer.start();
    const rs = await waitForReadStream(source);
    rs.write('partial');
    await new Promise((r) => setTimeout(r, 10));
    await transfer.cancel();
    await p;
    expect(transfer.getInfo().state).toBe('cancelled');
    await rm(dir, { recursive: true, force: true });
  });

  it('fails when the SSH connection errors', async () => {
    const { FileTransfer } = await import('../src/index.js');
    const source = makeFakeSftp(100);
    const conn = new EventEmitter() as any;
    conn.end = () => {};
    const transfer = new FileTransfer('f4', 'A', '/tmp/out.bin', '/data/big.bin', 'download',
      { conn, jumpConns: [], sftp: source.sftp as any },
    );
    conn.emit('error', new Error('boom'));
    const info = transfer.getInfo();
    expect(info.state).toBe('failed');
    expect(info.error).toBe('boom');
  });

  it('tears down open streams and fails when the connection errors mid-download', async () => {
    const { FileTransfer } = await import('../src/index.js');
    const source = makeFakeSftp(100);
    const dir = await mkdtemp(join(tmpdir(), 'mcp-dl3-'));
    const local = join(dir, 'out.bin');
    const conn = new EventEmitter() as any;
    conn.end = () => {};
    const transfer = new FileTransfer('f5', 'A', local, '/data/big.bin', 'download',
      { conn, jumpConns: [], sftp: source.sftp as any },
    );
    const p = transfer.start();
    const rs = await waitForReadStream(source);
    rs.write('partial');
    conn.emit('error', new Error('boom'));
    await p;
    const info = transfer.getInfo();
    expect(info.state).toBe('failed');
    expect(info.error).toBe('boom');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('resolveLocalStatError', () => {
  it('maps EACCES to InternalError with a permission message', async () => {
    const { resolveLocalStatError } = await import('../src/index.js');
    const err: any = new Error('EACCES: permission denied');
    err.code = 'EACCES';
    const mapped = resolveLocalStatError(err, '/local/file.txt');
    expect(mapped).toBeInstanceOf(McpError);
    expect((mapped as McpError).code).toBe(ErrorCode.InternalError);
    expect((mapped as McpError).message).toContain('permission denied');
  });

  it('maps EPERM to InternalError with a permission message', async () => {
    const { resolveLocalStatError } = await import('../src/index.js');
    const err: any = new Error('EPERM: operation not permitted');
    err.code = 'EPERM';
    const mapped = resolveLocalStatError(err, '/local/file.txt');
    expect((mapped as McpError).code).toBe(ErrorCode.InternalError);
  });

  it('maps ENOENT to InvalidParams', async () => {
    const { resolveLocalStatError } = await import('../src/index.js');
    const err: any = new Error('ENOENT: no such file');
    err.code = 'ENOENT';
    const mapped = resolveLocalStatError(err, '/local/missing.txt');
    expect((mapped as McpError).code).toBe(ErrorCode.InvalidParams);
    expect((mapped as McpError).message).toContain("Local file '/local/missing.txt' cannot be read: ENOENT: no such file");
  });

  it('passes through an existing McpError unchanged', async () => {
    const { resolveLocalStatError } = await import('../src/index.js');
    const original = new McpError(ErrorCode.InvalidParams, 'not a file');
    expect(resolveLocalStatError(original, '/local/file.txt')).toBe(original);
  });
});

describe('assertLocalDestinationParent', () => {
  it('accepts an existing directory', async () => {
    const { assertLocalDestinationParent } = await import('../src/index.js');
    await expect(assertLocalDestinationParent(tmpdir())).resolves.toBeUndefined();
  });

  it('rejects a missing parent directory with InvalidParams', async () => {
    const { assertLocalDestinationParent } = await import('../src/index.js');
    const missing = join(tmpdir(), `mcp-parent-missing-${Date.now()}`);
    const err = await assertLocalDestinationParent(missing).catch((e: any) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(ErrorCode.InvalidParams);
    expect(err.message).toContain('does not exist');
  });

  it('rejects a parent that is not a directory', async () => {
    const { assertLocalDestinationParent } = await import('../src/index.js');
    const dir = await mkdtemp(join(tmpdir(), 'mcp-parent-file-'));
    const file = join(dir, 'not-a-dir');
    await writeFile(file, 'x', 'utf8');
    const err = await assertLocalDestinationParent(file).catch((e: any) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(ErrorCode.InvalidParams);
    expect(err.message).toContain('is not a directory');
    await rm(dir, { recursive: true, force: true });
  });
});
