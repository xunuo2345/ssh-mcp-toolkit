import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

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
