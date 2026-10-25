import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  BLOCKED_HEADER,
  BLOCKED_HEADER_VALUE,
  checkPublicUrl,
  decide,
  startNetworkGuard,
  type GuardOptions,
  type NetworkGuard,
} from '../src/collect/network-guard.js';

/**
 * The guard against real sockets. The "public" site is a local server, so the
 * tests inject a resolver and an address policy in which 127.0.0.1 stands in
 * for a public address and 10.x for a private one.
 */

let upstream: http.Server;
let upstreamPort: number;
const seenHosts: string[] = [];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    seenHosts.push(req.headers.host ?? '');
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`hello ${req.url}`);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = (upstream.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
});

const names: Record<string, string[]> = {
  'public.example': ['127.0.0.1'],
  // One good address is not enough: any private answer blocks the name.
  'mixed.example': ['127.0.0.1', '10.0.0.7'],
  'private.example': ['10.0.0.1'],
};

function testOptions(extra: Partial<GuardOptions> = {}): GuardOptions {
  return {
    lookup: async (host) => {
      const found = names[host];
      if (!found) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      return found;
    },
    isBlockedAddress: (a) => a.startsWith('10.'),
    hostReason: () => undefined,
    ...extra,
  };
}

/** A plain-HTTP request through the proxy (absolute-form request target). */
function viaProxy(guard: NetworkGuard, target: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const req = http.request(
      { host: '127.0.0.1', port: guard.port, method: 'GET', path: target, headers: { host: u.host } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Open a CONNECT tunnel and return the proxy's status line plus the socket. */
function connect(guard: NetworkGuard, authority: string): Promise<{ head: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(guard.port, '127.0.0.1');
    let buf = '';
    socket.on('error', reject);
    socket.on('data', function onData(chunk) {
      buf += chunk.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      resolve({ head: buf.slice(0, end), socket });
    });
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });
}

describe('network guard: plain HTTP', () => {
  it('forwards a request for a public name, keeping the Host header', async () => {
    const guard = await startNetworkGuard(testOptions());
    try {
      const res = await viaProxy(guard, `http://public.example:${upstreamPort}/hello?x=1`);
      expect(res.status).toBe(200);
      expect(res.body).toBe('hello /hello?x=1');
      expect(seenHosts.at(-1)).toBe(`public.example:${upstreamPort}`);
      expect(guard.blocked).toEqual([]);
    } finally {
      await guard.close();
    }
  });

  it('refuses a name with any private address, marks the response and records why', async () => {
    const guard = await startNetworkGuard(testOptions());
    try {
      const res = await viaProxy(guard, `http://mixed.example:${upstreamPort}/`);
      expect(res.status).toBe(403);
      expect(res.headers[BLOCKED_HEADER]).toBe(BLOCKED_HEADER_VALUE);
      expect(guard.blocked).toHaveLength(1);
      expect(guard.blocked[0]!.target).toBe(`mixed.example:${upstreamPort}`);
      expect(guard.blocked[0]!.reason).toMatch(/10\.0\.0\.7/);
    } finally {
      await guard.close();
    }
  });

  it('resolves once and connects to the address it checked (no DNS rebinding)', async () => {
    let calls = 0;
    // First answer public, every later answer private: a rebinding attack.
    const guard = await startNetworkGuard(
      testOptions({ lookup: async () => (calls++ === 0 ? ['127.0.0.1'] : ['10.6.6.6']) }),
    );
    try {
      const res = await viaProxy(guard, `http://rebind.example:${upstreamPort}/`);
      expect(res.status).toBe(200);
      expect(calls).toBe(1);
    } finally {
      await guard.close();
    }
  });

  it('refuses a name that does not resolve', async () => {
    const guard = await startNetworkGuard(testOptions());
    try {
      const res = await viaProxy(guard, `http://nowhere.example:${upstreamPort}/`);
      expect(res.status).toBe(403);
      expect(guard.blocked[0]!.reason).toMatch(/did not resolve \(ENOTFOUND\)/);
    } finally {
      await guard.close();
    }
  });

  it('refuses a WebSocket upgrade to a private name', async () => {
    const guard = await startNetworkGuard(testOptions());
    try {
      const head = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(guard.port, '127.0.0.1');
        let buf = '';
        socket.on('error', reject);
        socket.on('data', (c) => (buf += c.toString('latin1')));
        socket.on('close', () => resolve(buf));
        socket.write(
          `GET http://private.example:${upstreamPort}/ws HTTP/1.1\r\nHost: private.example\r\n` +
            'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
        );
      });
      expect(head).toMatch(/^HTTP\/1\.1 403/);
      expect(head.toLowerCase()).toContain(`${BLOCKED_HEADER}: ${BLOCKED_HEADER_VALUE}`);
      expect(guard.blocked[0]!.target).toBe(`private.example:${upstreamPort}`);
    } finally {
      await guard.close();
    }
  });
});

describe('network guard: CONNECT tunnels (HTTPS, wss)', () => {
  it('tunnels to a public name', async () => {
    const guard = await startNetworkGuard(testOptions());
    try {
      const { head, socket } = await connect(guard, `public.example:${upstreamPort}`);
      expect(head).toMatch(/^HTTP\/1\.1 200/);
      const reply = await new Promise<string>((resolve) => {
        let buf = '';
        socket.on('data', (c) => (buf += c.toString()));
        socket.on('end', () => resolve(buf));
        socket.write('GET /through-tunnel HTTP/1.1\r\nHost: public.example\r\nConnection: close\r\n\r\n');
      });
      expect(reply).toMatch(/hello \/through-tunnel/);
      socket.destroy();
    } finally {
      await guard.close();
    }
  });

  it('refuses a tunnel to a private name or address', async () => {
    const guard = await startNetworkGuard(testOptions());
    try {
      const byName = await connect(guard, 'private.example:443');
      expect(byName.head).toMatch(/^HTTP\/1\.1 403/);
      expect(byName.head.toLowerCase()).toContain(`${BLOCKED_HEADER}: ${BLOCKED_HEADER_VALUE}`);
      byName.socket.destroy();

      const byAddress = await connect(guard, '10.1.2.3:443');
      expect(byAddress.head).toMatch(/^HTTP\/1\.1 403/);
      byAddress.socket.destroy();

      expect(guard.blocked.map((b) => b.target)).toEqual(['private.example:443', '10.1.2.3:443']);
    } finally {
      await guard.close();
    }
  });
});

describe('decide: the default policy', () => {
  const noLookup = { lookup: async () => { throw new Error('must not resolve'); } };

  it('refuses literal private addresses without a lookup', async () => {
    for (const host of ['127.0.0.1', '[::1]', '::ffff:127.0.0.1', '192.168.1.1', '169.254.169.254', '100.101.102.103']) {
      expect((await decide(host, noLookup)).allow).toBe(false);
    }
  });

  it('refuses DDEV and other local names without a lookup', async () => {
    for (const host of ['mysite.ddev.site', 'localhost', 'app.lndo.site', 'nas.local', '127.0.0.1.nip.io']) {
      const d = await decide(host, noLookup);
      expect(d.allow).toBe(false);
    }
  });

  it('refuses a public-looking name that resolves to a private address', async () => {
    const d = await decide('innocent.example.com', { lookup: async () => ['192.168.0.10'] });
    expect(d).toEqual({ allow: false, reason: 'innocent.example.com resolves to 192.168.0.10, a private or reserved address' });
  });

  it('allows a name that resolves only to public addresses, pinned to the first', async () => {
    const d = await decide('example.com', { lookup: async () => ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'] });
    expect(d).toEqual({ allow: true, address: '93.184.215.14' });
  });

  it('checkPublicUrl rejects non-http schemes', async () => {
    expect((await checkPublicUrl('file:///etc/passwd')).allow).toBe(false);
    expect((await checkPublicUrl('not a url')).allow).toBe(false);
  });
});
