# Measuring energy locally

GitHub-hosted runners are virtual machines, and **none of them can measure Firefox
energy**: the Energy probe workflow tested all six types and every one produced zero
power samples ([hosted-scanning.md](hosted-scanning.md#github-hosted-runners-cannot-measure-energy)).
To measure energy, run the scanner on a physical machine — your own computer, or one
you register for this repository. That is the primary path for energy work.

## 1. Ask the machine

From a checkout of this repository:

```bash
npm ci
npm run energy-check
```

That installs Firefox for Playwright, builds the tool and runs `doctor`.

The **Energy measurement** section runs Firefox for a few seconds with the profiler on,
counts real power samples and ends with one verdict:

```
Energy measurement
  ok       Physical machine (no hypervisor detected)
  ok       RAPL power events: cores, pkg, psys, ram
  warning  kernel.perf_event_paranoid = 2 (Firefox needs <= 0)
  => This host can measure energy after one fix. RAPL power events are present ...
       - Run `sudo sysctl kernel.perf_event_paranoid=0` (resets at reboot), then `web-energy doctor` again.
```

| Verdict | Meaning |
|---|---|
| **CAN measure energy** | Firefox recorded power samples. Scans on this machine include energy. |
| **after one fix** | The hardware is there, but a setting blocks it. The fix is printed. |
| **CANNOT measure energy** | No usable power hardware (usually a virtual machine). The options are printed. |
| **not tested** | Firefox could not start, so nothing was proven either way. |

`node dist/cli/index.js doctor --json` prints the same thing as JSON.

## 2. Which machines work

Firefox has power counters on four platforms. What the number covers differs, and that
matters more than which platform is "better".

| Machine | Setup | What the energy covers | Best for |
|---|---|---|---|
| **Apple Silicon Mac** (M1 or later), physical | none | **Firefox's own processes** | A/B comparisons; the most precise option |
| **Linux, bare metal, Intel or AMD CPU** | `sudo sysctl kernel.perf_event_paranoid=0` | the whole CPU package (+ DRAM, or the whole platform where the CPU reports it) | good results on a quiet machine |
| **Windows 11**, supported Intel, AMD or ARM CPU | none | the whole CPU package | as Linux |
| **Intel Mac** | none | the whole CPU package | supported by Firefox; not yet verified with this tool |
| Any **virtual machine** | — | nothing | not possible: GitHub-hosted runners, cloud VMs, Docker Desktop, WSL2, Parallels, UTM |

**Per-process versus whole package.** On Apple Silicon, Firefox reports the energy of
its own processes, so other applications do not leak in. On Linux, Windows and Intel
Macs it reads the CPU's RAPL counters, which cover **every process on the machine**.
The scanner subtracts an idle baseline, so the number is still the extra energy the page
caused. But background work during a run adds noise there, so close other applications,
stay on mains power, and use more runs. Results always record which scope they used,
and you should only compare runs that share one.

**Linux details.** Firefox 107 or later is needed. AMD needs a Zen CPU and Linux 5.8 or
later. Firefox reads the counters on CPU 0, so on a multi-socket server only the first
socket is counted. To keep the setting across reboots:

```bash
echo 'kernel.perf_event_paranoid = 0' | sudo tee /etc/sysctl.d/99-firefox-energy.conf
sudo sysctl --system
```

Lowering `perf_event_paranoid` lets any local user read performance counters. That is
fine on a machine dedicated to measurement, and worth thinking about on a shared one.

**Docker on a Linux host** shares the host kernel, so it can work. The host needs the
sysctl above, and the container needs `--cap-add PERFMON` (Docker's default seccomp
profile blocks `perf_event_open` otherwise). Docker Desktop on macOS or Windows runs a
virtual machine, so it cannot.

## 3. Run scans

```bash
node dist/cli/index.js measure https://example.org/ https://example.org/about \
  --runs 10 --warmups 3 --headless
```

The summary prints energy per page with a **Resolved** column. Lighthouse can run
afterwards in the same command (`--lighthouse`); it never overlaps the Firefox energy
window. See [lighthouse.md](lighthouse.md).

For reliable numbers: mains power, Low Power Mode off (macOS), other applications
closed, at least 10 runs. `doctor` warns about battery and Low Power Mode.

## 4. Publish local results

Local results go through the same review as hosted ones: the `scan-results` branch and
its one pull request (see [hosted-scanning.md](hosted-scanning.md#what-gets-published)).
Add yours to it:

```bash
node dist/cli/index.js measure https://example.org/ --runs 10 --headless --out site/results
git fetch origin
# Join the open results branch if there is one, otherwise start it from main.
git switch scan-results 2>/dev/null || git switch -c scan-results origin/main
git pull --rebase origin scan-results 2>/dev/null || true
git add site/results
git commit -m "Add local energy results for example.org"
git push -u origin scan-results
```

If no results pull request is open, open one from `scan-results` (`gh pr create --fill`).
When it is merged, the Pages deploy rebuilds the index and the results appear with their
energy figures. Hosted scans and local runs share the one branch, so there is never more
than one.

## 5. Or let issues use your machine

The full runbook, including security and a set-up prompt, is
[LOCAL-RUNNER.md](../LOCAL-RUNNER.md). In short:

1. Register it as a self-hosted runner ([self-hosted-runner.md](self-hosted-runner.md)).
2. Set the repository variable **`ENERGY_RUNNER`** to its labels, e.g.
   `self-hosted,macOS,ARM64` (Settings → Secrets and variables → Actions → Variables).

Requests then run there by default ("Where to run: Auto"). Any platform works — use the
labels your runner was registered with. On a self-hosted Linux runner, set
`perf_event_paranoid` on the machine itself: the workflow only changes it on disposable
GitHub-hosted runners.

**No suitable machine of your own?** Cloud providers rent physical hardware too, for
example Apple Silicon Mac minis by the hour (AWS EC2 Mac, Scaleway, MacStadium) or
bare-metal Linux servers. These are physical machines, not virtual ones, so they should
work as energy runners — but none has been tested with this tool yet. Run
`npm run energy-check` on one before relying on it.
