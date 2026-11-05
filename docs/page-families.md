# Page families and adaptive sampling

A crawl measures a sample of a site's pages. Page families group those pages by how they
are built, so a reader can see which templates the sample covers, which page to look at
first for each, and which pages stand out from their family.

A family is a grouping **for investigation, not a measurement**. It adds no energy figure
and changes no measurement definition. Its numbers are medians of the pages measured in
it; nothing is extrapolated to the pages that were not measured.

## Where it appears

- **Results JSON:** `families` (see `FamilyReport` in `src/analysis/families.ts`) and, for
  crawls, `sampling.reasons`, `sampling.strata` and `sampling.limitations`.
- **CSV:** four columns appended at the end, so existing positions are unchanged:
  `family_id`, `page_fingerprint`, `url_pattern`, `sample_reason`.
- **HTML report:** a _Page families_ section with a table, one disclosure per family and
  _How the pages were chosen_.
- **Issue comment:** a _Page families_ table for hosted scans.
- **CLI:** `web-energy families <result.json>` groups the pages of any stored result,
  older ones included; `--json` prints the report, `--write` stores it in the result and
  regenerates its HTML and CSV.

Families are computed for crawls and for `measure` runs with two or more pages.

## What a page is made of

`collectPageAnatomy` already walks the DOM after the measured window (so it adds nothing
to the energy figure). It now also records `anatomy.structure`:

| Field | What it holds |
| --- | --- |
| `landmarks` | ARIA landmark roles in document order. `header` and `footer` count only outside sectioning content; `form` and `section` only when named. |
| `components` | Component signatures, largest first, at most 40, each with how it was recognised, how often it appears and how many elements it holds. |
| `frameworks` | Framework roots found: Drupal, React, Next.js, Vue, Angular, Svelte, web components. |
| `drupal` | The page template from body classes (`page-node-type-*`, else `path-*`), route classes, the theme and, when Drupal sends it uncompressed, the library list. |

Component signatures, most trustworthy first:

1. **annotation**: `data-component-id` or `data-component`, which the site put there
   (Drupal single-directory components emit `data-component-id`).
2. **framework**: custom elements (`element:my-carousel`) and framework roots.
3. **drupal**: Drupal's class conventions name the template or plugin that rendered the
   markup: `drupal-node:<type>:<view mode>`, `drupal-paragraph:<type>`,
   `drupal-view:<id>`, `drupal-block:<plugin>`, `drupal-region:<name>`.
4. **landmark**: `landmark:<role>`.
5. **class-heuristic**: the first non-utility class of an element with at least ten
   descendants. A guess, labelled as one.

Numbers in names become `:id`, so `page-node-59986` and `page-node-1883456` match.

Twig debug comments would name templates exactly, but Twig debug changes the markup and
the server's work, so it is never on while benchmarking. `diagnose` reads them when a
development site has Twig debug on; families use only what a production page carries.

## How pages are grouped

Method `structure-v1`, deterministic for a given set of results:

1. Each page gives five feature sets: **components** (not landmarks), **resources**
   (first-party scripts and stylesheets by host and path, query dropped; third parties by
   host only, since their lazy-loaded chunks vary by visit), **landmarks** (counted),
   **template** and **URL pattern**.
2. Two pages are compared set by set with a weighted Jaccard index. A feature's weight is
   `ln(1 + N / df)`, so the site header found on every page still counts, but less than a
   component that sets a few pages apart.
3. The sets are combined with fixed weights: components 0.35, resources 0.35, landmarks
   0.1, template 0.1, URL pattern 0.1. A set empty on both pages (no Drupal template, say)
   drops out and the rest are rescaled.
4. Average-linkage clustering, pages in URL order, merges the most similar pair while it
   is at least 0.6.

Per family the report gives:

- **id** `pf-…`: a hash of the structural features at least 80% of its pages share
  (components, landmarks, template, URL pattern; not resources, whose aggregated names
  change on every deploy). It stays the same while the family's shared structure does.
- **representative**: the page most like the rest of its family.
- **signals**: those shared features, in readable form.
- **metrics**: median, minimum and maximum DOM nodes, transfer and requests.
- **outliers**: in a family of three or more, pages at least twice or at most half the
  family median on one of those metrics.
- **cohesion**: the mean similarity of its pages, from 0 to 1.

Each page also gets a fingerprint `fp-…`, the hash of its own structural features: the
same structure gives the same fingerprint in any scan.

Results made before `structure` was recorded are still grouped, by URL, scripts,
stylesheets and their five heaviest subtrees, and the report says so. Rebuilt from the
issue #31 result, cms.gov's 20 pages form two families: the home page, and the 19 others,
which share one template.

## Adaptive sampling

`--sample` (and hosted scans of one URL) takes a seeded random sample of the sitemap.
**It is unchanged** — a test pins its output — because re-scans compare like with like
only while the same site gives the same pages.

`--adaptive` (or `SAMPLE:adaptive` in an issue title, or _Page sampling: Spread across
sections_ in the form) takes a stratified sample instead. Strata are URL sections: the
first two folders a page sits in, stopping at an item segment (`/news/2024/story` is in
`/news`; `/about` is in `/`). When a sitemap index names several child sitemaps, strata
are also split by child, since sites often split those by content type. Up to six child
sitemaps are read, rather than three.

1. One page from each common section, largest first: the **representatives**.
2. About a fifth of the sample from **rare sections**, each holding at most 1% of the
   listed pages (and at least one), in seeded order. Unusual corners of a site are where
   one-off templates and forgotten pages tend to live. Kept only when the sample has room
   for four or more pages.
3. The rest **in proportion** to section size (D'Hondt), so a large section gets more.

Pages within a section are drawn in seeded order, and the order of picks puts the
representatives first, so a page limit cuts the proportional share first. The same
sitemap and site give the same sample.

The result records why each page was measured (`start`, `requested`, `random`,
`representative`, `rare-section`, `proportional`, `linked`), each section with the pages
listed and measured, and the sample's limitations.

## Limitations

- Families describe the pages measured. A small template can be missing from a random
  sample; an adaptive sample makes that less likely, not impossible.
- URL sections are a guess at structure. The families say how the measured pages
  actually group.
- Grouping says pages are built alike, not that they cost alike: content, media and
  behaviour after interaction can still differ.
- A sitemap index with many children is read in part; the sampling record says how many
  of how many.
- If the start page redirects to a page the sitemap also lists, that pick is skipped as
  already measured, so the crawl measures one page fewer. This applies to both samples.

## Cost of the analysis

Structure is read in the same DOM walk as before, once per page, after the measured
window. Families are computed from stored results with no browser and no network. An
adaptive sample reads at most three more child sitemaps than a random one. None of this
profiles a page or adds a visit.
