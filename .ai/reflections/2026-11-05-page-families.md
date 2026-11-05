# 2026-11-05 — page families and adaptive sampling (component diagnosis, PR 1 of 4)

**Task:** Group a crawl's pages into families by structure; add an opt-in adaptive sample.

**Changed:** `src/collect/page-anatomy.ts` (structure), `src/analysis/*` (new),
`src/collect/sitemap.ts`, `src/collect/crawler.ts`, `src/report/{csv,html,families-html,index-builder}.ts`,
`src/cli/{index,args,issue-parser}.ts`, the scan workflow and issue form, docs.

**Evidence:** `npm test`; the default sample pinned against the pre-change output;
`families` on the issue #31 result gives 2 families (home page; 19 template pages);
structure collection checked in Chromium on a Drupal-like fixture (no Firefox locally;
the e2e runs it in Firefox in CI).

**Worked:** testing the clustering on a real stored result before writing tests.

**Cost time:** body classes leaking into component signatures (`class:path-node`); a
start page that redirects into the sitemap's own list wastes one pick.

**Next:** PR 2, component inventory and performance evidence.
