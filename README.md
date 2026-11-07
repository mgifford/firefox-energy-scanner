# firefox-energy-scanner

Measure **observed client-side browser energy** and **modelled CO2e** for websites and
authenticated application interfaces, using Playwright, Firefox, and CO2.js.

Built for a specific research question: *does a change to a web application alter the
energy a browser spends on it, even when the transferred bytes stay roughly the same?*

## The short version of why this exists

Two pages measured with this tool, on the same machine, minutes apart:

| Page | Transfer | CO2.js estimate | Observed client energy |
|---|---|---|---|
| static text | 436 B | 0.065 mg | ~0 mWh |
| same size, busy JS | 678 B | 0.100 mg | **1.010 mWh** |

A bytes-based model rates these as near-equivalent. The browser spends roughly **two
orders of magnitude** more energy on one of them. Transferred bytes are not a proxy for
client energy, which is the whole premise of the project.

## Three metrics, three boundaries, never merged

This tool deliberately reports three different classes of indicator and never adds them
together. CO2.js is never converted into anything.

- **Modelled CO2e** — CO2.js, estimated from transferred bytes and model assumptions.
  Covers datacentre, network, and device segments. Not a measurement. This is already
  the hosting-side figure; there is no separate server carbon number.
- **Observed client energy** — Firefox's power counters, in joules/mWh. Covers the
  energy drawn by Firefox's processes on the machine running the test.
- **Grid-derived carbon** *(opt-in)* — the carbon implied by that observed energy at a
  grid intensity you declare, in µg CO2e. It is derived from the energy, **not** from
  CO2.js, and it carries its intensity, zone, kind and year wherever it appears.

```
web-energy measure https://example.com --grid-zone CA
web-energy measure https://example.com --grid-intensity 30 --grid-source "IESO 2025"
```

The measurement boundary is the **client machine**. Results say nothing about server,
PHP, database, or data-centre energy, and are not a total carbon figure for a site. Do
not add the modelled and derived carbon figures: the model's device segment and the
observed client energy describe the same device from opposite directions.

## Two tiers: local and hosted

The same commands run everywhere. What differs is whether the host has physical
power-measurement hardware, and every result declares its tier so an absent energy
figure is never read as a measured zero.

| | **Structural tier** (any host) | **Full tier** (physical Apple Silicon) |
|---|---|---|
| transferred bytes, requests, resource types | yes | yes |
| CO2.js modelled emissions | yes | yes |
| navigation timings, LCP | yes | yes |
| DOM size, depth, heaviest subtrees | yes | yes |
| CSS rule and selector counts | yes | yes |
| expensive-selector and image findings | yes | yes |
| payload triage between two targets | yes | yes |
| **observed energy (joules / mWh)** | no | **yes** |
| **idle baseline subtraction** | no | **yes** |
| **resolution check** | no | **yes** |
| **grid-derived carbon (µg CO₂e, when an intensity is declared)** | no | **yes** |
| **energy by work category** | no | **yes** |
| **A/B energy regression** | no | **yes** |
| Lighthouse score, lab metrics, recommendations (optional, Chromium) | yes | yes |

On a hosted runner the energy column reads **not measured**: no reading was taken.
That is different from **not resolved**, which means energy was measured but was
smaller than its own run-to-run spread. Neither is a zero.

The practical consequence: **most of the actionable output does not need energy
hardware.** A hosted scan still tells you the DOM is 4,000 nodes, that a stylesheet
carries 12,000 selectors, and which images are served ten times larger than displayed.
Only the energy questions need a Mac.

## Hosted scanning

**<https://mgifford.github.io/firefox-energy-scanner/>**

**Paste URLs — that is all a request needs.** Use the web form, or open an issue titled
`SCAN: canada.ca` with nothing else, as in [open-scans](https://github.com/mgifford/open-scans).

- **One URL** scans a sample of its site: the start page and pages from its sitemap, or,
  without one, the pages it links to. 20 pages by default; `PAGES:8` or `VIEWPORT:mobile`
  in the title change that. www and non-www, http and https count as one site.
- **Several URLs** scans exactly those pages, up to 200 — a
  [Top Task Finder](https://mgifford.github.io/top-task-finder/) list works well.
- **Lighthouse** runs by default on the 10 heaviest pages.

A comment confirms the scan has started. The results are posted on the issue and added
to a single rolling **Scan results** pull request; merging that publishes them to the
site. Reopen the issue to scan again.

### GitHub's cloud cannot measure energy

This was tested, not assumed. The [Energy probe](.github/workflows/energy-probe.yml)
workflow ran Firefox with its power profiler on every GitHub-hosted machine type:

| Runner | Virtual machine | Firefox power samples |
|---|---|---|
| `macos-latest` (Apple Silicon) | yes | 0 — the counter exists but never reports |
| `macos-15-intel` | yes | 0 |
| `ubuntu-latest` (x64), `ubuntu-24.04-arm` | yes (Azure) | 0 — no RAPL, even with `perf_event_paranoid=0` |
| `windows-latest` (x64), `windows-11-arm` | yes (Azure) | 0 |

Virtual machines do not pass power-measurement hardware through, so cloud scans visit
each page once and report page weight, modelled CO2e, timing, page structure and
Lighthouse. Their energy column reads **not measured**, which is an absence, not a zero.

**Energy needs a physical machine.** On an Apple Silicon Mac (M1 or later) there is
nothing to set up: scans measure Firefox's own energy by default. Intel Macs, bare-metal
Linux PCs with an Intel or AMD CPU (after one `sysctl`), and Windows 11 work too. Every
scan says at the start what this machine can measure, and how to fix it if a setting is
in the way. For a fuller check:

```bash
npm ci && npm run energy-check
```

Run scans locally from there, or register the machine so issue scans use it — see
[docs/local-energy.md](docs/local-energy.md). To have people submit domains that a
machine at home measures, follow [LOCAL-RUNNER.md](LOCAL-RUNNER.md): a runbook for a Mac
mini or Linux box, with the security steps and a set-up prompt for an AI assistant.

Only public `http(s)` URLs are accepted, and hosted scans run with `--public-only`: every
connection the browsers make, including redirects and page resources, is checked at scan
time, so a request cannot reach localhost, a home or office network, or a development
site such as `*.ddev.site`. Locally, leave the flag off to measure your own development
site.

## Requirements

- Node.js 20+
- For energy measurement, a **physical** machine: an Apple Silicon Mac (per-process,
  no setup), bare-metal Linux with an Intel or AMD CPU (one `sysctl`), or Windows 11.
  Virtual machines, including GitHub-hosted runners, cannot measure energy; the tool
  still reports timing, bytes, CO2.js and page structure there. Run `doctor` to find out
  what your machine can do. See [docs/local-energy.md](docs/local-energy.md).

Energy measurement needs **no elevated privileges**.

## Install

```bash
npm install
npx playwright install firefox
npm run build
```

Then run any command in one of three ways:

```bash
node dist/cli/index.js doctor          # the built CLI
npm run web-energy -- doctor           # rebuilds first, so it is never stale after a git pull
npm link                               # once: puts `web-energy` on your PATH
web-energy doctor
```

Lighthouse is an optional dependency (Node.js 22.19+). Use `npm install --omit=optional`
to skip it if you only need the Firefox measurements.

## Check your environment first

```bash
npm run energy-check        # installs Firefox, builds, then runs doctor
node dist/cli/index.js doctor --json   # the same verdict as data
```

You do not need this before a scan: `measure`, `crawl`, `journey`, `compare`,
`experiment` and `matrix` begin with one line on what this machine can measure, for
example `Energy: Apple M1 Mac. Firefox measures the energy of its own processes here,
with no setup.` A Linux PC that still needs `kernel.perf_event_paranoid=0` is told before
the scan, not after it. An option the CLI does not recognise, such as a misspelling, is
reported with the option it is closest to; it is not silently ignored.

`doctor` verifies Node, Playwright and Firefox, then runs Firefox for a few seconds
with the power profiler on and says plainly whether **this machine can measure
energy** — with the energy it measured, or the reason it cannot and what would fix it.
It also warns about conditions that invalidate comparisons, most importantly running
on **battery**, which changes power management behaviour.

## Commands

```bash
web-energy doctor
web-energy measure <url...>
web-energy crawl <url> --include '^/admin' --max-pages 50
web-energy journey examples/drupal-admin-basic.js --url https://example.com
web-energy baseline
web-energy compare --a <url> --b <url> --journey <file>
web-energy report results/<file>.json
web-energy profile --journey <file>
web-energy lighthouse <url...>
web-energy trace <url...>
web-energy crux <url>
web-energy webnrg <url...>
```

### Lighthouse (optional)

Add `--lighthouse` to `measure` or `crawl` to run Google Lighthouse afterwards, in
Chromium. It reports the Performance score (median of 3 runs, with the range), lab
Core Web Vitals, main-thread work, and the failing performance recommendations with
estimated savings, plus the recommendations shared across pages. It is a separate
indicator with its own boundary and is never combined with the Firefox results. See
[docs/lighthouse.md](docs/lighthouse.md).

```bash
node dist/cli/index.js measure https://example.com/ --lighthouse
node dist/cli/index.js lighthouse https://example.com/ --lighthouse-categories all
```

### Chromium tracing (optional)

Add `--trace` to `measure` or `crawl` to trace a few pages in Chromium afterwards (3 by
default, one per page family first), or run `trace <url...>` on its own. A trace says
which script ran a long task, which file keeps requesting animation frames, which
component's animation never stops, and which embedded widget keeps working while the
page sits idle. It records main-thread time in one run, not energy. See
[docs/tracing.md](docs/tracing.md).

```bash
node dist/cli/index.js crawl https://example.com/ --sample --trace
node dist/cli/index.js trace https://example.com/ --trace-keep traces/
```

### Field data (CrUX, optional)

Add `--crux` to `measure` or `crawl`, or run `crux <url>` on its own, to report Chrome
UX Report field data: the 75th percentile and band shares that **real Chrome users**
experienced over a trailing 28-day window. It is a fourth indicator with its own
boundary — a different population from both the lab and the measurement — and it is
never combined with anything else.

It does not replace Lighthouse. A 28-day window cannot show that a fix made today
helped, and CrUX has no record for previews, staging or low-traffic pages.

`--crux-pages` adds field data for each measured page, and `--popular` makes a crawl's
sample prefer pages real Chrome users visit (those with a CrUX record). Keep the key in
a `.env` file (gitignored; copy `.env.example`), or, for hosted scans, in the repository
secret `CRUX_API_KEY`, which turns both on. See
[docs/crux.md](docs/crux.md#the-api-key).

```bash
cp .env.example .env        # then set CRUX_API_KEY=… in .env
node dist/cli/index.js crux https://example.com/
node dist/cli/index.js measure https://example.com/ --lighthouse --crux
node dist/cli/index.js crawl https://example.com/ --adaptive --popular
```

The query carries the URL to Google, so local and private targets are refused before
anything is sent. See [docs/crux.md](docs/crux.md).

### Lab check: webNRG (optional)

Add `--webnrg` to `measure` or `crawl` to show a second energy figure from
[webNRG](https://website-tester.green-coding.io/): Firefox on Green Coding's dedicated,
calibrated machine, through their Green Metrics Tool. A result from the last 30 days is
reused; otherwise a measurement is requested (5 to 30 minutes). It has its own
boundary and is shown beside this scanner's figures, never combined with them. Every
webNRG result is public. Hosted scans do this by default for up to three pages.

```bash
node dist/cli/index.js measure https://example.com/ --webnrg
node dist/cli/index.js measure https://example.com/ --webnrg-lookup-only   # send nothing
```

See [docs/webnrg.md](docs/webnrg.md).

### measure

Measure one or more URLs directly.

```bash
node dist/cli/index.js measure https://example.com --runs 10 --warmups 3
```

### Grid-derived carbon (optional)

Pass a grid carbon intensity to also report the carbon implied by the observed client
energy, in µg CO₂e. It is derived from the energy, never from the CO2.js estimate, and
the assumption behind it (intensity, zone, kind, year, source) is printed beside the
number.

```bash
node dist/cli/index.js measure https://example.com --grid-zone CA
node dist/cli/index.js measure https://example.com \
  --grid-intensity 30 --grid-zone CA-ON \
  --grid-source "IESO 2025 annual average" --grid-year 2025
node dist/cli/index.js compare --a <url> --b <url> --journey <file> --grid-intensity 30
```

Values are suppressed for steps whose incremental energy is below its own run-to-run
spread, because a negative or noise-derived emission is not a result. `--grid-zone`
accepts ISO country codes from a bundled national annual-average table; subnational
grids (Ontario, Alberta, California) need an explicit `--grid-intensity`. See
[docs/methodology.md](docs/methodology.md) and [docs/limitations.md](docs/limitations.md).

### journey — the mode to use for regressions

Deterministic scripted user tasks with explicitly named measurement boundaries.
Authentication happens in `setup()`, outside the measured region.

```js
export default defineJourney({
  name: 'drupal-admin-content-filter',
  async setup({ page, baseUrl, env }) {
    await loginDrupal(page, { baseUrl, ...readDrupalCredentials(env) });
  },
  async run({ page, measure, url }) {
    await measure('open-content', async () => {
      await page.goto(url('/admin/content'));
    });
    await measure('filter-content', async () => {
      await page.getByLabel('Title').fill('test');
      await page.getByRole('button', { name: /filter/i }).click();
    });
  },
});
```

### crawl — for discovery, not regression

Crawls visit different pages under different conditions, which makes them a poor basis
for A/B comparison. Use them to find what to measure, then write a journey.

`--sample` takes a sample of the pages the site's sitemap lists instead of following
links, the start page first; the same site gives the same sample. Hosted scans of one URL
use it. `--adaptive` spreads the sample across the site's URL sections instead, keeping a
few pages for rare ones. Either way, each page's place in the draw depends only on the
page, so a re-scan keeps most of its pages even after the sitemap changes.

A crawl also measures the site's **key pages**, found from the start page, as a WCAG-EM
sample has them: search results, a top task (a link such as "Apply" or "Renew"), the
accessibility statement (in 24 languages), contact, help, and the "not found" page. They
take at most a quarter of `--max-pages` (`--no-key-pages` to leave them out).
`--also-file <file>` adds pages you always want, from a list, a CSV, a sitemap or a
[top-task-finder](https://github.com/mgifford/top-task-finder) JSON list. Sitemap
metadata is used too: one language of each translated page, the newest of a yearly
series, a page with video, and the oldest page when a site's dates span years. See
[docs/page-families.md](docs/page-families.md).

**Only HTML pages are measured.** Before Firefox visits a URL, the scan checks what it
serves: a file extension (`.pdf`, `.xlsx`) settles it, and otherwise a `HEAD` request
reads the server's `Content-Type`, or a GET for the first kilobyte where a server refuses
`HEAD`. That catches file aliases with no extension, such as CMS.gov's
`/files/document/finalpptpdf`. A PDF, spreadsheet or archive is skipped. It does not count
against `--max-pages`, and a sample measures another page from the same section in its
place. The result and report list what was skipped and its type. `measure` skips a listed
file once, before any warmup. A URL that cannot be checked, or that answers with an error,
is kept, and Firefox still recognises a download when it gets there.

After a crawl, the pages are grouped into **page families** by how they are built
(components, landmarks, scripts and stylesheets, Drupal template, URL pattern), each with a
representative page and its outliers. A family is a grouping for investigation, not a
measurement. `web-energy families <result.json>` rebuilds them for any stored result. See
[docs/page-families.md](docs/page-families.md).

A **component inventory** lists the components the pages are built from, which recur,
what each holds (elements, media, animations, scripts), and, with `--lighthouse`, the
Lighthouse findings that fall inside each one, matched by DOM node path. It is evidence
for where to look, never a component's energy. See
[docs/component-inventory.md](docs/component-inventory.md).

Every scan also writes a **component graph**: pages, component types and instances,
resources and findings, by stable id, validated against a published JSON Schema. Every
element is owned by its nearest component, so wrappers are not credited with their
contents. Resources are placed by reach, so a script every page loads from `<head>`
shows up even though no element owns it. See [docs/component-graph.md](docs/component-graph.md).

The HTML report opens with **Investigate first**: a queue in a stated order (evidence,
reach, remedy, workload; a sort, not a score), each item with where it is on the page, a
remedy, its rationale and the measured comparison that would check it, plus page maps
drawn from recorded positions. **Since the last scan** compares the scan with the previous
scan of the same site. See [docs/investigation-report.md](docs/investigation-report.md).

To find out whether a change **measurably reduces client energy**, run an **experiment**:
the page as served against the page with one change (animations paused, reduced motion,
lazy images, no autoplay, a host or script refused, an element hidden). The runs are
interleaved and the change is applied symmetrically. The result says whether the change
applied and the page still passed its checks, and reports the measured difference with
both sides' spread. `--from <result.json> --item <n>` builds the experiment for an item of
the queue. See [docs/experiments.md](docs/experiments.md).

Journeys can be drafted with Playwright MCP and checked with `web-energy journey-check`;
they always run without a model. See [docs/journeys-with-mcp.md](docs/journeys-with-mcp.md).

### compare

Runs are **interleaved** (`A B B A …`) from a stored seed, so drift in thermal state,
network, or server cache is not confounded with the target being tested.

```bash
node dist/cli/index.js compare \
  --a https://baseline.tugboatqa.com --label-a core-head \
  --b https://patch.tugboatqa.com   --label-b issue-12345 \
  --journey examples/drupal-admin-basic.js \
  --warmups 10 --runs 30
```

## Drupal

Credentials come from the environment and are never logged, never written to results,
and never placed in a URL. Copy `.env.example` to `.env`.

```
DRUPAL_BASE_URL
DRUPAL_USERNAME
DRUPAL_PASSWORD
```

Tugboat previews are treated as ordinary remote HTTPS targets; no Tugboat API access is
required.

## Output

JSON is canonical and always retains raw per-run measurements — summaries never replace
them. CSV and a static, accessible HTML report (no JS framework, tables rather than
canvas charts) are generated alongside.

## Documentation

- [docs/decision-record.md](docs/decision-record.md) — what was verified, and how
- [docs/methodology.md](docs/methodology.md) — boundaries and what the numbers mean
- [docs/energy-measurement.md](docs/energy-measurement.md) — how energy is captured
- [docs/limitations.md](docs/limitations.md) — confounders and known limits
- [docs/local-energy.md](docs/local-energy.md) — which machines can measure energy, and how
- [docs/self-hosted-runner.md](docs/self-hosted-runner.md) — energy measurement in CI
- [docs/what-costs-energy.md](docs/what-costs-energy.md) — which parts of a page cost most
- [docs/comparisons.md](docs/comparisons.md) — comparing patches without confounding
- [docs/lighthouse.md](docs/lighthouse.md) — optional Lighthouse scores and recommendations
- [docs/tracing.md](docs/tracing.md) — optional Chromium traces: which script, element or iframe does the work
- [docs/crux.md](docs/crux.md) — optional CrUX field data from real Chrome users
- [docs/webnrg.md](docs/webnrg.md) — optional webNRG lab figures from Green Coding's cluster
- [docs/page-families.md](docs/page-families.md) — grouping a crawl's pages by how they are built, and adaptive sampling
- [docs/component-graph.md](docs/component-graph.md) — the canonical model: types, instances, resources, findings, schema
- [docs/component-attribution-plan.md](docs/component-attribution-plan.md) — the review and plan for component-level attribution
- [docs/component-inventory.md](docs/component-inventory.md) — recurring components and the Lighthouse evidence tied to them
- [docs/investigation-report.md](docs/investigation-report.md) — the investigation queue, remedies, page maps and history
- [docs/experiments.md](docs/experiments.md) — measuring whether a change reduces client energy
- [docs/journeys-with-mcp.md](docs/journeys-with-mcp.md) — writing journeys with Playwright MCP, and the rules they follow

## Licence

AGPL-3.0-or-later.
