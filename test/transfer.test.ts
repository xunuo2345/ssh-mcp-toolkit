import { describe, it, expect } from 'vitest';

const MB = 1024 * 1024;

describe('validateTransferParams', () => {
  it('accepts valid params', async () => {
    const { validateTransferParams } = await import('../src/index.js');
    expect(() =>
      validateTransferParams({ sourceHost: 'A', targetHost: 'B', sourcePath: '/a', targetPath: '/b', mode: 'auto', sizeThresholdMb: 10 })
    ).not.toThrow();
  });

  it('rejects an invalid mode', async () => {
    const { validateTransferParams } = await import('../src/index.js');
    expect(() =>
      validateTransferParams({ sourceHost: 'A', targetHost: 'B', sourcePath: '/a', targetPath: '/b', mode: 'turbo' })
    ).toThrow(/mode/);
  });

  it('rejects relative paths', async () => {
    const { validateTransferParams } = await import('../src/index.js');
    expect(() => validateTransferParams({ sourceHost: 'A', targetHost: 'B', sourcePath: 'relative', targetPath: '/b' })).toThrow(/source_path/);
    expect(() => validateTransferParams({ sourceHost: 'A', targetHost: 'B', sourcePath: '/a', targetPath: 'relative' })).toThrow(/target_path/);
  });

  it('rejects a non-positive or non-integer size threshold', async () => {
    const { validateTransferParams } = await import('../src/index.js');
    expect(() => validateTransferParams({ sourceHost: 'A', targetHost: 'B', sourcePath: '/a', targetPath: '/b', sizeThresholdMb: 0 })).toThrow(/size_threshold_mb/);
    expect(() => validateTransferParams({ sourceHost: 'A', targetHost: 'B', sourcePath: '/a', targetPath: '/b', sizeThresholdMb: 10.5 })).toThrow(/size_threshold_mb/);
  });

  it('rejects identical source and target hosts', async () => {
    const { validateTransferParams } = await import('../src/index.js');
    expect(() => validateTransferParams({ sourceHost: 'A', targetHost: 'A', sourcePath: '/a', targetPath: '/b' })).toThrow(/differ/);
  });
});

describe('resolveTransferMode', () => {
  it('auto uses stream for files below the threshold', async () => {
    const { resolveTransferMode } = await import('../src/index.js');
    expect(resolveTransferMode('auto', 99 * MB, 100 * MB, false)).toBe('stream');
  });

  it('auto uses direct for files at or above the threshold', async () => {
    const { resolveTransferMode } = await import('../src/index.js');
    expect(resolveTransferMode('auto', 100 * MB, 100 * MB, false)).toBe('direct');
    expect(resolveTransferMode('auto', 200 * MB, 100 * MB, false)).toBe('direct');
  });

  it('auto forces direct for directories', async () => {
    const { resolveTransferMode } = await import('../src/index.js');
    expect(resolveTransferMode('auto', 1 * MB, 10 * MB, true)).toBe('direct');
  });

  it('passes through explicit modes', async () => {
    const { resolveTransferMode } = await import('../src/index.js');
    expect(resolveTransferMode('direct', 1, 10, false)).toBe('direct');
    expect(resolveTransferMode('stream', 1000, 10, false)).toBe('stream');
    expect(resolveTransferMode('hybrid', 1000, 10, false)).toBe('hybrid');
  });
});

describe('parseRsyncProgress', () => {
  it('parses a typical progress2 record', async () => {
    const { parseRsyncProgress } = await import('../src/index.js');
    expect(parseRsyncProgress('1,000,000 10% 1.00MB/s 0:01:00')).toEqual({ bytes: 1000000, percent: 10, speed: '1.00MB/s' });
  });

  it('parses the final 100% record', async () => {
    const { parseRsyncProgress } = await import('../src/index.js');
    expect(parseRsyncProgress('10,000,000 100% 5.00MB/s 0:00:10 (xfr#1, to-chk=0/1)')).toEqual({ bytes: 10000000, percent: 100, speed: '5.00MB/s' });
  });

  it('returns null for garbage input', async () => {
    const { parseRsyncProgress } = await import('../src/index.js');
    expect(parseRsyncProgress('not a progress line')).toBeNull();
    expect(parseRsyncProgress('')).toBeNull();
  });
});

describe('quoteShellArg', () => {
  it('quotes a simple argument', async () => {
    const { quoteShellArg } = await import('../src/index.js');
    expect(quoteShellArg('/var/backup/full.dump')).toBe("'/var/backup/full.dump'");
  });

  it('escapes embedded single quotes', async () => {
    const { quoteShellArg } = await import('../src/index.js');
    expect(quoteShellArg("it's here")).toBe(`'it'\\''s here'`);
  });
});

describe('buildDirectCommand', () => {
  it('builds a direct rsync command with proper quoting', async () => {
    const { buildDirectCommand } = await import('../src/index.js');
    const cmd = buildDirectCommand({
      targetUser: 'bob',
      targetHost: '10.0.0.5',
      targetPort: 2222,
      sourcePath: '/var/backup/full.dump',
      targetPath: '/data/backup/full.dump',
    });
    expect(cmd).toContain('ssh -p 2222 -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15 bob@10.0.0.5');
    expect(cmd).toContain("mkdir -p '\\''/data/backup'\\''");
    expect(cmd).toContain('rsync -a --partial --inplace --size-only --info=progress2 --no-motd');
    expect(cmd).toContain("-e 'ssh -p 2222 -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15'");
    expect(cmd).toContain("'/var/backup/full.dump'");
    expect(cmd).toContain("'bob@10.0.0.5:/data/backup/full.dump'");
  });
});
