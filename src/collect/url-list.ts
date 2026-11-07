import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseSitemapXml } from './sitemap.js';

/**
 * URLs in a text: a sitemap XML, a CSV (the first column), or one URL a line.
 * Lines that are not http(s) URLs (a header row, comments) are left out. Pure.
 */
export function parseUrlList(text: string): string[] {
  if (/<(urlset|sitemapindex)[\s>]/i.test(text)) return parseSitemapXml(text).locs;
  return text
    .split(/\r?\n/)
    .map((line) => line.split(',')[0]!.trim().replace(/^"|"$/g, ''))
    .filter((u) => /^https?:\/\//i.test(u));
}

/** The URLs listed in a file, for --also-file. None when no file is named. */
export async function readUrlList(file: string | undefined): Promise<string[]> {
  return file ? parseUrlList(await readFile(resolve(file), 'utf8')) : [];
}
