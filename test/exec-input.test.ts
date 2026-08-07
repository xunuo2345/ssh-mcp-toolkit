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

  // Regression for the review finding: if a program's output coincidentally
  // contains the literal `__MCP_DONE__{uuid}__0\n` text (e.g. a user-pasted
  // UUID), an interactive run must NOT prematurely complete.
  it('interactive run ignores coincidental __MCP_DONE__ text in output and stays running', async () => {
    const { ShellCommandQueue } = await import('../src/index.js');
    const { shell, writes } = makeFakeShell();
    const q = new ShellCommandQueue(shell as any);
    const chunks: string[] = [];
    let done: { output: string; exitCode: number } | null = null;
    q.launch(
      'menu',
      { onData: (c) => chunks.push(c), onDone: (r) => { done = r; } },
      { interactive: true },
    );
    const collision = 'some output\n__MCP_DONE__aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee__0\nmore output';
    q.handleData(collision);
    expect(q.hasPending).toBe(true);
    expect(done).toBeNull();
    expect(chunks.join('')).toBe(collision);
    // Program continues to receive more input normally.
    q.handleData('still running\n');
    expect(q.hasPending).toBe(true);
    expect(done).toBeNull();
    expect(writes.some((w) => w.includes('__MCP_DONE__'))).toBe(false);
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
      interactive: true,
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

describe('validateExecInputPostState', () => {
  function makeRun(overrides: Partial<any> = {}): any {
    return {
      run_id: 'r1',
      session_id: 's1',
      command: 'menu',
      state: 'running',
      output: '',
      exitCode: null,
      startedAt: 1000,
      finishedAt: null,
      cancelRequested: false,
      expiresAt: null,
      interactive: true,
      ...overrides,
    };
  }

  // Re-check the post-state guard for the cancel race: if exec-cancel
  // transitions the run during the wait_ms window, the text was already
  // written to the shell and may have been executed as a command.
  it('throws when the run transitioned to cancelled during input', async () => {
    const { validateExecInputPostState } = await import('../src/index.js');
    expect(() => validateExecInputPostState(makeRun({ state: 'cancelled' }), 'r1'))
      .toThrow(/cancelled.*during exec-input.*may have been executed/);
  });

  it('throws when the run transitioned to failed during input', async () => {
    const { validateExecInputPostState } = await import('../src/index.js');
    expect(() => validateExecInputPostState(makeRun({ state: 'failed' }), 'r1'))
      .toThrow(/failed.*during exec-input/);
  });

  it('does not throw when the run is still running', async () => {
    const { validateExecInputPostState } = await import('../src/index.js');
    expect(() => validateExecInputPostState(makeRun({ state: 'running' }), 'r1')).not.toThrow();
  });

  it('does not throw when the run completed normally (program consumed input and exited)', async () => {
    const { validateExecInputPostState } = await import('../src/index.js');
    expect(() => validateExecInputPostState(makeRun({ state: 'completed', exitCode: 0 }), 'r1')).not.toThrow();
  });
});
