import { describe, it, expect, vi } from 'vitest';
import net from 'net';
import { PassThrough } from 'stream';

function listenServer(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
}

function listenEcho(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer((socket) => socket.pipe(socket));
  return listenServer(server).then((port) => ({ server, port }));
}

function readUntil(socket: NodeJS.ReadableStream, needle: string, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${JSON.stringify(needle)}, got ${JSON.stringify(data)}`)),
      timeoutMs
    );
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('latin1');
      if (data.includes(needle)) {
        clearTimeout(timer);
        resolve(data);
      }
    });
    socket.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

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

  it('accepts port boundaries', async () => {
    const { validateEgressParams } = await import('../src/index.js');
    expect(() => validateEgressParams({ proxyPort: 1, proxyBind: '192.168.1.10' })).not.toThrow();
    expect(() => validateEgressParams({ proxyPort: 65535, proxyBind: '192.168.1.10' })).not.toThrow();
  });

  it('accepts undefined optional params', async () => {
    const { validateEgressParams } = await import('../src/index.js');
    expect(() => validateEgressParams({})).not.toThrow();
  });

  it('rejects wildcard bind addresses', async () => {
    const { validateEgressParams } = await import('../src/index.js');
    expect(() => validateEgressParams({ proxyPort: 80, proxyBind: '0.0.0.0' })).toThrow(/proxy_bind/);
    expect(() => validateEgressParams({ proxyPort: 80, proxyBind: '::' })).toThrow(/proxy_bind/);
    expect(() => validateEgressParams({ proxyPort: 80, proxyBind: '0:0:0:0:0:0:0:0' })).toThrow(/proxy_bind/);
  });

  it('accepts a non-loopback IPv6 address', async () => {
    const { validateEgressParams } = await import('../src/index.js');
    expect(() => validateEgressParams({ proxyPort: 80, proxyBind: 'fd00::1' })).not.toThrow();
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

describe('handleProxyConnection', () => {
  it('CONNECT replies 200 and tunnels bidirectionally', async () => {
    const { handleProxyConnection } = await import('../src/index.js');
    const { server: echo, port: echoPort } = await listenEcho();
    const proxy = net.createServer((socket) =>
      handleProxyConnection(socket, () => net.connect({ host: '127.0.0.1', port: echoPort }))
    );
    const proxyPort = await listenServer(proxy);
    try {
      const client = net.connect({ host: '127.0.0.1', port: proxyPort });
      client.write('CONNECT 127.0.0.1:9999 HTTP/1.1\r\nHost: 127.0.0.1:9999\r\n\r\n');
      const resp = await readUntil(client, '200 Connection Established');
      expect(resp).toContain('HTTP/1.1 200 Connection Established');
      client.write('ping');
      const echoed = await readUntil(client, 'ping');
      expect(echoed).toContain('ping');
      client.destroy();
    } finally {
      proxy.close();
      echo.close();
    }
  });

  it('forwards an absolute-form GET as origin-form and strips proxy headers', async () => {
    const { handleProxyConnection } = await import('../src/index.js');
    let received = '';
    const origin = net.createServer((socket) => {
      let buf = '';
      socket.on('data', (chunk: Buffer) => {
        buf += chunk.toString('latin1');
        if (buf.includes('\r\n\r\n')) {
          received = buf;
          socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi');
        }
      });
    });
    const originPort = await listenServer(origin);
    const proxy = net.createServer((socket) =>
      handleProxyConnection(socket, () => net.connect({ host: '127.0.0.1', port: originPort }))
    );
    const proxyPort = await listenServer(proxy);
    try {
      const client = net.connect({ host: '127.0.0.1', port: proxyPort });
      client.write(
        'GET http://example.com:8080/path?q=1 HTTP/1.1\r\n' +
        'Host: example.com:8080\r\nProxy-Connection: keep-alive\r\n\r\n'
      );
      const resp = await readUntil(client, 'hi');
      expect(resp).toContain('hi');
      expect(received).toBe('GET /path?q=1 HTTP/1.1\r\nHost: example.com:8080\r\n\r\n');
      client.destroy();
    } finally {
      proxy.close();
      origin.close();
    }
  });

  it('forwards an origin-form GET using the Host header', async () => {
    const { handleProxyConnection } = await import('../src/index.js');
    let received = '';
    const origin = net.createServer((socket) => {
      let buf = '';
      socket.on('data', (chunk: Buffer) => {
        buf += chunk.toString('latin1');
        if (buf.includes('\r\n\r\n')) {
          received = buf;
          socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
        }
      });
    });
    const originPort = await listenServer(origin);
    const proxy = net.createServer((socket) =>
      handleProxyConnection(socket, () => net.connect({ host: '127.0.0.1', port: originPort }))
    );
    const proxyPort = await listenServer(proxy);
    try {
      const client = net.connect({ host: '127.0.0.1', port: proxyPort });
      client.write('GET /hello HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      await readUntil(client, 'ok');
      expect(received).toMatch(/^GET \/hello HTTP\/1\.1/);
      expect(received).toContain('Host: 127.0.0.1');
      client.destroy();
    } finally {
      proxy.close();
      origin.close();
    }
  });

  it('replies 502 when the upstream connect fails', async () => {
    const { handleProxyConnection } = await import('../src/index.js');
    const proxy = net.createServer((socket) =>
      handleProxyConnection(socket, () => Promise.reject(new Error('refused')))
    );
    const proxyPort = await listenServer(proxy);
    try {
      const client = net.connect({ host: '127.0.0.1', port: proxyPort });
      client.write('GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n');
      const resp = await readUntil(client, '502 Bad Gateway');
      expect(resp).toContain('502 Bad Gateway');
      client.destroy();
    } finally {
      proxy.close();
    }
  });

  it('destroys the connection on a malformed request without throwing', async () => {
    const { handleProxyConnection } = await import('../src/index.js');
    const proxy = net.createServer((socket) =>
      handleProxyConnection(socket, () => Promise.reject(new Error('never called')))
    );
    const proxyPort = await listenServer(proxy);
    try {
      const client = net.connect({ host: '127.0.0.1', port: proxyPort });
      const closed = new Promise<void>((resolve) => client.on('close', () => resolve()));
      client.write('GARBAGE\r\n\r\n');
      await closed;
      expect(client.destroyed).toBe(true);
    } finally {
      proxy.close();
    }
  });

  it('works on a PassThrough stream (ClientChannel-shaped)', async () => {
    const { handleProxyConnection } = await import('../src/index.js');
    const { server: echo, port: echoPort } = await listenEcho();
    try {
      const upstream = net.connect({ host: '127.0.0.1', port: echoPort });
      await new Promise((resolve) => upstream.once('connect', resolve));
      const channel = new PassThrough();
      handleProxyConnection(channel as any, () => Promise.resolve(upstream));
      channel.write('CONNECT x:80 HTTP/1.1\r\nHost: x\r\n\r\n');
      const resp = await readUntil(channel, '200 Connection Established');
      expect(resp).toContain('200 Connection Established');
      channel.write('hello');
      const echoed = await readUntil(channel, 'hello');
      expect(echoed).toContain('hello');
      channel.destroy();
      upstream.destroy();
    } finally {
      echo.close();
    }
  });
});

function makeFakeConn() {
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  const calls = { forwardIn: [] as Array<[string, number]>, unforwardIn: [] as number[] };
  const conn = {
    forwardIn(bind: string, port: number, cb: (e?: Error) => void) {
      calls.forwardIn.push([bind, port]);
      cb(null);
    },
    unforwardIn(bind: string, port: number) {
      calls.unforwardIn.push(port);
    },
    on(evt: string, fn: (...args: any[]) => void) {
      (listeners[evt] ||= []).push(fn);
    },
    once(evt: string, fn: (...args: any[]) => void) {
      (listeners[evt] ||= []).push(fn);
    },
    end() {},
  };
  return { conn, listeners, calls };
}

function triggerTcpip(listeners: Record<string, Array<(...args: any[]) => void>>, stream: any) {
  const fn = listeners['tcp connection']?.[0];
  expect(fn).toBeDefined();
  fn({ destIP: '0.0.0.0', destPort: 0, srcIP: '10.0.0.5', srcPort: 12345 }, () => stream);
}

describe('InternetEgress', () => {
  it('opens a forwardIn listener on start', async () => {
    const { InternetEgress } = await import('../src/index.js');
    const { conn, calls } = makeFakeConn();
    const egress = new InternetEgress('e1', 'A', '192.168.1.10', 8080, [], conn as any, []);
    await egress.start();
    expect(calls.forwardIn).toEqual([['192.168.1.10', 8080]]);
    expect(egress.getInfo().state).toBe('active');
    egress.dispose();
  });

  it('rejects when forwardIn fails', async () => {
    const { InternetEgress } = await import('../src/index.js');
    const { conn } = makeFakeConn();
    conn.forwardIn = (_bind: string, _port: number, cb: (e?: Error) => void) => cb(new Error('gateway denied'));
    const egress = new InternetEgress('e1', 'A', '192.168.1.10', 8080, [], conn as any, []);
    await expect(egress.start()).rejects.toThrow(/Failed to listen/);
    expect(egress.getInfo().state).toBe('closed');
  });

  it('proxies incoming tcpip streams to the internet', async () => {
    const { InternetEgress } = await import('../src/index.js');
    const { conn, listeners } = makeFakeConn();
    const { server: echo, port: echoPort } = await listenEcho();
    const egress = new InternetEgress('e1', 'A', '192.168.1.10', 8080, [], conn as any, []);
    try {
      await egress.start();
      const channel = new PassThrough();
      triggerTcpip(listeners, channel);
      channel.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`);
      const resp = await readUntil(channel, '200 Connection Established');
      expect(resp).toContain('200 Connection Established');
      channel.write('ping');
      const echoed = await readUntil(channel, 'ping');
      expect(echoed).toContain('ping');
      expect(egress.getInfo().totalConnections).toBe(1);
      channel.destroy();
      await new Promise((r) => setTimeout(r, 30));
      expect(egress.getInfo().activeConnections).toBe(0);
    } finally {
      egress.dispose();
      echo.close();
    }
  });

  it('runs the idle timer only while there are no active connections', async () => {
    const { InternetEgress } = await import('../src/index.js');
    const { conn, listeners } = makeFakeConn();
    const { server: echo, port: echoPort } = await listenEcho();
    const egress = new InternetEgress('e1', 'A', '192.168.1.10', 8080, [], conn as any, []);
    try {
      await egress.start();
      expect(egress.getInfo().idleMs).not.toBeNull();
      const channel = new PassThrough();
      triggerTcpip(listeners, channel);
      await new Promise((r) => setTimeout(r, 30));
      expect(egress.getInfo().activeConnections).toBe(1);
      expect(egress.getInfo().idleMs).toBeNull();
      channel.destroy();
      await new Promise((r) => setTimeout(r, 30));
      expect(egress.getInfo().activeConnections).toBe(0);
      expect(egress.getInfo().idleMs).not.toBeNull();
    } finally {
      egress.dispose();
      echo.close();
    }
  });

  it('disposes on idle timeout', async () => {
    vi.useFakeTimers();
    const { InternetEgress } = await import('../src/index.js');
    const { conn } = makeFakeConn();
    const disposed: string[] = [];
    const egress = new InternetEgress('e1', 'A', '192.168.1.10', 8080, [], conn as any, [], 60_000, (id) => disposed.push(id));
    try {
      await egress.start();
      expect(disposed).toEqual([]);
      vi.advanceTimersByTime(60_001);
      expect(disposed).toEqual(['e1']);
      expect(egress.getInfo().state).toBe('closed');
    } finally {
      egress.dispose();
      vi.useRealTimers();
    }
  });

  it('dispose removes the remote listener and fires onDispose', async () => {
    const { InternetEgress } = await import('../src/index.js');
    const { conn, calls } = makeFakeConn();
    const disposed: string[] = [];
    const egress = new InternetEgress('e1', 'A', '192.168.1.10', 8080, [], conn as any, [], 60_000, (id) => disposed.push(id));
    await egress.start();
    egress.dispose();
    expect(calls.unforwardIn).toEqual([8080]);
    expect(disposed).toEqual(['e1']);
    expect(egress.getInfo().state).toBe('closed');
  });

  it('marks dead when the SSH connection errors', async () => {
    const { InternetEgress } = await import('../src/index.js');
    const { conn, listeners } = makeFakeConn();
    const egress = new InternetEgress('e1', 'A', '192.168.1.10', 8080, [], conn as any, []);
    await egress.start();
    const errorHandler = listeners['error']?.find((fn) => fn.toString().includes('markDead'));
    expect(errorHandler).toBeDefined();
    errorHandler(new Error('boom'));
    expect(egress.getInfo().state).toBe('dead');
    expect(egress.getInfo().lastError).toBe('boom');
    egress.dispose();
  });
});
