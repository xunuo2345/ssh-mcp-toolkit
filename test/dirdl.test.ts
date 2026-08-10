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
