import { describe, it, expect, vi } from 'vitest';
import net from 'net';

function listenEcho(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.pipe(socket);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ server, port });
    });
  });
}

function makeFakeConn() {
  return {
    forwardOut(
      _srcIp: string,
      _srcPort: number,
      dstIp: string,
      dstPort: number,
      cb: (err: Error | null, stream?: any) => void
    ) {
      const stream = net.connect({ host: dstIp, port: dstPort });
      stream.once('connect', () => cb(null, stream));
      stream.on('error', () => {});
      return stream;
    },
    once() {},
    end() {},
  };
}

describe('validateTunnelParams', () => {
  it('accepts valid ports and bind', async () => {
    const { validateTunnelParams } = await import('../src/index.js');
    expect(() =>
      validateTunnelParams({ localPort: 8080, remotePort: 8081, localBind: '127.0.0.1' })
    ).not.toThrow();
  });

  it('throws when remote_port is out of range', async () => {
    const { validateTunnelParams } = await import('../src/index.js');
    expect(() => validateTunnelParams({ remotePort: 0 })).toThrow(/remote_port/);
    expect(() => validateTunnelParams({ remotePort: 65536 })).toThrow(/remote_port/);
  });

  it('throws when local_port is out of range', async () => {
    const { validateTunnelParams } = await import('../src/index.js');
    expect(() => validateTunnelParams({ remotePort: 80, localPort: -1 })).toThrow(/local_port/);
    expect(() => validateTunnelParams({ remotePort: 80, localPort: 70000 })).toThrow(/local_port/);
  });

  it('allows omitting local_port (auto-assign)', async () => {
    const { validateTunnelParams } = await import('../src/index.js');
    expect(() => validateTunnelParams({ remotePort: 80 })).not.toThrow();
  });

  it('throws when local_bind is empty', async () => {
    const { validateTunnelParams } = await import('../src/index.js');
    expect(() => validateTunnelParams({ remotePort: 80, localBind: '' })).toThrow(/local_bind/);
  });
});

describe('formatTunnelLine', () => {
  it('formats an active tunnel with active connections', async () => {
    const { formatTunnelLine } = await import('../src/index.js');
    const info = {
      id: 'web', hostId: 'B', localBind: '127.0.0.1', localPort: 8080,
      remoteHost: '127.0.0.1', remotePort: 8080, jumpHosts: ['A', 'B'],
      state: 'active' as const, activeConnections: 2, totalConnections: 17,
      lastError: null, idleMs: null,
    };
    expect(formatTunnelLine(info)).toBe(
      'tunnel=web local=127.0.0.1:8080 -> host=B remote=127.0.0.1:8080 jump=A -> B state=active conns=2/17'
    );
  });

  it('shows idle seconds when no active connections', async () => {
    const { formatTunnelLine } = await import('../src/index.js');
    const info = {
      id: 'web', hostId: 'B', localBind: '127.0.0.1', localPort: 8080,
      remoteHost: '127.0.0.1', remotePort: 8080, jumpHosts: [],
      state: 'active' as const, activeConnections: 0, totalConnections: 1,
      lastError: null, idleMs: 42,
    };
    expect(formatTunnelLine(info)).toBe(
      'tunnel=web local=127.0.0.1:8080 -> host=B remote=127.0.0.1:8080 jump=direct state=active conns=0/1 idle=42s'
    );
  });

  it('shows lastError for a dead tunnel', async () => {
    const { formatTunnelLine } = await import('../src/index.js');
    const info = {
      id: 'db', hostId: 'B', localBind: '127.0.0.1', localPort: 5432,
      remoteHost: '10.0.2.50', remotePort: 5432, jumpHosts: ['A'],
      state: 'dead' as const, activeConnections: 0, totalConnections: 3,
      lastError: 'connection refused', idleMs: null,
    };
    expect(formatTunnelLine(info)).toBe(
      'tunnel=db local=127.0.0.1:5432 -> host=B remote=10.0.2.50:5432 jump=A state=dead conns=0/3 lastError=connection refused'
    );
  });
});

describe('PortForward', () => {
  it('pipes a local connection to remote through forwardOut and cleans up', async () => {
    const { PortForward } = await import('../src/index.js');
    const { server: echo, port: echoPort } = await listenEcho();
    const calls: Array<[string, number, string, number]> = [];
    const fakeConn = {
      forwardOut(
        srcIp: string,
        srcPort: number,
        dstIp: string,
        dstPort: number,
        cb: (err: Error | null, stream?: any) => void
      ) {
        calls.push([srcIp, srcPort, dstIp, dstPort]);
        const stream = net.connect({ host: dstIp, port: dstPort });
        stream.once('connect', () => cb(null, stream));
        stream.on('error', () => {});
        return stream;
      },
      once() {},
      end() {},
    };

    const tunnel = new PortForward(
      't1', 'h1', '127.0.0.1', 0, '127.0.0.1', echoPort, [],
      fakeConn as any, [], 60_000
    );
    try {
      await tunnel.start();
      const boundPort = tunnel.getInfo().localPort;
      expect(boundPort).toBeGreaterThan(0);
      expect(tunnel.getInfo().state).toBe('active');

      await new Promise<void>((resolve, reject) => {
        const client = net.connect({ host: '127.0.0.1', port: boundPort }, () => client.write('hello'));
        client.on('data', (data) => {
          try {
            expect(data.toString()).toBe('hello');
            client.end();
            resolve();
          } catch (err) {
            reject(err);
          }
        });
        client.on('error', reject);
      });

      await new Promise((r) => setTimeout(r, 30));
      expect(calls).toEqual([['127.0.0.1', 0, '127.0.0.1', echoPort]]);
      expect(tunnel.getInfo().totalConnections).toBe(1);
      expect(tunnel.getInfo().activeConnections).toBe(0);
    } finally {
      tunnel.dispose();
      echo.close();
    }
  });

  it('runs the idle timer only while there are no active connections', async () => {
    const { PortForward } = await import('../src/index.js');
    const { server: echo, port: echoPort } = await listenEcho();
    const tunnel = new PortForward(
      't1', 'h1', '127.0.0.1', 0, '127.0.0.1', echoPort, [],
      makeFakeConn() as any, [], 60_000
    );
    try {
      await tunnel.start();
      expect(tunnel.getInfo().idleMs).not.toBeNull();

      const client = net.connect({ host: '127.0.0.1', port: tunnel.getInfo().localPort });
      await new Promise((r) => client.on('connect', r));
      await new Promise((r) => setTimeout(r, 30));
      expect(tunnel.getInfo().activeConnections).toBe(1);
      expect(tunnel.getInfo().idleMs).toBeNull();

      client.destroy();
      await new Promise((r) => setTimeout(r, 30));
      expect(tunnel.getInfo().activeConnections).toBe(0);
      expect(tunnel.getInfo().idleMs).not.toBeNull();
    } finally {
      tunnel.dispose();
      echo.close();
    }
  });

  it('disposes the tunnel when the idle timeout elapses', async () => {
    vi.useFakeTimers();
    const { PortForward } = await import('../src/index.js');
    const disposed: string[] = [];
    const tunnel = new PortForward(
      't1', 'h1', '127.0.0.1', 0, '127.0.0.1', 8080, [],
      { once() {}, end() {} } as any, [], 60_000,
      (id) => disposed.push(id)
    );
    try {
      await tunnel.start();
      expect(disposed).toEqual([]);
      vi.advanceTimersByTime(60_001);
      expect(disposed).toEqual(['t1']);
      expect(tunnel.getInfo().state).toBe('closed');
    } finally {
      tunnel.dispose();
      vi.useRealTimers();
    }
  });

  it('destroys the stream when the local client aborts before forwardOut resolves', async () => {
    const { PortForward } = await import('../src/index.js');
    const { server: echo, port: echoPort } = await listenEcho();
    let streamRef: any = null;
    const fakeConn = {
      forwardOut(_s: string, _p: number, dstIp: string, dstPort: number, cb: (e: Error | null, st?: any) => void) {
        const stream = net.connect({ host: dstIp, port: dstPort });
        stream.once('connect', () => { streamRef = stream; setTimeout(() => cb(null, stream), 50); });
        stream.on('error', () => {});
        return stream;
      },
      once() {},
      end() {},
    };
    const tunnel = new PortForward('t1', 'h1', '127.0.0.1', 0, '127.0.0.1', echoPort, [], fakeConn as any, [], 60_000);
    try {
      await tunnel.start();
      const client = net.connect({ host: '127.0.0.1', port: tunnel.getInfo().localPort });
      await new Promise((r) => client.on('connect', r));
      client.destroy();
      await new Promise((r) => setTimeout(r, 80));
      expect(streamRef).not.toBeNull();
      expect(streamRef.destroyed).toBe(true);
      expect(tunnel.getInfo().activeConnections).toBe(0);
    } finally {
      tunnel.dispose();
      echo.close();
    }
  });

  it('does not dispose while a connection is active', async () => {
    vi.useFakeTimers();
    const { PortForward } = await import('../src/index.js');
    const { server: echo, port: echoPort } = await listenEcho();
    const disposed: string[] = [];
    const tunnel = new PortForward('t1', 'h1', '127.0.0.1', 0, '127.0.0.1', echoPort, [], makeFakeConn() as any, [], 60_000, (id) => disposed.push(id));
    try {
      await tunnel.start();
      const client = net.connect({ host: '127.0.0.1', port: tunnel.getInfo().localPort });
      await new Promise((r) => client.on('connect', r));
      vi.advanceTimersByTime(60_001);
      expect(disposed).toEqual([]);
      expect(tunnel.getInfo().state).toBe('active');
      client.destroy();
    } finally {
      tunnel.dispose();
      echo.close();
      vi.useRealTimers();
    }
  });
});
