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

/** What the sitemap's metadata changed about the sample, in a sentence. */
export function sitemapMetaSentence(s: CrawlSampling): string {
  const m = s.sitemapMeta;
  if (!m) return '';
  const parts = [
    m.translationsSetAside ? `${m.translationsSetAside} translation${m.translationsSetAside === 1 ? '' : 's'} of other pages set aside (one language of each page is eligible)` : '',
    m.seriesSetAside ? `${m.seriesSetAside} earlier year${m.seriesSetAside === 1 ? '' : 's'} of a yearly series set aside (the newest of each is eligible)` : '',
    m.videoPages ? `${m.videoPages} page${m.videoPages === 1 ? '' : 's'} marked with video` : '',
    m.oldest && m.newest && m.oldest !== m.newest ? `pages last modified from ${m.oldest} to ${m.newest}` : '',
  ].filter(Boolean);
  return parts.length ? ` The sitemap: ${parts.join('; ')}.` : '';
}
