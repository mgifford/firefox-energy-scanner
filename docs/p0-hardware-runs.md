# P0 hardware runs, 18 November 2026

Real Apple M2 / Firefox 153 runs on the fixture site and one published Vital
Core candidate. These are **one session** each; none is independently
replicated. The result files are local scratch output under `results/` and are
not committed; their hashes let a reviewer identify them.

## 1. Post-load removal — Low Power Mode on, on battery

Command:

```bash
node dist/cli/index.js experiment http://127.0.0.1:8086/articles/d \
  --kind remove --selector '[data-component-id="live-chart"]' \
  --idle 10000 --runs 10 --warmups 2 --assert-role main --seed m2-chart
```

Environment: `lowPowerMode: true`, `onBattery: true`, headed Firefox 153.
The CLI warned that LPM and battery make these runs incomparable with clean
runs.

| Step | Result |
| --- | --- |
| Applied | yes: 1 subtree removed in every measured variant run; none re-inserted |
| Checks | baseline passed; variant passed |
| Script work | animation-frame callbacks 60.0/s with and 60.0/s without the component |
| Load (negative control) | 0.081 → 0.080 mWh (IQR 0.006 / 0.004), −0.001, within spread |
| Idle (attributable) | 0.091 → 0.065 mWh (IQR 0.055 / 0.015), −0.025, within spread |
| Baseline | median-of-bins 0.933 / 0.932 mW; the window mean was 101.6 / 102.6 mW |
| Finding | no difference shown, confidence none |

**What this shows:** the median-baseline change works on real hardware. The
baseline is now under 1 mW, not the ~100 mW mean, so incremental energy is
readable. The idle point estimate is −0.025 mWh (−27%), but the baseline side's
IQR is larger than the difference and only 9 of 10 runs on each side produced
usable energy. Under the registered rule this is **no difference shown**, not
proof of no effect.

**Caveat:** LPM and battery invalidate comparison with clean runs. This result
should not be used as the final P0 energy evidence. Re-run with Low Power Mode
off and the Mac on power.

Result: `compare-2026-11-18T14-11-31-202Z.json`, SHA-256
`64ee1a8c9a34c64ea964c22e47c0134ca8c59dd3497119cfb3192e45bb4e5dbb`.

## 2. Pre-load removal — run failed, no result

Command:

```bash
node dist/cli/index.js experiment http://127.0.0.1:8086/articles/d \
  --kind remove-before-load --selector '[data-component-id="live-chart"]' \
  --idle 10000 --runs 10 --warmups 2 --assert-role main --seed m2-chart-pre
```

The run stopped at Run 3/20: Playwright Firefox timed out after 180 s while
launching (`browserType.launch`), with only a Firefox JavaScript warning in the
log. No result was written. This is an infrastructure/browser-launch failure,
not a measured null result.

Retry after closing Firefox, with Low Power Mode off and the Mac on power.

## 3. Real Firefox same-run stack edge — confirmed

Command:

```bash
node dist/cli/index.js diagnose http://127.0.0.1:8086/articles/d \
  --idle 10000 --out results
```

Environment: LPM false, on battery false, headed Firefox 153 (clean).

The idle interval (11.49 s, 137.4 mJ measured) names:

```text
script http://127.0.0.1:8086/js/chart.js
  (observed with component:live-chart; medium confidence, supported, not ownership)
```

The graph carries exactly one script relation:
`script-observed-with-component` from `/js/chart.js` to the `live-chart`
instance, `profiler-correlation`, medium confidence, `supported`. The script
was on the stack in 21 samples during the idle interval.

The interval's component list also includes `landmark:main` (the container that
declares the `<script>`) and cards whose network requests occurred during the
wider load/stabilizing intervals. Those are leads from declaration/network
evidence, not ownership of `chart.js`; the script relation is the chart one.

This closes the Phase 1 “pending Firefox” gap. It is a diagnostic profile, not
a benchmark or a per-element energy figure.

Result: `diagnose-2026-11-18T16-07-13-035Z.json`, SHA-256
`583fc43006d359a8d8a1da120213de369f9a5be7f483f09070b855f5148d7f82`.

## 4. Real Vital Core candidate — clean, null result

Command:

```bash
node dist/cli/index.js experiment --spec examples/experiments/vital-cms-driver-js-block.yaml
```

Environment: LPM false, on battery false, headed Firefox 153 (clean).

| Step | Result |
| --- | --- |
| Applied | yes: 48 requests refused across all runs |
| Checks | baseline passed; variant passed |
| Load | 0.542 → 0.531 mWh (IQR 0.026 / 0.009), −0.012, within spread |
| Idle | 0.070 → 0.073 mWh (IQR 0.018 / 0.030), +0.004, within spread |
| Baseline | median-of-bins 1.08 / 1.03 mW; mean 103.2 / 104.5 mW |
| Finding | no difference shown, confidence none |

Blocking `jsdelivr.net` on the CMS MCD search page applied, but the measured
load and idle energy differences are within the run-to-run spread. This is a
null result for this page/workload, not proof of no effect. The host block can
remove the driver.js tour; the only assertion is `role=main`, so review the
page behaviour before treating the block as production-like.

Result: `compare-2026-11-18T17-10-49-006Z.json`, SHA-256
`9c68c0a3d2dae5284566be07a285bd9a33fa455b4cb3f1672fe21c827fef7662`.

## What remains

- Re-run the post-load experiment with LPM off and on power.
- Retry the pre-load experiment; the failure was a browser-launch timeout.
- Run a null/A-A and an independent replication before calling any difference
  replicated. All results here are one session and `not-replicated`.
- No per-element or per-script energy is claimed.
