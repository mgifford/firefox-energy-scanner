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

## Three indicator classes

This project maintains three separate sustainability indicators with different system
boundaries. They are reported side by side, in their own units, and are never summed or
averaged together.

Class A is never converted into anything. Class C is derived from Class B, the observed
energy, and carries its own declared assumption. Nothing is ever derived from Class A.

### A. Modelled sustainability estimate (CO2.js)

Derived from network/resource activity and model assumptions. Recorded per run:

- transferred bytes, request count, resource types
- first-party vs third-party breakdown
- CO2.js library version and model identifier
- estimated CO2e, including datacentre / network / device segments
- green-hosting status when checked

This is a **model output**, not an observation. Its boundary spans datacentre, network,
and a generic consumer device — none of which is the specific machine under test.

It already covers the hosting side. There is no separate "server carbon" figure: the
datacentre and network segments are that figure, as the model states them.

### B. Observed browser/client energy (Firefox power counters)

Energy drawn by Firefox's processes on the machine running the test, in joules and
milliwatt-hours. Its boundary is the browser's processes on one client machine.

### C. Grid-derived carbon for observed energy

Optional and off by default. When a grid carbon intensity is declared, the incremental
client energy from Class B is multiplied by it:

```
µg CO2e = incremental energy (mWh) × grid intensity (gCO2e/kWh)
```

The unit conversion is not missing. `1 mWh = 1e-6 kWh` and `1 g = 1e6 µg`, so the two
factors of one million cancel and one multiplication is the whole formula.

**What this class is:**

- a carbon estimate for the electricity one browser actually drew
- conditional on a declared intensity, zone, kind (average or marginal) and year, all of
  which travel into the report
- published only where the energy it derives from is resolvable against its own spread

**What this class is not:**

- a conversion of the CO2.js estimate
- a server, network, data-centre or whole-site figure
- a real-time grid signal
- something to add to Class A

The intensity comes from `--grid-intensity` (or the `carbon.grid_intensity_g_per_kwh`
config key), recorded with its source and year, or from the bundled national
annual-average table via `--grid-zone`. The bundled table is **country-level only**.
Subnational grids differ sharply — Ontario and Alberta are roughly an order of magnitude
apart — so pass a local figure explicitly where that matters. The table refuses
subnational zone codes rather than silently substituting a national average.

Bundled table provenance: extracted once from Our World in Data's
`carbon-intensity-electricity.csv?v=1&csvType=full&useColumnShortNames=true` (Ember),
keeping the latest year at or before 2024 for each ISO 3166-1 alpha-3 code, joining alpha-3
to alpha-2, and rounding to whole gCO2e/kWh. The per-entry year records when a country
had no 2024 figure. It lives in `src/core/grid-zones.ts` and is generated data, not
hand-maintained.

#### Why A and C differ, and why they must not be added

A measured run of `https://www.thegreenwebfoundation.org/` transferred 123.5 KB and
produced a CO2.js estimate of **18.748 mg**. Its incremental energy was **−0.042 mWh**,
below the resolution of the setup. Its gross energy, 0.063 mWh, implies about **25 µg**
at 400 gCO2e/kWh — roughly 750× smaller than the CO2.js figure, and the incremental
figure is not publishable at all.

That gap is the point of the project, not a defect in either number. CO2.js models a
generic device's share of a byte transfer; Class C reports what one browser on one
machine was measured to draw. They are not two estimates of the same quantity.

Adding them would also double count. CO2.js's `consumerDeviceGrams` segment already
models device energy; Class C observes device energy. Summing A and C would count the
client device twice. This is the same reasoning by which the Firefox Profiler zeroes its
device grid intensity when pairing its power track with CO2.js.

### Why A and B are not interchangeable

A page can transfer very few bytes and still burn substantial CPU. Measured on this
machine, two pages of near-identical size (436 B vs 678 B) differed by roughly 134× in
raw measured energy. Any framework that treats bytes as a proxy for client energy will
miss that entirely.

Notably, the Firefox Profiler itself pairs its power track with CO2.js and explicitly
zeroes the device grid intensity so as not to double-count energy the power track
already attributes to the device. This tool follows the same reasoning: the device
segment of the model is kept visible but separate, and Class C is opt-in.

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
