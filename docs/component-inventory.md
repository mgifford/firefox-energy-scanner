# Component inventory and performance evidence

A scan now records which components its pages are built from, which of them recur across
the site, what each one holds, and the Lighthouse findings that fall inside it. The
inventory is for finding **where to look**, and gives a developer something specific to
investigate or fix.

**No figure in the inventory is a component's energy.** Firefox's power counters cover
whole processes, and its profile carries no DOM references (Mozilla bugs 789712 and
713031), so no tool measures an element's energy. Whether changing a component saves
energy is answered by a measured comparison: the same journey with and without the
change, through `compare`.

## What is recorded per page

The anatomy walk that already runs after the measured window records up to 24
**component occurrences** per page. These are the largest, at most three of any one
signature, plus smaller ones that hold media or animations. Each occurrence records:

| Field | What it holds |
| --- | --- |
| `signature`, `method` | As in [page-families.md](page-families.md): annotation, framework, Drupal class, landmark or class-name guess. |
| `selector` | A CSS selector that matched only this element when it was recorded. |
| `nodePath` | The DevTools node path (`1,HTML,1,BODY,1,MAIN,0,DIV`), the format Lighthouse uses, so its findings can be matched. |
| `ancestry` | Signatures of the components it sits in, outermost first. |
| `role`, `name` | The ARIA role, explicit or implied, and the accessible name (or, for sectioning content, its first heading). |
| `nodes`, `depth` | Elements inside it and how deeply they nest. |
| `rect`, `belowFold` | Position and size in document coordinates, and whether it starts below the first screenful. |
| `media` | Images; images below the first screen without `loading="lazy"`; videos, and those playing on load; iframes; canvases. |
| `resources` | Up to six images, videos, iframes and external scripts it loads. |
| `animations` | Web Animations API: animations running inside it, those that never stop, and their names. |
| `liveRegion` | Whether it is, or holds, an ARIA live region. |

## What the inventory adds

`result.components` (method `inventory-v1`) groups occurrences by signature across pages.
Each record has:

- a stable `cmp-…` id (a hash of the signature);
- the pages, families and reach;
- occurrence count, median and maximum elements, and share of the page;
- roles and names;
- the most media and animations found on any one page;
- resources, with transfer where the scan recorded it, and third-party hosts;
- up to three example occurrences;
- Lighthouse evidence;
- plain-language **signals**;
- limitations.

Signals are facts, not a score. For example:

- "On 19 of 20 pages, in 2 page families."
- "Its 60 occurrences on a page hold 79% of the page’s elements."
- "1 animation that never stops (pulse)."
- "59 images below the first screen without loading="lazy"."
- "Lighthouse (Chromium): animation not composited: Unsupported CSS Property: width, on 1 page."

Identification confidence is **high** for annotations, framework roots and Drupal
classes, **medium** for landmarks and **low** for a class-name guess.

## Lighthouse evidence: the Chromium trace

Lighthouse already derives element and script findings from a Chromium trace. They are
kept from the median run, at most 40 element findings and 20 script findings per URL,
instead of being computed again by a second trace pipeline:

| Evidence | Lighthouse audit |
| --- | --- |
| Layout shifts and their elements | `cls-culprits-insight`, `layout-shifts` |
| Animations the compositor cannot run | `non-composited-animations` |
| The LCP element | `lcp-breakdown-insight`, `lcp-discovery-insight` |
| Largest and deepest DOM nodes | `dom-size-insight` |
| Oversized and unsized images | `image-delivery-insight`, `unsized-images` |
| Script CPU time per URL | `bootup-time` |
| Long tasks per URL | `long-tasks` |
| Forced synchronous layouts, by source location | `forced-reflow-insight` |
| Third-party main-thread time | `third-parties-insight` |

Each piece of evidence is either a **finding** or **context**:

- A finding is something Lighthouse reports as a problem: a non-composited animation, a
  layout shift, an unsized or oversized image, a long task, a forced reflow, or a script or
  DOM-size audit that fails.
- Context is what it reports either way: the LCP element, or the deepest node of a page
  whose DOM-size audit passes.

Only findings count as evidence of a problem. The LCP element becomes a caution: keep that
image eager.

How evidence is tied to a component:

- **node-path**: the element's path starts with the occurrence's path. The deepest
  occurrence wins, so a finding goes to the carousel, not to `<main>` around it.
- **tag-path**: element names match but positions differ, as when a script inserts a
  banner in one browser. This is weaker and is used only when exactly one occurrence
  fits.
- **script-in-component**: the script, or the iframe on the script's host, is loaded by
  an element inside the component.

Anything else is kept as **unattributed**, with the reason: Chromium could not name the
script; the work is in the page's own inline scripts and parsing; or no recorded
component loads the script, as with bundled and global scripts. Nothing is assigned by
guessing.

Style recalculation and paint are page-level in Lighthouse (`mainthread-work-breakdown`)
and stay page-level here. Firefox CPU categories are page-level as well: run
`web-energy diagnose <url>` on a representative page.

Lighthouse runs in Chromium under throttling, a different browser and boundary from the
Firefox measurement. Its milliseconds are Chromium main-thread time. They are never
added to, compared as or converted into Firefox energy.

## Twig templates (development only)

`diagnose` against a development Drupal site with Twig debug on now names the template
that renders each of the largest components. It matches the first element each
template's output produced to the component's node path; when an outer template adds no
wrapper, the innermost template wins. Twig debug changes the markup and the server's
work, so it is never on while benchmarking, and crawls do not use it.

## Where it appears

- **JSON:** `components`, and `anatomy.structure.instances` per page.
- **CSV:** `<result>.components.csv`, one row per component. It is a separate file from
  the per-run CSV because its rows are not measurements. Cells that a spreadsheet would
  read as formulas are neutralised.
- **HTML report:** a _Components_ section. It has a table of components that recur or
  carry a signal, one disclosure per component with its evidence and where to find it,
  and the unattributed findings with reasons.
- **Issue comment:** a folded _Components worth a look_ list.
- **CLI:**
  - `web-energy components <result.json> [--json] [--write]`;
  - `crawl` and `measure` print the components worth a look;
  - `diagnose` prints the largest components, with Twig templates when available.

Add `--lighthouse` to a crawl for the evidence. Without it the inventory is structure
only, and says so.

## Cost

The occurrences come from the same DOM walk, once per page, after the measured window.
The inventory is computed from stored results. Lighthouse evidence comes from the
Lighthouse run already requested (by default the 10 heaviest pages of a crawl), so
nothing is profiled that was not already. Each page's result grows by about 4–10 KB.

## Limitations

- Stylesheets, web fonts and CSS background images are not tied to components.
- Chromium's DOM can differ from Firefox's (scripts, user-agent differences). The match
  method is recorded, and unmatched findings are listed.
- At most 24 occurrences are recorded per page. Counts and sizes still cover every
  occurrence, but a small component that is not among them has no position, media or
  evidence.
- The class-name fallback can join unrelated markup that shares a class, or split one
  component. It is marked low confidence.
