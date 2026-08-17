# Self-hosted runner (the only way to get energy in CI)

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

Look for:

```
ok  firefox-profiler: power counters produced 465 samples in a 5680 ms probe
```

If it instead says **"the platform reports support but the power counters emitted NO
samples"**, the machine is virtualised and cannot measure energy — check you are on
real hardware, not a VM.

`doctor` also warns about battery power and Low Power Mode. For a runner, plug it in
and turn Low Power Mode off:

**System Settings → Battery → Low Power Mode → Never**

## Using it

Pick **self-hosted — physical Apple Silicon, includes ENERGY** in the scan form or
issue template.

The workflow checks whether a runner is online *before* dispatching. If none is
available it falls back to a hosted runner and says so in the issue comment, rather
than queuing forever — a self-hosted job with no runner waits indefinitely by default,
which is the failure mode this avoids.

## Security

A self-hosted runner executes workflow code on your machine.

**Do not enable self-hosted runners on a public repository that accepts pull requests
from strangers.** A malicious PR can run arbitrary code on the runner. GitHub documents
this directly, and it is the reason hosted runners are ephemeral.

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
