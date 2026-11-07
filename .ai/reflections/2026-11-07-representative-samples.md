# 2026-11-07 — representative, stable samples

**Task:** Ideas 1–4 from mgifford/purple-a11y-fork's sitemap-tools: stable sampling,
key pages, a cleaned sample, sitemap metadata.

**Changed:** `src/collect/sitemap.ts` (hash order, cleaning loop, entries, translations,
special pages), `src/collect/key-pages.ts` and `src/collect/url-list.ts` (new),
`src/collect/content-type.ts` (gone, status, final URL), `src/collect/crawler.ts` (key
pages, order of the queue, gone pages), `src/analysis/history.ts`, CLI options
(`--no-key-pages`, `--also-file`), report text, the fixture site, tests, docs, TDR-020.

**Evidence:** on a 4,000-page sitemap, a 20-page sample now keeps 19 of its pages after
the sitemap grows by 5% or loses 2%; the old shuffle kept 0 and 1. Key pages were found
over real HTTP on the fixture site (search with its query, contact, accessibility, an
HTML 404). `npm test`; trace e2e in Chromium. The Firefox e2e runs in CI.

**Worked:** measuring the old order's stability before changing it. The number made the
case for changing a pinned output.

**Cost time:** keeping the sampler deterministic while it replaces pages: each special
pick and each replacement had to step through the same seeded order.

**Next:** traffic-weighted scans from an analytics CSV; a cheap discovery pass for sites
without sitemaps.
