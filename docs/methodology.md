# Methodology

## The central claim, stated precisely

This tool reports the **incremental client-side energy associated with performing a
defined browser workload**.

It does **not** measure, and must not be described as measuring:

- Drupal PHP execution energy
- database energy
- web server or application server energy
- data-centre energy
- total Internet energy
- total website energy
- total carbon emissions

## Two indicator classes

This project maintains two separate sustainability measurements with different system
boundaries. They are reported side by side, in their own units, and are never summed,
averaged together, or converted into one another.

### A. Modelled sustainability estimate (CO2.js)

Derived from network/resource activity and model assumptions. Recorded per run:

- transferred bytes, request count, resource types
- first-party vs third-party breakdown
- CO2.js library version and model identifier
- estimated CO2e, including datacentre / network / device segments
- green-hosting status when checked

This is a **model output**, not an observation. Its boundary spans datacentre, network,
and a generic consumer device — none of which is the specific machine under test.

### B. Observed browser/client energy (Firefox power counters)

Energy drawn by Firefox's processes on the machine running the test, in joules and
milliwatt-hours. Its boundary is the browser's processes on one client machine.

### Why they are not interchangeable

A page can transfer very few bytes and still burn substantial CPU. Measured on this
machine, two pages of near-identical size (436 B vs 678 B) differed by roughly 134× in
raw measured energy. Any framework that treats bytes as a proxy for client energy will
miss that entirely.

Notably, the Firefox Profiler itself pairs its power track with CO2.js and explicitly
zeroes the device grid intensity so as not to double-count energy the power track
already attributes to the device. This tool follows the same reasoning by keeping the
device segment visible but separate.

## Measurement boundary

For remote targets such as Tugboat previews:

```
Remote infrastructure          <-- NOT measured
  Drupal, PHP, database, web server
        |
        | HTTPS
        v
Local test machine             <-- measurement boundary
  Playwright, Firefox, OS, GPU, compositor, network stack
```

A server-side change (for example a PHP-level cache optimisation) will typically move
TTFB while leaving client energy largely unchanged. That is the boundary working as
intended, not a failure of the tool.

## How energy is attributed to a step

Per-step profiler control is not possible from Playwright: `nsIProfiler` is
chrome-privileged and Playwright exposes no chrome-context evaluation for Firefox.
Instead:

1. Firefox is launched with the Gecko Profiler enabled for the whole session.
2. The harness records wall-clock start/end timestamps for each named step.
3. After the browser exits and the profile is written, power counters are integrated
   over each step's time window.

Consequences, recorded in every result as `attribution: "time-window"`:

- Attribution is temporal, not causal. Concurrent browser activity inside the window
  is included.
- Steps are measured as half-open intervals so adjacent steps never double count.

Power counters are summed across the **parent process and every content process**, each
normalised to its own time origin. Omitting content processes attributes none of the
page's JavaScript work, which produces physically impossible results — this was caught
during validation and is locked in by a regression test.

## Units

Gecko power counter samples are **picowatt-hours**. The conversion used is:

```
joules = pWh × 1e-12 × 3600
```

This mirrors the Firefox Profiler's own `PWH_TO_WH = 1e-12` constant. Because a
documented physical model backs the conversion, reporting joules is defensible.

No proxy metric is ever converted into joules. When no energy source is available, the
tool reports timing only and omits energy fields entirely rather than substituting an
estimate.

## Baseline subtraction

```
baseline watts          = idle joules / idle seconds
expected idle energy    = baseline watts × workload duration
incremental energy      = raw measured energy − expected idle energy
```

All three values are retained in the output. Negative incremental values are **not
clamped to zero**; they are reported and flagged as noisy. A negative value usually
means the workload was genuinely lighter than average idle draw, or that the baseline is
stale.

The baseline is sampled only after a settle period, because Firefox performs significant
startup work in its first seconds. Sampling immediately inflates the idle estimate — in
testing, an unsettled baseline read 0.114 W versus 0.045 W once settled.

## Repetition and ordering

Warmups populate caches and settle JIT and thermal state. They are executed and then
**excluded from all statistics**.

Development defaults are 3 warmups and 10 runs. For high-confidence benchmarking, 10
warmups and 30 runs are recommended.

A/B comparisons interleave runs from a stored seed rather than running all of A followed
by all of B, so that drift over the session is not confounded with the target.

## Statistics

Median is the headline statistic; count, mean, min, max, standard deviation, p25, p75,
p95, and IQR are all reported. Comparisons below 10 runs per side are explicitly
qualified as indicative, and no significance is claimed from small samples.

Correlation uses **Spearman's rank coefficient**, because the relationships of interest
are monotonic rather than necessarily linear and the data is not assumed normal.
