/**
 * Key pages, as WCAG-EM's structured sample has them: pages most sites share
 * and most visitors reach, whatever a random sample happens to draw.
 *
 * - search: the site's own search results, which no sitemap lists and which
 *   are often among the heaviest pages a site serves;
 * - contact and accessibility: the contact page and the accessibility
 *   statement, linked from nearly every page;
 * - not-found: the page a broken link leads to.
 *
 * Found from the start page's HTML, read once from the server before the
 * scan starts: no Firefox visit and no energy window. Pure, apart from the
 * one check of the not-found page, so the rules are tested directly.
 */

export type KeyPageKind = 'search' | 'contact' | 'accessibility' | 'not-found';

export interface KeyPage {
  kind: KeyPageKind;
  url: string;
  /** How it was found, in words: the link text, or the search form's field. */
  from: string;
}

export const KEY_PAGE_LABEL: Record<KeyPageKind, string> = {
  search: 'site search results',
  contact: 'contact page',
  accessibility: 'accessibility statement',
  'not-found': '"not found" page',
};

const decode = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' })[e] ?? '');
const text = (html: string) => decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? '') : undefined;
};
const sameSite = (a: string, b: string) => {
  try {
    return new URL(a).hostname.replace(/^www\./, '') === new URL(b).hostname.replace(/^www\./, '');
  } catch {
    return false;
  }
};

/** At most this many links are read: the navigation and footer come well before it. */
const MAX_LINKS = 3000;

const CONTACT_TEXT = /^(contact|contact us|get in touch|contactez-nous|contacto|kontakt)\b/i;
const CONTACT_PATH = /\/(contact|contact-us|contactez-nous|contacto|kontakt)\/?$/i;
const A11Y_TEXT = /\b(accessibility|accessibilit[ée]|accesibilidad|barrierefreiheit)\b/i;
const A11Y_PATH = /\/(accessibility|accessibility-statement|accessibilite|accesibilidad|barrierefreiheit)[^/]*\/?$/i;

/** Search fields by name, most specific first. */
const SEARCH_FIELDS = ['search_api_fulltext', 'keys', 'query', 'search', 'keyword', 'keywords', 'q', 's', 'k', 'text'];

/**
 * The word searched for: the first word of four letters or more in the
 * page's title, so results are about the site, and the same site always gives
 * the same search. "help" when the title has none.
 */
export function searchTerm(html: string): string {
  const title = text(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
  return /\p{L}{4,}/u.exec(title)?.[0]?.toLowerCase() ?? 'help';
}

/** Key pages linked from a page, by its HTML. Same site only; the first match of each kind. */
export function findKeyPages(html: string, pageUrl: string): KeyPage[] {
  const out: KeyPage[] = [];
  const add = (kind: KeyPageKind, url: string, from: string) => {
    if (!out.some((k) => k.kind === kind) && sameSite(url, pageUrl)) out.push({ kind, url, from });
  };

  // Search: a GET form marked as search, with a text field we recognise.
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const [tag, inner] = [m[1]!, m[2]!];
    const method = (attr(tag, 'method') ?? 'get').toLowerCase();
    const marked = /search/i.test(`${attr(tag, 'role') ?? ''} ${attr(tag, 'action') ?? ''} ${attr(tag, 'class') ?? ''} ${attr(tag, 'id') ?? ''}`) || /type\s*=\s*["']?search/i.test(inner);
    if (method !== 'get' || !marked) continue;
    const inputs = [...inner.matchAll(/<input\b[^>]*>/gi)].map((i) => i[0]);
    const named = (n: string) => inputs.find((i) => attr(i, 'name') === n && !/type\s*=\s*["']?(hidden|submit|checkbox|radio)/i.test(i));
    const field = inputs.find((i) => /type\s*=\s*["']?search/i.test(i) && attr(i, 'name')) ?? SEARCH_FIELDS.map(named).find(Boolean);
    const name = field ? attr(field, 'name') : undefined;
    if (!name) continue;
    try {
      const u = new URL(attr(tag, 'action') || pageUrl, pageUrl);
      u.hash = '';
      // The form's hidden fields go too: some searches need them (a site or collection id).
      for (const h of inputs.filter((i) => /type\s*=\s*["']?hidden/i.test(i))) {
        const hn = attr(h, 'name');
        if (hn) u.searchParams.set(hn, attr(h, 'value') ?? '');
      }
      u.searchParams.set(name, searchTerm(html));
      add('search', u.toString(), `the search form's "${name}" field`);
    } catch {
      /* an action that is not a URL */
    }
    break;
  }

  // Contact and accessibility: by link text first, then by address.
  let n = 0;
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (++n > MAX_LINKS) break;
    const href = attr(m[1]!, 'href');
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
    let url: string;
    try {
      url = new URL(href, pageUrl).toString().replace(/#.*$/, '');
    } catch {
      continue;
    }
    const label = text(m[2]!) || attr(m[1]!, 'aria-label') || '';
    const path = new URL(url).pathname;
    if (CONTACT_TEXT.test(label) || CONTACT_PATH.test(path)) add('contact', url, label ? `the link "${label.slice(0, 60)}"` : `the address ${path}`);
    if (A11Y_TEXT.test(label) || A11Y_PATH.test(path)) add('accessibility', url, label ? `the link "${label.slice(0, 60)}"` : `the address ${path}`);
  }
  return out;
}

/** An address no site has, on this site: the page a broken link leads to. */
export function notFoundUrl(startUrl: string): string {
  return new URL('/web-energy-scan-page-not-found', startUrl).toString();
}
