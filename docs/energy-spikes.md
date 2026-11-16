# Energy timelines, intervals and leads

A step total says how much energy a page load or an idle minute cost. A timeline says
**when** in that window the power was high, and the same run's profile says **what the
browser was doing then**. Together they turn "this page costs energy while idle" into "for
these 1.5 seconds, power doubled while `carousel.js` was on the stack: test that
component".

None of it measures a component's energy. Firefox has no counter for an element, a script
or a component. A timeline shows the **whole measurement scope's** power over time; an
interval is **where to look**; a lead is **what to test**. Only an experiment
([experiments.md](experiments.md)) measures a difference, and only between two scenarios.

## What Firefox measures

The timeline uses the same power counters, the same selection and the same clocks as every
step total ([energy-measurement.md](energy-measurement.md)):

| Machine | Counters | Scope of the timeline |
| --- | --- | --- |
| Apple Silicon Mac | `Process Power`, one per Firefox process, summed | Firefox's own processes |
| Linux (Intel/AMD), Intel Mac, Windows | RAPL `Power: CPU package` (+ DRAM), or `Power: System` | the whole processor or platform: **every process on the machine** |
| Virtual machines, GitHub-hosted runners | none that report | **not measured**: no timeline at all |

On RAPL machines another process's work shows in the timeline too. Every interval found
there is flagged `machine-wide-scope`.

Each counter sample is the energy since the counter's previous sample, in picowatt-hours,
on its own process's clock. The timeline converts each process's sample times to one clock
before binning, as the step totals do (TDR-003), and never adds nested RAPL domains.

## The timeline

```bash
web-energy diagnose https://example.org/ --idle 10000 --bin 250
```

`diagnose` runs a profiled Firefox session: an idle baseline on `about:blank`, a warm-up
load, then the measured **load** and **idle** windows. It writes:

- `diagnose-….json`: the result, with `timelines[0]` (schema
  [`energy-timeline/1`](../schema/energy-timeline.schema.json));
- `diagnose-….html`: the report, with the timeline chart, tables, intervals, leads and the
  component explorer;
- `diagnose-….timeline.csv`: one row per bin;
- `diagnose-….screenshot.png`: the page after the measured windows (`--no-screenshot` to
  skip);
- `diagnose-….profile.json` with `--keep-profile`: the raw Gecko profile, for
  <https://profiler.firefox.com/> (Load from file).

Each bin has:

| Field | Meaning |
| --- | --- |
| `energyJ` | energy the counters read in the bin. **Null when no sample was read** - never zero |
| `averagePowerW` | that energy over the bin's width. Null when there is no energy, or when a sample's energy reaches back past the bin (after a gap) |
| `samples` | samples read in the bin |
| `phase` | the measured step at the bin's middle: idle baseline, loading, settling, idle, interaction; none between steps |
| `flags` | `no-samples`, `lumped` (energy from a gap), `unit-missing` (a counter that was reporting read nothing here), `phase-boundary`, `first-sample` |

The bins of a step add up to that step's total.

### Resolution: no precision the samples do not have

The profiler samples every 10 ms by default, but a counter may move less often than it is
sampled. The timeline measures both, and the narrowest bin it allows is **twice the
interval at which the counters actually move**. Asked for a finer bin, it uses the
narrowest supported one and says so. `resolution.supportedBinsMs` lists which of 100, 250,
500 and 1,000 ms the samples support. Coarser bins can be read from the CSV or with
`web-energy timeline --bin 1000`.

### Measuring without diagnostic overhead

`diagnose` samples stacks (`js`, `stackwalk`, `cpu`) so it can say which scripts ran. That
adds work to what is measured, and the result says so. For a timeline with no extra
profiler overhead:

```bash
web-energy measure https://example.org/ --timeline --runs 5
web-energy experiment https://example.org/ --kind remove --selector '.hero' --timeline
web-energy diagnose https://example.org/ --low-overhead     # power and markers only, no stacks
```

`--timeline` uses the same power samples as the benchmark, so the measurement itself is
unchanged. Keep diagnostic profiles and benchmarks apart: find intervals with `diagnose`,
confirm effects with `experiment`.

## Finding intervals of elevated power

Method `robust-threshold-v1` (`src/energy/spikes.ts`), recorded with every result:

1. **A reference level.** The run's idle baseline (`about:blank`) when it has at least five
   usable bins. Without one, the page's quietest half of bins. On request, a rolling median
   (`--spike-reference rolling`) for local transients: it rises with a long workload, so it
   misses prolonged ones.
2. **Its spread.** 1.4826 × the median absolute deviation of the reference bins: an
   estimate of the standard deviation that the spikes themselves do not inflate. When the
   reference does not vary (a MAD of zero), the smallest power step the bins resolve is
   used instead, and the result says so.
3. **Elevated bins.** Power above reference + **k** × spread. k is 3.5 by default, the usual
   cut-off for a modified z-score (`--spike-k`). There is **no universal power threshold**:
   what is "high" depends on the machine and the scope. A floor can be set
   (`--spike-min-rise 0.2`), and is recorded.
4. **Intervals.** Elevated bins within one bin of each other are joined. An interval stays
   within one part of the workload (load, idle, one interaction), since the evidence for
   each differs. Intervals shorter than two bins are dropped (`--spike-min-ms`).
5. **Shape and rank.** An interval of a second or more is **sustained**; shorter, a **brief
   peak**. Intervals are ranked by **energy above the reference**, so a long moderate
   workload can outrank a short tall peak: it costs more. Intervals in the measured run
   come before those in warm-up runs (whose caches are colder), which are labelled. The
   five highest single bins are listed separately.

Flags on an interval: `outside-measured-steps` (setup, a checkpoint, settling),
`crosses-phase-boundary`, `includes-lumped-bins`, `warmup`, `during-baseline`,
`machine-wide-scope`.

An interval says power was high. It does not say the page did something wrong.

## From an interval to what to test

For each interval, `diagnose` reads the **same run's profile** for that time
(`src/energy/gecko-evidence.ts`):

- **markers**: garbage collection, style, layout, paint, compositing, refresh-driver ticks
  (where `requestAnimationFrame` callbacks run), CSS animations, timers, DOM events,
  network requests;
- **scripts on the stack** in the samples taken (with the `js` feature): URL, function and
  line;
- **CPU time by category** in the interval, beside its share over the whole run. Energy
  apportioned by CPU share is a model ([attribution.ts](../src/energy/attribution.ts)), and
  is labelled as one.

What the profile does not hold is reported **unavailable**, not absent.

### The page's work, and Firefox's own

Firefox runs several processes, and only some of them run the page. Every marker and
script is labelled with the kind of process that recorded it:

| Process | What runs there |
| --- | --- |
| **the page (web content)** | the page's scripts, style, layout and painting (`Web Content`, `Isolated Web Content`) |
| **Firefox itself (parent process)** | the browser's own interface and services: update checks, remote settings, its own modules; on macOS also compositing |
| **GPU process** | compositing, where Firefox uses one |
| **other Firefox processes** | network sockets, utilities, media decoding, extensions, preallocated processes |

On the first real run (Apple M2, example.org), much of the activity in the intervals was
Firefox's own: `remote-settings`, `ChromeUtils.importESModule`, and a system add-on update
check to `aus5.mozilla.org` during the idle window. Such work is reported separately. Its
requests are listed as **not the page's**, and the interval carries the note that part of
its energy may be the browser's. Scripts on the stack in Firefox's own processes never
become leads. A script whose URL is the page itself is the page's **inline** script (or
an event-handler attribute): no component owns it.

On Apple Silicon each process has its own power counter, so each interval also gives the
energy **by process**: how much the page's content process drew, and how much Firefox
itself did. That is a measurement per process, not an apportionment. It does not exist on
RAPL machines, whose counters are the whole processor's.

Marker time is the time **covered** within the interval: overlapping and nested markers,
and the same work on several threads, are counted once, so it never exceeds the interval.
(The first version summed marker durations, and reported hundreds of seconds of script in
a 1.25 s interval.)

`web-energy timeline <profile.json> --describe` lists each process in a saved profile as
it is read: its role, name and type, power counters, threads, markers and a few script
locations.

Then it ties what it found to the [component graph](component-graph.md)
(`src/energy/spike-analysis.ts`). Every lead says how it is tied:

| Evidence class | Meaning |
| --- | --- |
| `profiler-correlation` | the same run's profile shows its script on the stack, or its request on the network, during the interval |
| `resource-association` | the component graph says this component loads that script or resource, on this page |
| `cross-run-trace` | a Chromium trace of the same page, **in a separate run in another browser**, saw this work in the same phase (load or idle). Matched by page and phase, never by time |
| `direct-node` | that trace named an element inside the component |
| `inferred` | the component holds something that usually works in this phase (an endless animation, an autoplaying video, an iframe), with nothing tying it to the interval in time |
| `unattributed` | work the evidence cannot tie to a component, with the reason |

DOM proximity is never evidence. A script loaded from the `<head>` that drives many
components belongs to none of them, and is listed as a page-wide script. Style, layout,
paint and garbage collection markers in Firefox do not name the elements or scripts that
caused them, so that work is listed as unattributed.

Add `--trace` to `diagnose` for Chromium corroboration: which script requested animation
frames, which timers fired, which elements were laid out and painted. It is diagnosis in
another browser, under tracing overhead ([tracing.md](tracing.md)), and never Firefox
energy.

## The report

The HTML report's **Energy timeline** section has no script, like the rest of the report:

- a chart of average power per bin, with the measured steps behind it and numbered
  intervals; each interval is a link to its details, and each bin has a tooltip;
- tables with the same values: the steps, the intervals, and every bin;
- for each interval: what was measured, the same run's evidence, the leads, what stays
  unattributed, and the commands to test each lead;
- the **component explorer**: each component the intervals point to, with its selector,
  page, how many pages share it, its scripts and resources, Lighthouse findings, the
  experiments available, previous experiments (`web-energy report diagnose-….json --with
  compare-….json`), and the screenshot with the component outlined.

An outline marks the position Firefox recorded. It is called **verified** only when the
selector matched exactly one element when the page was captured. A selector that matched
several is ambiguous, and one never checked is unverified; neither is treated as the
component.

The commands run the page in an isolated test browser. Nothing in the report changes the
live site.

## Investigating a component with a profiler

1. **Find the interval.** `web-energy diagnose <url> --keep-profile --trace`. Open the HTML
   report: which interval ranks first, in which phase, and what leads does it have?
2. **Read the profile.** Load `diagnose-….profile.json` at
   <https://profiler.firefox.com/>. Select the interval's time range on the track (the
   report gives it in seconds from the start of the timeline; the profiler's own time zero
   is earlier, at browser start). The Call Tree shows the functions; the Marker Chart shows
   style, layout, paint and GC.
3. **Re-read a saved profile.** `web-energy timeline diagnose-….profile.json --bin 500`
   prints the intervals and same-run evidence again, with other settings; `--write` saves
   `profile.timeline.json` and `.csv`. Without the run's step windows it has no phases and
   no idle baseline, so its reference is the quietest bins.
4. **Test the lead.** `diagnose` ends by printing the command for the top lead (or, with
   none, a starting point), with its own result file as `--evidence`; the report has one
   for each lead and kind. For example:

   ```bash
   node dist/cli/index.js experiment https://example.org/ --kind remove \
     --selector '[data-component-id="hero-carousel"]' --idle 10000 --runs 10 --warmups 2 \
     --assert-role main --evidence results/diagnose-2026-11-16T20-00-58-629Z.json
   ```

   The selector must exist on that page, and `--evidence` must be the path `diagnose`
   printed. The evidence file is read before anything runs, and a selector that matches
   nothing stops the experiment at its first checkpoint.

   `--evidence` brings the interval's profiling evidence into the experiment's finding as
   the observed activity ([evidence-records.md](evidence-records.md)).

## Limits

- Power is the scope's: Firefox's processes on Apple Silicon, the whole CPU package or
  platform elsewhere. Never one element's, script's or component's.
- An interval is a time, not a cause. A lead is a reason to test, not a measurement.
- Diagnostic stack sampling adds work. Intervals from `diagnose` find where to look; their
  energy is not a benchmark.
- Chromium traces come from a separate run in another browser. They corroborate; they are
  never aligned with Firefox's power by time.
- No timeline exists where energy is not measured (virtual machines, GitHub's runners). The
  report says not measured; it never shows a zero.
- The detection method has settings. They are recorded with each result, so another reader
  can repeat or change them.
