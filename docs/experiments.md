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
| `remove` | a selector's elements detached from the DOM after the page loaded | the component gone while the page sits idle (its scripts may keep running) |
| `remove-before-load` | a selector's elements removed from the markup before it is parsed | the component never in the page: load and idle without it |

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

### Hide, remove, remove before load, block: four different interventions

They are not interchangeable, and each answers a different question:

| | `hide` | `remove` | `remove-before-load` | `block` |
| --- | --- | --- | --- | --- |
| Markup parsed | yes | yes (removed after load) | **no** | yes |
| Element in the DOM | yes | **no**, after the checkpoint | **no** | yes |
| Layout, paint, CSS animation | stopped | stopped, after the checkpoint | never | as before |
| Its inline scripts ran | yes | yes, before the checkpoint | **no** | yes |
| Timers, animation-frame loops, workers, listeners its scripts started | **keep running** | **keep running**, unless its code checks | never started by its inline scripts; head scripts still run | never started, if they came from the refused scripts |
| Its network requests | made | made during load | not made | **refused** |
| Steps that can show an effect | load and idle | **idle only** (load is a negative control) | load and idle | load and idle |

An `iframe` is the exception for `remove`: detaching it unloads its document, which stops
that document's scripts. Nothing else takes its scripts with it.

## Removal experiments

```bash
web-energy experiment https://example.org/ --kind remove \
  --selector '[data-component-id="hero-carousel"]' --idle 10000 --runs 10 --warmups 2 \
  --assert-role main --assert-text "Contact"
```

The workload, on both sides:

1. **load** (measured): the page loads, with the component, on both sides alike. A
   difference here cannot be the removal's: this step is a **negative control**. If it
   moves anyway, the report says the sides were not alike.
2. **checkpoint** (not measured): both sides find the selector's matches. Only the variant
   removes them, outermost matches only: a match inside another goes with it and is counted
   once. A watcher for re-inserted matches starts on both sides.
3. **settle** (not measured, `--settle`, default 2,000 ms): both sides wait, so the
   removal's own aftermath is not measured.
4. **idle** (measured, `--idle`, at least 1,000 ms): the only step that can show the
   removal's effect.
5. **probe** (not measured): does the selector match again? Did the watcher see a matching
   element inserted, or a removed one re-attached?

Nothing is removed unless every check passes. A removal is **refused**, and the experiment
stops after the first refused run, when the selector:

- is invalid CSS;
- matches nothing;
- matches the document's own `html`, `head` or `body` (checked by element, so `:is(body)`
  is caught too);
- matches more than `--max-matches` elements (default 24; up to 500, deliberately).

A removal that was refused, removed nothing, left a match behind, or that the page **put
back** is **not applied**: no difference is reported, the exit code is 2, and the finding is
`intervention-failed`. That is never "no saving".

**Script work after the removal.** On both sides, before the page loads, a small init
script counts the callbacks the page's timers and `requestAnimationFrame` loops receive (it
wraps the callbacks; what the page schedules is unchanged, and the cost is on both sides).
The report gives each side's rate from the checkpoint to the end of idle, and the running
CSS and Web Animations. A rate that holds without the component means its scripts, or
something else on the page, kept working: the removal did not stop them.

**What was removed.** The report lists what the removed subtrees held: elements, headings,
landmarks, interactive controls and links, form controls, live regions, media, iframes,
canvases and text. Removing headings, landmarks, controls or live regions makes the saving
**not like-for-like**, as does failing a check the baseline passed.

### Before the page is parsed

```bash
web-energy experiment https://example.org/ --kind remove-before-load --selector '.hero'
```

In each run's setup, outside every measured window, the document is fetched through the
browser, parsed by **the browser's own HTML parser** (`DOMParser`), checked as above,
stripped of its matches on the variant, and serialised again on both sides. Both sides
are then served that snapshot through the same interception, so the round trip and the
interception are on both sides alike. No regular expression edits the markup.

Both load and idle can show an effect. Limits of its own: the server's response time is
part of neither side; anything the server varies per request is frozen for the run; a URL
that redirects is refused (use the address it redirects to); a component the page's scripts
create is not in the markup (use `remove`), and one they create anyway when it is missing
makes the removal not applied.

Never add a `remove` result to a `remove-before-load` result: they measure different
things.

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

### Inconclusive results

"No difference shown" and "below resolution" are not "no effect". They say this setup
could not distinguish the two sides. Before concluding anything:

- **Is the effect in the right window?** A post-load removal can only act on idle. A
  component whose cost is in loading needs `remove-before-load` or `block`.
- **Is the window long enough?** A 10 s idle window catches a loop running at 60 frames a
  second; a timer that fires every 30 s needs a longer one (`--idle 60000`).
- **Are there enough runs?** Under 10 per side is indicative. More runs narrow the spread.
- **Is the machine quiet?** On battery, in Low Power Mode, or (on RAPL) with other work
  running, the spread grows. `doctor` warns about the first two.
- **Did the change do anything?** The script-activity table shows whether work fell.
  Removing a component whose timers keep running cannot save their energy.

A difference that stays within spread with enough runs, a long window and a quiet machine
is a result: on this page and machine, the change saves less than this setup resolves.

## A fixture experiment, step by step

The fixture site (`tests/fixtures/site/server.mjs`, synthetic content) has a ticker whose
timer keeps running after its element is removed:

```bash
npm run build
node -e "import('./tests/fixtures/site/server.mjs').then(m => m.startFixtureSite({ port: 8086 }))" &
node dist/cli/index.js experiment http://127.0.0.1:8086/lab/ticker --kind remove \
  --selector '[data-component-id="ticker"]' --idle 5000 --settle 1000 --runs 10 --warmups 2 \
  --assert-role main --seed fixture-ticker
```

What it shows, on any machine:

- **Applied: yes**: one subtree removed in every variant run, and it stayed removed;
- **Script work carried on**: timer callbacks at about 10 a second on both sides;
- **Not like-for-like**: the ticker held a heading and a region landmark;
- the finding, in `compare-….finding.md` beside the result.

On a machine that measures energy, the idle step's difference is the removal's measured
effect, with this timer still running. On a virtual machine it reads **not measured**. The
same spec is in `examples/experiments/ticker-remove.yaml`. Other fixture pages: `/lab/polite`
(its timer stops itself when its element goes), `/lab/remount` (the page puts it back: not
applied), `/lab/ensure` (its script creates it when the markup lacks it), `/lab/static` (a
large static subtree), `/articles/d` (an animation-frame loop), `/spinner` (a CSS animation),
`/embed` (an iframe).

## Protocol and findings

Each experiment records its protocol (`experiment.protocol`): the design (interleaved A/B,
seeded order, a fresh browser per run), runs and warm-ups per side, the idle baseline in
every run, cache mode, viewport, network conditions, profiler features and interval, and a
build label (`--release`). The seed and order are in the report; the environment
(Firefox version, OS, hardware, battery) in the result.

Each experiment also writes an evidence record and a Markdown issue draft:
[evidence-records.md](evidence-records.md). `--evidence <diagnose result>` adds the
profiling evidence that led to the experiment ([energy-spikes.md](energy-spikes.md)).
`--timeline` records each run's energy timeline, from the same power samples.

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
- `remove` does not stop a component's scripts. A saving from it is what the page costs
  idle without the markup, with whatever its scripts still do.
- A removal is a diagnostic stand-in. It shows what a component costs in this scenario; it
  does not show the component should be removed from production.
- On a virtual machine there is no energy at all. The experiment still shows whether the
  change applies and the page keeps working.
