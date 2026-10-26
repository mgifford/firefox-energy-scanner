# Limitations and confounders

Read this before quoting any number from this tool.

## Hard limitations

### Platform

Firefox has power counters on physical **Apple Silicon Macs** (per-process),
**Windows 11** and **bare-metal Linux with Intel or AMD RAPL** (whole CPU package; needs
`kernel.perf_event_paranoid` ≤ 0), and Intel Macs. **Virtual machines**, including every
GitHub-hosted runner, produce no samples. The tool probes with a real Firefox session,
reports timing, bytes and CO2.js where it cannot measure, and never fabricates an energy
value. See [local-energy.md](local-energy.md).

### Scope differs by platform

On Apple Silicon the energy is Firefox's own processes. On Linux, Windows and Intel Macs
it is the whole CPU package, for every process on the machine, with the idle baseline
subtracted. Each result records its scope; do not compare results across scopes.

### URLs that are files, not pages

A URL that serves a file (typically a PDF) makes Firefox start a download instead of
rendering anything. There is no page to lay out or paint, so the step is reported as
**not a web page** and left out of every summary. Earlier versions published these rows
with the previous page's URL; the index now re-reads stored results with the corrected
handling. Each request is also counted only in the step that issued it, so a download
that finishes late cannot add its bytes to whatever step is running.

### Attribution is temporal, not causal

Energy is integrated over a step's wall-clock window. Background browser work inside
that window (garbage collection, unrelated tabs, telemetry, extension activity) is
included. Every result records `attribution: "time-window"`.

### Scope excludes the display

The counters cover Firefox's processes. Screen brightness — often the single largest
consumer on a laptop — is outside the boundary, as are other applications and the OS.

### Energy spread needs more than one visit

`crawl` loads each page once. One sample has no interquartile range: the value is 0 by
construction, not a sign of stability. The HTML report therefore prints `—` and says the
spread was not estimated, and with a single visit the resolution check has nothing to
compare against — so a published crawl figure is indicative, not resolved. Repeat the page
with `measure <url> --runs 10` to get a real spread.

### Grid-derived carbon is an assumption, not a measurement

Class C multiplies observed energy by a grid intensity you declare. Each part of that is
contestable, and the report prints the assumption next to the number for that reason.

- **Location is declared, never detected.** The tool does not geolocate the client. On a
  VPN, or with the wrong country selected, the figure is simply wrong.
- **An annual average is not a marginal intensity.** A national average smooths
  subnational grids and time of day. Alberta and Ontario differ by roughly an order of
  magnitude; so do night and peak demand.
- **The bundled table is country-level.** `--grid-zone` refuses subnational codes rather
  than quietly substituting a national average. Pass `--grid-intensity` for a local grid.
- **Transmission and distribution losses** are included only if the intensity figure you
  supply already accounts for them.
- **Below-resolution energy is suppressed.** A figure derived from noise would be a
  negative or meaningless emission, so the HTML and terminal reports print `—`. The CSV
  still exports the signed per-run value so the suppression rule can be audited.
- **It is not additive with CO2.js.** The model's device segment and the observed client
  energy describe the same device from opposite directions.

### Server-side changes will look like nothing

The boundary is the client. A patch that speeds up PHP or database work may move TTFB
without measurably changing browser energy. That is correct behaviour, not a null tool.

### No causal explanation

The tool tells you *that* energy changed, not *why*. Use `web-energy profile` for a
diagnostic Gecko profile, which is deliberately kept separate from benchmark results
because stack sampling changes the workload.

## Confounders

Each of these can move results independently of the thing being tested.

**Machine state**

- thermal state and fan/throttling behaviour
- background processes
- **AC vs battery power** — power management differs materially; `doctor` warns on battery
- battery charge level
- display brightness and number of displays
- GPU behaviour and compositor state

**Network and server**

- network latency and variability
- server latency and load
- **server cache state** — uncontrolled for remote targets such as Tugboat; warmups
  reduce but do not eliminate this
- CDN behaviour and geographic routing

**Browser and cache**

- browser cache state
- service worker and application cache behaviour
- browser version (Playwright pins its own Firefox, distinct from the system install)

**Tooling versions**

Any change to Firefox, Playwright, CO2.js, or the CO2 model invalidates comparison with
earlier runs. All are recorded in every result for exactly this reason.

**Methodology**

- workload duration (very short steps have few samples and high relative noise)
- run ordering (mitigated by interleaving)
- profiler overhead (the observer effect — see below)

## Cache modes

- `warm` — no cache clearing between runs.
- `cold-context` — a fresh browser context per run. This clears cookies and storage.
  Playwright does **not** guarantee full HTTP cache eviction, so this is not a true
  cold cache and is not described as one.
- `new-browser` — a fresh browser process per run.

Browser cache, server cache, service worker cache, and application cache are distinct.
This tool only influences the first, and only partially.

## The observer effect

Profiling changes the workload it measures. Two run types are kept separate:

- **primary measurement** — power counters only, minimal features, low overhead
- **diagnostic profiling** (`web-energy profile`) — stack sampling and richer features

Diagnostic runs must never be mixed into benchmark statistics, and the CLI says so when
you start one.

## Sample-count caveat

Short steps produce few power samples. A step lasting a few hundred milliseconds may
integrate only a handful of samples, making it dominated by noise. `sampleCount` is
recorded per measurement so this can be checked rather than assumed.

## Statistical caution

Comparisons with fewer than 10 runs per side are flagged as indicative only. The tool
does not perform significance testing, and no significance is claimed. Small median
differences on noisy data should not be reported as regressions or improvements.

## Field data (CrUX) limits

CrUX is the only optional indicator that describes the live site, and it has the
narrowest coverage of any of them:

- **The window is 28 days.** A change deployed today cannot show up in it. Field data
  describes the site as it was, not the build under test, so it cannot confirm a fix.
- **It covers Chrome only**, and only origins and URLs above Google's traffic
  threshold. Previews, staging sites, authenticated pages and low-traffic pages usually
  return no record. That is reported as `no data`, not as an error.
- **An origin record spans the whole site**, including pages this run never visited, so
  it cannot be attributed to one template, one asset or one step.
- **The distribution is Google's**, not ours. Only the p75 and three band shares are
  published, so the shape of the distribution cannot be inspected.
- **It is not comparable with Lighthouse by construction.** Different population,
  device mix and window. The report shows them side by side and labels the difference;
  it never averages the two or treats one as validation of the other.

## Explicit non-goals for version 1

Deliberately excluded, because they would blur the measurement boundary:

- carbon-neutrality claims or offset calculations
- a single composite "green score"
- server energy estimated from bytes
- data-centre or whole-Internet energy modelling
- Lighthouse-derived sustainability scoring
- field data (CrUX) used as a regression signal, which its 28-day window cannot support
- CI comparisons on uncontrolled shared runners
