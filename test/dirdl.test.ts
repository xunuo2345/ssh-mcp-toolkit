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

  it('only enables parallel chunking from the configured threshold and never for resumed transfers', async () => {
    const { DEFAULT_CHUNK_THRESHOLD_BYTES, shouldUseChunking } = await import('../src/index.js');
    const threshold = DEFAULT_CHUNK_THRESHOLD_BYTES;
    expect(shouldUseChunking(threshold - 1, 0, threshold, 4)).toBe(false);
    expect(shouldUseChunking(threshold, 0, threshold, 4)).toBe(true);
    expect(shouldUseChunking(threshold * 2, 1, threshold, 4)).toBe(false);
    expect(shouldUseChunking(threshold * 2, 0, threshold, 1)).toBe(false);
  });

  it('caps directory chunk threads so concurrent files cannot amplify SFTP sessions', async () => {
    const { resolveDirectoryChunkThreads } = await import('../src/index.js');
    expect(resolveDirectoryChunkThreads(1, 16)).toBe(16);
    expect(resolveDirectoryChunkThreads(4, 16)).toBe(4);
    expect(resolveDirectoryChunkThreads(16, 16)).toBe(1);
  });
});

describe('DirectoryTransfer listing', () => {
  function makeDirSftp(tree: Record<string, { size: number; dir?: boolean; symlink?: boolean }>) {
    const entries: Record<string, Array<{ filename: string; attrs: { size: number; isDirectory: () => boolean; isSymbolicLink: () => boolean } }>> = {};
    for (const [path, info] of Object.entries(tree)) {
      const parent = path.slice(0, path.lastIndexOf('/'));
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (info.dir) {
        (entries[parent] ??= []).push({ filename: name, attrs: { size: 0, isDirectory: () => true, isSymbolicLink: () => false } });
      } else {
        (entries[parent] ??= []).push({ filename: name, attrs: { size: info.size, isDirectory: () => false, isSymbolicLink: () => !!info.symlink } });
      }
    }
    const consumed: Record<string, boolean> = {};
    const sftp = {
      opendir(path: string, cb: (err: Error | null, handle?: Buffer) => void) { cb(null, Buffer.from(path)); },
      readdir(handle: Buffer, cb: (err: Error | null, list?: any[]) => void) {
        const key = handle.toString();
        if (consumed[key]) { cb({ code: 1, message: 'End of file' } as any); return; }
        consumed[key] = true;
        cb(null, entries[key] ?? []);
      },
      stat(path: string, cb: (err: Error | null, stats?: any) => void) {
        const info = tree[path];
        if (info) cb(null, { size: info.size, isDirectory: () => !!info.dir, isSymbolicLink: () => false });
        else cb(new Error('ENOENT') as any);
      },
      lstat(path: string, cb: (err: Error | null, stats?: any) => void) {
        const info = tree[path];
        if (info) cb(null, { size: info.size, isDirectory: () => !!info.dir, isSymbolicLink: () => !!info.symlink });
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
      { relPath: 'sub', size: 0, isDir: true },
      { relPath: 'sub/b.bin', size: 200 },
    ]);
  });

  it('skips remote symlink entries so the manifest never follows them', async () => {
    const { DirectoryTransfer } = await import('../src/index.js');
    const tree = {
      '/data': { size: 0, dir: true },
      '/data/a.bin': { size: 100 },
      '/data/secret': { size: 0, symlink: true },
      '/data/sub': { size: 0, dir: true },
      '/data/sub/b.bin': { size: 200 },
    };
    const sftp = makeDirSftp(tree);
    const t = new DirectoryTransfer('d1s', 'A', '/data', '/local/data', 'download-dir',
      { conn: { end() {} } as any, jumpConns: [], sftp: sftp as any });
    (t as any).conns = { conn: { end() {} }, jumpConns: [], sftp };
    const listing = await (t as any).listFiles('/data');
    expect(listing).toEqual([
      { relPath: 'a.bin', size: 100 },
      { relPath: 'sub', size: 0, isDir: true },
      { relPath: 'sub/b.bin', size: 200 },
    ]);
  });

  it('rejects a remote download root that is itself a symlink', async () => {
    const { DirectoryTransfer } = await import('../src/index.js');
    const tree = {
      '/data': { size: 0, symlink: true },
      '/target/file.bin': { size: 100 },
    };
    const sftp = makeDirSftp(tree);
    const t = new DirectoryTransfer('d1r', 'A', '/data', '/local/data', 'download-dir',
      { conn: { end() {} } as any, jumpConns: [], sftp: sftp as any });
    (t as any).conns = { conn: { end() {} }, jumpConns: [], sftp };
    await expect((t as any).listFiles('/data')).rejects.toThrow(/symlink/);
  });

  it('lists the local tree for upload-dir', async () => {
    const { DirectoryTransfer } = await import('../src/index.js');
    const { mkdtemp, mkdir, writeFile, rm } = await import('fs/promises');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const localRoot = await mkdtemp(join(tmpdir(), 'dirup-'));
    await mkdir(join(localRoot, 'nested'), { recursive: true });
    await writeFile(join(localRoot, 'file.txt'), Buffer.alloc(42));
    await writeFile(join(localRoot, 'nested', 'deep.bin'), Buffer.alloc(7));
    const sftp = { stat(_p: string, cb: (e: Error | null, s?: any) => void) { cb(null, { size: 0, isDirectory: () => true }); }, end() {} };
    const t = new DirectoryTransfer('d2', 'A', '/remote/data', localRoot, 'upload-dir',
      { conn: { end() {} } as any, jumpConns: [], sftp: sftp as any });
    (t as any).conns = { conn: { end() {} }, jumpConns: [], sftp };
    const listing = await (t as any).listLocalFiles(localRoot);
    expect(listing).toEqual([
      { relPath: 'file.txt', size: 42 },
      { relPath: 'nested', size: 0, isDir: true },
      { relPath: 'nested/deep.bin', size: 7 },
    ]);
    await rm(localRoot, { recursive: true, force: true });
  });

  it('download-dir reproduces empty subdirectories', async () => {
    const { DirectoryTransfer } = await import('../src/index.js');
    const { mkdtemp, rm, stat } = await import('fs/promises');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const localRoot = await mkdtemp(join(tmpdir(), 'dirdl-empty-'));
    const tree = {
      '/data': { size: 0, dir: true },
      '/data/empty': { size: 0, dir: true },
    };
    const sftp = makeDirSftp(tree);
    const t = new DirectoryTransfer('dl3', 'A', '/data', localRoot, 'download-dir',
      { conn: { end() {} } as any, jumpConns: [], sftp: sftp as any });
    await t.start();
    expect(t.getInfo().state).toBe('completed');
    expect(t.getInfo().filesDone).toBe(0); // empty dirs are not progress-counted files
    const st = await stat(join(localRoot, 'empty'));
    expect(st.isDirectory()).toBe(true);
    await rm(localRoot, { recursive: true, force: true });
  });

  it('upload-dir creates empty subdirectories remotely', async () => {
    const { DirectoryTransfer } = await import('../src/index.js');
    const { mkdtemp, mkdir, rm } = await import('fs/promises');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const localRoot = await mkdtemp(join(tmpdir(), 'dirup-empty-'));
    await mkdir(join(localRoot, 'empty'), { recursive: true });
    const existing = new Set<string>();
    const mkdirs: string[] = [];
    const sftp = {
      stat(path: string, cb: (e: Error | null, s?: any) => void) {
        if (existing.has(path)) cb(null, { size: 0, isDirectory: () => true });
        else cb(new Error('ENOENT') as any);
      },
      lstat(path: string, cb: (e: Error | null, s?: any) => void) {
        if (existing.has(path)) cb(null, { size: 0, isDirectory: () => true, isSymbolicLink: () => false });
        else cb(new Error('ENOENT') as any);
      },
      mkdir(path: string, _opts: any, cb: (e: Error | null) => void) { mkdirs.push(path); existing.add(path); cb(null); },
      end() {},
    };
    const t = new DirectoryTransfer('du1', 'A', '/remote/data', localRoot, 'upload-dir',
      { conn: { end() {} } as any, jumpConns: [], sftp: sftp as any });
    await t.start();
    expect(t.getInfo().state).toBe('completed');
    expect(t.getInfo().filesDone).toBe(0);
    expect(mkdirs).toContain('/remote/data/empty');
    await rm(localRoot, { recursive: true, force: true });
  });

  it('upload-dir refuses to write through a symlinked remote parent', async () => {
    const { DirectoryTransfer } = await import('../src/index.js');
    const { mkdtemp, mkdir, writeFile, rm } = await import('fs/promises');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const localRoot = await mkdtemp(join(tmpdir(), 'dirup-sym-'));
    await mkdir(join(localRoot, 'sub'), { recursive: true });
    await writeFile(join(localRoot, 'sub', 'evil.bin'), Buffer.alloc(5));
    const mkdirs: string[] = [];
    const sftp = {
      stat(_path: string, cb: (e: Error | null, s?: any) => void) {
        cb(new Error('ENOENT') as any);
      },
      lstat(path: string, cb: (e: Error | null, s?: any) => void) {
        if (path === '/remote') {
          cb(null, { size: 0, isDirectory: () => true, isSymbolicLink: () => false });
          return;
        }
        // '/remote/data' and below are a symlink -> /etc
        cb(null, { size: 0, isDirectory: () => true, isSymbolicLink: () => true });
      },
      mkdir(path: string, _opts: any, cb: (e: Error | null) => void) { mkdirs.push(path); cb(null); },
      end() {},
    };
    const t = new DirectoryTransfer('du1s', 'A', '/remote/data', localRoot, 'upload-dir',
      { conn: { end() {} } as any, jumpConns: [], sftp: sftp as any });
    await t.start();
    expect(t.getInfo().state).toBe('failed');
    expect(t.getInfo().error).toContain('symlink');
    await rm(localRoot, { recursive: true, force: true });
  });

  it('download-dir creates missing nested local directories', async () => {
    const { DirectoryTransfer } = await import('../src/index.js');
    const { mkdtemp, rm, readFile, access } = await import('fs/promises');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const localRoot = await mkdtemp(join(tmpdir(), 'dirdl-'));
    const tree = {
      '/data': { size: 0, dir: true },
      '/data/a.bin': { size: 4 },
      '/data/sub': { size: 0, dir: true },
      '/data/sub/b.bin': { size: 4 },
    };
    const contents = new Map([
      ['/data/a.bin', Buffer.from([1, 2, 3, 4])],
      ['/data/sub/b.bin', Buffer.from([5, 6, 7, 8])],
    ]);
    const consumed: Record<string, boolean> = {};
    const statCalls: string[] = [];
    const sftp = {
      opendir(path: string, cb: (err: Error | null, handle?: Buffer) => void) { cb(null, Buffer.from(path)); },
      readdir(handle: Buffer, cb: (err: Error | null, list?: any[]) => void) {
        const key = handle.toString();
        const items: Array<{ filename: string; attrs: { size: number; isDirectory: () => boolean; isSymbolicLink: () => boolean } }> = [];
        for (const [p, info] of Object.entries(tree)) {
          if (p.slice(0, p.lastIndexOf('/')) === key) {
            const name = p.slice(p.lastIndexOf('/') + 1);
            items.push({ filename: name, attrs: { size: info.size, isDirectory: () => !!info.dir, isSymbolicLink: () => false } });
          }
        }
        if (consumed[key]) { cb({ code: 1, message: 'End of file' } as any); return; }
        consumed[key] = true;
        cb(null, items);
      },
      stat(path: string, cb: (err: Error | null, stats?: any) => void) {
        statCalls.push(path);
        const info = tree[path];
        if (info) cb(null, { size: info.size, isDirectory: () => !!info.dir, isSymbolicLink: () => false });
        else cb(new Error('ENOENT') as any);
      },
      lstat(path: string, cb: (err: Error | null, stats?: any) => void) {
        const info = tree[path];
        if (info) cb(null, { size: info.size, isDirectory: () => !!info.dir, isSymbolicLink: () => false });
        else cb(new Error('ENOENT') as any);
      },
      createReadStream(path: string) {
        const { Readable } = require('stream');
        const r = new Readable();
        r._read = () => {};
        r.push(contents.get(path) ?? Buffer.alloc(0));
        r.push(null);
        return r;
      },
      close(_handle: Buffer, cb: (err: Error | null) => void) { cb(null); },
      end() {},
    };
    const t = new DirectoryTransfer('dl1', 'A', '/data', localRoot, 'download-dir',
      { conn: { end() {} } as any, jumpConns: [], sftp: sftp as any },
      { concurrency: 2 });
    await t.start();
    expect(t.getInfo().state).toBe('completed');
    expect(t.getInfo().filesDone).toBe(2);
    const rootFile = await readFile(join(localRoot, 'a.bin'));
    expect([...rootFile]).toEqual([1, 2, 3, 4]);
    await access(join(localRoot, 'sub', 'b.bin'));
    const nestedFile = await readFile(join(localRoot, 'sub', 'b.bin'));
    expect([...nestedFile]).toEqual([5, 6, 7, 8]);
    expect(statCalls).not.toContain('/data');
    expect(statCalls).not.toContain('/data/sub');
    await rm(localRoot, { recursive: true, force: true });
  });
});

describe('DirectoryTransfer concurrency', () => {
  it('runs at most N file transfers concurrently', async () => {
    const { DirectoryTransfer } = await import('../src/index.js');
    const { mkdtemp, rm } = await import('fs/promises');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const localRoot = await mkdtemp(join(tmpdir(), 'dirconc-'));
    let maxActive = 0;
    let active = 0;
    const t = new DirectoryTransfer('c1', 'A', '/data', localRoot, 'download-dir',
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
    await rm(localRoot, { recursive: true, force: true });
  });

  it('waits for in-flight workers before closing the shared connection after a failure', async () => {
    const { DirectoryTransfer } = await import('../src/index.js');
    const { mkdtemp, rm } = await import('fs/promises');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const localRoot = await mkdtemp(join(tmpdir(), 'dirfail-'));
    let releaseSecond!: () => void;
    const secondStarted = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let signalSecondStarted!: () => void;
    const slowWorkerStarted = new Promise<void>((resolve) => { signalSecondStarted = resolve; });
    let secondActive = false;
    const t = new DirectoryTransfer('c2', 'A', '/data', localRoot, 'download-dir',
      { conn: { end() {} } as any, jumpConns: [], sftp: { end() {} } as any },
      { concurrency: 2 });
    (t as any).listFiles = async () => [{ relPath: 'bad', size: 1 }, { relPath: 'slow', size: 1 }];
    (t as any).maybeSkip = async () => false;
    (t as any).transferOne = async (source: string) => {
      if (source.endsWith('/bad')) {
        await slowWorkerStarted;
        throw new Error('injected failure');
      }
      secondActive = true;
      signalSecondStarted();
      await secondStarted;
      secondActive = false;
      return 1;
    };
    let settled = false;
    const start = t.start().then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondActive).toBe(true);
    expect(settled).toBe(false);
    releaseSecond();
    await start;
    expect(t.getInfo().state).toBe('failed');
    await rm(localRoot, { recursive: true, force: true });
  });
});

describe('FileTransfer chunked download', () => {
  it('closes every resolved extra connection when one factory fails', async () => {
    const { FileTransfer } = await import('../src/index.js');
    const closed: string[] = [];
    let calls = 0;
    const makeConnection = (name: string) => ({
      conn: { end() {} },
      jumpConns: [],
      sftp: { end() { closed.push(name); } },
    });
    const ft = new FileTransfer('x-leak', 'A', '/tmp/source', '/remote/file', 'download',
      makeConnection('primary') as any,
      {
        parallelConnectionFactory: async () => {
          const name = `extra-${++calls}`;
          if (name === 'extra-2') {
            await new Promise((resolve) => setTimeout(resolve, 5));
            throw new Error('factory failed');
          }
          await new Promise((resolve) => setTimeout(resolve, name === 'extra-1' ? 15 : 1));
          return makeConnection(name) as any;
        },
      });
    await expect((ft as any).openChunkConnections(4)).rejects.toThrow('factory failed');
    expect(closed).toEqual(expect.arrayContaining(['extra-1', 'extra-3']));
  });

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
      { chunkThreads: 4, chunkSize: 50, chunkThreshold: 100 });
    await ft.start();
    expect(starts.length).toBeGreaterThan(1); // chunked into multiple range reads
    expect(new Set(starts).size).toBeGreaterThan(1); // distinct range starts prove parallel segments
    const finalContent = await readFile(local);
    expect(finalContent.length).toBe(100);
    await rm(dir, { recursive: true, force: true });
  });

  it('uses independent SFTP sessions for chunk ranges when supplied', async () => {
    const { FileTransfer } = await import('../src/index.js');
    const { mkdtemp, readFile, rm } = await import('fs/promises');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const dir = await mkdtemp(join(tmpdir(), 'chunk-dl-conns-'));
    const local = join(dir, 'big.bin');
    const full = Buffer.alloc(100, 0x42);
    const reads: Array<{ connection: string; start: number }> = [];
    const closed: string[] = [];
    const makeSftp = (connection: string) => ({
      stat(_p: string, cb: (e: Error | null, s?: any) => void) { cb(null, { size: full.length, isDirectory: () => false }); },
      createReadStream(_p: string, opts?: any) {
        reads.push({ connection, start: opts?.start ?? 0 });
        const { Readable } = require('stream');
        const r = new Readable();
        r._read = () => {};
        r.push(full.subarray(opts?.start ?? 0, Math.min((opts?.end ?? full.length - 1) + 1, full.length)));
        r.push(null);
        return r;
      },
      rename(_f: string, _t: string, cb: (e: Error | null) => void) { cb(null); },
      end() { closed.push(connection); },
    });
    let factoryCalls = 0;
    const ft = new FileTransfer('x2', 'A', local, '/remote/big.bin', 'download',
      { conn: { end() {} } as any, jumpConns: [], sftp: makeSftp('primary') as any },
      {
        chunkThreads: 4,
        chunkSize: 50,
        chunkThreshold: 100,
        parallelConnectionFactory: async () => {
          factoryCalls += 1;
          return { conn: { end() {} } as any, jumpConns: [], sftp: makeSftp(`extra-${factoryCalls}`) as any };
        },
      });
    await ft.start();
    expect(ft.getInfo().state).toBe('completed');
    expect(factoryCalls).toBe(1);
    expect(new Set(reads.map((read) => read.connection))).toEqual(new Set(['primary', 'extra-1']));
    expect(closed).toContain('extra-1');
    expect(await readFile(local)).toEqual(full);
    await rm(dir, { recursive: true, force: true });
  });

  it('opens extra chunk connections concurrently, not serially', async () => {
    const { FileTransfer } = await import('../src/index.js');
    const { mkdtemp, readFile, rm } = await import('fs/promises');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const dir = await mkdtemp(join(tmpdir(), 'chunk-dl-par-'));
    const local = join(dir, 'big.bin');
    const full = Buffer.alloc(100, 0x42);
    const reads: Array<{ connection: string; start: number }> = [];
    const closed: string[] = [];
    const makeSftp = (connection: string) => ({
      stat(_p: string, cb: (e: Error | null, s?: any) => void) { cb(null, { size: full.length, isDirectory: () => false }); },
      createReadStream(_p: string, opts?: any) {
        reads.push({ connection, start: opts?.start ?? 0 });
        const { Readable } = require('stream');
        const r = new Readable();
        r._read = () => {};
        r.push(full.subarray(opts?.start ?? 0, Math.min((opts?.end ?? full.length - 1) + 1, full.length)));
        r.push(null);
        return r;
      },
      rename(_f: string, _t: string, cb: (e: Error | null) => void) { cb(null); },
      end() { closed.push(connection); },
    });
    let factoryCalls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const started = Date.now();
    const ft = new FileTransfer('x7', 'A', local, '/remote/big.bin', 'download',
      { conn: { end() {} } as any, jumpConns: [], sftp: makeSftp('primary') as any },
      {
        chunkThreads: 4,
        chunkSize: 25,
        chunkThreshold: 100,
        parallelConnectionFactory: async () => {
          const name = `extra-${++factoryCalls}`;
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 40));
          inFlight -= 1;
          return { conn: { end() {} } as any, jumpConns: [], sftp: makeSftp(name) as any };
        },
      });
    await ft.start();
    const elapsed = Date.now() - started;
    expect(ft.getInfo().state).toBe('completed');
    expect(factoryCalls).toBe(3);
    // Three extras open concurrently: peak in-flight > 1 proves Promise.all,
    // not a serial loop. Wall-clock stays well under 2× the factory latency.
    expect(maxInFlight).toBeGreaterThan(1);
    expect(elapsed).toBeLessThan(100);
    expect(new Set(reads.map((read) => read.connection))).toEqual(new Set(['primary', 'extra-1', 'extra-2', 'extra-3']));
    expect(closed).toContain('extra-1');
    expect(closed).toContain('extra-2');
    expect(closed).toContain('extra-3');
    expect(await readFile(local)).toEqual(full);
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
      { chunkThreads: 4, chunkSize: 50, chunkThreshold: 100 });
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
      { chunkThreads: 4, chunkSize: 50, chunkThreshold: 100 });
    await ft.start();
    expect(ft.getInfo().state).toBe('failed');
    expect(ft.getInfo().error).toContain('segment 0 read failed');
    expect(destroyed).toContain(50);
    await rm(dir, { recursive: true, force: true });
  });

  it('removes the sparse .part on chunked failure so a re-run succeeds', async () => {
    const { FileTransfer } = await import('../src/index.js');
    const { mkdtemp, readFile, rm, stat } = await import('fs/promises');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const dir = await mkdtemp(join(tmpdir(), 'chunk-dlfix-'));
    const local = join(dir, 'big.bin');
    const part = `${local}.part`;
    const full = Buffer.alloc(100, 0x42);
    let failFirst = true;
    const makeSftp = () => {
      let readCount = 0;
      return {
        stat(p: string, cb: (e: Error | null, s?: any) => void) { cb(null, { size: full.length, isDirectory: () => false }); },
        createReadStream(p: string, opts?: any) {
          const { Readable } = require('stream');
          const r = new Readable();
          r._read = () => {};
          if (failFirst && readCount === 0) {
            readCount += 1;
            r.destroy(new Error('segment 0 read failed'));
            return r;
          }
          readCount += 1;
          const start = opts?.start ?? 0;
          const end = opts?.end === undefined ? full.length - 1 : opts.end;
          r.push(full.subarray(start, Math.min(end + 1, full.length)));
          r.push(null);
          return r;
        },
        rename(f: string, t: string, cb: (e: Error | null) => void) { cb(null); },
        end() {},
      };
    };

    const t1 = new FileTransfer('x5', 'A', local, '/remote/big.bin', 'download',
      { conn: { end() {} } as any, jumpConns: [], sftp: makeSftp() as any },
      { chunkThreads: 4, chunkSize: 50, chunkThreshold: 100 });
    await t1.start();
    expect(t1.getInfo().state).toBe('failed');
    await expect(stat(part)).rejects.toThrow(); // sparse chunked .part cleaned up

    failFirst = false;
    const t2 = new FileTransfer('x6', 'A', local, '/remote/big.bin', 'download',
      { conn: { end() {} } as any, jumpConns: [], sftp: makeSftp() as any },
      { chunkThreads: 4, chunkSize: 50, chunkThreshold: 100 });
    await t2.start();
    expect(t2.getInfo().state).toBe('completed');
    expect((await readFile(local)).length).toBe(100);
    await rm(dir, { recursive: true, force: true });
  });
});
