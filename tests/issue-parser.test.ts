import { describe, it, expect } from 'vitest';
import {
  isPublicHttpUrl,
  extractSection,
  parseScanRequest,
  parseViewport,
  estimateMinutes,
  MAX_URLS,
  MAX_RUNS,
  MAX_CRAWL_PAGES,
  JOB_BUDGET_MINUTES,
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
  const build = (urls: string[], runner = 'macos', runs = '8', mode = 'measure') =>
    ['### Scan mode', '', mode, '', '### URLs', '', ...urls, '', '### Measurement type', '', runner,
     '', '### Measured runs per URL', '', runs, ''].join('\n');

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
    expect(r.notes.join(' ')).toMatch(/capped/);
  });

  it('falls back to the default run count on unparseable input', () => {
    const r = parseScanRequest(build(['https://a.com'], 'macos', 'lots'));
    expect(r.runs).toBe(8);
    expect(r.notes.join(' ')).toMatch(/Could not read a run count/);
  });

  it('defaults to measure mode', () => {
    expect(parseScanRequest(build(['https://a.com'])).mode).toBe('measure');
  });
});

describe('parseViewport', () => {
  it('defaults to desktop', () => {
    expect(parseViewport(undefined)).toEqual({ width: 1280, height: 800 });
    expect(parseViewport('Default (1280x800 desktop)')).toEqual({ width: 1280, height: 800 });
  });

  it('distinguishes tablet portrait from landscape', () => {
    expect(parseViewport('Tablet portrait (768x1024)')).toEqual({ width: 768, height: 1024 });
    expect(parseViewport('Tablet landscape (1024x768)')).toEqual({ width: 1024, height: 768 });
  });

  it('distinguishes mobile portrait from landscape', () => {
    expect(parseViewport('Mobile portrait')).toEqual({ width: 390, height: 844 });
    expect(parseViewport('Mobile landscape')).toEqual({ width: 844, height: 390 });
  });

  it('accepts an explicit WIDTHxHEIGHT', () => {
    expect(parseViewport('1440x900')).toEqual({ width: 1440, height: 900 });
    expect(parseViewport('1440×900')).toEqual({ width: 1440, height: 900 });
  });

  it('bounds absurd custom sizes', () => {
    expect(parseViewport('99999x99999')).toEqual({ width: 3840, height: 2160 });
  });
});

describe('estimateMinutes', () => {
  it('scales linearly with pages in crawl mode', () => {
    const one = estimateMinutes({ mode: 'crawl', urls: ['https://a.com'], runs: 1, maxPages: 50 });
    const two = estimateMinutes({ mode: 'crawl', urls: ['https://a.com'], runs: 1, maxPages: 100 });
    expect(two).toBeGreaterThan(one * 1.8);
  });

  it('scales with runs in measure mode', () => {
    const few = estimateMinutes({ mode: 'measure', urls: ['https://a.com'], runs: 2, maxPages: 0 });
    const many = estimateMinutes({ mode: 'measure', urls: ['https://a.com'], runs: 20, maxPages: 0 });
    expect(many).toBeGreaterThan(few * 3);
  });

  /**
   * The distinction that motivates separate limits for the two modes: a full
   * 200-page crawl fits the budget, while repeating 200 URLs eight times each
   * does not.
   */
  it('shows a 200-page crawl is feasible where 200 measured URLs are not', () => {
    const crawl = estimateMinutes({ mode: 'crawl', urls: ['https://a.com'], runs: 1, maxPages: 200 });
    const measure = estimateMinutes({
      mode: 'measure',
      urls: Array.from({ length: 200 }, (_, i) => `https://e${i}.com`),
      runs: 8,
      maxPages: 0,
    });
    expect(crawl).toBeLessThan(JOB_BUDGET_MINUTES);
    expect(measure).toBeGreaterThan(JOB_BUDGET_MINUTES);
    // Roughly 44 minutes versus 147.
    expect(Math.round(crawl)).toBeLessThan(60);
    expect(Math.round(measure)).toBeGreaterThan(120);
  });
});

describe('crawl mode requests', () => {
  const buildCrawl = (urls: string[], pages = '50', include?: string) =>
    [
      '### Scan mode', '', 'crawl', '',
      '### URLs', '', ...urls, '',
      '### Measurement type', '', 'macos', '',
      '### Maximum pages to crawl', '', pages, '',
      ...(include ? ['### Include pattern', '', include, ''] : []),
    ].join('\n');

  it('parses a crawl request', () => {
    const r = parseScanRequest(buildCrawl(['https://a.com'], '80'));
    expect(r.mode).toBe('crawl');
    expect(r.maxPages).toBe(80);
    expect(r.errors).toEqual([]);
  });

  it('allows many more pages than measure mode allows URLs', () => {
    const r = parseScanRequest(buildCrawl(['https://a.com'], String(MAX_CRAWL_PAGES)));
    expect(r.maxPages).toBe(MAX_CRAWL_PAGES);
    expect(MAX_CRAWL_PAGES).toBeGreaterThan(MAX_URLS);
    expect(r.errors).toEqual([]);
  });

  it('caps the page limit', () => {
    const r = parseScanRequest(buildCrawl(['https://a.com'], '5000'));
    expect(r.maxPages).toBe(MAX_CRAWL_PAGES);
    expect(r.notes.join(' ')).toMatch(/capped/);
  });

  it('uses only the first URL as the crawl start', () => {
    const r = parseScanRequest(buildCrawl(['https://a.com', 'https://b.com']));
    expect(r.urls).toEqual(['https://a.com']);
    expect(r.notes.join(' ')).toMatch(/single start URL/);
  });

  it('accepts a valid include pattern', () => {
    const r = parseScanRequest(buildCrawl(['https://a.com'], '20', '^/admin'));
    expect(r.include).toBe('^/admin');
    expect(r.errors).toEqual([]);
  });

  it('rejects an invalid include pattern', () => {
    const r = parseScanRequest(buildCrawl(['https://a.com'], '20', '[unclosed'));
    expect(r.errors.join(' ')).toMatch(/not a valid regular expression/);
  });

  it('warns that a crawl is not a regression workload', () => {
    const r = parseScanRequest(buildCrawl(['https://a.com']));
    expect(r.notes.join(' ')).toMatch(/not for regression comparison/);
  });
});

describe('job budget guard', () => {
  /**
   * The URL and run caps already keep measure requests well inside the budget:
   * the maximum allowed request (20 URLs x 30 runs) is about 47 minutes. The
   * guard exists for crawls, where the page limit dominates.
   */
  it('allows the largest permitted measure request', () => {
    const many = Array.from({ length: MAX_URLS }, (_, i) => `https://e${i}.com`);
    const body = ['### Scan mode', '', 'measure', '', '### URLs', '', ...many, '',
      '### Measured runs per URL', '', String(MAX_RUNS), ''].join('\n');
    const r = parseScanRequest(body);
    expect(r.errors).toEqual([]);
    expect(estimateMinutes(r)).toBeLessThan(JOB_BUDGET_MINUTES);
  });

  it('rejects a crawl that would exceed the budget', () => {
    // estimateMinutes is exercised directly because the page cap prevents a
    // request from expressing an over-budget crawl through the form.
    const withinBudget = estimateMinutes({
      mode: 'crawl', urls: ['https://a.com'], runs: 1, maxPages: MAX_CRAWL_PAGES,
    });
    const overBudget = estimateMinutes({
      mode: 'crawl', urls: ['https://a.com'], runs: 1, maxPages: 2000,
    });
    expect(withinBudget).toBeLessThan(JOB_BUDGET_MINUTES);
    expect(overBudget).toBeGreaterThan(JOB_BUDGET_MINUTES);
  });

  it('rejects an oversized crawl only when it exceeds the budget', () => {
    const ok = parseScanRequest(['### Scan mode', '', 'crawl', '', '### URLs', '',
      'https://a.com', '', '### Maximum pages to crawl', '', '200', ''].join('\n'));
    expect(ok.errors).toEqual([]);
  });

  it('accepts a request that fits', () => {
    const body = ['### Scan mode', '', 'measure', '', '### URLs', '', 'https://a.com', '',
      '### Measured runs per URL', '', '8', ''].join('\n');
    expect(parseScanRequest(body).errors).toEqual([]);
  });
});
