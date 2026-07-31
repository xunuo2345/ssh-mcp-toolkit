import { describe, it, expect } from 'vitest';

describe('validateEgressParams', () => {
  it('accepts a valid port and IP', async () => {
    const { validateEgressParams } = await import('../src/index.js');
    expect(() => validateEgressParams({ proxyPort: 8080, proxyBind: '192.168.1.10' })).not.toThrow();
  });

  it('throws when proxy_port is out of range', async () => {
    const { validateEgressParams } = await import('../src/index.js');
    expect(() => validateEgressParams({ proxyPort: 0, proxyBind: '192.168.1.10' })).toThrow(/proxy_port/);
    expect(() => validateEgressParams({ proxyPort: 65536, proxyBind: '192.168.1.10' })).toThrow(/proxy_port/);
    expect(() => validateEgressParams({ proxyPort: 80.5, proxyBind: '192.168.1.10' })).toThrow(/proxy_port/);
  });

  it('throws when proxy_bind is not a valid IP', async () => {
    const { validateEgressParams } = await import('../src/index.js');
    expect(() => validateEgressParams({ proxyPort: 80, proxyBind: 'localhost' })).toThrow(/proxy_bind/);
    expect(() => validateEgressParams({ proxyPort: 80, proxyBind: 'not-an-ip' })).toThrow(/proxy_bind/);
    expect(() => validateEgressParams({ proxyPort: 80, proxyBind: '' })).toThrow(/proxy_bind/);
  });

  it('accepts loopback IPs', async () => {
    const { validateEgressParams } = await import('../src/index.js');
    expect(() => validateEgressParams({ proxyPort: 80, proxyBind: '127.0.0.1' })).not.toThrow();
    expect(() => validateEgressParams({ proxyPort: 80, proxyBind: '::1' })).not.toThrow();
  });
});

describe('formatEgressLine', () => {
  it('formats an active egress with active connections', async () => {
    const { formatEgressLine } = await import('../src/index.js');
    const info = {
      id: 'web', hostId: 'A', proxyBind: '192.168.1.10', proxyPort: 8080,
      jumpHosts: [], state: 'active' as const,
      activeConnections: 2, totalConnections: 17, lastError: null, idleMs: null,
    };
    expect(formatEgressLine(info)).toBe(
      'egress=web host=A bind=192.168.1.10:8080 jump=direct state=active conns=2/17'
    );
  });

  it('shows idle seconds when no active connections', async () => {
    const { formatEgressLine } = await import('../src/index.js');
    const info = {
      id: 'web', hostId: 'A', proxyBind: '192.168.1.10', proxyPort: 8080,
      jumpHosts: ['gateway', 'A'], state: 'active' as const,
      activeConnections: 0, totalConnections: 1, lastError: null, idleMs: 42,
    };
    expect(formatEgressLine(info)).toBe(
      'egress=web host=A bind=192.168.1.10:8080 jump=gateway -> A state=active conns=0/1 idle=42s'
    );
  });

  it('shows lastError for a dead egress', async () => {
    const { formatEgressLine } = await import('../src/index.js');
    const info = {
      id: 'db', hostId: 'A', proxyBind: '192.168.1.10', proxyPort: 8081,
      jumpHosts: [], state: 'dead' as const,
      activeConnections: 0, totalConnections: 3, lastError: 'connection refused', idleMs: null,
    };
    expect(formatEgressLine(info)).toBe(
      'egress=db host=A bind=192.168.1.10:8081 jump=direct state=dead conns=0/3 lastError=connection refused'
    );
  });
});
