import { describe, it, expect } from 'vitest';

function makeFakeShell() {
  const writes: string[] = [];
  const shell = {
    write(data: string, cb?: (err: Error | null) => void) {
      writes.push(data);
      cb?.(null);
    },
  };
  return { shell, writes };
}

function markerFromWrites(writes: string[]): string {
  const printfCmd = writes.find((w) => w.includes('__MCP_DONE__')) ?? '';
  const m = /(__MCP_DONE__[0-9a-f-]+__)/.exec(printfCmd);
  if (!m) throw new Error(`no marker found in writes: ${JSON.stringify(writes)}`);
  return m[1];
}

describe('resolveExecFinishState', () => {
  it('returns cancelled when cancel was requested regardless of exit code', async () => {
    const { resolveExecFinishState } = await import('../src/index.js');
    expect(resolveExecFinishState(true, 0)).toBe('cancelled');
    expect(resolveExecFinishState(true, 130)).toBe('cancelled');
  });

  it('returns completed for exit 0 and failed for non-zero', async () => {
    const { resolveExecFinishState } = await import('../src/index.js');
    expect(resolveExecFinishState(false, 0)).toBe('completed');
    expect(resolveExecFinishState(false, 1)).toBe('failed');
  });
});

describe('ShellCommandQueue', () => {
  it('launch writes the command and a completion marker, then streams output incrementally', async () => {
    const { ShellCommandQueue } = await import('../src/index.js');
    const { shell, writes } = makeFakeShell();
    const q = new ShellCommandQueue(shell as any);
    const chunks: string[] = [];
    let done: { output: string; exitCode: number } | null = null;
    q.launch('echo hello', { onData: (c) => chunks.push(c), onDone: (r) => { done = r; } });

    expect(writes[0]).toBe('echo hello\n');
    expect(writes[1]).toContain('__MCP_DONE__');
    const marker = markerFromWrites(writes);
    expect(q.hasPending).toBe(true);

    q.handleData('line one\r\n');
    expect(chunks).toEqual(['line one\r\n']);
    expect(done).toBeNull();

    q.handleData(`line two\r\n${marker}0\n`);
    expect(chunks).toEqual(['line one\r\n', 'line two\r\n']);
    expect(done).toEqual({ output: 'line one\nline two', exitCode: 0 });
    expect(q.hasPending).toBe(false);
  });

  it('parses a non-zero exit code and strips the exit marker line from output', async () => {
    const { ShellCommandQueue } = await import('../src/index.js');
    const { shell, writes } = makeFakeShell();
    const q = new ShellCommandQueue(shell as any);
    let done: { output: string; exitCode: number } | null = null;
    q.launch('false', { onDone: (r) => { done = r; } });
    const marker = markerFromWrites(writes);
    q.handleData(`err output${marker}1\n`);
    expect(done).toEqual({ output: 'err output', exitCode: 1 });
  });

  it('strips __MCP_READY__ bootstrap output from the result', async () => {
    const { ShellCommandQueue } = await import('../src/index.js');
    const { shell, writes } = makeFakeShell();
    const q = new ShellCommandQueue(shell as any);
    let done: { output: string; exitCode: number } | null = null;
    q.launch('echo hi', { onDone: (r) => { done = r; } });
    const marker = markerFromWrites(writes);
    q.handleData(`__MCP_READY__ hi${marker}0\n`);
    expect(done!.output).toBe('hi');
  });

  it('interrupt sends Ctrl-C to the shell', async () => {
    const { ShellCommandQueue } = await import('../src/index.js');
    const { shell, writes } = makeFakeShell();
    const q = new ShellCommandQueue(shell as any);
    q.interrupt();
    expect(writes).toEqual(['\u0003']);
  });

  it('launch rejects a second concurrent command', async () => {
    const { ShellCommandQueue } = await import('../src/index.js');
    const { shell } = makeFakeShell();
    const q = new ShellCommandQueue(shell as any);
    q.launch('sleep 1', {});
    expect(() => q.launch('echo nope', {})).toThrow(/Another command/);
  });

  it('handleClose invokes onError for a pending command', async () => {
    const { ShellCommandQueue } = await import('../src/index.js');
    const { shell } = makeFakeShell();
    const q = new ShellCommandQueue(shell as any);
    let err: Error | null = null;
    q.launch('sleep 1', { onError: (e) => { err = e; } });
    q.handleClose();
    expect(err).not.toBeNull();
    expect(q.hasPending).toBe(false);
  });
});
