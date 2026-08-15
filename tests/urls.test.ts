import { describe, it, expect } from 'vitest';
import {
  normalizeUrl,
  matchesRules,
  sameOrigin,
  isThirdParty,
  sortUrls,
} from '../src/collect/urls.js';

describe('normalizeUrl', () => {
  it('drops fragments', () => {
    expect(normalizeUrl('https://e.com/a#frag')).toBe('https://e.com/a');
  });

  it('strips query strings by default', () => {
    expect(normalizeUrl('https://e.com/a?b=1')).toBe('https://e.com/a');
  });

  it('sorts query params when keeping them', () => {
    expect(normalizeUrl('https://e.com/a?b=2&a=1', { queryStrategy: 'keep' })).toBe(
      'https://e.com/a?a=1&b=2',
    );
  });

  it('removes trailing slash but preserves the root', () => {
    expect(normalizeUrl('https://e.com/a/')).toBe('https://e.com/a');
    expect(normalizeUrl('https://e.com/')).toBe('https://e.com/');
  });

  it('lowercases host and drops default ports', () => {
    expect(normalizeUrl('HTTPS://Example.COM:443/A')).toBe('https://example.com/A');
    expect(normalizeUrl('http://example.com:80/a')).toBe('http://example.com/a');
  });

  it('collapses URLs that differ only by fragment', () => {
    expect(normalizeUrl('https://e.com/a#x')).toBe(normalizeUrl('https://e.com/a#y'));
  });

  it('returns the input unchanged when it is not a valid URL', () => {
    expect(normalizeUrl('not a url')).toBe('not a url');
  });
});

describe('matchesRules', () => {
  it('includes everything when no include patterns are given', () => {
    expect(matchesRules('https://e.com/x')).toBe(true);
  });

  it('applies include patterns against the path', () => {
    expect(matchesRules('https://e.com/admin/content', ['^/admin'])).toBe(true);
    expect(matchesRules('https://e.com/node/1', ['^/admin'])).toBe(false);
  });

  it('lets exclude win over include', () => {
    const inc = ['^/admin'];
    const exc = ['/admin/reports/dblog/event/'];
    expect(matchesRules('https://e.com/admin/reports/dblog/event/9', inc, exc)).toBe(false);
    expect(matchesRules('https://e.com/admin/content', inc, exc)).toBe(true);
  });

  it('does not match everything when a pattern is invalid', () => {
    expect(matchesRules('https://e.com/a', ['[unclosed'])).toBe(false);
  });
});

describe('sameOrigin', () => {
  it('compares scheme, host and port', () => {
    expect(sameOrigin('https://e.com/a', 'https://e.com/b')).toBe(true);
    expect(sameOrigin('https://e.com/a', 'http://e.com/b')).toBe(false);
    expect(sameOrigin('https://e.com/a', 'https://other.com/b')).toBe(false);
  });
});

describe('isThirdParty', () => {
  it('treats the same host as first party', () => {
    expect(isThirdParty('https://e.com/x.js', 'https://e.com/')).toBe(false);
  });

  it('treats subdomains of the page host as first party', () => {
    expect(isThirdParty('https://static.e.com/x.js', 'https://e.com/')).toBe(false);
  });

  it('treats a different registrable host as third party', () => {
    expect(isThirdParty('https://cdn.other.com/x.js', 'https://e.com/')).toBe(true);
  });
});

describe('sortUrls', () => {
  it('is deterministic', () => {
    const input = ['https://e.com/b', 'https://e.com/a'];
    expect(sortUrls(input)).toEqual(['https://e.com/a', 'https://e.com/b']);
    // does not mutate the caller's array
    expect(input[0]).toBe('https://e.com/b');
  });
});
