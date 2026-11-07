import { describe, it, expect } from 'vitest';
import { checkPage, checkPages, fileExtension, judgeHeaders, notHtmlSentence, type HeaderRequester } from '../src/collect/content-type.js';
import { adaptiveSample, sampleFromSitemaps, seededSample } from '../src/collect/sitemap.js';
import { selectCrawlLinks } from '../src/collect/crawler.js';
import { pageKey, siteOf } from '../src/collect/urls.js';
import { defaultConfig } from '../src/core/config.js';

describe('judging a response', () => {
  it('takes HTML and XHTML as pages', () => {
    expect(judgeHeaders({ 'content-type': 'text/html; charset=UTF-8' })).toEqual({ verdict: 'html', contentType: 'text/html' });
    expect(judgeHeaders({ 'content-type': 'application/xhtml+xml' }).verdict).toBe('html');
  });

  it('takes anything else as a file', () => {
    expect(judgeHeaders({ 'content-type': 'application/pdf' })).toEqual({ verdict: 'file', contentType: 'application/pdf' });
    expect(judgeHeaders({ 'content-type': 'application/vnd.ms-excel.sheet.macroEnabled.12' }).verdict).toBe('file');
    expect(judgeHeaders({ 'content-type': 'text/htmlx' }).verdict).toBe('file');
  });

  it('takes an attachment as a file, even when it says HTML', () => {
    expect(judgeHeaders({ 'content-type': 'text/html', 'content-disposition': 'attachment; filename="x.html"' }).verdict).toBe('file');
  });

  it('cannot tell without a Content-Type', () => {
    expect(judgeHeaders({})).toEqual({ verdict: 'unknown' });
  });
});

/** A fake server: what HEAD and GET answer for each URL. */
function server(answers: Record<string, { head?: { status: number; type?: string } | 'error'; get?: { status: number; type?: string } | 'error' }>) {
  const asked: string[] = [];
  const request: HeaderRequester = async (url, method) => {
    asked.push(`${method} ${url}`);
    const a = answers[url]?.[method === 'HEAD' ? 'head' : 'get'];
    if (!a || a === 'error') return undefined;
    return { status: a.status, headers: a.type ? { 'content-type': a.type } : {} };
  };
  return { request, asked };
}

describe('checking a URL', () => {
  it('settles a file extension without a request', async () => {
    const s = server({});
    expect(await checkPage('https://a.gov/report.PDF?x=1', s.request)).toMatchObject({ verdict: 'file', contentType: '.pdf file', by: 'extension' });
    expect(s.asked).toEqual([]);
    expect(fileExtension('https://a.gov/news/article')).toBeUndefined();
  });

  it('asks the server when the address has no extension, as Drupal file aliases do', async () => {
    const s = server({ 'https://cms.gov/files/document/finalpptpdf': { head: { status: 200, type: 'application/pdf' } } });
    expect(await checkPage('https://cms.gov/files/document/finalpptpdf', s.request)).toEqual({ url: 'https://cms.gov/files/document/finalpptpdf', verdict: 'file', contentType: 'application/pdf', by: 'head' });
    expect(s.asked).toEqual(['HEAD https://cms.gov/files/document/finalpptpdf']);
  });

  it('falls back to a ranged GET when the server refuses HEAD or gives no type', async () => {
    const s = server({
      'https://a.gov/x': { head: { status: 405 }, get: { status: 206, type: 'application/zip' } },
      'https://a.gov/y': { head: { status: 200 }, get: { status: 200, type: 'text/html' } },
    });
    expect((await checkPage('https://a.gov/x', s.request)).by).toBe('get');
    expect(await checkPage('https://a.gov/y', s.request)).toMatchObject({ verdict: 'html', by: 'get' });
  });

  it('never skips a page on an error response, such as a firewall’s 403 to HEAD', async () => {
    const s = server({
      'https://a.gov/blocked': { head: { status: 403, type: 'text/plain' }, get: { status: 200, type: 'text/html' } },
      'https://a.gov/gone': { head: { status: 404, type: 'text/plain' }, get: { status: 404, type: 'text/plain' } },
    });
    expect(await checkPage('https://a.gov/blocked', s.request)).toMatchObject({ verdict: 'html', by: 'get' });
    expect((await checkPage('https://a.gov/gone', s.request)).verdict).toBe('unknown');
  });

  it('keeps a URL it cannot check, for Firefox to decide', async () => {
    const s = server({ 'https://a.gov/z': { head: 'error', get: 'error' } });
    expect(await checkPage('https://a.gov/z', s.request)).toEqual({ url: 'https://a.gov/z', verdict: 'unknown', by: 'none' });
  });

  it('checks several, a few at a time, in order', async () => {
    const answers = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`https://a.gov/p${i}`, { head: { status: 200, type: i % 3 ? 'text/html' : 'application/pdf' } }]));
    const results = await checkPages(Object.keys(answers), server(answers).request, 3);
    expect(results.map((r) => r.verdict)).toEqual(['file', 'html', 'html', 'file', 'html', 'html', 'file', 'html', 'html']);
  });

  it('says what was skipped, in one sentence', () => {
    expect(notHtmlSentence([{ contentType: 'application/pdf' }, { contentType: 'application/pdf' }, { contentType: 'application/zip' }], 3, true)).toBe(
      '3 URLs were not HTML pages (2 application/pdf, 1 application/zip), so they were skipped before Firefox visited them, and other pages were measured in their place.',
    );
    expect(notHtmlSentence([{ contentType: '.csv file' }])).toBe('1 URL was not an HTML page (1 .csv file), so it was skipped before Firefox visited it.');
  });
});

describe('a sample that meets a file', () => {
  it('steps over a skipped item and keeps the rest of a random sample in place', () => {
    const items = Array.from({ length: 30 }, (_, i) => `https://a.gov/p${String(i).padStart(2, '0')}`);
    const first = seededSample(items, 5, 'a.gov');
    const again = seededSample(items, 5, 'a.gov', new Set([first[2]!]));
    expect(again).toHaveLength(5);
    expect(again).not.toContain(first[2]);
    expect(again.slice(0, 2)).toEqual(first.slice(0, 2));
    expect(again.slice(2, 4)).toEqual(first.slice(3, 5));
  });

  it('replaces a file in an adaptive sample from the same section', () => {
    const groups = new Map([
      ['/files', ['https://a.gov/files/a', 'https://a.gov/files/b', 'https://a.gov/files/c']],
      ['/news', Array.from({ length: 10 }, (_, i) => `https://a.gov/news/n${i}`)],
    ]);
    const first = adaptiveSample(groups, 2, 'a.gov').picks;
    const fileUrl = first.find((p) => p.key === '/files')!.url;
    const again = adaptiveSample(groups, 2, 'a.gov', new Set([fileUrl])).picks;
    expect(again.map((p) => p.key).sort()).toEqual(['/files', '/news']);
    expect(again.find((p) => p.key === '/files')!.url).not.toBe(fileUrl);
    expect(again.find((p) => p.key === '/news')).toEqual(first.find((p) => p.key === '/news'));
  });

  it('gives a section of nothing but files its turn to the next', () => {
    const groups = new Map([
      ['/files', ['https://a.gov/files/a', 'https://a.gov/files/b']],
      ['/news', Array.from({ length: 10 }, (_, i) => `https://a.gov/news/n${i}`)],
      ['/about', Array.from({ length: 5 }, (_, i) => `https://a.gov/about/p${i}`)],
    ]);
    const picks = adaptiveSample(groups, 3, 'a.gov', new Set(groups.get('/files'))).picks;
    expect(picks).toHaveLength(3);
    expect(picks.some((p) => p.key === '/files')).toBe(false);
  });

  it('checks the sitemap sample and replaces its files, so the scan measures as many pages as asked', async () => {
    const locs = [...Array.from({ length: 12 }, (_, i) => `https://a.gov/news/item-${i}`), ...Array.from({ length: 6 }, (_, i) => `https://a.gov/files/document/report${i}pdf`)];
    const xml = `<?xml version="1.0"?><urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join('')}</urlset>`;
    const checked: string[] = [];
    const sample = await sampleFromSitemaps('https://a.gov/', {
      get: async (url) => (new URL(url).pathname === '/sitemap.xml' ? { ok: true, url, text: xml } : { ok: false, url, text: '' }),
      robotsSitemaps: [],
      maxPages: 9,
      strategy: 'adaptive',
      siteOf,
      pageKey: (u) => pageKey(u),
      select: (l, sites) => selectCrawlLinks(l, 'https://a.gov/', sites, defaultConfig().crawl),
      checkPages: async (urls) => {
        checked.push(...urls);
        return urls.map((url) => ({ url, verdict: url.includes('/files/') ? ('file' as const) : ('html' as const), by: 'head' as const, contentType: url.includes('/files/') ? 'application/pdf' : 'text/html' }));
      },
    });
    expect(sample!.urls).toHaveLength(9);
    expect(sample!.urls.some((u) => u.includes('/files/'))).toBe(false);
    expect(sample!.notHtml!.length).toBeGreaterThan(0);
    expect(sample!.notHtml!.every((n) => n.contentType === 'application/pdf')).toBe(true);
    expect(new Set(checked).size).toBe(checked.length); // nothing is checked twice
  });
});
