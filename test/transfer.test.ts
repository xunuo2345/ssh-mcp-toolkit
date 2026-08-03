import { describe, it, expect } from 'vitest';
import { PassThrough, Writable, EventEmitter } from 'stream';

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

describe('formatRsyncFailureMessage', () => {
  it('appends an install hint when rsync is missing on the source host', async () => {
    const { formatRsyncFailureMessage } = await import('../src/index.js');
    const msg = formatRsyncFailureMessage(
      'rsync exited with code 127: sh: 1: rsync: not found',
      'sh: 1: rsync: not found',
    );
    expect(msg).toContain('install it');
    expect(msg).toContain('hybrid');
  });

  it('leaves other rsync failures untouched', async () => {
    const { formatRsyncFailureMessage } = await import('../src/index.js');
    const msg = formatRsyncFailureMessage(
      'rsync exited with code 1: Permission denied (publickey)',
      'Permission denied (publickey)',
    );
    expect(msg).not.toContain('install it');
  });
});

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

function makeFakeExecConn(exitCode: number, stdout: string, stderr: string) {
  const channel = new EventEmitter() as any;
  channel.stderr = new EventEmitter();
  channel.exitCode = exitCode;
  channel.close = () => {
    channel.emit('close');
  };
  const execCalls: string[] = [];
  const conn = {
    exec(command: string, cb: (error: Error | null, stream?: any) => void) {
      execCalls.push(command);
      cb(null, channel);
    },
    end() {},
  };
  return { conn, channel, execCalls };
}

function fakeResolved(host: string, port: number, username: string) {
  return {
    config: { host, port, username },
    jumpConfig: undefined,
    jumpHostId: undefined,
    jumpConfigs: [],
    jumpHostIds: [],
  };
}

const srcResolved = fakeResolved('10.0.0.1', 22, 'alice');
const tgtResolved = fakeResolved('10.0.0.5', 2222, 'bob');

describe('ServerTransfer', () => {
  it('stream mode completes, counts bytes, and keeps a snapshot after dispose', async () => {
    const { ServerTransfer } = await import('../src/index.js');
    const source = makeFakeSftp(10);
    const target = makeFakeSftp(0, true);
    const transfer = new ServerTransfer(
      't1', 'A', 'B', srcResolved as any, tgtResolved as any,
      '/var/backup/full.dump', '/data/backup/full.dump', 'stream',
      {
        source: { conn: { end() {} } as any, jumpConns: [], sftp: source.sftp as any },
        target: { conn: { end() {} } as any, jumpConns: [], sftp: target.sftp as any },
      },
    );
    const p = transfer.start();
    await new Promise((r) => setImmediate(r));
    source.getReadStream()!.write('hello');
    source.getReadStream()!.end();
    await p;
    const info = transfer.getInfo();
    expect(info.state).toBe('completed');
    expect(info.transferredBytes).toBe(5);
    expect(info.totalBytes).toBe(10);
    expect(info.percent).toBe(50);
    expect(source.calls.read).toEqual(['/var/backup/full.dump']);
    expect(target.calls.write).toEqual(['/data/backup/full.dump']);
    expect(target.calls.mkdir).toEqual([]);
    expect(target.writeChunks.join('')).toBe('hello');
    expect(source.calls.end).toBe(1);
    expect(transfer.getInfo().state).toBe('completed');
  });

  it('stream mode can be cancelled', async () => {
    const { ServerTransfer } = await import('../src/index.js');
    const source = makeFakeSftp(100);
    const target = makeFakeSftp(0);
    const transfer = new ServerTransfer('t2', 'A', 'B', srcResolved as any, tgtResolved as any, '/s', '/t', 'stream',
      {
        source: { conn: { end() {} } as any, jumpConns: [], sftp: source.sftp as any },
        target: { conn: { end() {} } as any, jumpConns: [], sftp: target.sftp as any },
      },
    );
    const p = transfer.start();
    await new Promise((r) => setImmediate(r));
    source.getReadStream()!.write('partial');
    await new Promise((r) => setTimeout(r, 10));
    await transfer.cancel();
    await p;
    expect(transfer.getInfo().state).toBe('cancelled');
  });

  it('direct mode completes on exit code 0', async () => {
    const { ServerTransfer } = await import('../src/index.js');
    const { conn, channel, execCalls } = makeFakeExecConn(0, '', '');
    const transfer = new ServerTransfer('t3', 'A', 'B', srcResolved as any, tgtResolved as any, '/s', '/t', 'direct',
      { source: { conn: conn as any, jumpConns: [], sftp: undefined } },
    );
    const p = transfer.start();
    await new Promise((r) => setImmediate(r));
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toContain('rsync');
    expect(execCalls[0]).toContain('bob@10.0.0.5');
    channel.emit('data', Buffer.from('10,000,000 100% 5.00MB/s 0:00:10\r'));
    channel.emit('close');
    await p;
    const info = transfer.getInfo();
    expect(info.state).toBe('completed');
    expect(info.transferredBytes).toBe(10000000);
    expect(info.percent).toBe(100);
  });

  it('direct mode ignores a 0% progress record when deriving totalBytes', async () => {
    const { ServerTransfer } = await import('../src/index.js');
    const { conn, channel } = makeFakeExecConn(0, '', '');
    const transfer = new ServerTransfer('t3b', 'A', 'B', srcResolved as any, tgtResolved as any, '/s', '/t', 'direct',
      { source: { conn: conn as any, jumpConns: [], sftp: undefined } },
    );
    const p = transfer.start();
    await new Promise((r) => setImmediate(r));
    channel.emit('data', Buffer.from('32,768 0% 0.00kB/s 0:00:00\r'));
    channel.emit('data', Buffer.from('10,000,000 100% 5.00MB/s 0:00:10 (xfr#1, to-chk=0/1)\r'));
    channel.emit('close');
    await p;
    const info = transfer.getInfo();
    expect(info.state).toBe('completed');
    expect(info.totalBytes).toBe(10000000);
    expect(info.percent).toBe(100);
  });

  it('direct mode fails on a non-zero exit', async () => {
    const { ServerTransfer } = await import('../src/index.js');
    const { conn, channel } = makeFakeExecConn(1, '', 'rsync: command not found\n');
    const transfer = new ServerTransfer('t4', 'A', 'B', srcResolved as any, tgtResolved as any, '/s', '/t', 'direct',
      { source: { conn: conn as any, jumpConns: [], sftp: undefined } },
    );
    const p = transfer.start();
    await new Promise((r) => setImmediate(r));
    channel.stderr.emit('data', Buffer.from('rsync: command not found\n'));
    channel.emit('close');
    await p;
    const info = transfer.getInfo();
    expect(info.state).toBe('failed');
    expect(info.error).toContain('rsync: command not found');
  });

  it('hybrid falls back to stream when direct fails', async () => {
    const { ServerTransfer } = await import('../src/index.js');
    const { conn, channel } = makeFakeExecConn(1, '', 'no route to host');
    const source = makeFakeSftp(10);
    const target = makeFakeSftp(0);
    const transfer = new ServerTransfer('t5', 'A', 'B', srcResolved as any, tgtResolved as any, '/s', '/t', 'hybrid',
      {
        source: { conn: conn as any, jumpConns: [], sftp: source.sftp as any },
        target: { conn: { end() {} } as any, jumpConns: [], sftp: target.sftp as any },
      },
    );
    const p = transfer.start();
    await new Promise((r) => setImmediate(r));
    channel.stderr.emit('data', Buffer.from('no route to host\n'));
    channel.emit('close');
    await new Promise((r) => setImmediate(r));
    source.getReadStream()!.write('hello');
    source.getReadStream()!.end();
    await p;
    const info = transfer.getInfo();
    expect(info.state).toBe('completed');
    expect(info.transferredBytes).toBe(5);
    expect(target.writeChunks.join('')).toBe('hello');
  });

  it('cancel throws for an already-finished transfer', async () => {
    const { ServerTransfer } = await import('../src/index.js');
    const source = makeFakeSftp(10);
    const target = makeFakeSftp(0);
    const transfer = new ServerTransfer('t6', 'A', 'B', srcResolved as any, tgtResolved as any, '/s', '/t', 'stream',
      {
        source: { conn: { end() {} } as any, jumpConns: [], sftp: source.sftp as any },
        target: { conn: { end() {} } as any, jumpConns: [], sftp: target.sftp as any },
      },
    );
    const p = transfer.start();
    await new Promise((r) => setImmediate(r));
    source.getReadStream()!.write('hello');
    source.getReadStream()!.end();
    await p;
    await expect(transfer.cancel()).rejects.toThrow(/already/);
  });
});
