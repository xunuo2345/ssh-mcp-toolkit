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

describe('ShellCommandQueue.sendInput', () => {
  it('writes the input text verbatim to the shell', async () => {
    const { ShellCommandQueue } = await import('../src/index.js');
    const { shell, writes } = makeFakeShell();
    const q = new ShellCommandQueue(shell as any);
    q.sendInput('1\n');
    q.sendInput('next-option\r');
    expect(writes).toEqual(['1\n', 'next-option\r']);
  });

  it('sendInput works without a running command', async () => {
    const { ShellCommandQueue } = await import('../src/index.js');
    const { shell, writes } = makeFakeShell();
    const q = new ShellCommandQueue(shell as any);
    q.sendInput('echo hello\n');
    expect(writes).toEqual(['echo hello\n']);
  });
});

describe('ShellCommandQueue.launch interactive mode', () => {
  it('interactive launch writes only the command without the completion marker', async () => {
    const { ShellCommandQueue } = await import('../src/index.js');
    const { shell, writes } = makeFakeShell();
    const q = new ShellCommandQueue(shell as any);
    q.launch('menu', { onData: () => {}, onDone: () => {}, onError: () => {} }, { interactive: true });
    expect(writes.length).toBe(1);
    expect(writes[0]).toBe('menu\n');
    expect(writes.some((w) => w.includes('__MCP_DONE__'))).toBe(false);
  });

  it('interrupt in interactive mode writes Ctrl-C, newline, then the completion marker', async () => {
    const { ShellCommandQueue } = await import('../src/index.js');
    const { shell, writes } = makeFakeShell();
    const q = new ShellCommandQueue(shell as any);
    q.launch('menu', { onData: () => {}, onDone: () => {}, onError: () => {} }, { interactive: true });
    q.interrupt();
    expect(writes[1]).toBe('\u0003');
    expect(writes[2]).toBe('\n');
    expect(writes[3]).toContain(`printf '__MCP_DONE__`);
  });
});

describe('PersistentSession.sendInput', () => {
  it('forwards input to the command queue', async () => {
    const { PersistentSession } = await import('../src/index.js');
    const writes: string[] = [];
    const session = new PersistentSession('s1', { config: { host: 'h' } } as any);
    const queue = {
      sendInput: (text: string) => { writes.push(text); },
      launch: () => {},
      interrupt: () => {},
      handleData: () => {},
      handleClose: () => {},
      hasPending: false,
    };
    (session as any).commandQueue = queue;
    session.sendInput('7\r');
    expect(writes).toEqual(['7\r']);
  });

  it('throws when the command queue is not ready', async () => {
    const { PersistentSession } = await import('../src/index.js');
    const session = new PersistentSession('s1', { config: { host: 'h' } } as any);
    expect(() => session.sendInput('x')).toThrow(/SSH shell not ready/);
  });
});

describe('exec-input tool result formatting', () => {
  function makeRun(overrides: Partial<any> = {}): any {
    return {
      run_id: 'r1',
      session_id: 's1',
      command: 'menu',
      state: 'running',
      output: 'DEFAULT MENU\n请输入 : ',
      exitCode: null,
      startedAt: 1000,
      finishedAt: null,
      cancelRequested: false,
      expiresAt: null,
      ...overrides,
    };
  }

  it('formatExecInputResult slices output from an offset', async () => {
    const { formatExecInputResult } = await import('../src/index.js');
    const result = formatExecInputResult(makeRun({ output: 'abcd' }), 2);
    expect(result.output).toBe('cd');
    expect(result.nextOffset).toBe(4);
  });

  it('formatExecInputResult with an out-of-range offset returns empty output', async () => {
    const { formatExecInputResult } = await import('../src/index.js');
    const result = formatExecInputResult(makeRun({ output: 'abc' }), 10);
    expect(result.output).toBe('');
    expect(result.nextOffset).toBe(3);
  });
});
