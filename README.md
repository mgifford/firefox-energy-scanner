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

**Paste URLs — that is all a request needs.** Use the web form or open a `SCAN:` issue.

- **One URL** crawls its site (www and non-www, http and https count as one site,
  redirects are followed), up to 50 pages by default.
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

**Energy needs a physical machine**: an Apple Silicon Mac, a bare-metal Linux PC with an
Intel or AMD CPU, or Windows 11. Check yours with one command:

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

Lighthouse is an optional dependency (Node.js 22.19+). Use `npm install --omit=optional`
to skip it if you only need the Firefox measurements.

## Check your environment first

```bash
npm run energy-check        # installs Firefox, builds, then runs doctor
node dist/cli/index.js doctor --json   # the same verdict as data
```

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

### Field data (CrUX, optional)

Add `--crux` to `measure` or `crawl`, or run `crux <url>` on its own, to report Chrome
UX Report field data: the 75th percentile and band shares that **real Chrome users**
experienced over a trailing 28-day window. It is a fourth indicator with its own
boundary — a different population from both the lab and the measurement — and it is
never combined with anything else.

It does not replace Lighthouse. A 28-day window cannot show that a fix made today
helped, and CrUX has no record for previews, staging or low-traffic pages.

```bash
export CRUX_API_KEY='…'
node dist/cli/index.js crux https://example.com/
node dist/cli/index.js measure https://example.com/ --lighthouse --crux
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
- [docs/crux.md](docs/crux.md) — optional CrUX field data from real Chrome users
- [docs/webnrg.md](docs/webnrg.md) — optional webNRG lab figures from Green Coding's cluster

## Licence

AGPL-3.0-or-later.
