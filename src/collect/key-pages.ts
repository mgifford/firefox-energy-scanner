/**
 * Key pages, as WCAG-EM's structured sample has them: pages most sites share
 * and most visitors reach, whatever a random sample happens to draw.
 *
 * - search: the site's own search results, which no sitemap lists and which
 *   are often among the heaviest pages a site serves;
 * - top-task: a service or form the site exists for, by a link that starts
 *   with what a visitor does there ("Apply", "Pay", "Renew", "Report a...");
 * - accessibility, contact and help: the accessibility statement, the
 *   contact page and help or FAQ, linked from nearly every page;
 * - not-found: the page a broken link leads to.
 *
 * Patterns, the accessibility statement's 24 languages among them, follow
 * mgifford/top-task-finder, matched against link text and the address's last
 * segment, not anywhere in the path: "report" anywhere in a path picks annual
 * reports, not tasks.
 *
 * Found from the start page's HTML, read once from the server before the
 * scan starts: no Firefox visit and no energy window. Pure, apart from the
 * one check of the not-found page, so the rules are tested directly.
 */

export type KeyPageKind = 'search' | 'top-task' | 'accessibility' | 'contact' | 'help' | 'not-found';

/** Which key pages to keep first when there is room for only some. */
export const KEY_PAGE_PRIORITY: KeyPageKind[] = ['search', 'top-task', 'accessibility', 'contact', 'help', 'not-found'];

export interface KeyPage {
  kind: KeyPageKind;
  url: string;
  /** How it was found, in words: the link text, or the search form's field. */
  from: string;
}

export const KEY_PAGE_LABEL: Record<KeyPageKind, string> = {
  search: 'site search results',
  'top-task': 'a top task',
  accessibility: 'accessibility statement',
  contact: 'contact page',
  help: 'help or FAQ',
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
/** "Accessibility" in the 24 official EU languages, with the ASCII spellings sites use in addresses (top-task-finder's list). */
const A11Y_WORDS = [
  'accessibility', 'accesibilidad', 'accessibilité', 'accessibilite', 'barrierefreiheit', 'zugänglichkeit', 'zuganglichkeit',
  'accessibilità', 'accessibilita', 'acessibilidade', 'toegankelijkheid', 'dostępność', 'dostepnosc', 'accesibilitate',
  'προσβασιμότητα', 'přístupnost', 'pristupnost', 'akadálymentesség', 'akadalymentesseg', 'hozzáférhetőség', 'hozzaferhetoseg',
  'tillgänglighet', 'tillganglighet', 'достъпност', 'tilgængelighed', 'tilgangelighed', 'saavutettavuus', 'prístupnosť',
  'inrochtaineacht', 'pristupačnost', 'pristupacnost', 'prieinamumas', 'dostopnost', 'pieejamība', 'pieejamiba',
  'ligipääsetavus', 'ligipaasetavus', 'aċċessibbiltà', 'accessibbilta',
];
// The word must start a word, and may go on: Finnish, German, Swedish and Dutch
// name the statement with compounds (Saavutettavuusseloste, Barrierefreiheitserklärung).
const word = (words: string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(${words.join('|')})`, 'iu');
const A11Y_TEXT = word(A11Y_WORDS);
/** In the last segment of the address: /accessibility, /accessibility-statement, /web-accessibility. */
const A11Y_PATH = word([...A11Y_WORDS, 'a11y']);

const HELP_TEXT = /^(help|support|faqs?|frequently asked questions|aide|ayuda|hilfe|aiuto|ajuda)\b/iu;
const HELP_PATH = /^(help|support|faqs?|aide|ayuda|hilfe)$/i;

/** A link that starts with what a visitor does: a service or a form, not a document about one. */
const TASK_TEXT = /^(apply|pay|register|renew|book|request|report an?|file an?|claim|sign up|order|subscribe|get a|find a)\b/iu;
const TASK_PATH = /^(apply|pay|register|renew|book|request|apply-[a-z0-9-]+|pay-[a-z0-9-]+|renew-[a-z0-9-]+)$/i;

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
    let last = path.split('/').filter(Boolean).pop() ?? '';
    try {
      last = decodeURIComponent(last);
    } catch {
      /* keep it encoded */
    }
    if (url.replace(/\/$/, '') === pageUrl.replace(/\/$/, '')) continue;
    // Say what matched: the link's text, or else its address.
    const byText = `the link "${label.slice(0, 60)}"`;
    const byPath = `the address ${path}`;
    const match = (kind: KeyPageKind, text: RegExp, pathRule: RegExp, target: string) => {
      if (text.test(label)) add(kind, url, byText);
      else if (pathRule.test(target)) add(kind, url, byPath);
    };
    match('contact', CONTACT_TEXT, CONTACT_PATH, path);
    match('accessibility', A11Y_TEXT, A11Y_PATH, last);
    match('help', HELP_TEXT, HELP_PATH, last);
    match('top-task', TASK_TEXT, TASK_PATH, last);
  }
  return out;
}

/** An address no site has, on this site: the page a broken link leads to. */
export function notFoundUrl(startUrl: string): string {
  return new URL('/web-energy-scan-page-not-found', startUrl).toString();
}

/**
 * Key pages in priority order, at most `max`: with a small page limit, key
 * pages must not crowd out the sample they sit beside.
 */
export function keepKeyPages(pages: KeyPage[], max: number): KeyPage[] {
  return [...pages].sort((a, b) => KEY_PAGE_PRIORITY.indexOf(a.kind) - KEY_PAGE_PRIORITY.indexOf(b.kind)).slice(0, Math.max(0, max));
}

/** Room for key pages: a quarter of the page limit, at least one. */
export const keyPageRoom = (maxPages: number) => Math.max(1, Math.floor(maxPages / 4));
