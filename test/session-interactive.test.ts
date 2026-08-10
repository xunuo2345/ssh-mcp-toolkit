import { describe, it, expect } from 'vitest';

describe('PersistentSession session-level output buffer', () => {
  async function makeSession() {
    const { PersistentSession } = await import('../src/index.js');
    return new PersistentSession('s1', { config: { host: 'h' } } as any);
  }

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
  it('formats output slice and nextOffset', async () => {
    const { formatSessionOutput } = await import('../src/index.js');
    const r = formatSessionOutput('MENU> [1] asset\n', 6);
    expect(r.output).toBe('[1] asset\n');
    expect(r.nextOffset).toBe(16);
  });

  it('clamps a negative offset to zero', async () => {
    const { formatSessionOutput } = await import('../src/index.js');
    const r = formatSessionOutput('abc', -5);
    expect(r.output).toBe('abc');
    expect(r.nextOffset).toBe(3);
  });
});
