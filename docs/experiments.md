# Energy experiments

An experiment answers the question the rest of the tool cannot: **does this change reduce
client energy on this page?** It measures the page as served (the baseline) against the
page with one change (the variant), with the same workload, interleaved, through the same
benchmark runner as `compare`.

The result is the only place a component's effect on energy appears, and it is reported
for what it is: a **measured difference between two scenarios**, in mWh. Each side's
median and spread are shown, with whether each side resolved and whether there were
enough runs. Nothing is converted from CPU time, bytes or Lighthouse scores.

## Running one

From the investigation queue:

```bash
# Write the spec for item 1 and read it before measuring anything
node dist/cli/index.js experiment --from results/crawl-….json --item 1 --save-spec experiments/carousel.yaml --dry-run
node dist/cli/index.js experiment --spec experiments/carousel.yaml
```

Or directly:

```bash
node dist/cli/index.js experiment https://example.org/ --kind pause-animations --selector "div.hero-carousel" --idle 10000 --runs 10 --warmups 2
```

The spec file (see `examples/experiments/carousel-animation.yaml`) is meant to be
committed: it is the versioned record of what was compared. It holds:

- the page, the kind and its scope;
- the idle window, or a journey file;
- the checks that must hold on both sides;
- runs, warm-ups and, optionally, the seed.

The command exits 0 when the change applied, and 2 when it did not, so a script can tell
an experiment that measured nothing from one that measured no difference.

## Kinds of change

Each change is made in the browser, as a stand-in for the fix:

| Kind | The change | Stands in for |
| --- | --- | --- |
| `pause-animations` | CSS animations and transitions paused in a selector (or the page) | stopping an endless animation, pausing it off screen |
| `reduced-motion` | `prefers-reduced-motion: reduce` | honouring the preference; shows whether the page responds to it |
| `lazy-images` | `loading="lazy"` on images without one, after the first N (default 2) | lazy-loading below-the-fold images |
| `no-autoplay` | `autoplay` removed from videos | a poster and a play button |
| `block` | requests to hosts or URLs refused | a facade for an embed, or removing or deferring a script (an upper bound) |
| `hide` | a selector not rendered (`display: none`) | rendering fewer elements there (an upper bound: the markup is still parsed) |

Comparing two real builds, such as a preview with the fix against production, is
`compare --a … --b … --journey …`, which these experiments are built on.

### Fair by construction

- **Symmetric.** The baseline goes through the same interception as the variant, with an
  identity change. Rewriting variants fetch the document through the automation on both
  sides; blocking variants route every request through the same handler. The
  interception itself is never the difference measured.
- **Interleaved.** Runs alternate in a seeded order (`interleavedOrder`, as `compare`
  uses), so drift in temperature, network or server cache is not read as an effect. Each
  side's first run carries the warm-ups, so neither side starts cold.
- **Isolated.** Every run is a fresh browser with its own idle baseline, as in `compare`.
  The variant is installed in the journey's `setup()`, outside every measured window.

## Did the change apply?

After each run, outside the measured windows, the page is probed. It checks:

- running animations in scope;
- whether reduced motion matched;
- elements matched and hidden;
- lazy images and playing videos;
- requests refused and documents rewritten.

If the change did not take effect, the experiment says so and reports **no difference**,
because there was nothing to measure. Typical reasons:

- the selector matches nothing;
- no CSS animation was running to pause (script-driven animation is not paused);
- no image was left to lazy-load;
- no request matched.

`reduced-motion` also reports whether the page reacted. "The page ran 2 animations either
way: it does not respond to prefers-reduced-motion" is a finding in its own right
(WCAG 2.3.3).

## Did the page still work?

- **Checks** in the spec (`assertions`) must hold on both sides. They use semantic
  locators: a role and name, a label, or visible text. A variant that fails a check the
  baseline passed has broken something, and the report says its saving is not
  like-for-like.
- **Accessibility structure** is compared on both sides: landmarks, headings, images
  without alt, and focusable elements. A change is listed, so a stand-in that removes
  content is noticed. For `hide` it is expected.

## Reading the difference

For each measured step (by default `load`, then `idle`):

| Reading | When |
| --- | --- |
| **not measured** | No energy on one side or both (a virtual machine, say). Time and transfer are still shown. |
| **below resolution** | A side's median does not exceed its own spread (IQR), or is at or below idle. No difference can be read. |
| **within spread** | Both resolve, but the medians differ by no more than the larger IQR. No difference shown. |
| **lower / higher** | The variant's median is below or above the baseline's by more than that. |

Fewer than 10 runs per side is marked **indicative**, as everywhere in this tool, and no
significance is claimed. Duration and transfer are shown beside energy, in their own
units, and never combined with it.

## The workload

Without a journey, the workload is **load-and-idle**: the page load (`load`), then an
intentional idle window (`idle`, default 10 s). Endless animations, carousels and timers
cost energy in the idle window. With `journey:` in the spec, both sides run that journey
instead, such as a filter or a menu opened. See [journeys-with-mcp.md](journeys-with-mcp.md)
for writing one.

## Output

- **JSON:** `experiment`, with the spec, the change, whether it applied, checks,
  accessibility structure, differences, seed, order and limitations. Every run is kept
  in `scenarios`, labelled `baseline` or `variant`.
- **CSV:** the usual per-run file, plus `<result>.experiment.csv` with one row per step.
- **HTML report:** an _Experiment_ section at the top.

## Cost

Each run is a fresh browser, with an idle baseline of 15 s by default, as in `compare`. Ten
runs per side with a 10 s idle window take roughly 10 minutes. Experiments are for the
few items worth confirming, not for every page. That is the order the tool is built for:
cheap structure for every page, Lighthouse for the heaviest, energy experiments for a
shortlist.

## Limitations

- A difference holds for this page, workload, browser and machine. It is not an energy
  figure for the component.
- A stand-in is not the fix. Code changes can cost or save more than a CSS override, a
  refused request or a hidden element.
- `hide` and `block` are upper bounds: hiding still parses the markup, and refusing a
  script removes everything it did.
- On a virtual machine there is no energy at all. The experiment still shows whether the
  change applies and the page keeps working.
