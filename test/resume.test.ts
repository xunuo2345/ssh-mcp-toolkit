import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { Readable } from 'stream';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('resolveResumeOffset', () => {
  it('returns 0 when no part file exists', async () => {
    const { resolveResumeOffset } = await import('../src/index.js');
    expect(resolveResumeOffset(null, 1000)).toBe(0);
  });

  it('returns the part size when it is smaller than the source (resume)', async () => {
    const { resolveResumeOffset } = await import('../src/index.js');
    expect(resolveResumeOffset(500, 1000)).toBe(500);
  });

  it('returns the part size when it equals the source (verify only)', async () => {
    const { resolveResumeOffset } = await import('../src/index.js');
    expect(resolveResumeOffset(1000, 1000)).toBe(1000);
  });

  it('returns 0 when the part is larger than the source (corrupt, rebuild)', async () => {
    const { resolveResumeOffset } = await import('../src/index.js');
    expect(resolveResumeOffset(2000, 1000)).toBe(0);
  });
});

describe('sha256File', () => {
  it('computes the sha256 of a file', async () => {
    const { sha256File } = await import('../src/index.js');
    const dir = await mkdtemp(join(tmpdir(), 'resume-sha-'));
    const p = join(dir, 'data.bin');
    const content = Buffer.from('hello resumable world');
    await writeFile(p, content);
    expect(await sha256File(p)).toBe(sha256(content));
    await rm(dir, { recursive: true, force: true });
  });
});

describe('partPathFor', () => {
  it('appends .part to the target path', async () => {
    const { partPathFor } = await import('../src/index.js');
    expect(partPathFor('/data/file.bin')).toBe('/data/file.bin.part');
    expect(partPathFor('/data/dir/file')).toBe('/data/dir/file.part');
  });
});

describe('FileTransfer download resume', () => {
  function makeFakeSftpForResume(sourceSize: number, sourceContent: Buffer) {
    const calls = { read: [] as Array<{ path: string; start?: number }>, end: 0 };
    let started = 0;
    const sftp = {
      stat(path: string, cb: (error: Error | null, stats?: any) => void) {
        cb(null, { size: sourceSize, isDirectory: () => false });
      },
      createReadStream(path: string, opts?: any) {
        calls.read.push({ path, start: opts?.start });
        const start = opts?.start ?? 0;
        started = start;
        const content = sourceContent.subarray(start);
        const r = new Readable();
        r._read = () => {};
        r.push(content);
        r.push(null);
        return r;
      },
      end() { calls.end += 1; },
    };
    return { sftp, calls, getStarted: () => started };
  }

  it('download resumes from the .part offset, then renames and verifies', async () => {
    const { FileTransfer, partPathFor } = await import('../src/index.js');
    const dir = await mkdtemp(join(tmpdir(), 'resume-dl-'));
    const local = join(dir, 'file.bin');
    const part = partPathFor(local);
    const full = Buffer.from('0123456789ABCDEF'); // 16 bytes
    const half = full.subarray(0, 8);
    await writeFile(part, half); // pre-existing .part with 8 bytes
    const source = makeFakeSftpForResume(16, full);
    const transfer = new FileTransfer('r1', 'A', local, '/remote/file.bin', 'download',
      { conn: { end() {} } as any, jumpConns: [], sftp: source.sftp as any });
    await transfer.start();
    expect(source.calls.read[0].start).toBe(8); // resumed from offset 8
    const finalContent = await readFile(local);
    expect(finalContent).toEqual(full);
    await expect(stat(part)).rejects.toThrow(); // .part renamed away
    expect(transfer.getInfo().state).toBe('completed');
    await rm(dir, { recursive: true, force: true });
  });

  it('download with a full .part skips transfer and verifies', async () => {
    const { FileTransfer, partPathFor } = await import('../src/index.js');
    const dir = await mkdtemp(join(tmpdir(), 'resume-dl2-'));
    const local = join(dir, 'file.bin');
    const part = partPathFor(local);
    const full = Buffer.from('same content here');
    await writeFile(part, full); // .part equals source
    const source = makeFakeSftpForResume(full.length, full);
    const transfer = new FileTransfer('r2', 'A', local, '/remote/file.bin', 'download',
      { conn: { end() {} } as any, jumpConns: [], sftp: source.sftp as any });
    await transfer.start();
    expect(source.calls.read.length).toBe(1); // only the sha256 verification stream
    expect(source.calls.read[0].start).toBeUndefined(); // no offset-resume transfer read
    expect(await readFile(local)).toEqual(full); // renamed into place
    await expect(stat(part)).rejects.toThrow();
    expect(transfer.getInfo().state).toBe('completed');
    await rm(dir, { recursive: true, force: true });
  });

  it('download of an empty remote file completes', async () => {
    const { FileTransfer, partPathFor } = await import('../src/index.js');
    const dir = await mkdtemp(join(tmpdir(), 'resume-dl4-'));
    const local = join(dir, 'file.bin');
    const part = partPathFor(local);
    const source = makeFakeSftpForResume(0, Buffer.alloc(0)); // 0-byte remote, no .part
    const transfer = new FileTransfer('r4', 'A', local, '/remote/empty.bin', 'download',
      { conn: { end() {} } as any, jumpConns: [], sftp: source.sftp as any });
    await transfer.start();
    const info = transfer.getInfo();
    expect(info.state).toBe('completed');
    expect((await stat(local)).size).toBe(0);
    await expect(stat(part)).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });

  it('download with an oversized .part rebuilds from scratch', async () => {
    const { FileTransfer, partPathFor } = await import('../src/index.js');
    const dir = await mkdtemp(join(tmpdir(), 'resume-dl3-'));
    const local = join(dir, 'file.bin');
    const part = partPathFor(local);
    const full = Buffer.from('short');
    await writeFile(part, Buffer.alloc(100, 0x41)); // 100 bytes > 5-byte source
    const source = makeFakeSftpForResume(5, full);
    const transfer = new FileTransfer('r3', 'A', local, '/remote/file.bin', 'download',
      { conn: { end() {} } as any, jumpConns: [], sftp: source.sftp as any });
    await transfer.start();
    expect(source.calls.read[0].start).toBe(0); // rebuilt from 0
    const finalContent = await readFile(local);
    expect(finalContent).toEqual(full);
    expect(transfer.getInfo().state).toBe('completed');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('FileTransfer upload resume', () => {
  function makeRemoteSftpForResume(initial?: Buffer, corruptRead = false, writeError?: string) {
    const calls = {
      open: [] as Array<{ path: string; flags: string }>,
      write: [] as Array<{ position: number; len: number }>,
      rename: [] as Array<{ from: string; to: string }>,
      fstat: [] as number[],
      end: 0,
    };
    let remoteContent = Buffer.from(initial ?? Buffer.alloc(0));
    const handles: Array<{ path: string }> = [];
    const sftp = {
      stat(path: string, cb: (error: Error | null, stats?: any) => void) {
        cb(null, { size: remoteContent.length, isDirectory: () => true });
      },
      open(path: string, flags: string, cb: (error: Error | null, handle?: Buffer) => void) {
        calls.open.push({ path, flags });
        handles.push({ path });
        cb(null, Buffer.from([handles.length]));
      },
      write(handle: Buffer, buf: Buffer, offset: number, length: number, position: number, cb: (error: Error | null) => void) {
        calls.write.push({ position, len: length });
        if (writeError) {
          setTimeout(() => cb(new Error(writeError)), 5);
          return;
        }
        const endPos = position + length;
        if (endPos > remoteContent.length) {
          const grown = Buffer.alloc(endPos);
          remoteContent.copy(grown);
          buf.copy(grown, position);
          remoteContent = grown;
        } else {
          buf.copy(remoteContent, position);
        }
        cb(null);
      },
      close(handle: Buffer, cb: (error: Error | null) => void) {
        cb(null);
      },
      fstat(handle: Buffer, cb: (error: Error | null, stats?: any) => void) {
        cb(null, { size: remoteContent.length });
      },
      rename(from: string, to: string, cb: (error: Error | null) => void) {
        calls.rename.push({ from, to });
        cb(null);
      },
      createReadStream(path: string) {
        const data = corruptRead ? Buffer.alloc(remoteContent.length, 0xff) : remoteContent;
        const r = new Readable();
        r._read = () => {};
        r.push(data);
        r.push(null);
        return r;
      },
      end() { calls.end += 1; },
    };
    return { sftp, calls, getContent: () => remoteContent };
  }

  it('upload resumes from the remote .part offset, renames and verifies', async () => {
    const { FileTransfer, partPathFor } = await import('../src/index.js');
    const dir = await mkdtemp(join(tmpdir(), 'resume-up-'));
    const local = join(dir, 'src.bin');
    const full = Buffer.from('local source data 1234567890');
    await writeFile(local, full);
    const seeded = full.subarray(0, 8); // pre-existing remote .part with 8 bytes
    const remote = makeRemoteSftpForResume(seeded);
    const transfer = new FileTransfer('u1', 'A', local, '/remote/dst.bin', 'upload',
      { conn: { end() {} } as any, jumpConns: [], sftp: remote.sftp as any });
    await transfer.start();
    expect(transfer.getInfo().state).toBe('completed');
    expect(remote.getContent().equals(full)).toBe(true);
    expect(remote.calls.open).toEqual([{ path: partPathFor('/remote/dst.bin'), flags: 'a' }]); // resumed in append mode
    expect(remote.calls.write[0].position).toBe(8); // resumed from offset 8
    expect(remote.calls.rename).toEqual([{ from: partPathFor('/remote/dst.bin'), to: '/remote/dst.bin' }]);
    expect(remote.calls.write.length).toBeGreaterThan(0);
    await rm(dir, { recursive: true, force: true });
  });

  it('upload reports failed on sha256 mismatch without renaming', async () => {
    const { FileTransfer } = await import('../src/index.js');
    const dir = await mkdtemp(join(tmpdir(), 'resume-up2-'));
    const local = join(dir, 'src.bin');
    await writeFile(local, Buffer.from('content that will mismatch'));
    const remote = makeRemoteSftpForResume(undefined, true); // corruptRead: hash-verification stream returns wrong bytes
    const transfer = new FileTransfer('u2', 'A', local, '/remote/dst.bin', 'upload',
      { conn: { end() {} } as any, jumpConns: [], sftp: remote.sftp as any });
    await transfer.start();
    expect(transfer.getInfo().state).toBe('failed');
    expect(remote.calls.rename).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it('upload cancelled mid-transfer settles start() without hanging', async () => {
    const { FileTransfer } = await import('../src/index.js');
    const dir = await mkdtemp(join(tmpdir(), 'resume-up3-'));
    const local = join(dir, 'big.bin');
    await writeFile(local, Buffer.alloc(32 * 1024 * 1024, 0x61));
    const remote = makeRemoteSftpForResume();
    const transfer = new FileTransfer('u3', 'A', local, '/remote/dst.bin', 'upload',
      { conn: { end() {} } as any, jumpConns: [], sftp: remote.sftp as any });
    const startPromise = transfer.start();
    await new Promise((r) => setTimeout(r, 5));
    await transfer.cancel();
    await Promise.race([
      startPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('start() hung after cancel')), 2000)),
    ]);
    expect(transfer.getInfo().state).toBe('cancelled');
    await rm(dir, { recursive: true, force: true });
  });

  it('upload surfaces a last-chunk write error as failed instead of size mismatch', async () => {
    const { FileTransfer } = await import('../src/index.js');
    const dir = await mkdtemp(join(tmpdir(), 'resume-up4-'));
    const local = join(dir, 'src.bin');
    await writeFile(local, Buffer.from('tiny single-chunk source'));
    const remote = makeRemoteSftpForResume(undefined, false, 'injected write failure');
    const transfer = new FileTransfer('u4', 'A', local, '/remote/dst.bin', 'upload',
      { conn: { end() {} } as any, jumpConns: [], sftp: remote.sftp as any });
    await transfer.start();
    expect(transfer.getInfo().state).toBe('failed');
    expect(transfer.getInfo().error).toContain('injected write failure');
    await rm(dir, { recursive: true, force: true });
  });
});
