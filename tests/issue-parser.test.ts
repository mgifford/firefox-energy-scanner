import { describe, it, expect } from 'vitest';
import {
  isPublicHttpUrl,
  extractSection,
  parseScanRequest,
  MAX_URLS,
  MAX_RUNS,
} from '../src/cli/issue-parser.js';

describe('isPublicHttpUrl', () => {
  it('accepts public http and https URLs', () => {
    expect(isPublicHttpUrl('https://example.com/')).toBe(true);
    expect(isPublicHttpUrl('http://example.com/a?b=1')).toBe(true);
    expect(isPublicHttpUrl('https://sub.example.co.uk/path')).toBe(true);
  });

  it('rejects non-http schemes', () => {
    expect(isPublicHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isPublicHttpUrl('ftp://example.com')).toBe(false);
    expect(isPublicHttpUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects localhost and loopback', () => {
    expect(isPublicHttpUrl('http://localhost:8080/')).toBe(false);
    expect(isPublicHttpUrl('http://127.0.0.1/')).toBe(false);
    expect(isPublicHttpUrl('http://127.1.2.3/')).toBe(false);
    expect(isPublicHttpUrl('http://app.localhost/')).toBe(false);
  });

  it('rejects RFC1918 private ranges', () => {
    expect(isPublicHttpUrl('http://10.0.0.1/')).toBe(false);
    expect(isPublicHttpUrl('http://192.168.1.1/')).toBe(false);
    expect(isPublicHttpUrl('http://172.16.0.1/')).toBe(false);
    expect(isPublicHttpUrl('http://172.31.255.255/')).toBe(false);
  });

  it('accepts public addresses just outside the private ranges', () => {
    expect(isPublicHttpUrl('http://172.15.0.1/')).toBe(true);
    expect(isPublicHttpUrl('http://172.32.0.1/')).toBe(true);
    expect(isPublicHttpUrl('http://11.0.0.1/')).toBe(true);
  });

  it('rejects link-local, multicast and 0.0.0.0', () => {
    expect(isPublicHttpUrl('http://169.254.169.254/')).toBe(false);
    expect(isPublicHttpUrl('http://224.0.0.1/')).toBe(false);
    expect(isPublicHttpUrl('http://0.0.0.0/')).toBe(false);
  });

  it('rejects .local and .internal hostnames', () => {
    expect(isPublicHttpUrl('http://printer.local/')).toBe(false);
    expect(isPublicHttpUrl('http://db.internal/')).toBe(false);
  });

  it('rejects a dotless hostname', () => {
    expect(isPublicHttpUrl('http://intranet/')).toBe(false);
  });

  it('rejects malformed input', () => {
    expect(isPublicHttpUrl('not a url')).toBe(false);
    expect(isPublicHttpUrl('')).toBe(false);
  });
});

describe('extractSection', () => {
  const body = [
    '### URLs',
    '',
    'https://a.com',
    'https://b.com',
    '',
    '### Measurement type',
    '',
    'macos',
    '',
    '### Measured runs per URL',
    '',
    '_No response_',
    '',
  ].join('\n');

  it('extracts a multi-line section', () => {
    expect(extractSection(body, 'URLs')).toBe('https://a.com\nhttps://b.com');
  });

  it('extracts a single-value section', () => {
    expect(extractSection(body, 'Measurement type')).toBe('macos');
  });

  it('treats "_No response_" as absent', () => {
    expect(extractSection(body, 'Measured runs per URL')).toBeUndefined();
  });

  it('returns undefined for a missing section', () => {
    expect(extractSection(body, 'Nope')).toBeUndefined();
  });

  it('is case-insensitive on the label', () => {
    expect(extractSection(body, 'urls')).toBeDefined();
  });
});

describe('parseScanRequest', () => {
  const build = (urls: string[], runner = 'macos', runs = '8') =>
    ['### URLs', '', ...urls, '', '### Measurement type', '', runner, '', '### Measured runs per URL', '', runs, ''].join('\n');

  it('parses a well-formed request', () => {
    const r = parseScanRequest(build(['https://a.com', 'https://b.com'], 'macos', '10'));
    expect(r.urls).toEqual(['https://a.com', 'https://b.com']);
    expect(r.runner).toBe('macos');
    expect(r.runs).toBe(10);
    expect(r.errors).toEqual([]);
  });

  it('selects the linux runner when requested', () => {
    expect(parseScanRequest(build(['https://a.com'], 'linux')).runner).toBe('linux');
  });

  it('defaults to the macos runner', () => {
    expect(parseScanRequest(build(['https://a.com'], 'something else')).runner).toBe('macos');
  });

  it('drops private URLs and reports them', () => {
    const r = parseScanRequest(build(['https://a.com', 'http://127.0.0.1/', 'http://10.0.0.5/']));
    expect(r.urls).toEqual(['https://a.com']);
    expect(r.errors.join(' ')).toMatch(/not public web URLs/);
  });

  it('errors when no valid URL remains', () => {
    const r = parseScanRequest(build(['http://localhost/']));
    expect(r.urls).toEqual([]);
    expect(r.errors.join(' ')).toMatch(/No valid public/);
  });

  it('deduplicates repeated URLs', () => {
    const r = parseScanRequest(build(['https://a.com', 'https://a.com']));
    expect(r.urls).toEqual(['https://a.com']);
  });

  it('strips markdown list markers', () => {
    const r = parseScanRequest(build(['- https://a.com', '* https://b.com']));
    expect(r.urls).toEqual(['https://a.com', 'https://b.com']);
  });

  it('caps the URL count', () => {
    const many = Array.from({ length: MAX_URLS + 5 }, (_, i) => `https://e${i}.com`);
    const r = parseScanRequest(build(many));
    expect(r.urls).toHaveLength(MAX_URLS);
    expect(r.errors.join(' ')).toMatch(/Too many URLs/);
  });

  it('caps the run count', () => {
    const r = parseScanRequest(build(['https://a.com'], 'macos', '999'));
    expect(r.runs).toBe(MAX_RUNS);
    expect(r.errors.join(' ')).toMatch(/capped/);
  });

  it('falls back to the default run count on unparseable input', () => {
    const r = parseScanRequest(build(['https://a.com'], 'macos', 'lots'));
    expect(r.runs).toBe(8);
    expect(r.errors.join(' ')).toMatch(/Could not read a run count/);
  });
});
