# The investigation report

The HTML report of a crawl or multi-page measure now opens with **Investigate first**: a
queue of what to look at, why, where to find it on the page, what to change, and how to
check that the change helped. **Since the last scan** compares the scan with the previous
scan of the same site.

Nothing in either section is an energy figure. The queue is evidence for where to look.
Energy is only ever a measured difference between two runs of the same workload, and
each remedy names that comparison.

## The queue

The items are of four kinds:

- **components** from the [component inventory](component-inventory.md) that carry a
  structural fact or a Lighthouse finding;
- **regions** (`<main>`, the banner), but only for a Lighthouse finding or trace
  observation that landed on the region itself, since otherwise they repeat the facts of
  the components inside them;
- **scripts** that no component loads, summed across pages, such as a bundle or a third
  party that takes main-thread time everywhere;
- **pages** at least twice their [family's](page-families.md) median elements, transfer
  or requests: something extra is on them;
- **resources** from the [component graph](component-graph.md):
  - shared ones of 100 KB or more, or with a Lighthouse finding;
  - files of 1 MB or more that only one page loads;
  - any file, however small and on however few pages, that a [Chromium trace](tracing.md)
    shows doing work: a repeating timer, continuous animation frames, a long task or
    forced layout. A small script on one page that runs a timer 100 times a second is
    worth a look. A file that was only fetched after load is noted, but is not queued
    for that alone.

  Files from one directory, of one kind and scope, are one item, so the files of one icon
  library are one dependency. Remedies include replacing an icon library with the icons
  used, checking whether every page needs a script, subsetting fonts, splitting a shared
  stylesheet, and serving images at the size shown.

Components are judged on what they **own**. A container is queued only for a Lighthouse
finding or trace observation that landed on it directly. What a trace saw on a
component's elements, such as an animation still running while idle or an embedded frame
still working, joins that component's evidence, labelled as a Chromium trace.

### The order, stated

The order is a **sort on four keys, one after another**. No keys are added, weighted or
merged, and each one has its own column:

1. **evidence**: a structural fact with a Lighthouse finding or a Chromium trace
   observation, then either of those alone, then a structural fact alone. Lighthouse
   and trace evidence share a level, but each is named by its source
   (`structure-and-lighthouse`, `structure-and-trace`), and one is never reported as
   the other;
2. **reach**: the pages it is on;
3. **opportunity**: whether a known remedy applies;
4. **workload**: elements, or Chromium main-thread time for a script.

Workload is shown as separate indicators in their own units: elements and share of the
page, endless animations, Chromium main-thread milliseconds, and transfer. It is never
combined into a single number.

Evidence counts only Lighthouse **findings**, not context. The LCP element becomes a
caution instead: keep that image eager.

### Remedies

Each remedy has an action, a **rationale** (why that kind of thing tends to cost client
work), and a **check** (the measured comparison that would show its effect here). Remedies
are triggered by recorded facts, never by a score:

| Fact | Remedy |
| --- | --- |
| An animation that never stops | Stop endless animations; honour `prefers-reduced-motion` |
| Lighthouse: animation not composited | Animate transform and opacity |
| A video playing on load | Do not autoplay |
| An iframe | Load embeds on interaction (a facade) |
| Lighthouse: layout shift or unsized image | Reserve space |
| Lighthouse: image could be smaller | Serve images at the size shown |
| Images below the first screen without `loading="lazy"` | Lazy-load them, never the LCP image |
| Lighthouse: a script the component loads | Defer or split it |
| Lighthouse: forced reflow | Batch layout reads before writes |
| A large share of the page's elements, or a failing DOM-size audit | Render fewer elements |
| A script no component loads | Check whether every page needs it |
| A page far from its family | Find what it adds to its template |

The remedies touching motion cite WCAG 2.2.2 (Pause, Stop, Hide) and 2.3.3 (Animation from
Interactions). Less motion is often both more accessible and less work.

### Page maps

For the representative page of each of the largest families, at most four, the report
draws the page as an SVG wireframe from the positions recorded in Firefox. It is
20% of real size and shows at most the top 3,600 px. It marks the end of the first screen
and numbers a box for each queued component.

- **Decorative, with a text equivalent.** The SVG is `aria-hidden`. The numbered list
  under it gives each item's position and size as text, with a link to the item.
- **Forced colours and dark mode** use system colours and theme tokens. The map has no
  fills that hide the lines under them, and no animation.
- **No screenshots.** The map needs no image of the page. A screenshot per page would add
  hundreds of kilobytes to every scan in the repository, more work for the scan itself,
  and a risk of capturing private content on authenticated pages. The positions are
  enough to find the element; the selector beside each item finds it in DevTools.

## Since the last scan

When the output directory holds an earlier result of the same site and mode, the result
records `history`. The directory's `index.json` is used when there is one, so only one
file is read; otherwise at most 30 of the newest files are. History records:

- pages measured in both scans, by URL with the query kept (the seeded sample makes
  this the usual case), and pages measured in only one;
- medians over those pages of transfer, elements and requests, before and after;
- the pages that changed most, by 10% or more;
- page families, before and after;
- components new and gone, and new signals on existing ones. Lighthouse signals are
  compared only when both scans ran it;
- observed energy, only when both scans measured it, both resolved it and they ran on the
  same operating system. Otherwise it says why it is not comparable.

Each page is visited once per scan, so every difference is **indicative**. Content moves
these numbers as much as code does.

`--no-history` turns it off. `web-energy investigate <result.json> --previous <older.json>`
compares any two results.

## Where it appears

- **JSON:** `investigation` (method `queue-v1`) and `history`.
- **CSV:** `<result>.queue.csv`, one row per item. Each sort key, the workload indicators,
  remedies and their checks have their own columns.
- **HTML report:** _Investigate first_ (order, table, page maps, one disclosure per item)
  and _Since the last scan_.
- **Issue comment:** the first five items with their remedies, and a one-line history.
- **Published site:** the first five items and the history line for each scan.
- **CLI:** crawls print the queue. `web-energy investigate <result.json> [--json]
  [--write] [--previous <result.json>]` builds families, inventory, queue and history for
  any stored result.

## Limitations

- A remedy is a lead until a measured comparison shows its effect on this site.
- Without `--lighthouse`, only structural facts are available.
- Regions and their components can both appear; a region appears only with a finding of
  its own.
- History needs the earlier result in the same directory, or `--previous`.
