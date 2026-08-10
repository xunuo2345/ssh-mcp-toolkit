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
    expect(source.calls.read).toEqual([]); // no read stream (skipped)
    expect(await readFile(local)).toEqual(full); // renamed into place
    await expect(stat(part)).rejects.toThrow();
    expect(transfer.getInfo().state).toBe('completed');
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
