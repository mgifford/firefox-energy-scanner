# What costs energy on a page

## The honest limit first

**No tool can tell you that a specific element cost a specific number of joules.**

Firefox's power counter is whole-process. From
`tools/profiler/core/PowerCounters-mac-arm64.cpp`:

```cpp
task_info(mach_task_self(), TASK_POWER_INFO_V2, ...)
```

`mach_task_self()` is the process. There is no per-element, per-selector or
per-resource power counter anywhere in the platform.

The Gecko profile carries no DOM node references either. `Styles` markers carry an
`innerWindowID` (a frame) and a stack — not an element. Mozilla's own requests for this
are still open:

- [bug 789712](https://bugzilla.mozilla.org/show_bug.cgi?id=789712) — "Show what is triggering a reflow"
- [bug 713031](https://bugzilla.mozilla.org/show_bug.cgi?id=713031) — "Add CSS selector profiler"

So **XPath-level or per-template energy attribution is not available**, and anything
claiming otherwise is estimating without saying so.

## What is available

Two things, which together get close to the practical question.

### 1. Category attribution (`web-energy diagnose`)

The profile carries a category on every stack frame and, with the `cpu` feature, CPU
time per sample. Summing CPU time per category and apportioning the measured energy:

```
Where the browser spent CPU time
  category          CPU ms     share   apportioned
  Other                 43     48.2%       43.9 mJ
  Layout                17     19.3%       17.6 mJ
  DOM                   10     10.8%        9.9 mJ
  Graphics               9     10.4%        9.5 mJ
  Network                9     10.0%        9.1 mJ
  JavaScript             1      1.2%        1.1 mJ
```

**This is apportionment, not measurement.** It assumes a millisecond of CPU costs about
the same in each category. The known weakness: GPU work (compositing, animation) draws
power without proportionate CPU time, so `Graphics` is under-attributed. Every field is
labelled, and the assumption is printed with the table.

`Other` is usually large. It is browser internals plus frames whose category could not
be resolved — not a category you can act on directly.

### 2. Page composition

Read from inside the page: DOM size and depth, heaviest subtrees, CSS rule and selector
counts, expensive selector patterns, script counts, oversized images, animated elements,
and the LCP element (the one element-level signal Firefox does expose).

```
Page composition
  DOM nodes        114 (max depth 16)
  CSS              255 rules, 301 selectors, 6 sheets
  Animated         12 elements
  LCP element      div at 141 ms

  Heaviest subtrees
    div.dialog-off-canvas-main-canvas        86 nodes
    div#page-wrapper                         85 nodes
```

These are the *inputs* to browser work. They do not carry joules, but they are what you
change to reduce it.

## Where to look first, in order

Ranked by how often they dominate, and how much control you have.

1. **JavaScript execution** — usually the largest single category on app-like pages.
   Look for libraries attached globally that only some pages need, work repeated on
   every page load, and third-party scripts.
2. **DOM size** — every node is re-examined on style recalculation and layout. Long
   unpaginated lists and deep wrapper chains are the usual causes.
3. **CSS selector surface** — the style system may match thousands of selectors against
   every element. Route-split CSS helps more than micro-optimising individual rules.
4. **Images** — decode happens at natural size regardless of CSS scaling, so an image
   served 20x larger than displayed wastes CPU and memory as well as bytes.
5. **Animations and transitions** — these keep the refresh driver and compositor awake,
   drawing power continuously even when nobody is interacting.
6. **Iframes** — each is a separate document with its own style, layout and script work.

## For Drupal specifically

Template-level attribution is not exposed to the browser: by the time Firefox sees the
page, Twig has already rendered to HTML and the template boundary is gone.

Two practical ways to recover it:

- **Enable Twig debug** (`twig.config.debug: true` in `services.yml`). Drupal then emits
  HTML comments naming the template for each region:
  `<!-- BEGIN OUTPUT from 'core/themes/olivero/templates/node.html.twig' -->`.
  Those comments sit in the DOM, so the heaviest-subtree output can be read against
  them to see which template produced the heavy markup. Do this on a development
  environment — never in production, and note that debug mode itself changes
  performance, so do not benchmark with it on.
- **Correlate structure with libraries.** `#attached['library']` determines which JS and
  CSS a page loads. If `diagnose` shows a large script count or CSS surface, the
  question is which libraries are attached and whether they are needed on that route.

The heaviest-subtree selectors are usually recognisable to a Drupal developer without
any of this — `div.dialog-off-canvas-main-canvas`, `div#page-wrapper`, `div.region` and
similar map directly onto theme templates.

## Running this locally versus on a hosted runner

`diagnose` needs energy measurement for its CPU-attribution table, so the full command
is local-only. But `measure` and `crawl` now collect page structure and findings on
**every** host, because none of that depends on power hardware.

| | hosted runner | local Mac |
|---|---|---|
| DOM size, depth, heaviest subtrees | yes | yes |
| CSS selector surface, expensive selectors | yes | yes |
| oversized images, missing dimensions | yes | yes |
| script and iframe counts, animations | yes | yes |
| LCP element | yes | yes |
| **energy split by work category** | no | yes |
| **apportioned millijoules per category** | no | yes |

So the workflow that makes sense is: **scan broadly on hosted runners** to find
structurally heavy pages, then **run `diagnose` locally** on the handful worth
understanding in depth.

## What to do with a result

`diagnose` prints ranked findings with an action for each:

```
  [MEDIUM] 12 elements with animations or transitions   (Graphics)
    12 elements have a non-zero animation or transition.
    -> Running animations keep the refresh driver and compositor awake, drawing power
       even when nothing is interacting. Prefer transform/opacity, and honour
       prefers-reduced-motion.
```

Thresholds are heuristics. They flag things worth looking at; they do not prove a
defect, and the evidence is always printed so the judgement is yours.

To confirm a change actually helped, use `measure` or `compare` — `diagnose` runs with
stack sampling enabled, which changes the workload and must not be mixed with benchmark
numbers.
