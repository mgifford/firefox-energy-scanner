import { describe, it, expect } from 'vitest';
import {
  isPublicHttpUrl,
  extractSection,
  parseScanRequest,
  parseViewport,
  estimateMinutes,
  parseLighthouseChoice,
  planRuns,
  LIGHTHOUSE_SECONDS_PER_RUN,
  LIGHTHOUSE_TOP_PAGES,
  DEFAULT_RUNS,
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


/** The new, short form: URLs, plus optional fields. */
const form = (urls: string[], fields: Record<string, string> = {}) =>
  ['### URLs', '', ...urls, '', ...Object.entries(fields).flatMap(([k, v]) => [`### ${k}`, '', v, ''])].join('\n');

/** The older, longer form (issues #2–#11 were filed with it). */
const legacy = (urls: string[], mode = 'measure', runner = 'linux', runs = '8', extra: Record<string, string> = {}) =>
  form(urls, { 'Scan mode': mode, 'Measurement type': runner, 'Measured runs per URL': runs, ...extra });

describe('parseScanRequest: the easy default', () => {
  it('needs nothing but URLs', () => {
    const r = parseScanRequest(form(['https://a.com/', 'https://a.com/about']));
    expect(r.errors).toEqual([]);
    expect(r.mode).toBe('measure');
    expect(r.runner).toBe('auto');
    expect(r.urls).toEqual(['https://a.com/', 'https://a.com/about']);
  });

  it('crawls the site when given a single URL', () => {
    const r = parseScanRequest(form(['https://france.fr/']));
    expect(r.mode).toBe('crawl');
    expect(r.maxPages).toBe(50);
    expect(r.notes[0]).toMatch(/Crawling https:\/\/france\.fr\/ .* up to 50 pages/);
  });

  it('scans a list as a list', () => {
    const r = parseScanRequest(form(['https://a.com/1', 'https://a.com/2', 'https://a.com/3']));
    expect(r.mode).toBe('measure');
    expect(r.notes[0]).toBe('Scanning 3 listed pages.');
  });

  it('honours an explicit choice either way', () => {
    expect(parseScanRequest(form(['https://a.com/'], { 'What to scan': 'Only the listed URLs' })).mode).toBe('measure');
    const crawl = parseScanRequest(form(['https://a.com/', 'https://a.com/b'], { 'What to scan': 'Crawl the site from the first URL' }));
    expect(crawl.mode).toBe('crawl');
    expect(crawl.notScanned).toEqual([{ url: 'https://a.com/b', reason: 'crawling starts from one URL' }]);
  });

  it('accepts comma-separated URLs, as the web form allows', () => {
    expect(parseScanRequest(form(['https://a.com/1, https://a.com/2'])).urls).toEqual(['https://a.com/1', 'https://a.com/2']);
  });

  it('scans up to 200 URLs and lists the rest instead of rejecting', () => {
    const many = Array.from({ length: MAX_URLS + 3 }, (_, i) => `https://e${i}.com`);
    const r = parseScanRequest(form(many));
    expect(MAX_URLS).toBe(200);
    expect(r.errors).toEqual([]);
    expect(r.urls).toHaveLength(MAX_URLS);
    expect(r.notScanned.map((n) => n.reason)).toEqual(Array(3).fill(`over the ${MAX_URLS}-URL limit`));
  });

  it('turns Lighthouse on for the heaviest pages by default in the new form', () => {
    const r = parseScanRequest(form(['https://a.com/'], { Lighthouse: 'Performance — the 10 heaviest pages' }));
    expect(r.lighthouse).toBe('performance');
    expect(r.lighthouseScope).toBe('top');
    expect(r.lighthouseRuns).toBe(1);
  });

  it('can audit every page, or switch Lighthouse off', () => {
    expect(parseScanRequest(form(['https://a.com/1', 'https://a.com/2'], { Lighthouse: 'Performance — every page (slower)' })).lighthouseScope).toBe('every');
    expect(parseScanRequest(form(['https://a.com/'], { Lighthouse: 'No' })).lighthouse).toBe('none');
  });

  it('falls back to the heaviest pages when Lighthouse on every page would overrun', () => {
    const many = Array.from({ length: 200 }, (_, i) => `https://e${i}.com`);
    const r = parseScanRequest(form(many, { Lighthouse: 'Performance — every page (slower)' }));
    expect(r.errors).toEqual([]);
    expect(r.lighthouseScope).toBe('top');
    expect(r.notes.join(' ')).toMatch(/would overrun/);
  });

  it('reads every option of the issue template exactly as written', async () => {
    // The labels come from the template itself, so a reworded option that the
    // parser no longer understands fails here rather than in production.
    const { readFileSync } = await import('node:fs');
    const { parse } = await import('yaml');
    const tpl = parse(readFileSync('.github/ISSUE_TEMPLATE/scan-request.yml', 'utf8')) as {
      body: { id?: string; attributes: { label?: string; options?: string[] } }[];
    };
    const options = (id: string) => tpl.body.find((b) => b.id === id)!.attributes.options!;
    const label = (id: string) => tpl.body.find((b) => b.id === id)!.attributes.label!;
    const one = (id: string, value: string, urls = ['https://a.com/', 'https://a.com/b']) =>
      parseScanRequest(form(urls, { [label(id)]: value }));

    expect(options('where').map((o) => one('where', o).runner)).toEqual(['auto', 'cloud']);
    expect(options('what').map((o) => one('what', o).mode)).toEqual(['measure', 'measure', 'crawl']);
    expect(options('what').map((o) => one('what', o, ['https://a.com/']).mode)).toEqual(['crawl', 'measure', 'crawl']);
    expect(options('lighthouse').map((o) => `${one('lighthouse', o).lighthouse}/${one('lighthouse', o).lighthouseScope}`)).toEqual([
      'performance/top',
      'performance/every',
      'all/top',
      'none/top',
    ]);
    expect(options('viewport').map((o) => one('viewport', o).viewport.width)).toEqual([1280, 768, 1024, 390, 844]);
  });

  it('skips private URLs, scans the rest, and lists what was skipped', () => {
    const r = parseScanRequest(form(['https://a.com', 'http://127.0.0.1/', 'http://10.0.0.5/']));
    expect(r.urls).toEqual(['https://a.com']);
    expect(r.errors).toEqual([]);
    expect(r.notScanned).toEqual([
      { url: 'http://127.0.0.1/', reason: 'a private or reserved address; scans only reach public sites' },
      { url: 'http://10.0.0.5/', reason: 'a private or reserved address; scans only reach public sites' },
    ]);
  });

  it('says why a DDEV or other local site is skipped', () => {
    const r = parseScanRequest(form(['https://a.com', 'https://mysite.ddev.site/', 'ftp://a.com/', 'https://u:p@a.com/']));
    expect(r.urls).toEqual(['https://a.com']);
    expect(r.notScanned.map((n) => n.reason)).toEqual([
      'a local or development name (such as localhost or *.ddev.site); scans only reach public sites',
      'not a public http(s) URL',
      'contains a user name or password',
    ]);
  });

  it('errors when no valid URL remains', () => {
    const r = parseScanRequest(form(['http://localhost/']));
    expect(r.urls).toEqual([]);
    expect(r.errors.join(' ')).toMatch(/No valid public/);
  });

  it('deduplicates repeated URLs and strips list markers', () => {
    expect(parseScanRequest(form(['- https://a.com', '* https://a.com', 'https://b.com'])).urls).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
  });

  it('flattens and bounds echoed text so it cannot break workflow outputs', () => {
    const hostile = 'x\nEOF_NOTES\nvalid=true\n' + 'y'.repeat(500);
    const r = parseScanRequest(form(['https://a.com', hostile], { 'Maximum pages to crawl': 'abc\nEOF_NOTES\nrunner=x' }));
    for (const line of [...r.notes, ...r.errors, ...r.notScanned.map((n) => n.url)]) {
      expect(line).not.toMatch(/[\r\n]/);
      expect(line.length).toBeLessThanOrEqual(400);
    }
  });

  it('rejects a multi-line include pattern', () => {
    const r = parseScanRequest(form(['https://a.com'], { 'Include pattern': '^/a\nissue=1' }));
    expect(r.errors.join(' ')).toMatch(/single line/);
  });
});

describe('parseScanRequest: requests written with the older form', () => {
  it('scans a pasted list even when the old form said crawl (issue #11)', () => {
    const urls = Array.from({ length: 82 }, (_, i) => `https://france.fr/page-${i}`);
    const r = parseScanRequest(legacy(urls, 'crawl — follow links from one URL, once each (up to 200 pages)'));
    expect(r.mode).toBe('measure');
    expect(r.urls).toHaveLength(82);
    expect(r.notScanned).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/82 URLs were listed, so they are scanned as a list/);
  });

  it('still crawls from a single URL when the old form said crawl', () => {
    expect(parseScanRequest(legacy(['https://france.fr/'], 'crawl')).mode).toBe('crawl');
  });

  it('keeps the old measure meaning for a single URL', () => {
    expect(parseScanRequest(legacy(['https://a.com/'], 'measure')).mode).toBe('measure');
  });

  it('maps the old runner choices', () => {
    expect(parseScanRequest(legacy(['https://a.com'], 'measure', 'self-hosted — physical Apple Silicon')).runner).toBe('auto');
    expect(parseScanRequest(legacy(['https://a.com'], 'measure', 'macos — structural only')).runner).toBe('macos');
    expect(parseScanRequest(legacy(['https://a.com'], 'measure', 'linux — structural only')).runner).toBe('cloud');
  });

  it('reads the old run count, capped, for machines that measure energy', () => {
    expect(parseScanRequest(legacy(['https://a.com'], 'measure', 'self-hosted', '999')).runs).toBe(MAX_RUNS);
    expect(parseScanRequest(legacy(['https://a.com'], 'measure', 'self-hosted', 'lots')).runs).toBe(DEFAULT_RUNS);
  });

  it('maps the old Lighthouse labels to the heaviest pages', () => {
    const r = parseScanRequest(legacy(['https://a.com'], 'measure', 'linux', '8', { Lighthouse: 'Performance — score, metrics and recommendations' }));
    expect(r.lighthouse).toBe('performance');
    expect(r.lighthouseScope).toBe('top');
  });

  it('leaves Lighthouse off when the old form had no Lighthouse field', () => {
    expect(parseScanRequest(legacy(['https://a.com'])).lighthouse).toBe('none');
  });
});

describe('parseLighthouseChoice', () => {
  it('reads each label', () => {
    expect(parseLighthouseChoice('No')).toBe('none');
    expect(parseLighthouseChoice('Performance — the 10 heaviest pages')).toBe('performance');
    expect(parseLighthouseChoice('All categories — the 10 heaviest pages')).toBe('all');
    expect(parseLighthouseChoice('All — performance, accessibility, best practices and SEO')).toBe('all');
    expect(parseLighthouseChoice(undefined)).toBe('none');
  });
});

describe('planRuns', () => {
  it('visits each page once on a machine that cannot measure energy', () => {
    expect(planRuns(80, false)).toEqual({ runs: 1, warmups: 0 });
  });

  it('repeats pages on a machine that measures energy', () => {
    expect(planRuns(5, true)).toEqual({ runs: DEFAULT_RUNS, warmups: 2 });
  });

  it('scales runs down so a long list still fits the budget', () => {
    const plan = planRuns(200, true);
    expect(plan.runs).toBeGreaterThanOrEqual(3);
    expect(plan.runs).toBeLessThan(DEFAULT_RUNS);
    expect(estimateMinutes({ mode: 'measure', urls: Array(150).fill('x'), maxPages: 0, energyMachine: true })).toBeLessThan(JOB_BUDGET_MINUTES + 1);
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
    const one = estimateMinutes({ mode: 'crawl', urls: ['https://a.com'], maxPages: 50 });
    const two = estimateMinutes({ mode: 'crawl', urls: ['https://a.com'], maxPages: 100 });
    expect(two).toBeGreaterThan(one * 1.8);
  });

  it('keeps the largest cloud requests inside the budget', () => {
    const urls = Array.from({ length: MAX_URLS }, (_, i) => `https://e${i}.com`);
    expect(estimateMinutes({ mode: 'measure', urls, maxPages: 0, lighthouse: 'all', lighthouseScope: 'top' })).toBeLessThan(JOB_BUDGET_MINUTES);
    expect(estimateMinutes({ mode: 'crawl', urls: ['https://a.com'], maxPages: MAX_CRAWL_PAGES, lighthouse: 'all' })).toBeLessThan(JOB_BUDGET_MINUTES);
  });

  it('counts Lighthouse on the heaviest pages only, by default', () => {
    const urls = Array.from({ length: 40 }, (_, i) => `https://e${i}.com`);
    const base = { mode: 'measure' as const, urls, maxPages: 0 };
    const diff = estimateMinutes({ ...base, lighthouse: 'performance' }) - estimateMinutes(base);
    expect(diff).toBeCloseTo((LIGHTHOUSE_TOP_PAGES * LIGHTHOUSE_SECONDS_PER_RUN) / 60, 6);
    const every = estimateMinutes({ ...base, lighthouse: 'performance', lighthouseScope: 'every' }) - estimateMinutes(base);
    expect(every).toBeCloseTo((40 * LIGHTHOUSE_SECONDS_PER_RUN) / 60, 6);
  });
});

describe('crawl requests', () => {
  const crawlForm = (pages?: string, include?: string) =>
    form(['https://a.com'], {
      ...(pages ? { 'Maximum pages to crawl': pages } : {}),
      ...(include ? { 'Include pattern': include } : {}),
    });

  it('reads the page limit and caps it', () => {
    expect(parseScanRequest(crawlForm('80')).maxPages).toBe(80);
    const r = parseScanRequest(crawlForm('5000'));
    expect(r.maxPages).toBe(MAX_CRAWL_PAGES);
    expect(r.notes.join(' ')).toMatch(/capped/);
  });

  it('accepts a valid include pattern and rejects an invalid one', () => {
    expect(parseScanRequest(crawlForm('20', '^/admin')).include).toBe('^/admin');
    expect(parseScanRequest(crawlForm('20', '[unclosed')).errors.join(' ')).toMatch(/not a valid regular expression/);
  });
});

describe('requests opened without the form', () => {
  it('takes the URL from a "SCAN:" title when the body is empty (issue #21, #22)', () => {
    const ottawa = parseScanRequest('', 'SCAN: Ottawa.ca');
    expect(ottawa.errors).toEqual([]);
    expect(ottawa.urls).toEqual(['https://Ottawa.ca']);
    expect(ottawa.notes.join(' ')).toMatch(/taken from the title/);
    expect(parseScanRequest('', 'SCAN: https://Canada.ca').urls).toEqual(['https://Canada.ca']);
  });

  it('reads several addresses from a title, and ignores other words', () => {
    expect(parseScanRequest('', 'SCAN: ottawa.ca, www.canada.ca/en please').urls).toEqual([
      'https://ottawa.ca',
      'https://www.canada.ca/en',
    ]);
  });

  it('reads full URLs from free text, but not words that only look like domains', () => {
    const r = parseScanRequest('Please check https://a.org/x and https://b.org (built with Node.js).', 'SCAN: a few pages');
    expect(r.urls).toEqual(['https://a.org/x', 'https://b.org']);
  });

  it('prefers the form field, and accepts a bare domain typed there', () => {
    const body = '### URLs\n\nottawa.ca\n\n### What to scan\n\nOnly the listed URLs';
    expect(parseScanRequest(body, 'SCAN: canada.ca').urls).toEqual(['https://ottawa.ca']);
  });

  it('still refuses local addresses written as bare names', () => {
    const r = parseScanRequest('', 'SCAN: mysite.ddev.site');
    expect(r.urls).toEqual([]);
    expect(r.errors[0]).toMatch(/Put the address in the title/);
  });
});
