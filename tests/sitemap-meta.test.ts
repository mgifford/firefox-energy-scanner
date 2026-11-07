import { describe, it, expect } from 'vitest';
import { collapseTranslations, parseSitemapEntries, sampleFromSitemaps, withSpecialPages, type AdaptivePick, type SitemapEntry } from '../src/collect/sitemap.js';
import { selectCrawlLinks } from '../src/collect/crawler.js';
import { pageKey, siteOf } from '../src/collect/urls.js';
import { defaultConfig } from '../src/core/config.js';

const NS = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"';

describe('reading a sitemap entry', () => {
  it('reads lastmod, image and video entries, and hreflang alternates', () => {
    const xml = `<?xml version="1.0"?><urlset ${NS}>
      <url><loc>https://www.canada.ca/en/news.html</loc><lastmod>2024-05-01T10:00:00Z</lastmod>
        <xhtml:link rel="alternate" hreflang="en" href="https://www.canada.ca/en/news.html"/>
        <xhtml:link rel="alternate" hreflang="fr" href="https://www.canada.ca/fr/nouvelles.html"/>
        <image:image><image:loc>https://www.canada.ca/a.jpg</image:loc></image:image><image:image><image:loc>https://www.canada.ca/b.jpg</image:loc></image:image></url>
      <url><loc><![CDATA[https://www.canada.ca/en/video.html?a=1&amp;b=2]]></loc>
        <video:video><video:title>Briefing</video:title><video:content_loc>https://www.canada.ca/v.mp4</video:content_loc></video:video></url>
    </urlset>`;
    const [a, b] = parseSitemapEntries(xml);
    expect(a).toEqual({
      loc: 'https://www.canada.ca/en/news.html',
      lastmod: '2024-05-01T10:00:00Z',
      images: 2,
      videos: 0,
      alternates: [
        { hreflang: 'en', href: 'https://www.canada.ca/en/news.html' },
        { hreflang: 'fr', href: 'https://www.canada.ca/fr/nouvelles.html' },
      ],
    });
    expect(b).toMatchObject({ loc: 'https://www.canada.ca/en/video.html?a=1&b=2', videos: 1, images: 0, alternates: [] });
  });

  it('does not take the urlset tag, or an image location, for an entry', () => {
    expect(parseSitemapEntries(`<urlset ${NS}><url><loc>https://a.gov/x</loc><image:image><image:loc>https://a.gov/i.png</image:loc></image:image></url></urlset>`).map((e) => e.loc)).toEqual(['https://a.gov/x']);
  });
});

const entry = (loc: string, o: Partial<SitemapEntry> = {}): SitemapEntry => ({ loc, images: 0, videos: 0, alternates: [], ...o });
const key = (u: string) => pageKey(u);

describe('translations', () => {
  const pair = (n: number) => [
    entry(`https://www.canada.ca/en/p${n}.html`, { alternates: [{ hreflang: 'en', href: `https://www.canada.ca/en/p${n}.html` }, { hreflang: 'fr', href: `https://www.canada.ca/fr/p${n}.html` }] }),
    entry(`https://www.canada.ca/fr/p${n}.html`, { alternates: [{ hreflang: 'en', href: `https://www.canada.ca/en/p${n}.html` }, { hreflang: 'fr', href: `https://www.canada.ca/fr/p${n}.html` }] }),
  ];
  const all = [...pair(1), ...pair(2), ...pair(3), entry('https://www.canada.ca/en/only-english.html'), entry('https://www.canada.ca/en.html', { alternates: [{ hreflang: 'en', href: 'https://www.canada.ca/en.html' }, { hreflang: 'fr', href: 'https://www.canada.ca/fr.html' }] })];
  const entries = new Map(all.map((e) => [key(e.loc), e]));
  const pages = all.map((e) => e.loc).filter((u) => !u.endsWith('/en.html'));

  it('keeps one page of each translation group, in the start page’s language', () => {
    const { pages: kept, setAside } = collapseTranslations(pages, entries, key, key('https://www.canada.ca/en.html'), 'canada.ca');
    expect(setAside).toBe(3);
    expect(kept.sort()).toEqual(['https://www.canada.ca/en/only-english.html', 'https://www.canada.ca/en/p1.html', 'https://www.canada.ca/en/p2.html', 'https://www.canada.ca/en/p3.html']);
  });

  it('changes nothing when the sitemap names no translations', () => {
    const plain = new Map(pages.map((u) => [key(u), entry(u)]));
    expect(collapseTranslations(pages, plain, key, 'x', 'canada.ca')).toEqual({ pages, setAside: 0 });
  });
});

describe('pages a draw of sections can miss', () => {
  const pages = Array.from({ length: 30 }, (_, i) => `https://a.gov/news/n${i}`);
  const groupOf = new Map(pages.map((u) => [u, '/news']));
  const picks = (n: number): AdaptivePick[] => pages.slice(0, n).map((url, i) => ({ url, key: '/news', reason: i === 0 ? 'representative' : 'proportional' }));
  const meta = new Map<string, SitemapEntry>([
    [pages[20]!, entry(pages[20]!, { videos: 1, lastmod: '2025-01-01' })],
    [pages[25]!, entry(pages[25]!, { lastmod: '2012-06-30' })],
    ...pages.slice(0, 8).map((u) => [u, entry(u, { lastmod: '2025-06-01' })] as const),
  ]);
  const entryOf = (u: string) => meta.get(u);

  it('takes a video page and the oldest page, each in place of a proportional pick', () => {
    const out = withSpecialPages(picks(8), pages, 8, 'a.gov', new Set(), groupOf, entryOf);
    expect(out).toHaveLength(8);
    expect(out.find((p) => p.reason === 'video-page')!.url).toBe(pages[20]);
    expect(out.find((p) => p.reason === 'legacy-page')!.url).toBe(pages[25]);
    expect(out[0]!.reason).toBe('representative');
  });

  it('takes neither for a small sample, and no video page when one is already drawn', () => {
    expect(withSpecialPages(picks(5), pages, 5, 'a.gov', new Set(), groupOf, entryOf)).toEqual(picks(5));
    const withVideo = [...picks(7), { url: pages[20]!, key: '/news', reason: 'proportional' as const }];
    expect(withSpecialPages(withVideo, pages, 8, 'a.gov', new Set(), groupOf, entryOf).filter((p) => p.reason === 'video-page')).toEqual([]);
  });

  it('steps over a skipped page, so a file or a gone page is never chosen for it', () => {
    const out = withSpecialPages(picks(8), pages, 8, 'a.gov', new Set([pages[25]!]), groupOf, entryOf);
    expect(out.some((p) => p.reason === 'legacy-page')).toBe(false);
  });
});

describe('an adaptive sample from a sitemap with metadata', () => {
  it('records what the sitemap said, and why the special pages are there', async () => {
    const urls = [
      ...Array.from({ length: 20 }, (_, i) => `<url><loc>https://a.gov/news/n${i}</loc><lastmod>2025-0${(i % 9) + 1}-01</lastmod></url>`),
      ...Array.from({ length: 12 }, (_, i) => `<url><loc>https://a.gov/services/s${i}</loc><lastmod>2025-01-01</lastmod></url>`),
      '<url><loc>https://a.gov/media/briefing</loc><lastmod>2025-02-02</lastmod><video:video><video:title>x</video:title></video:video></url>',
      '<url><loc>https://a.gov/news/archive-2011</loc><lastmod>2011-03-04</lastmod></url>',
    ];
    const xml = `<?xml version="1.0"?><urlset ${NS}>${urls.join('')}</urlset>`;
    const sample = (await sampleFromSitemaps('https://a.gov/', {
      get: async (url) => (new URL(url).pathname === '/sitemap.xml' ? { ok: true, url, text: xml } : { ok: false, url, text: '' }),
      robotsSitemaps: [],
      maxPages: 10,
      strategy: 'adaptive',
      siteOf,
      pageKey: (u) => pageKey(u),
      select: (l, sites) => selectCrawlLinks(l, 'https://a.gov/', sites, defaultConfig().crawl),
    }))!;
    expect(sample.urls).toHaveLength(10);
    expect(sample.sitemapMeta).toEqual({ videoPages: 1, dated: 34, oldest: '2011-03-04', newest: '2025-09-01' });
    expect(sample.reasons['https://a.gov/news/archive-2011']).toBe('legacy-page');
    expect(Object.values(sample.reasons).filter((r) => r === 'video-page' || r === 'representative').length).toBeGreaterThan(0);
    expect(sample.urls).toContain('https://a.gov/media/briefing');
  });
});
