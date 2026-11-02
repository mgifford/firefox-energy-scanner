# Self-hosted runner (the only way to get energy in CI)

> Setting one up at home for public scan requests? Start with
> [LOCAL-RUNNER.md](../LOCAL-RUNNER.md), which covers a Mac mini or Linux box end to end,
> including network isolation and fork pull-request approval.

GitHub's hosted runners cannot measure energy. Their macOS runners are virtual machines
(`Apple M1 (Virtual)`, `hw.model VirtualMac2,1`), and Apple's Virtualization framework
does not expose the SoC power-manager block to a guest, so Firefox's power counters
exist but emit zero samples. See [decision-record.md](decision-record.md) TDR-008.

A **physical** Apple Silicon Mac registered as a self-hosted runner measures energy
correctly — and is better than a laptop for it:

| | laptop | racked Mac as runner |
|---|---|---|
| power source | often battery | always mains |
| Low Power Mode | often on | off |
| thermals | varies with use | stable |
| competing workload | your own apps | none |
| availability | when you are at it | always |

## Requirements

- A physical Apple Silicon Mac (M1 or later) that can stay powered on
- macOS with Node.js 20+
- Admin access to this repository (to register the runner)

## Register the runner

Follow GitHub's own flow, which issues a single-use token:

**Settings → Actions → Runners → New self-hosted runner → macOS / ARM64**

That page gives you the exact `./config.sh` command including the registration token.
Do not copy a token from anywhere else — they are single-use and short-lived.

When prompted for **labels**, the defaults (`self-hosted`, `macOS`, `ARM64`) are what
the workflow targets. Adding more is fine; removing those three will stop scans from
matching.

To keep it running across reboots:

```bash
./svc.sh install
./svc.sh start
```

## Verify it can actually measure energy

Registering is not proof. On the runner machine, from a checkout of this repo:

```bash
npm ci && npx playwright install firefox && npm run build
node dist/cli/index.js doctor
```

Look for the verdict at the end of the **Energy measurement** section:

```
  ok       Firefox power samples: 465 (counters: Process Power)
  => This host CAN measure energy. Firefox recorded 465 power samples: this host measures per-process Firefox energy.
```

If it instead says **"This host CANNOT measure energy"**, the reason and the
alternatives follow on the next lines. The usual cause is a virtual machine — check you
are on real hardware. Other machines that can measure energy are listed in
[local-energy.md](local-energy.md).

`doctor` also warns about battery power and Low Power Mode. For a runner, plug it in
and turn Low Power Mode off:

**System Settings → Battery → Low Power Mode → Never**

## Tell the workflow to use it

GitHub's workflow token cannot list runners, so the repository says which machine
measures energy. Set the repository variable **`ENERGY_RUNNER`** to the runner's
labels, comma-separated:

**Settings → Secrets and variables → Actions → Variables → New repository variable**

```
Name:  ENERGY_RUNNER
Value: self-hosted,macOS,ARM64
```

Scans with "Where to run: Auto" (the default) then go to this machine and wait for it
when it is busy or offline. Remove the variable to send everything to GitHub's cloud
again. A Linux or Windows energy machine works the same way with its own labels; on
Linux, set `kernel.perf_event_paranoid=0` on the machine itself
([local-energy.md](local-energy.md)).

## Using it

With `ENERGY_RUNNER` set, every request whose **Where to run** is *Auto* (the default)
runs on this machine. A request can still choose *GitHub's cloud only*. If the machine
is offline, scans wait in the queue until it comes back (GitHub gives up after 24
hours); remove the variable to stop routing scans to it.

The workflows use actions that run on Node.js 24, which needs runner version 2.327.1 or
later. A registered runner updates itself; one that has been offline for a long time
updates when it next connects.

## Security

A self-hosted runner executes workflow code on your machine.

**On a public repository, require approval before fork pull requests run workflows.**
A malicious pull request can add a workflow that targets the runner and runs arbitrary
code on it. GitHub documents this directly, and it is the reason hosted runners are
ephemeral. Set **Settings → Actions → General → Fork pull request workflows from
outside collaborators → Require approval for all external contributors**, and read any
workflow change before approving it. Hosted scans keep the browsers off private
addresses (`--public-only`), and isolating the machine's network adds a second layer:
see [LOCAL-RUNNER.md](../LOCAL-RUNNER.md#security-before-opening-it-to-the-public).

This repository's scan workflow is triggered by *issues*, not pull requests, and the
issue body is parsed and validated rather than executed — URLs are passed as argv, never
interpolated into a shell. That is a much narrower surface than `pull_request`, but the
general rule still applies:

- keep the runner on a machine you do not mind reimaging
- do not give it access to credentials it does not need
- review any workflow change that adds a `pull_request` trigger

## What you get that hosted cannot give

- observed energy in joules / mWh
- idle baseline subtraction and the resolution check
- energy apportioned to work categories (`diagnose`)
- A/B energy regression via `compare` and `matrix`

Everything else — bytes, requests, CO2.js, timings, DOM and CSS structure, findings —
works on any runner and does not need this setup.
