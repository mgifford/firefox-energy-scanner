/**
 * Is a URL an HTML page? Asked before Firefox visits it, so a scan spends
 * its page budget, and each page's energy window, only on pages.
 *
 * A file extension answers it for free. Otherwise the server's headers do:
 * a HEAD request, or, where a server refuses HEAD, a GET for the first
 * kilobyte (Range), so a 30 MB PDF is not downloaded to learn that it is one.
 * A URL that cannot be checked is kept: Firefox still recognises a download
 * when it gets there, as before.
 */

/** Paths that name a file rather than a page. */
export const FILE_EXTENSION = new RegExp(
  '\\.(' +
    [
      'pdf', 'docx?', 'xlsx?', 'xlsm', 'pptx?', 'odt', 'ods', 'odp', 'rtf', 'epub',
      'zip', 'gz', 'tgz', 'rar', '7z', 'exe', 'dmg', 'apk', 'iso',
      'csv', 'json', 'xml', 'rss', 'atom', 'txt', 'ics',
      'css', 'js', 'mjs', 'map', 'woff2?', 'ttf', 'otf', 'eot', 'ico',
      'jpe?g', 'png', 'gif', 'svg', 'webp', 'avif', 'bmp', 'tiff?',
      'mp3', 'm4a', 'wav', 'ogg', 'mp4', 'm4v', 'webm', 'mov', 'avi',
    ].join('|') +
    ')$',
  'i',
);

export interface PageCheck {
  url: string;
  /**
   * html: a page. file: not a page, skipped. gone: the server says 404 or 410,
   * so a sample replaces it. unknown: could not tell, so kept.
   */
  verdict: 'html' | 'file' | 'gone' | 'unknown';
  /** The served Content-Type, or the file extension that settled it. */
  contentType?: string;
  /** How it was decided: the URL's extension, a HEAD request, or a ranged GET. */
  by: 'extension' | 'head' | 'get' | 'none';
  /** The status of the response that decided it. */
  status?: number;
  /** Where the URL led, when it redirected. */
  finalUrl?: string;
}

/** The headers of a response, lower-cased names. */
export type HeaderRequester = (url: string, method: 'HEAD' | 'GET') => Promise<{ status: number; headers: Record<string, string>; url?: string } | undefined>;

/** HTML and XHTML are pages; everything else a browser would download or show raw. */
const HTML = /^\s*(text\/html|application\/xhtml\+xml)\s*(;|$)/i;

/** Judge a response's headers. Pure. */
export function judgeHeaders(headers: Record<string, string>): { verdict: PageCheck['verdict']; contentType?: string } {
  const type = headers['content-type']?.trim();
  // An attachment is a download whatever its type.
  if (/^\s*attachment\b/i.test(headers['content-disposition'] ?? '')) return { verdict: 'file', contentType: type ? `${type} (attachment)` : 'attachment' };
  if (!type) return { verdict: 'unknown' };
  return { verdict: HTML.test(type) ? 'html' : 'file', contentType: type.split(';')[0]!.trim() };
}

/** The extension that marks a URL as a file, when it has one. */
export function fileExtension(url: string): string | undefined {
  try {
    return FILE_EXTENSION.exec(new URL(url).pathname)?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Check one URL. Never throws. */
export async function checkPage(url: string, request: HeaderRequester): Promise<PageCheck> {
  const ext = fileExtension(url);
  if (ext) return { url, verdict: 'file', contentType: `.${ext} file`, by: 'extension' };
  // Only a successful response says what the URL serves. An error (a 404, or
  // a firewall's 403 to a HEAD request) says nothing about the page, so the
  // URL is kept rather than skipped on a block page's Content-Type.
  type Res = { status: number; headers: Record<string, string>; url?: string };
  const served = (r: Res | undefined): r is Res => !!r && r.status < 400;
  const where = (r: Res) => ({ status: r.status, ...(r.url && r.url !== url ? { finalUrl: r.url } : {}) });
  const head = await request(url, 'HEAD').catch(() => undefined);
  if (served(head)) {
    const j = judgeHeaders(head.headers);
    if (j.verdict !== 'unknown') return { url, ...j, by: 'head', ...where(head) };
  }
  // A server that refuses HEAD (405, 501), or answers it with no type: a GET for the first kilobyte.
  const get = await request(url, 'GET').catch(() => undefined);
  if (served(get)) {
    const j = judgeHeaders(get.headers);
    if (j.verdict !== 'unknown') return { url, ...j, by: 'get', ...where(get) };
  }
  // Gone only when the GET itself says so, with 404 or 410: a page that is not
  // there. A 403, 429 or 5xx says nothing about the page, so it is kept.
  if (get && (get.status === 404 || get.status === 410)) return { url, verdict: 'gone', by: 'get', ...where(get) };
  return { url, verdict: 'unknown', by: 'none' };
}

/** Check several URLs, a few at a time. Results in input order. */
export async function checkPages(urls: string[], request: HeaderRequester, concurrency = 4): Promise<PageCheck[]> {
  const out: PageCheck[] = new Array(urls.length);
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      out[i] = await checkPage(urls[i]!, request);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return out;
}

/** A requester on a Playwright request context: the browser context's, so it goes through the same network guard. */
export function contextRequester(request: {
  head: (url: string, o: object) => Promise<{ status(): number; headers(): Record<string, string>; url(): string }>;
  get: (url: string, o: object) => Promise<{ status(): number; headers(): Record<string, string>; url(): string }>;
}): HeaderRequester {
  return async (url, method) => {
    try {
      const options = { timeout: 10_000, maxRedirects: 5, failOnStatusCode: false };
      const res = method === 'HEAD' ? await request.head(url, options) : await request.get(url, { ...options, headers: { Range: 'bytes=0-1023' } });
      return { status: res.status(), headers: res.headers(), url: res.url() };
    } catch {
      return undefined;
    }
  };
}

/** One sentence for a skipped URL. */
export function skipReason(c: PageCheck): string {
  return `Not an HTML page (${c.contentType ?? 'not HTML'}), so it was skipped before Firefox visited it.`;
}

/**
 * One sentence on what was skipped: "3 URLs were not HTML pages (2
 * application/pdf, 1 application/zip), so they were skipped before Firefox
 * visited them, and other pages measured in their place."
 */
export function notHtmlSentence(list: { contentType?: string }[], count = list.length, replaced = false): string {
  if (!count) return '';
  const byType = new Map<string, number>();
  for (const c of list) byType.set(c.contentType ?? 'not HTML', (byType.get(c.contentType ?? 'not HTML') ?? 0) + 1);
  const types = [...byType].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 4).map(([t, n]) => `${n} ${t}`);
  const more = byType.size > 4 ? ', …' : '';
  return (
    `${count} URL${count === 1 ? ' was not an HTML page' : 's were not HTML pages'} (${types.join(', ')}${more}), ` +
    `so ${count === 1 ? 'it was' : 'they were'} skipped before Firefox visited ${count === 1 ? 'it' : 'them'}` +
    (replaced ? ', and other pages were measured in their place.' : '.')
  );
}

