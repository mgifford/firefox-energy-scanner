import { stableHash } from '../analysis/signature.js';

/**
 * A resource's identity: host and path, keeping query values that name the
 * asset, dropping those that vary per page or per load (a page URL passed
 * along, a timestamp), so one script loaded on every page is one resource.
 * Third-party beacons and pings (anything but scripts, styles, fonts and
 * documents) are identified by endpoint alone: each hit's query differs.
 */
export function resourceIdentity(url: string, kind?: string, thirdParty?: boolean): string {
  try {
    const u = new URL(url);
    const base = `${u.hostname.toLowerCase()}${u.pathname}`;
    if (thirdParty && kind && !['script', 'stylesheet', 'font', 'document'].includes(kind)) return base;
    const kept = [...u.searchParams.entries()].filter(([, v]) => !/^https?:|%3A%2F%2F|^\d{10,}$/i.test(v) && !/^https?:\/\//i.test(decodeURIComponent(v)));
    const q = kept.length ? `?${kept.map(([k, v]) => `${k}=${v}`).sort().join('&')}` : '';
    const key = `${base}${q}`;
    return key.length > 240 ? `${key.slice(0, 200)}…#${stableHash(key)}` : key;
  } catch {
    return url;
  }
}
