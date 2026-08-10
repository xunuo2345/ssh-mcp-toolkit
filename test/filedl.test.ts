import { describe, it, expect } from 'vitest';
import { PassThrough, Writable, EventEmitter } from 'stream';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

function makeFakeSftp(size: number, isDir = false) {
  const calls = { stat: [] as string[], read: [] as string[], write: [] as string[], mkdir: [] as string[], end: 0 };
  const writeChunks: Buffer[] = [];
  let readStream: PassThrough | null = null;
  const sftp = {
    stat(path: string, cb: (error: Error | null, stats?: any) => void) {
      calls.stat.push(path);
      cb(null, { size, isDirectory: () => isDir });
    },
    createReadStream(path: string) {
      calls.read.push(path);
      readStream = new PassThrough();
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

function makeDirCreatingSftp() {
  const calls = { mkdir: [] as string[], write: [] as string[] };
  const writeChunks: Buffer[] = [];
  const existing = new Set<string>(['/']);
  const sftp = {
    stat(path: string, cb: (error: Error | null, stats?: any) => void) {
      if (existing.has(path)) {
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
    createWriteStream(path: string) {
      calls.write.push(path);
      return new Writable({
        write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
          writeChunks.push(chunk);
          done();
        },
      });
    },
    end() {},
  };
  return { sftp, calls, writeChunks };
}

describe('FileTransfer', () => {
  it('download mode completes, counts bytes, and writes the local file', async () => {
    const { FileTransfer } = await import('../src/index.js');
    const source = makeFakeSftp(10);
    const dir = await mkdtemp(join(tmpdir(), 'mcp-dl-'));
    const local = join(dir, 'out.bin');
    const transfer = new FileTransfer('f1', 'A', local, '/data/big.bin', 'download',
      { conn: { end() {} } as any, jumpConns: [], sftp: source.sftp as any },
    );
    const p = transfer.start();
    await new Promise((r) => setImmediate(r));
    source.getReadStream()!.write('hello');
    source.getReadStream()!.end();
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
    expect(info.totalBytes).toBe(10);
    expect(info.percent).toBe(50);
    expect(await readFile(local, 'utf8')).toBe('hello');
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
    await new Promise((r) => setImmediate(r));
    source.getReadStream()!.write('partial');
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
    await new Promise((r) => setImmediate(r));
    source.getReadStream()!.write('partial');
    conn.emit('error', new Error('boom'));
    await p;
    const info = transfer.getInfo();
    expect(info.state).toBe('failed');
    expect(info.error).toBe('boom');
    await rm(dir, { recursive: true, force: true });
  });
});
