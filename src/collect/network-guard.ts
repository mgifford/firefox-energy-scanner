import http from 'node:http';
import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isPrivateAddress, localHostReason } from '../core/addresses.js';

/**
 * Network guard: a forward proxy that only lets the browser reach public
 * internet addresses.
 *
 * Checking a URL before a scan is not enough. A public name can resolve to a
 * private address (DDEV's *.ddev.site resolves to 127.0.0.1 by design), a
 * public page can redirect to one or embed resources from one, and a name can
 * answer differently on its next lookup (DNS rebinding). So in public-only
 * mode every connection the browser makes goes through this proxy, which:
 *
 *   - refuses names that are local by design and literal private addresses;
 *   - resolves every other name once, refuses it if ANY address is private,
 *     and then connects to exactly the address it checked, so a second
 *     lookup can never steer the connection somewhere else;
 *   - handles plain HTTP (absolute-form requests), HTTPS and WebSockets
 *     (CONNECT tunnels, end-to-end TLS untouched) and HTTP upgrades.
 *
 * UDP cannot go through an HTTP proxy, so the browser launchers also turn
 * off WebRTC and HTTP/3 in this mode (see firefoxGuardPrefs, chromeGuardFlags).
 *
 * The proxy only copies bytes, which costs very little CPU. On Linux, where
 * energy covers the whole CPU package, that little is included; results
 * record that the guard was on so guarded and unguarded runs are not mixed.
 */

export const BLOCKED_HEADER = 'x-blocked-by';
export const BLOCKED_HEADER_VALUE = 'firefox-energy-scanner';

export interface BlockedRequest {
  /** host:port as the browser asked for it. */
  target: string;
  reason: string;
  at: number;
}

export type Lookup = (hostname: string) => Promise<string[]>;

export interface GuardOptions {
  /** Name resolution; defaults to the system resolver, as the browser uses. */
  lookup?: Lookup;
  /** Address policy; defaults to isPrivateAddress. Injectable for tests. */
  isBlockedAddress?: (address: string) => boolean;
  /** Host-name policy; defaults to localHostReason. Injectable for tests. */
  hostReason?: (hostname: string) => string | undefined;
  connectTimeoutMs?: number;
}

export interface NetworkGuard {
  /** e.g. http://127.0.0.1:53211 */
  url: string;
  port: number;
  blocked: BlockedRequest[];
  close: () => Promise<void>;
}

const systemLookup: Lookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

export type Decision = { allow: true; address: string } | { allow: false; reason: string };

/** Decide whether a host may be reached, and at which single address. */
export async function decide(
  hostname: string,
  options: Pick<GuardOptions, 'lookup' | 'isBlockedAddress' | 'hostReason'> = {},
): Promise<Decision> {
  const host = hostname.replace(/^\[|\]$/g, '');
  const reasonFor = options.hostReason ?? localHostReason;
  const blockedAddress = options.isBlockedAddress ?? isPrivateAddress;

  if (net.isIP(host)) {
    return blockedAddress(host)
      ? { allow: false, reason: `${host} is a private or reserved address` }
      : { allow: true, address: host };
  }
  const byName = reasonFor(host);
  if (byName) return { allow: false, reason: byName };

  let addresses: string[];
  try {
    addresses = await (options.lookup ?? systemLookup)(host);
  } catch (err) {
    return { allow: false, reason: `${host} did not resolve (${(err as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  if (addresses.length === 0) return { allow: false, reason: `${host} did not resolve` };
  const bad = addresses.find((a) => blockedAddress(a));
  if (bad) return { allow: false, reason: `${host} resolves to ${bad}, a private or reserved address` };
  return { allow: true, address: addresses[0]! };
}

/** Check a URL the same way the guard checks a connection. */
export async function checkPublicUrl(url: string, options: GuardOptions = {}): Promise<Decision> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { allow: false, reason: 'not a valid URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { allow: false, reason: `${u.protocol} is not http(s)` };
  return decide(u.hostname, options);
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function forwardHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) out[k] = v;
  }
  return out;
}

function splitHostPort(authority: string, defaultPort: number): { host: string; port: number } {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority) ?? /^([^:]+)(?::(\d+))?$/.exec(authority);
  if (!m) return { host: authority, port: defaultPort };
  return { host: m[1]!, port: m[2] ? Number(m[2]) : defaultPort };
}

export async function startNetworkGuard(options: GuardOptions = {}): Promise<NetworkGuard> {
  const blocked: BlockedRequest[] = [];
  const timeout = options.connectTimeoutMs ?? 15000;
  const record = (target: string, reason: string) => blocked.push({ target, reason, at: Date.now() });
  const sockets = new Set<net.Socket>();

  const server = http.createServer(async (req, res) => {
    // A proxy request carries an absolute URL: GET http://host/path HTTP/1.1
    let target: URL;
    try {
      target = new URL(req.url ?? '');
      if (target.protocol !== 'http:') throw new Error('not http');
    } catch {
      res.writeHead(400, { [BLOCKED_HEADER]: BLOCKED_HEADER_VALUE, 'content-type': 'text/plain' });
      res.end('This proxy only forwards absolute http:// requests.');
      return;
    }
    const port = target.port ? Number(target.port) : 80;
    const decision = await decide(target.hostname, options);
    if (!decision.allow) {
      record(`${target.hostname}:${port}`, decision.reason);
      res.writeHead(403, { [BLOCKED_HEADER]: BLOCKED_HEADER_VALUE, 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Blocked by the scanner: ${decision.reason}.`);
      return;
    }
    const upstream = http.request(
      {
        host: decision.address,
        port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: { ...forwardHeaders(req.headers), host: target.host },
        // Connect to the address that was checked, never a fresh lookup.
        lookup: (_h, _o, cb) => cb(null, decision.address, net.isIP(decision.address)),
        timeout,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, forwardHeaders(upRes.headers));
        upRes.pipe(res);
      },
    );
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end();
    });
    req.pipe(upstream);
  });

  // HTTPS and WebSocket-over-TLS: CONNECT host:port, then a raw tunnel.
  server.on('connect', async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    const { host, port } = splitHostPort(req.url ?? '', 443);
    const decision = await decide(host, options);
    if (!decision.allow) {
      // Bracket IPv6 as URL.hostname does, so both record the same way.
      record(`${net.isIPv6(host) ? `[${host}]` : host}:${port}`, decision.reason);
      client.end(
        `HTTP/1.1 403 Forbidden\r\n${BLOCKED_HEADER}: ${BLOCKED_HEADER_VALUE}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
      return;
    }
    const upstream = net.connect({ host: decision.address, port, timeout });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.once('connect', () => {
      upstream.setTimeout(0);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => {
      if (client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });
  });

  // Plain ws:// through the proxy arrives as an absolute-form upgrade request.
  server.on('upgrade', async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const port = target.port ? Number(target.port) : 80;
    const decision = await decide(target.hostname, options);
    if (!decision.allow) {
      record(`${target.hostname}:${port}`, decision.reason);
      client.end(`HTTP/1.1 403 Forbidden\r\n${BLOCKED_HEADER}: ${BLOCKED_HEADER_VALUE}\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const upstream = net.connect({ host: decision.address, port, timeout });
    sockets.add(upstream);
    upstream.once('connect', () => {
      upstream.setTimeout(0);
      const headers = Object.entries(req.headers)
        .filter(([k]) => !k.startsWith('proxy-'))
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      upstream.write(`${req.method} ${target.pathname}${target.search} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });

  server.on('clientError', (_err, socket) => socket.destroy());

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    blocked,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/**
 * Firefox settings for public-only mode. Without hijacking, Firefox connects
 * to localhost directly instead of through the proxy. WebRTC and HTTP/3 use
 * UDP, which an HTTP proxy cannot carry, so they are turned off.
 */
export function firefoxGuardPrefs(): Record<string, string | number | boolean> {
  return {
    'network.proxy.allow_hijacking_localhost': true,
    'network.proxy.no_proxies_on': '',
    'network.http.http3.enable': false,
    'media.peerconnection.enabled': false,
  };
}

/** The same settings for Chrome, which Lighthouse drives. */
export function chromeGuardFlags(proxyUrl: string): string[] {
  return [
    `--proxy-server=${proxyUrl}`,
    // Chrome sends localhost directly unless "<-loopback>" removes the bypass.
    '--proxy-bypass-list=<-loopback>',
    '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  ];
}
