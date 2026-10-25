import { describe, it, expect } from 'vitest';
import { isPrivateAddress, localHostReason } from '../src/core/addresses.js';
import { isPublicHttpUrl } from '../src/cli/issue-parser.js';

describe('isPrivateAddress: IPv4', () => {
  it.each([
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '100.127.255.254', '127.0.0.1', '127.255.255.255',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.1', '192.168.1.1',
    '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250',
    '240.0.0.1', '255.255.255.255',
  ])('refuses %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['1.1.1.1', '8.8.8.8', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0', '93.184.215.14'])(
    'allows public %s',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});

describe('isPrivateAddress: IPv6', () => {
  it.each([
    '::', '::1', '[::1]', 'fe80::1', 'fe80::1%eth0', 'fc00::1', 'fd12:3456:789a::1', 'fec0::1', 'ff02::1',
    '2001:db8::1', '100::1',
    // IPv4 wrapped in IPv6 must be judged as the IPv4 address it carries.
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:192.168.1.1', '::127.0.0.1',
    '64:ff9b::10.0.0.1', '64:ff9b::a00:1', '2002:c0a8:0101::1', '2002:7f00:1::',
  ])('refuses %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1'])(
    'allows public %s',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );

  it('refuses what it cannot parse rather than guessing', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
    expect(isPrivateAddress('1.2.3')).toBe(true);
    expect(isPrivateAddress('')).toBe(true);
  });
});

describe('localHostReason', () => {
  it.each([
    'mysite.ddev.site', 'ddev.site', 'drupal11.ddev.site', 'app.ddev.local', 'site.lndo.site',
    'anything.localtest.me', 'x.lvh.me', '127.0.0.1.nip.io', '10.0.0.1.sslip.io', 'my.traefik.me',
    'localhost', 'app.localhost', 'printer.local', 'db.internal', 'site.test', 'router.home.arpa',
    'nas.lan', 'intranet', 'LOCALHOST', 'mysite.ddev.site.',
  ])('refuses %s by name', (host) => {
    expect(localHostReason(host)).toBeDefined();
  });

  it('names DDEV in the reason', () => {
    expect(localHostReason('mysite.ddev.site')).toMatch(/development name \(\.ddev\.site\)/);
  });

  it.each(['example.com', 'www.drupal.org', 'ddev.com', 'notddev.site', 'test.com', 'local.gov.uk', 'my-site.dev'])(
    'allows %s',
    (host) => {
      expect(localHostReason(host)).toBeUndefined();
    },
  );
});

describe('isPublicHttpUrl: forms that hide a private address', () => {
  it.each([
    'http://mysite.ddev.site/',
    'https://drupal.ddev.site:8443/user/login',
    'http://app.lndo.site/',
    'http://127.0.0.1.nip.io/',
    // WHATWG URL normalises these to 127.0.0.1 before the check runs.
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fd00::1]/',
    'http://100.100.100.100/', // Tailscale
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://user:pass@example.com/',
  ])('refuses %s', (url) => {
    expect(isPublicHttpUrl(url)).toBe(false);
  });
});
