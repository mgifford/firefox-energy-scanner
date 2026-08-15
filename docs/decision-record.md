# Technical Decision Record (Phase 1)

Status: accepted
Date: 2026-08-14
Platform verified on: macOS 26.5.2 (build 25F84), arm64 (Apple Silicon), Node v22.20.0

This record documents what was **empirically verified on this machine**, what was read
from **primary sources**, and what was **rejected**. Every claim below that affects a
number in a benchmark result was tested, not assumed.

---

## TDR-001: Firefox power data is reachable, and is a real physical unit

**Decision:** Use the Gecko Profiler `power` feature as the primary energy source.

**Verification.** Launching Playwright's bundled Firefox with profiler startup
environment variables produced a profile containing a power counter:

```
features: ["screenshots","cpu","power"]
counter: {"name":"Process Power","category":"power","description":"Power utilization"}
```

775 samples were captured with schema `{"time":0,"count":1}`.

**Units.** The raw `count` value is **picowatt-hours (pWh)**. This is not an inference.
The Firefox Profiler front-end defines the conversion in
`src/components/timeline/TrackCounterTooltipFormat.ts`:

```ts
const PWH_TO_WH = 1e-12;
const MS_PER_HOUR = 1000 * 3600;

export function pwhToWh(pwh: number): number {
  return pwh * PWH_TO_WH;
}

export function pwhPerMsToWatts(pwhPerMs: number): number {
  return pwhPerMs * PWH_TO_WH * MS_PER_HOUR;
}
```

Therefore `joules = pWh * 1e-12 * 3600`. Because a documented physical model backs this
conversion, reporting joules is defensible. This satisfies the project rule that proxy
metrics must never be relabelled as joules — this is not a proxy metric.

**Consequence:** `measurementType` is `hardware-estimate` and `measurementScope` is
`process` (per-process counters, aggregated across Firefox's processes). It is *not*
`system` scope; it does not include the display, and it is not whole-machine energy.

---

## TDR-002: `nsIProfiler` cannot be driven per-step from Playwright

**Decision:** Profile for the whole browser session and slice the power counter by
wall-clock time range, rather than starting/stopping the profiler around each step.

**Why.** `nsIProfiler` is chrome-privileged. Its interface is real and offers exactly the
control we would want (from `tools/profiler/gecko/nsIProfiler.idl`):

```
Promise StartProfiler(in uint32_t aEntries, in double aInterval,
                      in Array<AUTF8String> aFeatures, ...);
Promise StopProfiler();
Array<AUTF8String> GetAllFeatures();
```

But Playwright exposes no chrome-context evaluation for Firefox. Enumerating the
`Browser` prototype confirmed the available surface:

```
newContext, contexts, version, newPage, isConnected,
newBrowserCDPSession, startTracing, stopTracing, close, ...
```

`newBrowserCDPSession` is Chromium-only. There is no Firefox equivalent that reaches
privileged code. This is the limitation the project brief anticipated.

**Fallback implemented.** Session-scoped profiling via documented environment variables
(`MOZ_PROFILER_STARTUP`, `MOZ_PROFILER_STARTUP_FEATURES`, `MOZ_PROFILER_STARTUP_INTERVAL`,
`MOZ_PROFILER_STARTUP_ENTRIES`, `MOZ_PROFILER_SHUTDOWN`), with the harness recording
precise `Date.now()` timestamps at each step boundary and integrating the counter over
that window.

**Scope of the fallback.** Step attribution is by *time window*, not by causal tracing.
Any background browser activity inside the window is included. This is stated in every
result via `energy.attribution: "time-window"`.

---

## TDR-003: Power must be summed across processes, each with its own time origin

**Decision:** Aggregate every counter with `category === "power"` from the parent process
*and* from each entry in `profile.processes`, normalising each by that process's own
`meta.startTime`.

**Why this is critical — a wrong result caught during validation.** An initial
implementation summed only the parent-process counter and produced:

```
IDLE: 0.729 J over 4.135s -> 0.176 W
BUSY: 0.601 J over 4.529s -> 0.133 W      <-- CPU-heavy page used LESS power
```

That is physically impossible. Inspection showed three power counters, not one:

```
power counters found: 3   process startTimes (relative): [0, 1452.82, 1083.59]
counter 0 (parent)  total = 3.265 J
counter 1 (content) total = 3.249 J   <-- where the page JS actually ran
counter 2 (content) total = 0.305 J
```

Two failures were present at once: the content process where JS executes was excluded,
and each process reports sample times relative to its **own** `meta.startTime`, so naive
summation misaligns windows.

**After correction:**

```
IDLE: 0.063 J / 5.04s = 0.012 W
BUSY: 4.535 J / 5.33s = 0.850 W
```

A ~70x separation in the correct direction. This is the project's validation criterion
("the energy collector should normally distinguish the heavy workload from idle") and it
now passes. The regression test in `tests/` locks in this ordering.

---

## TDR-004: `powermetrics` is opt-in, never default

**Decision:** Ship `macos-powermetrics` as an explicitly-enabled adapter only.

**Why.** Verified on this machine:

```
$ sudo -n powermetrics --help
sudo: a password is required
```

A default adapter that blocks on a password prompt would break unattended runs. It also
measures **system** scope, not the browser, so it answers a different question.
It remains valuable as a cross-check and is implemented for that purpose.

---

## TDR-005: CO2.js stays a separate metric, and we avoid double-counting

**Decision:** Use `@tgwf/co2` v0.19.0 with segmented results, and never sum CO2.js output
with measured energy.

**Verified API surface:**

```
exports: [ 'averageIntensity', 'co2', 'hosting', 'marginalIntensity' ]
swd   -> 0.1482  g/MB
1byte -> 0.29081 g/MB
```

Segmented output separates the device boundary from the network/datacentre boundary:

```json
{"dataCenterCO2e":0.033098,"networkCO2e":0.035568,
 "consumerDeviceCO2e":0.079534,"total":0.1482}
```

**Precedent.** The Firefox Profiler itself pairs its power track with CO2.js and
explicitly zeroes the device grid intensity, commenting that this is done
"so we don't double-count energy that the power track already attributes to the device."
We follow the same reasoning: `consumerDeviceCO2e` is the segment that *overlaps* our
measured energy, and the two are reported side by side, never added.

**Boundary statement.** CO2.js estimates modelled emissions from transferred bytes.
Firefox power measures observed device energy. Different system boundaries, different
units, not interchangeable, not validation of one another.

---

## TDR-006: Playwright + Firefox, pinned and recorded

Playwright ships a patched Firefox (Juggler) pinned to the Playwright release; it is not
the system Firefox. Verified: Playwright's build reports **153.0** while the system
install is **152.0.5**. Both versions are recorded in every result, because a browser
version change invalidates cross-run comparison.

Sitespeed.io/Browsertime are **not** driven against the same Firefox process as
Playwright. Two automation frameworks controlling one browser is not safe or documented;
per the brief, Playwright owns the browser and any Sitespeed collection runs separately.

---

## TDR-007: GitHub-hosted runners — macOS can measure energy, Linux cannot

**Decision:** Run network/CO2.js/timing scans on `ubuntu-latest`, and energy
measurement on `macos-latest`.

**Verified empirically** by running `doctor` on both GitHub-hosted runners
(workflow run 31907018340, 2026-08-15):

`macos-latest`:

```
arch=arm64
node arch: arm64 platform: darwin
  ok  Platform darwin/arm64
  ok  firefox-profiler: power counters expected on this platform (no elevated privileges needed)
  ok  macos-powermetrics: available (opt-in; system scope)
  ok  Running on AC power
```

`ubuntu-latest`:

```
arch=x86_64
node arch: x64 platform: linux
  ok       Platform linux/x64
  warning  firefox-profiler: Firefox power counters are not expected on linux/x64.
  warning  macos-powermetrics: powermetrics is macOS-only.
```

Two useful consequences beyond the architecture itself: the macOS runner reports
**AC power**, removing the battery confounder present on the development laptop, and
`powermetrics` is available without a password prompt there.

**CORRECTION (2026-08-15, after the first real hosted scan).** The `doctor` output
above says power counters are *expected*, and that is all it can say: platform and
architecture are necessary but **not sufficient**. The first scan run on
`macos-latest` produced a `Process Power` counter with **zero samples** — every energy
value came back exactly `0.0000`, baseline included.

GitHub's macOS runners are virtualised, and the host does not expose Apple Silicon
power counters to the guest. So:

| Runner | arm64 | Counter present | Samples emitted | Can measure energy |
|---|---|---|---|---|
| local Apple Silicon laptop | yes | yes | 468 in a 5.8 s probe | **yes** |
| `macos-latest` (GitHub) | yes | yes | **0** | **no** |
| `ubuntu-latest` (GitHub) | no | no | n/a | no |

This exposed a real defect: `hasPowerData()` returned true because a counter *object*
existed, so results published `totalJoules: 0` — a fabricated measurement, which is
exactly what this project must never do. Fixed by requiring `sampleCount > 0` before
any energy field is populated, and by making `doctor` run an actual short profile and
count samples instead of inferring from platform.

**Consequence for hosted scanning.** GitHub-hosted runners can produce network,
CO2.js and timing metrics only. Real energy measurement needs a **self-hosted** Apple
Silicon runner (or a local machine). The workflow still offers the macOS runner because
`doctor` and the result labelling now report the absence honestly.

**Caveats that remain.** Hosted runners are shared, multi-tenant virtual machines with
no thermal or noise-neighbour control. They are **not** suitable for the A/B regression
work this project exists to support — that still wants a dedicated machine. The
published site labels every result with its platform and whether energy was actually
captured.

---

## Open limitations carried into implementation

- Energy is attributed by time window, not causally.
- Scope is Firefox processes, not the whole machine; display power is excluded.
- Battery vs AC changes power behaviour; this machine was on **battery** during
  verification, and `doctor` warns when power source differs across compared runs.
- Profiling has observer overhead; primary measurement and diagnostic profiling are
  kept as separate run types.
- Remote (e.g. Tugboat) server cache state is uncontrolled; warmups reduce but do not
  remove this variance.


---

## TDR-008: Datacentre runners cannot measure energy — this is hardware, not configuration

**Question:** can reliable energy data be obtained by running in a datacentre rather
than on user hardware?

**Answer: no, not on virtualised hosts, and no setting changes this.**

**Where the number comes from.** Firefox's Apple Silicon counter is not a model or an
estimate. From `tools/profiler/core/PowerCounters-mac-arm64.cpp`:

```cpp
int64_t GetTaskEnergy() {
  task_power_info_v2_data_t task_power_info;
  mach_msg_type_number_t count = TASK_POWER_INFO_V2_COUNT;
  kern_return_t kr = task_info(mach_task_self(), TASK_POWER_INFO_V2,
                               (task_info_t)&task_power_info, &count);
  if (kr != KERN_SUCCESS) {
    return 0;
  }
  // task_energy is in nanojoules. To be consistent with the Windows EMI
  // API, return values in picowatt-hour.
  return task_power_info.task_energy / 3.6;
}
```

The kernel supplies `task_energy` in nanojoules, and the kernel gets it from the SoC's
power-manager block. Note the failure mode: on error it returns **0**, indistinguishable
from "used no energy" unless sample counts are checked.

**What a GitHub macOS runner actually is** (probed directly):

```
machdep.cpu.brand_string : Apple M1 (Virtual)
hw.model                 : VirtualMac2,1
kern.hv_vmm_present      : 1          <- running under a hypervisor
hw.ncpu                  : 3
```

And `powermetrics`, which reads the same hardware, fails outright:

```
ERROR: cannot find the IO registry entry for IODeviceTree:/arm-io/pmgr
```

`pmgr` is the Apple Silicon power manager. It is **not present in the guest**. Apple's
Virtualization framework does not expose power-measurement hardware to a VM, so the
kernel has nothing to populate `task_energy` with and returns 0. `IOReportHub` is
likewise absent.

**This is not fixable by configuration.** There is no flag, entitlement or runner image
that adds power hardware to a VM. The measurement requires a physical SoC power block.

| Host | arm64 | Counter exists | Samples | Energy |
|---|---|---|---|---|
| Physical Apple Silicon (laptop) | yes | yes | 468 in 5.8 s probe | **yes** |
| GitHub `macos-latest` (VirtualMac2,1) | yes | yes | **0** | **no** |
| GitHub `ubuntu-latest` (x86_64) | no | no | n/a | no |

**What this means for "datacentre" measurement generally.** The blocker is
virtualisation, not the datacentre. A physical Apple Silicon machine racked in a
datacentre and registered as a **self-hosted runner** would measure energy correctly,
and would be *better* than a laptop: mains power, stable thermals, no Low Power Mode,
no competing user workload. What cannot work is a shared virtual machine.

Even then, `measurementScope` remains `process` — the energy of Firefox's processes on
that machine. It never becomes a measurement of the datacentre, the server under test,
or the network.

**Implemented consequences.**

- `doctor` probes for real samples and FAILs on a virtualised host rather than reporting
  platform support.
- The `macos-powermetrics` adapter now runs a real sample and detects the missing
  `pmgr` entry, instead of treating "sudo works" as availability.
- Energy fields are omitted entirely when no samples exist, so a virtualised run can
  never publish `0 J` as though it were a measurement.
