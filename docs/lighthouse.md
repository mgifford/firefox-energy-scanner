# Lighthouse

Lighthouse is optional. When it is on, it runs **after** the Firefox measurements have
finished and the Firefox session has closed, so Chromium's work never falls inside a
Firefox energy window.

## What it adds

For each URL:

- the **Performance score** (0–100). Locally the CLI reports the median of 3 runs with
  the lowest and highest score in brackets; hosted scans run once per page to keep a
  long list affordable
- lab metrics: Largest Contentful Paint, Total Blocking Time, Cumulative Layout Shift,
  First Contentful Paint and Speed Index
- the **failing performance recommendations** (Lighthouse's "Insights" and
  "Diagnostics"), worst first, each with Lighthouse's estimated time and byte savings
  and a link to its documentation
- **main-thread work** by category (script evaluation, style and layout, rendering, …),
  JavaScript execution time, total bytes, and unused JavaScript and CSS bytes
- optionally the Accessibility, Best practices and SEO scores, with the failing audits

Across the scan, it lists the **recommendations shared by several pages**. Pages on one
site share a theme, so a failure on most pages usually means one fix in a template or a
shared asset.

## A separate indicator, with its own boundary

| | Engine | What it is |
|---|---|---|
| CO2.js | none | modelled emissions from transferred bytes |
| Observed energy | Firefox | power counters on the client machine |
| Grid-derived carbon | none | observed energy × a declared grid intensity |
| **Lighthouse** | **Chromium** | lab load performance under simulated throttling |

Lighthouse numbers are not Firefox numbers and not energy. They are reported beside the
Firefox results and never combined with them. Main-thread work is the Lighthouse figure
closest to client energy, because it counts CPU time. On a hosted runner, with no power
hardware, it is the best available hint about how much work a page costs the device.

## Device profile

Lighthouse has two standard profiles, and they are used unmodified so scores line up
with [PageSpeed Insights](https://pagespeed.web.dev/):

- a viewport 1100 px or wider uses the **desktop** profile
- anything narrower (tablet or phone) uses the **mobile** profile: a mid-range Android
  phone on a throttled 4G connection, with 4× CPU slowdown

Override it with `--lighthouse-form-factor mobile|desktop`. Mobile scores are usually much
lower than desktop scores for the same page.

## Running it

```bash
# Alongside a Firefox measurement
node dist/cli/index.js measure https://example.com/ https://example.com/about \
  --runs 10 --lighthouse

# Lighthouse only, all four categories, keeping the full HTML reports
node dist/cli/index.js lighthouse https://example.com/ \
  --lighthouse-categories all --lighthouse-reports lighthouse-reports

# A crawl, auditing the 10 heaviest pages it found
node dist/cli/index.js crawl https://example.com/ --max-pages 100 --lighthouse
```

| Option | Default | |
|---|---|---|
| `--lighthouse` | off | run Lighthouse on measure or crawl targets |
| `--lighthouse-runs <n>` | 3 | runs per URL; the median run is reported (max 9) |
| `--lighthouse-categories <c>` | `performance` | a comma list, or `all` |
| `--lighthouse-form-factor <f>` | from viewport | `mobile` or `desktop` |
| `--lighthouse-top <n>` | 10 | crawl mode: how many of the heaviest pages to audit |
| `--lighthouse-reports <dir>` | none | write each URL's full HTML report (median run) |

Lighthouse needs Node.js 22.19 or later and a Chrome or Chromium. It uses `CHROME_PATH`
if set, then an installed Google Chrome, then Playwright's Chromium
(`npx playwright install chromium`).

URLs that Firefox found to be file downloads (such as PDFs) are skipped, because
Lighthouse cannot audit them either.

## Hosted scans

Lighthouse is **on by default** in the scan form and issue template: performance, on
the 10 heaviest pages of the scan (by transferred bytes), one run each — about four
minutes. You can pick every page, all four categories, or turn it off. The issue
comment gains a Lighthouse table and the most common recommendations, and the published
site shows each audited page's score, metrics and recommendations.

Full HTML reports are uploaded as a **workflow artifact kept for 14 days**, linked from
the issue comment. They are not committed to the repository: each one is about half a
megabyte, mostly screenshots, and the published results keep only the few kilobytes
that the summary needs.

Lighthouse is an optional npm dependency. CI jobs that do not run it install with
`npm ci --omit=optional`, which skips about 200 MB of packages.

## Limits

- **Simulated throttling.** Lighthouse loads the page quickly and then models a slower
  device and network. That is fast and repeatable, but the metrics are estimates.
- **Shared runners vary.** Lighthouse records a CPU benchmark (`benchmarkIndex`) for the
  host. Compare scores only between runs on similar hosts.
- **One load, no interaction.** Lighthouse audits the initial page load. It says nothing
  about work done after the user starts interacting.
- **Third-party content changes.** Ads, analytics and embedded widgets vary between runs,
  which is why the score range is shown.
