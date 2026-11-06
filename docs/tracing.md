# Chromium tracing

Tracing records what a page's main thread did. It shows which scripts ran, what was
restyled, laid out and painted, and what kept running after the page had loaded. It
traces only a few pages, in Chromium, after the Firefox measurement has finished. It never
runs inside an energy window. It is evidence of where work happens, **not a measurement of
energy**, and its figures are never combined with Firefox's.

## When to use it

Use it when a scan has found something worth explaining, for example a page that stays
busy, a component with an endless animation, or a heavy script on every page. A trace says
which file, function and element are involved. That is what turns a finding into
something a developer can change.

Tracing every page would cost more than the scan it serves. On the fixture site's small
pages, a trace with a 3 s idle window is 1–5 MB of events. Heavier real pages produce
more, and Chromium works hard to record it. So tracing is off by default and budgeted
when on.

## Commands

```bash
# Trace 3 pages of a crawl: one per page family first, then the heaviest
node dist/cli/index.js crawl https://example.com/ --sample --trace

# Trace named pages on their own, without Firefox
node dist/cli/index.js trace https://example.com/ https://example.com/news/

# Keep the raw traces, gzipped, to open in Chrome DevTools' Performance panel
node dist/cli/index.js trace https://example.com/ --trace-keep traces/
```

| Option | Default | |
|---|---|---|
| `--trace` | off | Trace a few `measure` or `crawl` pages after Firefox (and Lighthouse) |
| `--trace-pages <n>` | 3 | Pages to trace, at most 10 |
| `--trace-idle <ms>` | 5000 | How long to leave each page alone after load, 1,000–30,000 |
| `--trace-max-mb <n>` | 40 | A larger trace is not analysed, and the record says so |
| `--trace-keep <dir>` | not kept | Write each raw trace here, gzipped |
| `--public-only` | off | Route Chromium through the network guard, as for Firefox |

Pages that Firefox found to be downloads, or that the network guard refused, are not
traced. A page that answers with an HTTP error, or that the guard refuses during tracing,
gets a record that says why. It does not get an analysis of the error page.

Chromium is found from `CHROME_PATH`, then Playwright's own Chromium, then any other
Chromium build Playwright has installed (as after an upgrade without reinstalling), then
an installed Google Chrome.

## What a trace records

Each page is traced over two windows, bounded by performance marks:

- **Load:** from the navigation request to the `load` event.
- **Idle:** the next `--trace-idle` milliseconds, with nobody touching the page.

For each window, on the page's renderer main thread:

- busy time, split into script, style, layout, paint and other work;
- script time by file, with the function that took longest, and **long tasks** (over
  50 ms), with the scripts inside them;
- **layout forced from script**, and the function that forced it;
- style recalculations and the elements they touched; layout roots and the most-painted
  elements;
- **animation frames** fired, a second, with where they were requested from;
- **timers** fired, with where they were installed and their interval;
- **animations** still running, and the element that runs them;
- requests made, except the favicon, which the browser fetches itself.

A cross-site iframe runs in its own renderer process. It is summarised on its own, under
its document URL, so a third-party widget's timers are not mistaken for the page's.

The categories are the `devtools.timeline` set: enough for the above, without compositor
internals. Response bodies are never recorded. Element positions in the trace are
resolved to the same node paths Firefox records while the page is still open, so trace
evidence can be tied to the same component instances.

## How findings are attributed

Trace observations become graph findings with the evidence class `trace-supported`.
Each one is tied to the most specific thing the trace itself names:

| Finding | Raised when | Tied to |
|---|---|---|
| `trace:continuous-animation-frames` | 10 or more frames a second while idle | the script that requested them |
| `trace:repeating-timer` | a timer fires twice or more while idle | the script that installed it |
| `trace:idle-request` | a request while idle | the resource, when Firefox recorded it |
| `trace:running-animation` | an animation runs while idle | the component whose element it animates |
| `trace:iframe-idle-work` | an iframe in its own process keeps working | the component that holds the iframe |
| `trace:idle-main-thread-work` | the main thread is busy 5% or more of idle | the page |
| `trace:long-task` | a task over 50 ms during load | each script inside it |
| `trace:forced-layout` | a layout of 1 ms or more forced from script | the script that forced it |
| `trace:interaction-work` | an input event in the trace | its handler's script |
| `trace:unattributed-script` | 5 ms or more of script with no file | unattributed |

A script is tied to a resource only if Firefox recorded that file **on that page**.
Inline script is tied to the page. Anything else is `unattributed`, with the reason, for
example "cdn.example/lib.js is not among the resources Firefox recorded for this page".
Nothing is apportioned by size, and nothing is guessed.

## What a trace cannot tell you

- **It is not energy.** Main-thread time is a sign of work, not a measure of what that
  work costs on any device. Only a controlled experiment measures an energy difference.
- **It is one run, in Chromium.** Firefox may schedule the same page differently. A
  trace says what ran and where, not how much it varies.
- **Nobody touches the page.** Interaction chains appear only in traces that contain
  input events. The scan's traces do not script any input.
- **Elements can move.** An element is matched to a Firefox-recorded component by its
  position in the document. Where Chromium and Firefox build a different DOM, or the
  element was removed before the trace ended, the finding stays unattributed.
- **Iframes in the page's own process** (same-site iframes) are counted with the page.

## Privacy

Kept traces (`--trace-keep`) hold every URL the page requested, query strings included,
and script source positions. Treat them like a HAR file: do not publish one for a page
behind a login. Without `--trace-keep`, only the summary described above is stored.
