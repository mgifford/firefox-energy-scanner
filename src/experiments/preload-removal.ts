/**
 * Removing a component before the page is parsed (`remove-before-load`).
 *
 * A post-load removal cannot show what a component costs while the page
 * loads: it was there on both sides. This mode removes it from the markup
 * before the browser sees it, so its parsing, resources, inline scripts,
 * layout and paint never happen on the variant.
 *
 * How, and why this way:
 *
 * - Once per run, in the journey's setup (outside every measured window, and
 *   before the idle baseline), the document is fetched through the browser
 *   context and parsed by the browser's own HTML parser (DOMParser) in the
 *   blank page. The selector is checked as in a post-load removal; on the
 *   variant the outermost matches are removed. The document is serialised
 *   back on both sides. No regular expressions touch the markup, and no
 *   parser dependency is added: the browser that renders the page parses it.
 * - Both sides are then served that snapshot for every load of the page,
 *   through the same route handler. The interception, the round trip through
 *   the parser and the snapshot's frozen server response are the same on
 *   both sides, so none of them is the difference measured.
 * - A URL that redirects is refused: the snapshot would be served at the
 *   wrong address, and relative URLs in it would resolve against the wrong
 *   base.
 */

import type { BrowserContext, Page, Route } from 'playwright';
import { checkpointInPage, preloadWatchInit, type RemovalCheckpoint } from './dom-removal.js';
import type { VariantCounts } from './variants.js';

export interface PreloadSnapshot {
  checkpoint: RemovalCheckpoint;
  /** Bytes of markup served on this side. */
  bytes: number;
  /** The fetched document's bytes, before the round trip. */
  originalBytes: number;
  status: number;
}

const DROP = /^(content-length|content-encoding|transfer-encoding|connection|keep-alive|content-type)$/i;

const sansHash = (u: string) => u.replace(/#.*$/, '');

/** Fetch, check and (on the variant) strip the document; install the route that serves it. */
export async function installPreloadRemoval(
  context: BrowserContext,
  page: Page,
  url: string,
  selector: string,
  apply: boolean,
  maxMatches: number,
  counts: VariantCounts,
): Promise<PreloadSnapshot> {
  const res = await context.request.get(url, { maxRedirects: 0, failOnStatusCode: false });
  const status = res.status();
  if (status >= 300 && status < 400) {
    const to = res.headers()['location'];
    throw new Error(`remove-before-load: ${url} redirects (HTTP ${status}${to ? ` to ${new URL(to, url).toString()}` : ''}). Use the address it redirects to.`);
  }
  const type = res.headers()['content-type'] ?? '';
  if (!/html/i.test(type)) throw new Error(`remove-before-load: ${url} is not an HTML page (${type || 'no Content-Type'}).`);
  const original = await res.text();

  // The blank page the run starts on: the browser's parser, outside every measured window.
  const result = await page.evaluate(checkpointInPage, { selector, apply, maxMatches, html: original });
  const { html, ...checkpoint } = result;
  // Refused: serve the document as fetched, on both sides alike; the report says nothing was removed.
  const body = checkpoint.refused || html === undefined ? original : html;
  const headers = Object.fromEntries(Object.entries(res.headers()).filter(([k]) => !DROP.test(k)));
  headers['content-type'] = 'text/html; charset=utf-8';

  // Insertions of a matching element, from the first byte parsed: the parser's on the
  // baseline; on the variant, only what the page's scripts create.
  await context.addInitScript(preloadWatchInit, selector);

  const target = sansHash(url);
  await context.route('**/*', async (route: Route) => {
    const req = route.request();
    if (req.resourceType() !== 'document' || req.frame() !== page.mainFrame() || sansHash(req.url()) !== target || req.method() !== 'GET') {
      return route.fallback();
    }
    counts.documentsRewritten++;
    counts.changes += checkpoint.removed;
    return route.fulfill({ status: status || 200, headers, body });
  });

  return { checkpoint, bytes: Buffer.byteLength(body), originalBytes: Buffer.byteLength(original), status };
}
