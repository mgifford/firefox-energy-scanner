# Public-site pilot: thegreenwebfoundation.org, 18 November 2026

One bounded structural pilot of **https://www.thegreenwebfoundation.org/**,
run on the P1 pilot runner at `2a40b94`. It is discovery evidence, not a
benchmark and not an energy measurement.

## What ran

| Field | Value |
| --- | --- |
| Seed | `https://www.thegreenwebfoundation.org/` |
| Pages measured | 20 |
| Families | 4 |
| Browser | Chromium 157 structural seam (`WEB_ENERGY_TEST_ENGINE=chromium`) |
| Energy | `not-measured` (`--no-energy`) |
| Lighthouse | **failed on all 10 URLs**: `Connection closed.` |
| Traces | 3 pages: home, `/news/`, `/publications/` |
| Clicks/forms/auth | none |
| Result | `results/pilot-tgwf-full/crawl-2026-11-18T18-13-18-110Z.json` (SHA-256 `d7f76d5b9b83cddb5a386ca79e61485c756febf403244edf7fd7027dfc615346`) |
| Manifest | `results/pilot-tgwf-full/pilot.json` (SHA-256 `a75e58142b9c47f43f12bf2bc8df0a384e2d7d8b25bcbd3393eff75b7372eab1`) |

The Lighthouse failure is a source limitation, not a zero score. No Lighthouse
finding is used in this note or the queue.

## Families

| Family | Pages | Representative |
| --- | --- | --- |
| `/news/:id and 13 other URL patterns` | 17 | `/contact/` |
| `/services` | 1 | `/services/` |
| `/publications` | 1 | `/publications/` |
| `/` | 1 | `/` |

The dominant family is broad: 17 pages and 13 URL patterns. It is usable for a
median and outliers, but it likely hides template differences between, for
example, `/about/`, `/news/`, `/newsletter/` and `/privacy-statement/`. Do not
treat its median as one template's cost. It has four outliers, including the
two large news transfers below.

## Recurring findings

Nine patterns over 20 pages:

| # | Pattern | Target | Pages | Evidence |
| --- | --- | --- | --- | --- |
| 1 | eager off-screen images | component type `class:nv-content-wrap` | 3 | direct observation |
| 2 | iframe | component type `class:wp-block-columns` | 1 | direct observation |
| 3 | repeating timer | resource `smush-lazy-load.min.js?ver=4.3.7` | 3 traced, 20 loaded | trace-supported |
| 4 | forced layout | the same smush resource | 2 | trace-supported |
| 5 | running animation while idle | component type `class:posts-wrapper` on `/news/` | 1 | trace-supported |
| 6 | long task | resource `/` (home document) | 1 | trace-supported |
| 7 | long task | the same smush resource | 1 | trace-supported |
| 8 | long task | unattributed (no script URL; parse/style/layout/browser work) | 1 | trace-supported |
| 9 | large own DOM | component type `class:nv-content-wrap` on `/privacy-statement/` | 1 | structural heuristic |

### What grouped correctly

- The shared `smush-lazy-load.min.js` is **one resource pattern** on 20 pages,
  not 20 copies. It is loaded site-wide and **no component loads it**; the
  pattern keeps that absence visible.
- The two `nv-content-wrap` findings are separate by mechanism (eager images
  vs large DOM), even though they share a component type.
- The `posts-wrapper` animation is a component-type finding, not a page
  finding; the component exists on 5 pages, but the trace observed the
  animation on one (`/news/`). Reach and observed-on pages are not conflated.
- The unattributed long task stays separate; it is not assigned to a script
  that happened to be on the stack.

### What not to conclude

- The 17-page family is not one template; its medians and outliers need a
  human review of the pages.
- A trace finding says what Chromium saw in a 5 s idle window on 3 pages. It
  does not say the animation uses energy, or that every page has it.
- `nv-content-wrap` is a container with 51 own elements and 18 pages of reach;
  eager images below the fold are a lazy-loading opportunity, not a component
  energy result.
- The smush script is 0 KB median transfer in the report but has trace work;
  bytes are not work.

## Queue

| Rank | Lead | Evidence | Next |
| --- | --- | --- | --- |
| 1 | smush lazy-load script, 20/20 pages | structure + trace: timer 2.4/s idle, long task | test whether every page needs it |
| 2 | home document, 26 KB unique | structure + trace: long task | diagnose the home page |
| 3 | `class:posts-wrapper`, 5 pages | trace: animation while idle | pause animation on `/news/` |
| 4 | `class:nv-content-wrap`, 18 pages | structure: 3 eager images | lazy-load below-fold images |
| 5 | `class:wp-block-columns`, 8 pages | structure: 2 iframes | facade embeds |
| 6 | `class:article-content-col`, 1 page | structure: 201 elements, 26% | render fewer elements |
| 7–10 | news pages with 5.4×–9.2× family transfer | structure | inspect what the pages add |

## Selected diagnostic and experiment

The representative page is **`/news/`**: it has the posts-wrapper animation and
loads the smush script.

Firefox `diagnose` on the quiet Mac:

```bash
node dist/cli/index.js diagnose https://www.thegreenwebfoundation.org/news/ \
  --idle 10000 --out results
```

The strongest repeated lead is the shared smush script, but it is a **resource**
with no component loader, not a component. The component-level lead is the
`posts-wrapper` animation, a low-confidence class-heuristic container.

Primary controlled experiment (resource, upper bound; block the script URL on
`/news/`):

```bash
node dist/cli/index.js experiment https://www.thegreenwebfoundation.org/news/ \
  --kind block \
  --block-url 'https://www.thegreenwebfoundation.org/wp-content/plugins/wp-smushit/app/assets/js/smush-lazy-load.min.js?ver=4.3.7' \
  --idle 10000 --runs 10 --warmups 2 --assert-role main \
  --seed tgwf-smush
```

Component alternative (CSS animation pause; the limit is that script-driven
requestAnimationFrame/timers keep running):

```bash
node dist/cli/index.js experiment https://www.thegreenwebfoundation.org/news/ \
  --kind pause-animations --selector 'div.posts-wrapper' \
  --idle 10000 --runs 10 --warmups 2 --assert-role main \
  --seed tgwf-posts
```

Run on power with Low Power Mode off, one at a time, Mac quiet. The block can
remove lazy-loading behaviour; the pause can leave script animation running.
Neither is a production recommendation, and neither is energy evidence until
the run completes.

## Limits

- Structural Chromium only; no Firefox energy, no per-element energy.
- Lighthouse failed for every selected URL; no Lighthouse finding is used.
- Three Chromium traces, 5 s idle each; the rest is structure.
- One sample, 20 pages; no whole-site prevalence.
- The dominant family is broad (13 URL patterns).
- The component type is a class heuristic with low confidence; the resource is
  site-wide with no component loader.
- Optional evaluation tools (GreenFrame, Sitespeed/CO2.js, agent-browser) were
  **not** used in this run; their evidence would be separate.
