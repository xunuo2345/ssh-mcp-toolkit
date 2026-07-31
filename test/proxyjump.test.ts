import { describe, it, expect } from 'vitest';

describe('ProxyJump data model', () => {
  it('HostsSchema accepts proxyJump field', async () => {
    const { HostsSchema } = await import('../src/index.js');
    const parsed = HostsSchema.safeParse({
      hosts: [{
        id: 'host3', host: '10.0.0.3', port: 22, username: 'user',
        proxyJump: 'host1',
      }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data.hosts[0].proxyJump).toBe('host1');
  });

  it('HostsSchema works without proxyJump (backward compat)', async () => {
    const { HostsSchema } = await import('../src/index.js');
    const parsed = HostsSchema.safeParse({
      hosts: [{ id: 'host1', host: '1.2.3.4', port: 22, username: 'user' }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data.hosts[0].proxyJump).toBeUndefined();
  });

  it('HostsSchema accepts proxyJump with empty string', async () => {
    const { HostsSchema } = await import('../src/index.js');
    const parsed = HostsSchema.safeParse({
      hosts: [{ id: 'h1', host: '1.2.3.4', port: 22, username: 'u', proxyJump: '' }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('resolveHostFromList', () => {
  it('returns config without jumpConfig when proxyJump is absent', async () => {
    const { resolveHostFromList } = await import('../src/index.js');
    const hosts = [
      { id: 'h1', host: '1.2.3.4', port: 22, username: 'u', password: 'p' },
    ];
    const result = await resolveHostFromList('h1', hosts);
    expect(result.config.host).toBe('1.2.3.4');
    expect(result.config.password).toBe('p');
    expect(result.jumpConfig).toBeUndefined();
  });

  it('returns jumpConfig when proxyJump references an existing host', async () => {
    const { resolveHostFromList } = await import('../src/index.js');
    const hosts = [
      { id: 'jump', host: '5.6.7.8', port: 22, username: 'juser', password: 'jpass' },
      { id: 'target', host: '10.0.0.3', port: 22, username: 'tuser', password: 'tpass', proxyJump: 'jump' },
    ];
    const result = await resolveHostFromList('target', hosts);
    expect(result.config.host).toBe('10.0.0.3');
    expect(result.jumpConfig!.host).toBe('5.6.7.8');
    expect(result.jumpConfig!.password).toBe('jpass');
  });

  it('throws when proxyJump references a non-existent host', async () => {
    const { resolveHostFromList } = await import('../src/index.js');
    const hosts = [
      { id: 'target', host: '10.0.0.3', port: 22, username: 'u', password: 'p', proxyJump: 'nope' },
    ];
    await expect(resolveHostFromList('target', hosts)).rejects.toThrow("Jump host 'nope' not found");
  });

  it('throws when host id is not found', async () => {
    const { resolveHostFromList } = await import('../src/index.js');
    await expect(resolveHostFromList('missing', [])).rejects.toThrow("Host 'missing' not found");
  });

  it('rejects a self-referencing proxyJump cycle', async () => {
    const { resolveHostFromList } = await import('../src/index.js');
    const hosts = [
      { id: 'h1', host: '1.2.3.4', port: 22, username: 'u', password: 'p', proxyJump: 'h1' },
    ];
    await expect(resolveHostFromList('h1', hosts)).rejects.toThrow('ProxyJump cycle detected');
  });

  it('resolveHostFromList populates jumpHostId when proxyJump is set', async () => {
    const { resolveHostFromList } = await import('../src/index.js');
    const hosts = [
      { id: 'jump', host: '5.6.7.8', port: 22, username: 'juser', password: 'jpass' },
      { id: 'target', host: '10.0.0.3', port: 22, username: 'tuser', password: 'tpass', proxyJump: 'jump' },
    ];
    const result = await resolveHostFromList('target', hosts);
    expect(result.jumpHostId).toBe('jump');
  });

  it('resolveHostFromList leaves jumpHostId undefined when no proxyJump', async () => {
    const { resolveHostFromList } = await import('../src/index.js');
    const hosts = [
      { id: 'h1', host: '1.2.3.4', port: 22, username: 'u', password: 'p' },
    ];
    const result = await resolveHostFromList('h1', hosts);
    expect(result.jumpHostId).toBeUndefined();
  });

  it('resolves a multi-hop chain in locally reachable connection order', async () => {
    const { resolveHostFromList } = await import('../src/index.js');
    const hosts = [
      { id: 'gateway', host: '203.0.113.10', port: 22, username: 'gateway-user', password: 'gpass' },
      { id: 'a', host: '10.0.0.10', port: 22, username: 'a-user', password: 'apass', proxyJump: 'gateway' },
      { id: 'b', host: '10.0.1.10', port: 2222, username: 'b-user', password: 'bpass', proxyJump: 'a' },
    ];
    const result = await resolveHostFromList('b', hosts);
    expect(result.jumpHostId).toBe('a');
    expect(result.jumpHostIds).toEqual(['gateway', 'a']);
    expect(result.jumpConfigs.map((config) => config.host)).toEqual(['203.0.113.10', '10.0.0.10']);
    expect(result.config.host).toBe('10.0.1.10');
  });

  it('rejects a cycle spanning multiple hosts', async () => {
    const { resolveHostFromList } = await import('../src/index.js');
    const hosts = [
      { id: 'a', host: '10.0.0.10', port: 22, username: 'a-user', proxyJump: 'b' },
      { id: 'b', host: '10.0.1.10', port: 22, username: 'b-user', proxyJump: 'a' },
    ];
    await expect(resolveHostFromList('a', hosts)).rejects.toThrow('ProxyJump cycle detected');
  });
});
