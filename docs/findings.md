# Findings

Empirical results from this toolkit. Every number here was measured, not modelled.

**Measurement conditions for all runs below:** macOS 26.5, Apple Silicon, on
**battery** with **Low Power Mode ON**. Low Power Mode throttles CPU frequency and
therefore *suppresses* absolute energy values. These figures are internally
consistent and comparable to each other, but should not be compared against runs made
on AC power or with Low Power Mode off.

---

## 1. Bytes are not a proxy for client energy (synthetic)

Two local pages of near-identical size:

| Page | Transfer | CO2.js | Measured energy |
|---|---|---|---|
| static text | 436 B | 0.065 mg | 0.029 J |
| same size, busy JS | 678 B | 0.100 mg | **3.88 J** |

CO2.js rates them within 1.5x of each other. Measured client energy differs by ~134x.

## 2. The two metrics can rank pages in opposite order (crawl)

From a crawl of three local pages:

| Page | Transfer | CO2.js | Measured energy |
|---|---|---|---|
| directory index | 65 KB | **9.889 mg (worst)** | 0.001 mWh (best) |
| heavy.html | 1 KB | 0.107 mg (best) | **0.998 mWh (worst)** |

The modelled metric and the measured metric produce **inverted rankings**. Neither is
wrong; they measure different things over different boundaries.

## 3. Real Drupal 12 admin pages (Tugboat preview)

Authenticated `drupal-admin-basic` journey, 8 measured runs + 2 warmups per step,
against a live Tugboat preview of a Drupal core merge request. Zero third-party
requests, so this is Drupal core behaviour without external noise.

| Step | Bytes | Reqs | TTFB | Energy (mWh) |
|---|---|---|---|---|
| admin | 452 KB | 18 | 169 ms | 0.030 |
| admin-content | 440 KB | 16 | 171 ms | 0.031 |
| **content-filter** | **425 KB (near-lowest)** | 11 | 157 ms | **0.046 (highest)** |
| admin-people | 487 KB (highest) | 19 | 182 ms | 0.043 |
| admin-structure | 432 KB | 14 | 150 ms | **0.028 (lowest)** |
| admin-config | 420 KB (lowest) | 10 | 268 ms | 0.031 |

Quality indicators: 0 of 48 runs produced negative incremental energy; ~700 power
samples per step.

**Key observation.** `content-filter` transfers among the fewest bytes and has the
lowest modelled CO2e, yet costs the *most* client energy — roughly 64% more than
`admin-structure`, which is larger. It is an interaction (fill a field, submit, re-render)
rather than a plain page load, so the browser performs script and layout work that
byte counts do not capture.

### Correlation with observed incremental energy (n = 48)

Spearman's rank coefficient:

| Variable | ρ |
|---|---|
| step duration | 0.366 |
| transferred bytes | 0.309 |
| CO2.js estimate | 0.309 |
| request count | 0.230 |
| DOMContentLoaded | −0.052 |

Transferred bytes (and therefore CO2.js, which is derived from them) explain only about
10% of the rank variance in measured client energy on these pages. This is the empirical
basis for the project's rule that the two indicator classes are reported separately and
never substituted for one another.

## 4. The client boundary correctly excludes server-side work

The anonymous front page of the same preview (which redirects to `/user/login`)
measured 0.078 J raw against a 0.103 J idle estimate — 9 of 10 runs came in *below*
baseline. The page is light, has no third-party resources, and finishes rendering in
278 ms, after which the browser is idle.

Two Drupal core issues were considered as test subjects and both turned out to be
server-side:

- **3587565** — entity static cache for non-existent entities (PHP/cache).
- **3615690** — removal of unnecessary PostgreSQL savepoints (database driver).
  Reported 2.25x–2.41x faster base queries and a menu rebuild dropping 192 ms → 104 ms.

Both would be expected to move TTFB while leaving client energy essentially unchanged,
because the browser receives the same markup and performs the same work. That is the
measurement boundary behaving as documented, not a limitation of the tool.

Of 18 open Drupal core issues tagged *Performance* surveyed on 2026-08-15, only 2 were
frontend-oriented (#3568172, moving `.js-show`/`.js-hide` styles to a conditionally
loaded library; #3587098, `sizes="auto"` for lazy-loaded images). Client-side energy
regression testing is most applicable to that minority.

## 5. Lightweight static sites fall below the resolution of this setup

Six GitHub Pages sites (mgifford.github.io and open-scans), 8 measured runs each,
on battery with Low Power Mode ON:

| Page | Transfer | CO2.js | Energy | Resolved |
|---|---|---|---|---|
| `/` | 79 KB | 12.009 mg | 0.062 mWh | yes |
| `/open-scans/` | 18 KB | 2.669 mg | −0.009 mWh | **NO** |
| `/open-scans/reports.html` | 35 KB | 5.308 mg | 0.004 mWh | **NO** |
| `/open-scans/trends.html` | 6 KB | 0.975 mg | −0.007 mWh | **NO** |
| `/alt-text-scan/` | 11 KB | 1.656 mg | −0.009 mWh | **NO** |
| `/top-task-finder/` | 27 KB | 4.072 mg | −0.006 mWh | **NO** |

Five of six measured *below* the idle baseline, and 28 of 48 runs were negative.
These are static pages: they load, paint, and the browser goes idle. There is very
little client-side work to detect, and what exists sits under the noise floor —
especially with Low Power Mode throttling the CPU.

**This is a negative result and is reported as one.** Only the root page produced a
resolvable measurement. The other five must not be ranked against each other; the
differences between them are indistinguishable from run-to-run scatter.

This prompted a `resolution()` check, now shown as a "Resolved" column. A scenario is
unresolved when either:

- the median incremental energy is at or below zero (the workload did not measurably
  exceed idle), or
- `|median| < IQR` (the effect is smaller than its own run-to-run spread).

### Where this tool does and does not work

| Workload | Resolvable? |
|---|---|
| CPU-heavy pages (busy JS, heavy render) | yes, easily — 134x separation observed |
| Authenticated app UIs (Drupal admin) | yes — 0/48 negative runs, clear per-step differences |
| Interactions (filter, submit, re-render) | yes — the highest-energy step measured |
| Lightweight static pages | **no** — below the noise floor |

The tool is built for application interfaces and interactions, not for ranking small
static pages. For those, transferred bytes and request counts remain the useful
metrics, and CO2.js models them directly.

### A note on transferred bytes

An apparent discrepancy during this run turned out to be correct behaviour.
`reports.html` is 470,169 bytes uncompressed but measured 35,815 bytes. The server
sends it gzipped at 35,040 bytes, so the measurement reflects **actual bytes over the
wire** plus response headers. That is the correct input for CO2.js. A naive `curl`
without `Accept-Encoding: gzip` overstates transfer by 13x here.

## 6. Defects caught by the validation protocol

Recorded because they demonstrate the value of validating rather than assuming.

1. **Missing content-process power.** Summing only the parent process made a
   CPU-burning page appear to use *less* power than idle (0.133 W vs 0.176 W).
   Page JavaScript runs in a content process, and each process reports sample times
   against its own origin. After the fix: 0.850 W busy vs 0.012 W idle.

2. **Unsettled baseline.** Sampling idle power immediately after browser start
   captured Firefox's startup work, inflating the baseline from 0.045 W to 0.114 W and
   producing spurious negative incremental energy on light pages.

3. **Logout-link detection.** Drupal logout links carry a CSRF token
   (`/user/logout?token=…`), so a suffix-anchored selector never matched and login
   detection wrongly reported failure against a real Drupal 12 site.

4. **Same-URL comparison.** A journey navigating to absolute paths resolves against the
   target origin, so pointing `--a`/`--b` at two paths on one host silently measured the
   same page twice. Now detected and reported as a warning.
