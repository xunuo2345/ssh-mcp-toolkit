import { describe, it, expect } from 'vitest';

describe('dir helpers', () => {
  it('computes totals from entries', async () => {
    const { dirEntriesToTotal } = await import('../src/index.js');
    const r = dirEntriesToTotal([
      { relPath: 'a.bin', size: 100 },
      { relPath: 'sub/b.bin', size: 200 },
    ]);
    expect(r.filesTotal).toBe(2);
    expect(r.totalBytes).toBe(300);
  });

  it('resolveDirSkip skips when size and hash match', async () => {
    const { resolveDirSkip } = await import('../src/index.js');
    expect(resolveDirSkip({ relPath: 'a', size: 10 }, 10, 'h', 'h')).toBe(true);
    expect(resolveDirSkip({ relPath: 'a', size: 10 }, 9, 'h', 'h')).toBe(false); // size mismatch
    expect(resolveDirSkip({ relPath: 'a', size: 10 }, 10, 'h1', 'h2')).toBe(false); // hash mismatch
    expect(resolveDirSkip({ relPath: 'a', size: 10 }, null, null, null)).toBe(false); // missing
  });

  it('chunkSegments splits the remaining range', async () => {
    const { chunkSegments } = await import('../src/index.js');
    // 100-byte file, offset 0, 4 threads
    const segs = chunkSegments(100, 0, 25, 4);
    expect(segs.length).toBe(4);
    expect(segs[0]).toEqual({ start: 0, end: 25 });
    expect(segs[3]).toEqual({ start: 75, end: 100 });
  });

  it('chunkSegments returns empty when nothing remains', async () => {
    const { chunkSegments } = await import('../src/index.js');
    expect(chunkSegments(100, 100, 100, 4)).toEqual([]);
  });

  it('chunkSegments returns a single segment for small remaining or 1 thread', async () => {
    const { chunkSegments } = await import('../src/index.js');
    expect(chunkSegments(10, 5, 100, 4)).toEqual([{ start: 5, end: 10 }]);
    expect(chunkSegments(1000, 0, 100, 1)).toEqual([{ start: 0, end: 1000 }]);
  });

  it('chunkSegments does not split below the chunk size threshold', async () => {
    const { chunkSegments } = await import('../src/index.js');
    // chunkSize=8 means segments must be >= 8 bytes; 10-byte remaining stays 1 segment
    expect(chunkSegments(10, 0, 8, 4)).toEqual([{ start: 0, end: 10 }]);
  });

  it('never produces a segment smaller than chunkSize', async () => {
    const { chunkSegments } = await import('../src/index.js');
    const segs = chunkSegments(31, 0, 10, 4);
    for (const s of segs) {
      expect(s.end - s.start).toBeGreaterThanOrEqual(10);
    }
    expect(segs[segs.length - 1].end).toBe(31);
  });
});

describe('DirectoryTransfer listing', () => {
  function makeDirSftp(tree: Record<string, { size: number; dir?: boolean }>) {
    const entries: Record<string, Array<{ filename: string; attrs: { size: number; isDirectory: () => boolean } }>> = {};
    for (const [path, info] of Object.entries(tree)) {
      const parent = path.slice(0, path.lastIndexOf('/'));
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (info.dir) {
        (entries[parent] ??= []).push({ filename: name, attrs: { size: 0, isDirectory: () => true } });
      } else {
        (entries[parent] ??= []).push({ filename: name, attrs: { size: info.size, isDirectory: () => false } });
      }
    }
    const consumed: Record<string, boolean> = {};
    const sftp = {
      opendir(path: string, cb: (err: Error | null, handle?: Buffer) => void) { cb(null, Buffer.from(path)); },
      readdir(handle: Buffer, cb: (err: Error | null, list?: any[]) => void) {
        const key = handle.toString();
        if (consumed[key]) { cb(null, []); return; }
        consumed[key] = true;
        cb(null, entries[key] ?? []);
      },
      stat(path: string, cb: (err: Error | null, stats?: any) => void) {
        const info = tree[path];
        if (info) cb(null, { size: info.size, isDirectory: () => !!info.dir });
        else cb(new Error('ENOENT') as any);
      },
      close(_handle: Buffer, cb: (err: Error | null) => void) { cb(null); },
      end() {},
    };
    return sftp;
  }

  it('lists all files recursively with relative paths', async () => {
    const { DirectoryTransfer } = await import('../src/index.js');
    const tree = {
      '/data': { size: 0, dir: true },
      '/data/a.bin': { size: 100 },
      '/data/sub': { size: 0, dir: true },
      '/data/sub/b.bin': { size: 200 },
    };
    const sftp = makeDirSftp(tree);
    const t = new DirectoryTransfer('d1', 'A', '/data', '/local/data', 'download-dir',
      { conn: { end() {} } as any, jumpConns: [], sftp: sftp as any });
    (t as any).conns = { conn: { end() {} }, jumpConns: [], sftp };
    const listing = await (t as any).listFiles('/data');
    expect(listing).toEqual([
      { relPath: 'a.bin', size: 100 },
      { relPath: 'sub/b.bin', size: 200 },
    ]);
  });

  it('lists the local tree for upload-dir', async () => {
    const { DirectoryTransfer } = await import('../src/index.js');
    const tree = {
      '/local/data': { size: 0, dir: true },
      '/local/data/file.txt': { size: 42 },
      '/local/data/nested': { size: 0, dir: true },
      '/local/data/nested/deep.bin': { size: 7 },
    };
    const sftp = makeDirSftp(tree);
    const t = new DirectoryTransfer('d2', 'A', '/remote/data', '/local/data', 'upload-dir',
      { conn: { end() {} } as any, jumpConns: [], sftp: sftp as any });
    (t as any).conns = { conn: { end() {} }, jumpConns: [], sftp };
    const listing = await (t as any).listFiles('/local/data');
    expect(listing).toEqual([
      { relPath: 'file.txt', size: 42 },
      { relPath: 'nested/deep.bin', size: 7 },
    ]);
  });
});

describe('DirectoryTransfer concurrency', () => {
  it('runs at most N file transfers concurrently', async () => {
    const { DirectoryTransfer } = await import('../src/index.js');
    let maxActive = 0;
    let active = 0;
    const t = new DirectoryTransfer('c1', 'A', '/data', '/local/data', 'download-dir',
      { conn: { end() {} } as any, jumpConns: [], sftp: { stat(_p: string, cb: (e: Error | null, s?: any) => void) { cb(null, { size: 0, isDirectory: () => true }); }, end() {} } as any },
      { concurrency: 2 });
    (t as any).listFiles = async () => [
      { relPath: 'a', size: 1 }, { relPath: 'b', size: 1 }, { relPath: 'c', size: 1 }, { relPath: 'd', size: 1 },
    ];
    (t as any).maybeSkip = async () => false;
    (t as any).transferOne = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
      return 1;
    };
    await (t as any).start();
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThanOrEqual(2); // concurrency genuinely engages
  });
});

describe('FileTransfer chunked download', () => {
  it('chunks a large file into range reads', async () => {
    const { FileTransfer, partPathFor } = await import('../src/index.js');
    const { mkdtemp, writeFile, readFile, rm } = await import('fs/promises');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const dir = await mkdtemp(join(tmpdir(), 'chunk-dl-'));
    const local = join(dir, 'big.bin');
    const full = Buffer.alloc(100, 0x42);
    const starts: number[] = [];
    const sftp = {
      stat(p: string, cb: (e: Error | null, s?: any) => void) { cb(null, { size: full.length, isDirectory: () => false }); },
      createReadStream(p: string, opts?: any) {
        starts.push(opts?.start ?? 0);
        const { Readable } = require('stream');
        const r = new Readable();
        r._read = () => {};
        const end = opts?.end ?? full.length;
        r.push(full.subarray(opts?.start ?? 0, Math.min(end + 1, full.length)));
        r.push(null);
        return r;
      },
      rename(f: string, t: string, cb: (e: Error | null) => void) { cb(null); },
      end() {},
    };
    const ft = new FileTransfer('x1', 'A', local, '/remote/big.bin', 'download',
      { conn: { end() {} } as any, jumpConns: [], sftp: sftp as any },
      { chunkThreads: 4, chunkSize: 50 });
    await ft.start();
    expect(starts.length).toBeGreaterThan(1); // chunked into multiple range reads
    expect(new Set(starts).size).toBeGreaterThan(1); // distinct range starts prove parallel segments
    const finalContent = await readFile(local);
    expect(finalContent.length).toBe(100);
    await rm(dir, { recursive: true, force: true });
  });

  it('does not read past EOF on the final chunk (strict server errors on probe)', async () => {
    const { FileTransfer } = await import('../src/index.js');
    const { mkdtemp, readFile, rm } = await import('fs/promises');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const dir = await mkdtemp(join(tmpdir(), 'chunk-eof-'));
    const local = join(dir, 'big.bin');
    const full = Buffer.alloc(100, 0x42);
    const sftp = {
      stat(p: string, cb: (e: Error | null, s?: any) => void) { cb(null, { size: full.length, isDirectory: () => false }); },
      createReadStream(p: string, opts?: any) {
        const { Readable } = require('stream');
        const r = new Readable();
        r._read = () => {};
        if (opts?.end !== undefined && opts.end >= full.length) {
          r.destroy(new Error('read past EOF'));
          return r;
        }
        const start = opts?.start ?? 0;
        const end = opts?.end === undefined ? full.length - 1 : opts.end;
        r.push(full.subarray(start, Math.min(end + 1, full.length)));
        r.push(null);
        return r;
      },
      end() {},
    };
    const ft = new FileTransfer('x3', 'A', local, '/remote/big.bin', 'download',
      { conn: { end() {} } as any, jumpConns: [], sftp: sftp as any },
      { chunkThreads: 4, chunkSize: 50 });
    await ft.start();
    expect(ft.getInfo().state).toBe('completed');
    expect((await readFile(local)).length).toBe(100);
    await rm(dir, { recursive: true, force: true });
  });

  it('tears down sibling read streams when a segment fails', async () => {
    const { FileTransfer } = await import('../src/index.js');
    const { mkdtemp, rm } = await import('fs/promises');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const dir = await mkdtemp(join(tmpdir(), 'chunk-sib-'));
    const local = join(dir, 'big.bin');
    const full = Buffer.alloc(100, 0x42);
    const destroyed: number[] = [];
    let callCount = 0;
    const sftp = {
      stat(p: string, cb: (e: Error | null, s?: any) => void) { cb(null, { size: full.length, isDirectory: () => false }); },
      createReadStream(p: string, opts?: any) {
        const { Readable } = require('stream');
        const r = new Readable();
        r._read = () => {};
        if (callCount++ === 0) {
          r.destroy(new Error('segment 0 read failed'));
        } else {
          r.push(full.subarray(opts.start, Math.min(opts.end + 1, full.length)));
          r.push(null);
        }
        const origDestroy = r.destroy.bind(r);
        r.destroy = (err?: Error) => { destroyed.push(opts.start); return origDestroy(err); };
        return r;
      },
      end() {},
    };
    const ft = new FileTransfer('x4', 'A', local, '/remote/big.bin', 'download',
      { conn: { end() {} } as any, jumpConns: [], sftp: sftp as any },
      { chunkThreads: 4, chunkSize: 50 });
    await ft.start();
    expect(ft.getInfo().state).toBe('failed');
    expect(ft.getInfo().error).toContain('segment 0 read failed');
    expect(destroyed).toContain(50);
    await rm(dir, { recursive: true, force: true });
  });
});
