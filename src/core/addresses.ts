import { isIP } from 'node:net';

/**
 * Which addresses a public scan must never reach.
 *
 * A scan of a URL submitted by a stranger runs a real browser. On GitHub's
 * cloud the worst it can reach is that throw-away machine; on a runner at
 * someone's home it could reach their router, their NAS or a development
 * site. So everything that is not a public internet address is refused:
 * loopback, private ranges, link-local, carrier-grade NAT (which includes
 * Tailscale), multicast, reserved, and the IPv6 equivalents, including IPv4
 * addresses wrapped inside IPv6.
 *
 * Shared by the issue parser (literal addresses, for early feedback) and the
 * network guard (every address a name resolves to, at scan time).
 */

function v4ToInt(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined;
    const v = Number(p);
    if (v > 255) return undefined;
    n = n * 256 + v;
  }
  return n;
}

/** CIDR blocks that are not public internet addresses (RFC 6890 and friends). */
const PRIVATE_V4: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT; Tailscale uses it too
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and 255.255.255.255 broadcast
];

const PRIVATE_V4_RANGES = PRIVATE_V4.map(([base, bits]) => {
  const start = v4ToInt(base)!;
  const size = 2 ** (32 - bits);
  return { start, end: start + size - 1 };
});

function isPrivateV4(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n === undefined) return true; // unparseable: refuse rather than guess
  return PRIVATE_V4_RANGES.some((r) => n >= r.start && n <= r.end);
}

/** Expand an IPv6 address to eight 16-bit groups. */
function v6Groups(ip: string): number[] | undefined {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);
  // A trailing dotted IPv4 part (::ffff:1.2.3.4) becomes two groups.
  const v4tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (v4tail) {
    const n = v4ToInt(v4tail[1]!);
    if (n === undefined) return undefined;
    addr = addr.slice(0, -v4tail[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && head.length !== 8) return undefined;
  if (missing < 0) return undefined;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8) return undefined;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined;
    out.push(Number.parseInt(g, 16));
  }
  return out;
}

const groupsToV4 = (a: number, b: number) =>
  `${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`;

function isPrivateV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return true; // unparseable: refuse
  const allZeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);

  if (g.every((x) => x === 0)) return true; // ::
  if (allZeroUpTo(7) && g[7] === 1) return true; // ::1
  // IPv4-mapped ::ffff:a.b.c.d and the old IPv4-compatible ::a.b.c.d
  if (allZeroUpTo(5) && (g[5] === 0xffff || g[5] === 0)) return isPrivateV4(groupsToV4(g[6]!, g[7]!));
  // NAT64 64:ff9b::/96 carries an IPv4 address in its last 32 bits
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isPrivateV4(groupsToV4(g[6]!, g[7]!));
  }
  // 6to4 2002::/16 carries an IPv4 address in bits 16–47
  if (g[0] === 0x2002) return isPrivateV4(groupsToV4(g[1]!, g[2]!));
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if (first === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // 100::/64 discard
  return false;
}

/** True for any address a public scan must not reach. Unparseable input counts as private. */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  const kind = isIP(bare.replace(/%.*$/, ''));
  if (kind === 4) return isPrivateV4(bare);
  if (kind === 6) return isPrivateV6(bare);
  return true;
}

/**
 * Host names that are local by design. Several are public DNS names that
 * resolve to 127.0.0.1 on purpose, so local development tools work without
 * editing /etc/hosts — DDEV (*.ddev.site), Lando (*.lndo.site), localtest.me,
 * lvh.me — or that embed any address in the name (nip.io, sslip.io). A check
 * on the URL alone cannot see where they point, so they are refused by name.
 * Reserved and private-use top-level names are refused too.
 */
const LOCAL_SUFFIXES = [
  // DDEV, Lando, and other local-development wildcards
  'ddev.site', 'ddev.local', 'lndo.site', 'localtest.me', 'lvh.me', 'vcap.me',
  'localhost.direct', 'local.gd', 'nip.io', 'sslip.io', 'xip.io', 'traefik.me',
  // reserved and private-use names
  'localhost', 'local', 'internal', 'test', 'example', 'invalid', 'home.arpa',
  'lan', 'home', 'corp', 'intranet', 'private', 'localdomain',
];

/** Why a host name or literal address is not public, or undefined if it may be. */
export function localHostReason(hostname: string): string | undefined {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return 'empty host';
  if (isIP(host.replace(/%.*$/, ''))) {
    return isPrivateAddress(host) ? `${host} is a private or reserved address` : undefined;
  }
  const suffix = LOCAL_SUFFIXES.find((s) => host === s || host.endsWith(`.${s}`));
  if (suffix) return `${host} is a local or development name${host === suffix ? '' : ` (.${suffix})`}`;
  if (!host.includes('.')) return `${host} is not a public host name`;
  return undefined;
}
