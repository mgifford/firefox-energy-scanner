/**
 * Static script references, collected only in diagnostic runs.
 *
 * A script loaded from the document head or by another script is page-level:
 * the graph cannot say which component owns it. It can say that the script's
 * source names an element the component contains (`getElementById('chart')`,
 * `querySelector('#chart')`). That is a lead, not ownership, and it is kept
 * separate from the same-run stack evidence that the script actually ran.
 *
 * Bounded on purpose: the first 24 scripts, same-origin only, 256 KB each,
 * 2 s per fetch, after the measured windows. Cross-origin scripts are marked,
 * never fetched. This function must not be called by benchmark runs.
 */
import type { Page } from 'playwright';
import type { ScriptReferenceRecord } from '../core/types.js';

const MAX_SCRIPTS = 24;
const MAX_BYTES = 256 * 1024;

export interface ScriptReference {
  kind: 'id' | 'selector';
  value: string;
}

/**
 * The patterns are deliberately narrow: a static reference that can be
 * checked against a component's DOM ids. A minified or dynamically built
 * selector is missed, and the record says the scan is static.
 */
export function scanScriptReferences(text: string): ScriptReference[] {
  const found = new Map<string, ScriptReference>();
  const add = (kind: ScriptReference['kind'], value: string) => {
    const v = value.trim();
    if (!v || v.length > 120) return;
    found.set(`${kind}:${v}`, { kind, value: v });
  };
  for (const m of text.matchAll(/getElementById\s*\(\s*(['"])([^'"]{1,120})\1\s*\)/g)) add('id', m[2]!);
  for (const m of text.matchAll(/querySelector(?:All)?\s*\(\s*(['"])#([A-Za-z_][\w:.-]{0,119})\1\s*\)/g)) add('id', m[2]!);
  for (const m of text.matchAll(/querySelector(?:All)?\s*\(\s*(['"])([^'"]{1,120})\1\s*\)/g)) {
    if (!m[2]!.startsWith('#')) add('selector', m[2]!);
  }
  return [...found.values()].slice(0, 30);
}

interface RawReferenceRecord {
  url: string;
  inline?: boolean;
  status: ScriptReferenceRecord['status'];
  bytes?: number;
  text?: string;
  error?: string;
}

/**
 * Read the page's scripts after the measured windows. Returns one record per
 * script inspected, with the references the source holds. No record means the
 * page had no scripts or the evaluation failed; it never means "no script".
 */
export async function collectScriptReferences(page: Page, pageUrl: string): Promise<ScriptReferenceRecord[]> {
  let raw: RawReferenceRecord[];
  try {
    raw = await page.evaluate(
      async ({ maxScripts, maxBytes, pageUrl }) => {
        const out: RawReferenceRecord[] = [];
        const scripts = Array.from(document.scripts);
        for (const s of scripts.slice(0, maxScripts)) {
          const src = s.src;
          if (!src) {
            const text = s.textContent ?? '';
            out.push({ url: pageUrl, inline: true, status: text.length > maxBytes ? 'too-large' : 'scanned', bytes: text.length, text: text.slice(0, maxBytes) });
            continue;
          }
          let u: URL;
          try {
            u = new URL(src, location.href);
          } catch {
            out.push({ url: src, status: 'unavailable', error: 'invalid URL' });
            continue;
          }
          if (u.origin !== location.origin) {
            out.push({ url: u.href, status: 'cross-origin' });
            continue;
          }
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 2000);
            const res = await fetch(u.href, { signal: controller.signal, cache: 'force-cache' });
            clearTimeout(timer);
            if (!res.ok) {
              out.push({ url: u.href, status: 'unavailable', error: `HTTP ${res.status}` });
              continue;
            }
            const text = await res.text();
            out.push({ url: u.href, status: text.length > maxBytes ? 'too-large' : 'scanned', bytes: text.length, text: text.slice(0, maxBytes) });
          } catch (err) {
            out.push({ url: u.href, status: 'unavailable', error: String(err).slice(0, 200) });
          }
        }
        if (scripts.length > maxScripts) {
          out.push({ url: pageUrl, status: 'not-fetched', error: `${scripts.length - maxScripts} scripts beyond the first ${maxScripts} were not scanned` });
        }
        return out;
      },
      { maxScripts: MAX_SCRIPTS, maxBytes: MAX_BYTES, pageUrl },
    );
  } catch {
    return [];
  }
  return raw.map((r) => ({
    url: r.url,
    page: pageUrl,
    ...(r.inline ? { inline: true } : {}),
    status: r.status,
    ...(r.bytes !== undefined ? { bytes: r.bytes } : {}),
    ...(r.status === 'too-large' ? { truncated: true } : {}),
    refs: r.text ? scanScriptReferences(r.text) : [],
    ...(r.error ? { error: r.error } : {}),
  }));
}
