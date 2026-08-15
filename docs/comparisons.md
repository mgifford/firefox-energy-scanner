# Comparing patches

## Why patch-vs-patch is not valid

The intuitive move — measure patch A, measure patch B, compare — is confounded.

Two Drupal merge requests sit on different branches and touch different code.
Measuring one against the other captures **everything that differs between the two
branches**, not the effect of either patch. If patch A's branch happens to be rebased on
a newer core with an unrelated asset change, that difference lands in your result and
gets attributed to patch A.

The comparison is only meaningful when the two sides differ by *one* thing.

## The shared-baseline design

Measure a common reference (core-head), then each patch against that same reference:

```
                core-head  (baseline)
                 /    |    \
                /     |     \
          patch-1  patch-2  patch-3
```

Each patch's number is its **difference from the shared baseline**. Those differences
are comparable to each other, because they are all measured against the same reference
in the same session under the same conditions.

This is what `web-energy matrix` implements.

## Usage

Describe the targets in a YAML file:

```yaml
targets:
  - label: core-head
    url: https://core-head-preview.tugboatqa.com
    baseline: true

  - label: js-show-hide
    url: https://mr16698-preview.tugboatqa.com
    issue: "3568172"
    mr: "16698"

  - label: lazy-sizes-auto
    url: https://mr15627-preview.tugboatqa.com
    issue: "3587098"
    mr: "15627"
```

Screen the candidates first — this takes seconds:

```bash
web-energy matrix examples/drupal-performance-matrix.yaml --triage-only
```

```
Matrix: 5 targets, baseline = core-head

Triage (delivered payload vs baseline)
    core-head                200  baseline
  * js-show-hide             200  styles 1+/0-, html +412B
  * lazy-sizes-auto          200  html +1204B
  - pgsql-savepoints         200  identical payload
  - pgsql-table-info         200  identical payload

  * differs from baseline (measure)   - identical payload (skip)   ? inconclusive
```

Targets whose delivered payload matches the baseline are skipped: the browser receives
and executes identical work, so client-side energy cannot differ. Then measure what
remains:

```bash
web-energy matrix examples/drupal-performance-matrix.yaml \
  --journey examples/drupal-admin-basic.js --runs 15
```

## Ordering

Runs are interleaved across all targets, with **every target appearing exactly once per
round** and shuffled within the round from a stored seed:

```
core-head js-show-hide lazy-sizes-auto
lazy-sizes-auto core-head js-show-hide
js-show-hide lazy-sizes-auto core-head
...
```

Grouping runs by target would confound drift in thermal state, network latency, or
server cache with the target itself. Per-round balancing spreads every target evenly
across the session, so a machine that warms up over twenty minutes affects all targets
equally. The seed is recorded so an ordering can be reproduced exactly.

## Reading the output

```
step                       core-head    js-show-hide  lazy-sizes-auto
---------------------------------------------------------------------
admin                          0.030    0.028 (-7%)     0.031 (+3%)
admin-content                  0.031    0.029 (-6%)     0.034 (+10%)
content-filter                 0.046    0.041 (-11%)    0.046 (+0%)
```

Baseline columns show absolute median mWh. Other columns show their median and the
percentage difference from the baseline.

## Interpreting responsibly

- **Median is the headline.** Means are reported too, but a single slow run can move a
  mean substantially.
- **Fewer than 10 runs per target is indicative only.** The tool says so explicitly and
  claims no significance.
- **A percentage on a tiny absolute value is misleading.** A change from 0.001 to 0.002
  mWh is +100% and almost certainly noise. Check the absolute numbers and the IQR.
- **Server-side patches should show no client difference.** If one appears to, suspect
  the measurement before believing the result — check power source, Low Power Mode,
  thermal state, and whether server cache state differed.
- **Third-party requests add noise** unrelated to the patch. The Drupal previews tested
  so far had zero, which is ideal.

## What a null result means

If a patch shows no client-energy difference, that is a finding, not a failure. It means
the change is server-side, or its client effect is smaller than the measurement noise on
this hardware. Both are useful things to be able to state with evidence.
