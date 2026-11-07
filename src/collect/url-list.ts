import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseSitemapXml } from './sitemap.js';

/**
 * URLs in a text: a sitemap XML, a CSV (the first column), one URL a line, or
 * JSON. JSON may be a list saved by top-task-finder (its `selectedUrls`,
 * https://github.com/mgifford/top-task-finder), an array of URLs, or an array
 * of objects with a `url`. Anything that is not an http(s) URL (a header row,
 * a comment) is left out. Pure.
 */
export function parseUrlList(text: string): string[] {
  if (/<(urlset|sitemapindex)[\s>]/i.test(text)) return parseSitemapXml(text).locs;
  if (/^\s*[[{]/.test(text)) return urlsInJson(text);
  return text
    .split(/\r?\n/)
    .map((line) => line.split(',')[0]!.trim().replace(/^"|"$/g, ''))
    .filter((u) => /^https?:\/\//i.test(u));
}

const isUrl = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\//i.test(v.trim());

function urlsInJson(text: string): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const record = doc as Record<string, unknown>;
  const list = Array.isArray(doc) ? doc : (['selectedUrls', 'urls', 'pages'].map((k) => record?.[k]).find(Array.isArray) as unknown[] | undefined) ?? [];
  return list
    .map((x) => (isUrl(x) ? x.trim() : x && typeof x === 'object' && isUrl((x as { url?: unknown }).url) ? ((x as { url: string }).url).trim() : undefined))
    .filter((u): u is string => !!u);
}

/** The URLs listed in a file, for --also-file. None when no file is named. */
export async function readUrlList(file: string | undefined): Promise<string[]> {
  return file ? parseUrlList(await readFile(resolve(file), 'utf8')) : [];
}
