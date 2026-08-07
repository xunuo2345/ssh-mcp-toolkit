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
