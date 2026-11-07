import type { CrawlSampling } from '../core/types.js';

/** What checking the sample found, when anything was replaced. */
export function healthSentence(s: CrawlSampling): string {
  const h = s.health;
  if (!h || !(h.gone || h.duplicates || h.offSite)) return '';
  const parts = [
    h.gone ? `${h.gone} not there (404 or 410)` : '',
    h.duplicates ? `${h.duplicates} redirecting to a page already in the sample` : '',
    h.offSite ? `${h.offSite} redirecting to another site` : '',
  ].filter(Boolean);
  return ` Of ${h.checked} sitemap URLs checked, ${parts.join(', ')}: replaced with other pages.`;
}
