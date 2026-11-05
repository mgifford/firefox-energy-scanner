/**
 * URL patterns: the shape of a URL with its variable parts replaced, so
 * /news/2024/05/budget-update and /news/2023/11/new-office are one pattern.
 * Pure and deterministic; the families and the adaptive sampler share it.
 */

/** A path segment that names one item rather than a section: numbers, hashes, dates, long slugs. */
export function isIdSegment(segment: string): boolean {
  if (/^\d+$/.test(segment)) return true;
  if (/^[0-9a-f]{8,}$/i.test(segment) && /\d/.test(segment)) return true; // hashes, uuids without dashes
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(segment)) return true;
  // Mostly-digit codes such as cms1242525 or r11787fm.
  const digits = segment.replace(/\D/g, '').length;
  if (digits >= 4 && digits / segment.length >= 0.5) return true;
  return false;
}

function segments(url: string): string[] {
  try {
    return new URL(url).pathname
      .split('/')
      .filter(Boolean)
      .map((s) => {
        try {
          return decodeURIComponent(s).toLowerCase();
        } catch {
          return s.toLowerCase();
        }
      });
  } catch {
    return [];
  }
}

/**
 * The URL's pattern: its path with item segments replaced by `:id` and a
 * file extension kept. The last segment of a path two or more deep is an
 * item whatever it looks like, since that is where most sites put the slug:
 * /news/budget-update and /news/new-office are both /news/:id.
 */
export function urlPattern(url: string): string {
  const parts = segments(url);
  if (parts.length === 0) return '/';
  return (
    '/' +
    parts
      .map((s, i) => {
        const last = i === parts.length - 1;
        const ext = /\.[a-z0-9]{2,5}$/.exec(s)?.[0] ?? '';
        const stem = ext ? s.slice(0, -ext.length) : s;
        return isIdSegment(stem) || (last && parts.length >= 2) ? `:id${ext}` : s;
      })
      .join('/')
  );
}

/**
 * The URL's section: the folders it sits in, up to `depth` of them, stopping
 * at an item segment. The page's own last segment is never part of it, so
 * /about and /contact are both in "/", and /news/2024/budget is in "/news".
 * Pages in one section are often, not always, built the same way, so the
 * adaptive sampler spreads its picks across sections.
 */
export function urlSection(url: string, depth = 2): string {
  const folders = segments(url).slice(0, -1);
  const out: string[] = [];
  for (const s of folders) {
    if (out.length >= depth || isIdSegment(s)) break;
    out.push(s);
  }
  return '/' + out.join('/');
}
