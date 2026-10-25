# Running energy scans on a machine at home

**Goal:** people submit domains as GitHub issues, and a machine you own measures how much
energy Firefox spends on them. GitHub still handles the queue, the comments and the
published site. Only the measuring happens at home.

This is a runbook: why, how to set up a Mac mini or a Linux box, the repository settings,
the security you need before opening it to the public, and a prompt you can paste into an
AI coding assistant on the machine to do the setup with you.

---

## Why a machine at home

**GitHub's cloud cannot measure energy.** This was tested, not assumed. The Energy probe
workflow ran Firefox's power profiler on all six GitHub-hosted machine types (macOS on
Apple Silicon and Intel, Linux x64 and Arm, Windows Server and Windows 11 Arm). Every one
is a virtual machine and none produced a single power sample. Hugging Face Spaces and
other container platforms run on rented virtual machines as well, so they will almost
certainly say the same (not tested; `npm run energy-check` would settle it). See
[docs/hosted-scanning.md](docs/hosted-scanning.md#github-hosted-runners-cannot-measure-energy).

**A physical machine can, and the numbers repeat.** On an Apple Silicon MacBook, three
separate sessions measuring the same three france.fr pages (10 runs each, mWh per page
load):

| Page | Transfer | Session 1 | Session 2 | Session 3 | Spread |
|---|---:|---:|---:|---:|---:|
| Côte d'Azur article | 10.8–11.2 MB | 1.779 | 1.772 | 1.656 | ±4% |
| Biarritz destination | 1.3–1.4 MB | 0.539 | 0.459 | 0.503 | ±8% |
| `/de` home page | 2.5 MB | 0.337 | 0.327 | 0.356 | ±4% |

Every result was **resolved** (bigger than its own run-to-run noise), and the ranking was
the same in all three sessions. Between sessions the numbers drift by a few percent
(temperature, background activity, the site and its CDN), which is far less than the
differences between pages. To compare two versions of a page, measure both in the same
session: `compare` interleaves them for exactly this reason.

The sessions also show why this is worth measuring. The article transfers about 8× the
bytes of the Biarritz page but costs about 3.5× the energy, and `/de` transfers almost
twice as much as Biarritz yet consistently costs *less*. A bytes-based CO2 estimate
ranks these pages wrongly. Lighthouse called all three "good" (94–98).

**Why not just use your laptop?** You can, for your own scans (`npm run energy-check`,
then `measure`). For a queue that other people feed, a dedicated machine is better:

| | Laptop | Dedicated Mac mini / Linux box |
|---|---|---|
| Always available | only when open and awake | yes |
| Power | battery changes power management | always mains |
| Thermals | vary with your own use | stable |
| Other work during a scan | your apps | none |
| Security | your accounts and files are on it | nothing to lose |

**Cost and footprint.** A second-hand M1 Mac mini costs a few hundred dollars and idles at
a few watts. Renting a physical Mac in the cloud (AWS EC2 Mac, Scaleway) works too, but
Apple's licence makes the minimum rental 24 hours, roughly $15–25 a day.

### What each machine measures

| Machine | Energy covers | Setup | Notes |
|---|---|---|---|
| **Mac mini, Apple Silicon (M1 or later)** | **Firefox's own processes** | none | Most precise; other apps do not leak in. Recommended. |
| **Linux box, bare metal, Intel or AMD (Zen, Linux 5.8+)** | the whole CPU package (+ DRAM where reported) | one kernel setting | Every process on the machine counts, so keep it dedicated. |
| Anything virtual (VMs, WSL2, Docker Desktop, cloud instances) | nothing | — | Not possible. |

Results always record which of these they measured. Compare results only from machines of
the same kind.

---

## How it fits together

```
someone opens a "SCAN:" issue
        │
        ▼
GitHub Actions (cloud): parse and validate the request, post "Scan started"
        │   ENERGY_RUNNER is set, so the scan job is sent to your machine
        ▼
your machine at home (self-hosted runner): Firefox measures each page
        │   10 runs per page with energy, plus Lighthouse
        ▼
GitHub: results comment on the issue → "Scan results" pull request → site
```

Without `ENERGY_RUNNER`, or with "Where to run: GitHub's cloud only", scans run in the
cloud as they do now: same results, no energy.

---

## Setup: Mac mini

Allow about an hour. You need admin access to the Mac and to the GitHub repository.

### 1. Prepare macOS

1. Install macOS updates, then create a **standard (non-admin) user** for the runner, for
   example `scanner`. Do the rest of these steps while logged in as that user, except where
   a step needs an admin password.
2. Keep it awake and on mains power:
   - System Settings → Energy: turn on **Prevent automatic sleeping when the display is
     off** and **Start up automatically after a power failure**. Low Power Mode: **Never**.
   - Or in Terminal (admin password needed):
     ```bash
     sudo pmset -a sleep 0 disksleep 0 powernap 0 autorestart 1
     ```
3. Log in automatically after a restart: System Settings → Users & Groups → **Automatically
   log in as** `scanner`. The runner starts at login, so without this it stays off after a
   power cut. (macOS disables automatic login while FileVault is on; on a dedicated machine
   with nothing personal on it, turning FileVault off is a reasonable trade.)
4. Use a wired network connection if you can, on an isolated network (see
   [Security](#security-before-opening-it-to-the-public)).
5. Install **Node.js 22 LTS** from <https://nodejs.org/> (or `brew install node@22`).
6. Install **Google Chrome**, which Lighthouse drives. (If it is missing, the workflow
   installs Playwright's Chromium instead.)

### 2. Check that it measures energy

```bash
git clone https://github.com/mgifford/firefox-energy-scanner.git
cd firefox-energy-scanner
npm ci
npm run energy-check
```

You want:

```
  ok       Physical machine (no hypervisor detected)
  ok       Firefox power samples: 459 (counters: Process Power)
  => This host CAN measure energy. ... this host measures per-process Firefox energy.
```

Stop here if it says anything else; the lines above it say why.

### 3. Register it as a runner

1. On GitHub: **Settings → Actions → Runners → New self-hosted runner → macOS → ARM64**.
   GitHub shows commands with a one-time registration token. Run the download and extract
   commands as shown.
2. Run the `config.sh` line GitHub shows, **adding a label and a name**:
   ```bash
   ./config.sh --url https://github.com/mgifford/firefox-energy-scanner \
     --token <TOKEN FROM THE GITHUB PAGE> \
     --labels energy-scanner --name mac-mini-energy
   ```
   Never paste the token anywhere else, and never commit it. It expires within an hour.
3. Install and start it as a service, so it starts at login:
   ```bash
   ./svc.sh install
   ./svc.sh start
   ```
4. On GitHub, the runner now shows as **Idle** under Settings → Actions → Runners.

Then continue with [Repository settings](#repository-settings).

---

## Setup: Linux box

Allow about an hour. Ubuntu 24.04 LTS is assumed; any recent distribution works. Commands
marked *admin* are run from your own account (with `sudo`); the rest as the `scanner`
user, which has no admin rights.

### 1. Prepare Linux (admin)

```bash
# A dedicated user for the runner
sudo adduser --disabled-password --gecos "" scanner

# Let Firefox read the CPU's RAPL energy counters, permanently
echo 'kernel.perf_event_paranoid = 0' | sudo tee /etc/sysctl.d/99-firefox-energy.conf
sudo sysctl --system

# Never sleep
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target

# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

`perf_event_paranoid = 0` lets any local user read performance counters. On a dedicated
machine with one user that is fine; it is a reason not to do this on a shared one.

Optional, for steadier numbers: set the CPU governor to `performance`
(`sudo apt-get install -y linux-tools-common && sudo cpupower frequency-set -g performance`).
It costs a few watts at idle.

### 2. Check that it measures energy

As the `scanner` user (from your account: `sudo -iu scanner`):

```bash
git clone https://github.com/mgifford/firefox-energy-scanner.git
cd firefox-energy-scanner
npm ci
```

Then, once, from your admin account, install the system libraries Firefox and Chromium
need:

```bash
cd /home/scanner/firefox-energy-scanner && sudo npx playwright install-deps firefox chromium
```

Back as `scanner`:

```bash
npm run energy-check
```

You want `RAPL power events: ...`, `kernel.perf_event_paranoid = 0`, a non-zero number of
Firefox power samples (counters such as `Power: CPU package`), and **This host CAN measure
energy ... whole-CPU-package energy**.

### 3. Register it as a runner

1. On GitHub: **Settings → Actions → Runners → New self-hosted runner → Linux → x64**. Run
   the download and extract commands as the `scanner` user.
2. Configure it with a label and a name:
   ```bash
   ./config.sh --url https://github.com/mgifford/firefox-energy-scanner \
     --token <TOKEN FROM THE GITHUB PAGE> \
     --labels energy-scanner --name linux-energy
   ```
3. From your admin account, in the runner's folder, install it as a systemd service that
   runs as `scanner`:
   ```bash
   cd /home/scanner/actions-runner     # or wherever you extracted it
   sudo ./svc.sh install scanner
   sudo ./svc.sh start
   ```

---

## Repository settings

In **Settings** on GitHub:

1. **Secrets and variables → Actions → Variables → New repository variable**
   - Name: `ENERGY_RUNNER`
   - Value: `self-hosted,energy-scanner`

   Requests with "Where to run: Auto" (the default) now go to your machine. Delete the
   variable to send everything back to the cloud.
2. **Actions → General → Fork pull request workflows from outside collaborators →
   Require approval for all external contributors.** Required; see below.
3. **Actions → General → Workflow permissions → Allow GitHub Actions to create and approve
   pull requests.** Already on; the results pull request needs it.

### Test it

Open an issue with the scan form and one URL. Within a minute:

- the **Scan started** comment says *Running on this repository's energy-measuring machine*;
- the runner shows **Active** on the Runners page;
- the results comment says **Energy check: measured**, and the energy column has numbers
  marked *resolved* or *not resolved* instead of *not measured*.

If the machine is offline, scans wait for it in the queue; GitHub cancels a job that has
waited 24 hours.

---

## Security before opening it to the public

A self-hosted runner runs workflow jobs on your machine, and this one will load web pages
that strangers choose. Four things matter.

1. **Fork pull requests.** Anyone can open a pull request from a fork, and a pull request
   can change a workflow to run on `self-hosted` and execute any code there. The scan
   workflow is triggered by issues and runs only the code on `main`, but that does not stop
   a pull request from adding its own workflow. **Require approval for all external
   contributors** (above) closes this: nothing from a fork runs until you approve it. Read
   any workflow change before approving.
2. **Your home network.** The scanner refuses private addresses typed into a request
   (`192.168.x.x`, `10.x.x.x`, `localhost` and so on). It does **not yet** stop a public
   hostname that *resolves* to a private address, or a page that redirects to one. From
   your home, that could reach your router's admin page or other devices. **Put the
   machine on a guest network or VLAN with no access to the rest of your network**, at
   least until runtime blocking is built ([Next steps](#next-steps)).
3. **Nothing worth stealing.** A dedicated user, no personal accounts signed in, no saved
   passwords, no SSH keys or cloud credentials. Each job gets a short-lived GitHub token
   that expires when the job ends.
4. **Stay updated.** Playwright pins the Firefox version it drives, so keep the repository's
   dependencies current (Dependabot opens the pull requests; merge them once the Tests
   check passes). Let the OS install updates outside scanning hours. The runner software
   updates itself.

---

## Running it day to day

- **Pause it:** delete the `ENERGY_RUNNER` variable (scans go to the cloud), or stop the
  service (`./svc.sh stop`; scans queue).
- **Logs:** the job log is on GitHub under Actions. The runner's own log is in its `_diag`
  folder.
- **Comparable numbers:** keep the machine doing nothing else, on mains, with the same
  settings. Note in the results which machine produced them; do not compare a Mac's
  per-process numbers with a Linux box's whole-package numbers.
- **Energy used by the scanner itself:** each page costs a few seconds of a busy CPU per
  run. Ten runs of 80 pages is about an hour of work; scan what you need, not everything.

---

## Next steps

Captured here so they can be built in order.

- [ ] **Set up the machine** (this document), then open one test issue.
- [ ] **Block private addresses at runtime.** Before navigation, and for every request the
      page makes, resolve the hostname and refuse private, loopback and link-local
      addresses, including after redirects. Required before inviting the public.
- [ ] **Compare home and cloud for each request.** When an energy machine is set up, run the
      same request on it *and* on a GitHub-hosted runner, and show them side by side in one
      comment: energy from home; transfer, requests and timings from both. Transfer and
      CO2.js should agree, which checks the two runs saw the same pages. Timings will
      differ, which shows how far a virtual machine's numbers are from real hardware. And
      it states plainly what the cloud cannot tell you. (Not built yet.)
- [ ] **Label results by machine** on the published site, so per-process and whole-package
      numbers are never compared.
- [ ] **Explain heavy pages.** For pages with high energy, run `diagnose` automatically and
      report where the work goes (layout, paint, script, garbage collection).
- [ ] Optional: **scheduled re-scans** of submitted domains, to track change over time.

---

## A prompt to set it up with an AI assistant

Paste this into Claude Code (or another coding assistant) **running on the Mac mini or
Linux box itself**. It does the checks and installs, and stops for you at every step that
needs a password, a token or a decision.

```text
You are helping me set up this computer as a dedicated energy-measurement runner for
the GitHub repository mgifford/firefox-energy-scanner. Follow LOCAL-RUNNER.md in that
repository; it is the source of truth. Work step by step and tell me what you are about
to do before each step.

Rules:
- Ask me before any command that needs sudo or an admin password.
- Never ask me to paste the GitHub runner registration token into this chat, and never
  write it to a file. When registration needs it, give me the exact config.sh command
  with <TOKEN> in it, and I will run it myself.
- Do not change settings unrelated to this setup. Do not sign in to any account.
- If a check fails, stop, explain what failed and why, and suggest the fix.

Steps:
1. Detect the OS and CPU. Confirm this is a physical machine, not a virtual machine,
   container or WSL. Stop if it is virtual: energy cannot be measured there.
2. Check prerequisites: git and Node.js 22 or later. Tell me what is missing and how
   to install it (for Linux, the commands in LOCAL-RUNNER.md).
3. Clone https://github.com/mgifford/firefox-energy-scanner into the home directory
   (or update it if it is already there), run `npm ci`, then `npm run energy-check`.
   On Linux, if it reports perf_event_paranoid above 0, give me the sysctl commands
   from LOCAL-RUNNER.md and re-run the check after I apply them.
4. Show me the "Energy measurement" section of the output and tell me plainly whether
   this machine CAN measure energy, and what scope (per-process on a Mac, whole CPU
   package on Linux). Stop if it cannot.
5. Walk me through the "Prepare" settings for this OS from LOCAL-RUNNER.md (sleep,
   restart after power failure, automatic login on macOS, dedicated user). Check each
   one that can be checked from the command line, and list the ones I must do by hand.
6. Walk me through registering the GitHub Actions runner with the label
   `energy-scanner`, then installing and starting it as a service. Afterwards, check
   the service is running.
7. Remind me of the repository settings: the ENERGY_RUNNER variable set to
   `self-hosted,energy-scanner`, "Require approval for all external contributors" for
   fork pull requests, and putting this machine on an isolated guest network or VLAN.
8. Finish with a short checklist of what is done and what is left for me.
```
