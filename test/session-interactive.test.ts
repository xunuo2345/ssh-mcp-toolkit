import { describe, it, expect } from 'vitest';

async function makeSession() {
  const { PersistentSession } = await import('../src/index.js');
  return new PersistentSession('s1', { config: { host: 'h' } } as any);
}

describe('PersistentSession session-level output buffer', () => {
  it('captures shell output even without a pending command', async () => {
    const session = await makeSession();
    (session as any).shell = { write: () => {}, end: () => {} };
    (session as any).commandQueue = { handleData: () => {}, handleClose: () => {}, launch: () => {}, sendInput: () => {}, interrupt: () => {}, hasPending: false };
    (session as any).onSessionData('MENU> [1] asset\n');
    expect((session as any).sessionOutput).toBe('MENU> [1] asset\n');
    expect(session.readSessionOutput(0)).toBe('MENU> [1] asset\n');
    expect(session.sessionOutputLength).toBe('MENU> [1] asset\n'.length);
  });

  it('readSessionOutput slices from an offset', async () => {
    const session = await makeSession();
    (session as any).shell = { write: () => {}, end: () => {} };
    (session as any).commandQueue = null;
    (session as any).onSessionData('0123456789');
    expect(session.readSessionOutput(4)).toBe('456789');
    expect(session.readSessionOutput(100)).toBe('');
  });

  it('writeInput writes to the shell', async () => {
    const session = await makeSession();
    const writes: string[] = [];
    (session as any).shell = { write: (t: string) => writes.push(t), end: () => {} };
    (session as any).commandQueue = null;
    session.writeInput('1\n');
    expect(writes).toEqual(['1\n']);
  });

  it('writeInput throws when the shell is not ready', async () => {
    const session = await makeSession();
    expect(() => session.writeInput('x')).toThrow(/SSH shell not ready/);
  });

  it('onSessionData still routes to commandQueue.handleData in order', async () => {
    const session = await makeSession();
    const handled: string[] = [];
    (session as any).shell = { write: () => {}, end: () => {}, removeAllListeners: () => {} };
    (session as any).commandQueue = { handleData: (d: string) => handled.push(d), handleClose: () => {}, launch: () => {}, sendInput: () => {}, interrupt: () => {}, hasPending: false };
    (session as any).onSessionData('chunk1');
    (session as any).onSessionData('chunk2');
    expect(handled).toEqual(['chunk1', 'chunk2']);
  });

  it('cleanup empties the session output buffer', async () => {
    const session = await makeSession();
    (session as any).shell = { write: () => {}, end: () => {}, removeAllListeners: () => {} };
    (session as any).commandQueue = null;
    (session as any).onSessionData('MENU> [1] asset\n');
    expect(session.sessionOutputLength).toBeGreaterThan(0);
    (session as any).cleanup();
    expect(session.sessionOutputLength).toBe(0);
  });

  it('writeInput rejects when a command is pending in the queue', async () => {
    const session = await makeSession();
    const writes: string[] = [];
    (session as any).shell = { write: (t: string) => writes.push(t), end: () => {} };
    (session as any).commandQueue = { handleData: () => {}, handleClose: () => {}, launch: () => {}, sendInput: () => {}, interrupt: () => {}, hasPending: true };
    expect(() => session.writeInput('1\n')).toThrow(/Another command is still running in this session/);
    expect(writes).toEqual([]);
  });

  it('bounds the session output buffer at 1MB, dropping the oldest part', async () => {
    const session = await makeSession();
    (session as any).shell = { write: () => {}, end: () => {} };
    (session as any).commandQueue = null;
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 20; i++) {
      (session as any).onSessionData(chunk);
    }
    expect(session.sessionOutputLength).toBeLessThanOrEqual(1024 * 1024);
    expect(session.sessionOutputLength).toBeGreaterThan(1024 * 1024 - 64 * 1024);
  });
});

describe('session output formatting', () => {
  it('slices raw output once and reports absolute nextOffset', async () => {
    const { formatSessionOutput } = await import('../src/index.js');
    const r = formatSessionOutput('0123456789', 4);
    expect(r.output).toBe('456789');
    expect(r.nextOffset).toBe(10);
  });

  it('clamps a negative offset to zero', async () => {
    const { formatSessionOutput } = await import('../src/index.js');
    const r = formatSessionOutput('abc', -5);
    expect(r.output).toBe('abc');
    expect(r.nextOffset).toBe(3);
  });

  it('tool-level flow slices once: a large offset returns the trailing part, not empty', async () => {
    const session = await makeSession();
    (session as any).shell = { write: () => {}, end: () => {} };
    (session as any).commandQueue = null;
    (session as any).onSessionData('a'.repeat(150));
    const { formatSessionOutput } = await import('../src/index.js');
    const r = formatSessionOutput(session.getSessionOutput(), 100);
    expect(r.output).toBe('a'.repeat(50));
    expect(r.nextOffset).toBe(150);
  });
});
