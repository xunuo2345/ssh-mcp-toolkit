import { describe, it, expect } from 'vitest';
import type { StoredHost } from '../src/index.js';

describe('validateProxyJump', () => {
  it('does nothing when proxyJump is undefined', async () => {
    const { validateProxyJump } = await import('../src/index.js');
    const hosts: StoredHost[] = [
      { id: 'h1', host: '1.2.3.4', port: 22, username: 'u' },
    ];
    expect(() => validateProxyJump('h2', undefined, hosts)).not.toThrow();
  });

  it('does nothing when proxyJump is empty string', async () => {
    const { validateProxyJump } = await import('../src/index.js');
    const hosts: StoredHost[] = [
      { id: 'h1', host: '1.2.3.4', port: 22, username: 'u' },
    ];
    expect(() => validateProxyJump('h2', '', hosts)).not.toThrow();
  });

  it('throws when proxyJump equals host id (self-reference)', async () => {
    const { validateProxyJump } = await import('../src/index.js');
    const hosts: StoredHost[] = [
      { id: 'h1', host: '1.2.3.4', port: 22, username: 'u' },
    ];
    expect(() => validateProxyJump('h1', 'h1', hosts)).toThrow(
      "Host 'h1' cannot use itself as a jump host"
    );
  });

  it('throws when proxyJump references a non-existent host', async () => {
    const { validateProxyJump } = await import('../src/index.js');
    const hosts: StoredHost[] = [
      { id: 'h1', host: '1.2.3.4', port: 22, username: 'u' },
    ];
    expect(() => validateProxyJump('h2', 'nope', hosts)).toThrow(
      "Jump host 'nope' not found"
    );
  });

  it('passes when proxyJump references an existing host', async () => {
    const { validateProxyJump } = await import('../src/index.js');
    const hosts: StoredHost[] = [
      { id: 'jump', host: '5.6.7.8', port: 22, username: 'ju' },
      { id: 'target', host: '10.0.0.1', port: 22, username: 'tu' },
    ];
    expect(() => validateProxyJump('target', 'jump', hosts)).not.toThrow();
  });
});

describe('formatHostLine', () => {
  it('formats a host without proxyJump (backward compat)', async () => {
    const { formatHostLine } = await import('../src/index.js');
    const host: StoredHost = {
      id: 'h1', host: '1.2.3.4', port: 22, username: 'user', password: 'secret',
    };
    expect(formatHostLine(host)).toBe(
      'id=h1 host=1.2.3.4:22 user=user auth=password'
    );
  });

  it('appends jump=<id> when proxyJump is set', async () => {
    const { formatHostLine } = await import('../src/index.js');
    const host: StoredHost = {
      id: 'h2', host: '10.0.0.1', port: 2222, username: 'admin', keyPath: '~/.ssh/id_rsa',
      proxyJump: 'jump',
    };
    expect(formatHostLine(host)).toBe(
      'id=h2 host=10.0.0.1:2222 user=admin auth=key jump=jump'
    );
  });

  it('uses agent auth and omits jump when neither keyPath nor proxyJump', async () => {
    const { formatHostLine } = await import('../src/index.js');
    const host: StoredHost = {
      id: 'h3', host: '192.168.1.1', port: 22, username: 'root',
    };
    expect(formatHostLine(host)).toBe(
      'id=h3 host=192.168.1.1:22 user=root auth=agent'
    );
  });
});
