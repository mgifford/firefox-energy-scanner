# Energy measurement

## How it works

Firefox is launched by Playwright with the Gecko Profiler enabled through documented
environment variables:

```
MOZ_PROFILER_STARTUP=1
MOZ_PROFILER_STARTUP_FEATURES=power
MOZ_PROFILER_STARTUP_INTERVAL=10
MOZ_PROFILER_STARTUP_ENTRIES=20000000
MOZ_PROFILER_SHUTDOWN=/path/to/profile.json
```

The profile is written when the browser exits. The harness records wall-clock
boundaries for each named step and integrates the power counters over those windows.

### Verified on this machine

```
features: ["screenshots","cpu","power"]
counter:  {"name":"Process Power","category":"power","description":"Power utilization"}
```

Playwright's bundled Firefox (153.0) supports the `power` feature. No elevated
privileges are required.

## Units

Counter `count` values are **picowatt-hours**:

```
joules = pWh × 1e-12 × 3600
```

matching the Firefox Profiler's own constants (`PWH_TO_WH = 1e-12`,
`MS_PER_HOUR = 1000 * 3600`).

## Multi-process aggregation

A Firefox session has several processes with power counters — the parent and one or more
content processes. **Page JavaScript runs in a content process**, so omitting them
attributes almost none of the page's work.

Each process reports sample times relative to its **own** `meta.startTime`, so windows
must be translated per process before summing.

Getting this wrong is not subtle. Summing only the parent process produced:

```
IDLE: 0.176 W
BUSY: 0.133 W     <- a CPU-burning page apparently using less power than idle
```

After aggregating all processes with per-process time origins:

```
IDLE: 0.012 W
BUSY: 0.850 W     <- ~70x separation, in the right direction
```

## Adapters

| Adapter | Scope | Privileges | Default |
|---|---|---|---|
| `firefox-profiler` | Firefox processes | none | yes |
| `macos-powermetrics` | whole system | sudo | opt-in |
| `noop` | none | none | fallback |

### firefox-profiler

The primary adapter. Per-process attribution, no privileges, and the scope that actually
answers "how much energy did the browser spend on this page".

### macos-powermetrics

Opt-in only. `sudo -n powermetrics` fails without a password, so making it the default
would break unattended runs. It measures **system** scope, which answers a different
question — useful as a cross-check, not as a substitute.

### noop

Records duration only. It emits no joules, no watts, and no derived energy of any kind.
Proxy metrics are never relabelled as energy.

## Baseline

Idle power is sampled inside the same browser session, after a settle period, so that
Firefox's startup work does not inflate the estimate.

```
baseline watts       = idle joules / idle seconds
expected idle energy = baseline watts × workload duration
incremental energy   = raw − expected idle
```

All three values are kept. Negative results are flagged, not clamped.

## Validation protocol

Run these four cases and confirm the collector separates them:

1. idle Firefox page
2. small static page
3. a normal website
4. a deliberately CPU-heavy local page

Expected: case 4 is clearly separated from cases 1–2. Measured on an Apple Silicon
machine, a 678-byte CPU-heavy page drew 3.88 J against 0.029 J for a 436-byte static
page — a 134× separation on comparable transfer sizes.

No expected values are hard-coded; the ordering relationship is what matters, and
platform differences are expected.

## When energy is unavailable

The tool reports timing, requests, bytes, and CO2.js, omits energy fields entirely, and
records a warning explaining why. It does not estimate energy from CPU time or bytes.
