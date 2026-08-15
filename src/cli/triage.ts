import { createHash } from 'node:crypto';

/**
 * Pre-flight triage for A/B candidates.
 *
 * A patch can only change client-side energy if it changes what the browser
 * receives or executes. Comparing the delivered payloads of two targets takes
 * seconds; a full benchmark takes many minutes. This check tells you whether a
 * comparison is worth running at all, and is deliberately conservative:
 * identical payloads are strong evidence of no client-side effect, while
 * differing payloads only mean a difference is *possible*.
 */

export interface AssetRef {
  url: string;
  kind: 'script' | 'style';
}

export interface PayloadFingerprint {
  url: string;
  status: number;
  htmlBytes: number;
  /** Hash of the HTML with cache-busting noise removed. */
  htmlHash: string;
  scripts: string[];
  styles: string[];
  error?: string;
}

/**
 * Strip values that differ between any two Drupal responses regardless of the
 * patch under test, so the hash reflects meaningful markup differences only.
 */
export function normalizeHtml(html: string): string {
  return (
    html
      // CSRF tokens and one-time links
      .replace(/([?&](?:token|form_token)=)[^"'&\s]+/g, '$1X')
      .replace(/name="form_token"\s+value="[^"]*"/g, 'name="form_token" value="X"')
      .replace(/name="form_build_id"\s+value="[^"]*"/g, 'name="form_build_id" value="X"')
      // Asset aggregation cache-busters, e.g. ?delta=0&language=en&theme=x&include=y
      .replace(/([?&])(?:v|version|delta|include|theme_token)=[^"'&\s]*/g, '$1$2=X')
      // Drupal JS settings often embed a per-request ajaxPageState token
      .replace(/"ajaxPageState":\{[^}]*\}/g, '"ajaxPageState":{}')
      // Session/user-specific ids in markup
      .replace(/js-view-dom-id-[a-f0-9]+/g, 'js-view-dom-id-X')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Extract script/stylesheet URLs, normalised for comparison. */
export function extractAssets(html: string, baseUrl: string): { scripts: string[]; styles: string[] } {
  const scripts: string[] = [];
  const styles: string[] = [];

  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    scripts.push(normalizeAssetUrl(m[1]!, baseUrl));
  }
  for (const m of html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)) {
    const href = /href=["']([^"']+)["']/i.exec(m[0]);
    if (href) styles.push(normalizeAssetUrl(href[1]!, baseUrl));
  }
  return { scripts: scripts.sort(), styles: styles.sort() };
}

function normalizeAssetUrl(href: string, baseUrl: string): string {
  try {
    const u = new URL(href, baseUrl);
    // Aggregated asset filenames embed a content hash; keep the path shape but
    // drop the hash so genuinely different bundles still compare unequal by
    // their other attributes. Query strings are dropped as cache-busters.
    u.search = '';
    return u.pathname;
  } catch {
    return href;
  }
}

export function hashHtml(html: string): string {
  return createHash('sha256').update(normalizeHtml(html)).digest('hex').slice(0, 16);
}

/** Fetch one URL and fingerprint what the browser would receive. */
export async function fingerprint(url: string, timeoutMs = 20000): Promise<PayloadFingerprint> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'firefox-energy-scanner/triage' },
    });
    const html = await res.text();
    const { scripts, styles } = extractAssets(html, url);
    return {
      url,
      status: res.status,
      htmlBytes: Buffer.byteLength(html),
      htmlHash: hashHtml(html),
      scripts,
      styles,
    };
  } catch (err) {
    return {
      url,
      status: 0,
      htmlBytes: 0,
      htmlHash: '',
      scripts: [],
      styles: [],
      error: (err as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface TriageVerdict {
  /** True when a client-side energy difference is even possible. */
  worthMeasuring: boolean;
  reasons: string[];
  a: PayloadFingerprint;
  b: PayloadFingerprint;
  htmlIdentical: boolean;
  scriptsIdentical: boolean;
  stylesIdentical: boolean;
  addedScripts: string[];
  removedScripts: string[];
  addedStyles: string[];
  removedStyles: string[];
  byteDelta: number;
}

/** Compare two fingerprints and decide whether an A/B run is justified. */
export function triage(a: PayloadFingerprint, b: PayloadFingerprint): TriageVerdict {
  const reasons: string[] = [];

  // A failed or non-OK fetch must never yield a confident verdict: two 404s
  // are trivially "identical" and would otherwise read as a definitive answer.
  const problems: string[] = [];
  if (a.error) problems.push(`a: ${a.error}`);
  if (b.error) problems.push(`b: ${b.error}`);
  if (!a.error && (a.status < 200 || a.status >= 300)) problems.push(`a returned HTTP ${a.status}`);
  if (!b.error && (b.status < 200 || b.status >= 300)) problems.push(`b returned HTTP ${b.status}`);
  if (!a.error && a.htmlBytes === 0) problems.push('a returned an empty body');
  if (!b.error && b.htmlBytes === 0) problems.push('b returned an empty body');

  if (problems.length > 0) {
    return {
      worthMeasuring: false,
      reasons: [
        `Inconclusive — could not compare the two targets: ${problems.join('; ')}.`,
        'Fix the URLs and re-run. This is NOT evidence that the payloads match.',
      ],
      a, b,
      htmlIdentical: false, scriptsIdentical: false, stylesIdentical: false,
      addedScripts: [], removedScripts: [], addedStyles: [], removedStyles: [],
      byteDelta: 0,
    };
  }

  const setA = new Set(a.scripts);
  const setB = new Set(b.scripts);
  const addedScripts = b.scripts.filter((s) => !setA.has(s));
  const removedScripts = a.scripts.filter((s) => !setB.has(s));

  const styleA = new Set(a.styles);
  const styleB = new Set(b.styles);
  const addedStyles = b.styles.filter((s) => !styleA.has(s));
  const removedStyles = a.styles.filter((s) => !styleB.has(s));

  const htmlIdentical = a.htmlHash === b.htmlHash;
  const scriptsIdentical = addedScripts.length === 0 && removedScripts.length === 0;
  const stylesIdentical = addedStyles.length === 0 && removedStyles.length === 0;
  const byteDelta = b.htmlBytes - a.htmlBytes;

  if (htmlIdentical && scriptsIdentical && stylesIdentical) {
    reasons.push(
      'Delivered HTML, scripts and stylesheets are identical after normalisation. ' +
        'The browser receives and executes the same work, so client-side energy cannot differ. ' +
        'Any improvement from this change is server-side and outside this tool\'s measurement boundary.',
    );
    return {
      worthMeasuring: false, reasons, a, b,
      htmlIdentical, scriptsIdentical, stylesIdentical,
      addedScripts, removedScripts, addedStyles, removedStyles, byteDelta,
    };
  }

  if (!scriptsIdentical) {
    reasons.push(
      `Script set differs (${addedScripts.length} added, ${removedScripts.length} removed). ` +
        'Different JavaScript means different parse, compile and execution work.',
    );
  }
  if (!stylesIdentical) {
    reasons.push(
      `Stylesheet set differs (${addedStyles.length} added, ${removedStyles.length} removed). ` +
        'Different CSS means different style recalculation and layout work.',
    );
  }
  if (!htmlIdentical) {
    reasons.push(
      `Delivered markup differs (${byteDelta >= 0 ? '+' : ''}${byteDelta} bytes). ` +
        'This may be meaningful, or may be residual per-request noise.',
    );
  }

  return {
    worthMeasuring: true, reasons, a, b,
    htmlIdentical, scriptsIdentical, stylesIdentical,
    addedScripts, removedScripts, addedStyles, removedStyles, byteDelta,
  };
}
