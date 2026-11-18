# The bounded candidate queue

`queue` turns a result's investigation queue into a reviewable plan. It starts
no browser, runs no experiment and measures no energy.

```bash
node dist/cli/index.js queue results/crawl-….json \
  --allow-file allow.txt \
  --max-candidates 5 \
  --max-pages 3 \
  --max-energy-runs 24 \
  --write
```

It writes `<result>.candidate-queue.json` (`candidate-queue/1`) and prints the
selected and rejected candidates. The measured result is not rewritten.

## Policy

| Limit | Default | Meaning |
| --- | --- | --- |
| `max-candidates` | 5 | selected candidates |
| `max-pages` | 3 | distinct selected pages |
| `max-energy-runs` | 24 | estimated browser runs, counting runs and warm-ups on both sides |

A default experiment of 10 measured runs per side plus 2 warm-ups per side is
24 runs. The estimate is a planning limit, not a measurement or a promise.

## Allowlist

`--allow-file` takes one rule per line:

```text
host:www.example.org
url:https://www.example.org/about/
prefix:https://www.example.org/blog/
```

A bare line is a host. `host` is exact (www and non-www are separate); `url`
uses FES page identity; `prefix` is a URL prefix. Blank lines and lines starting
with `#` are ignored.

Without `--allow-file`, the policy defaults to the result's target host. If the
result has no target and no host can be derived, the command refuses to run.
`#` comments are file-line comments, not shell comments.

## What is selected

The investigation queue's order is kept. For each item:

1. it must have a page;
2. the page must be allowlisted;
3. it must not duplicate an earlier page/target/kind;
4. it must have a proposed experiment (unless the policy is built with
   `requireRemedy: false`; the CLI uses `true`);
5. the candidate, page and estimated-run budgets must still fit.

Every rejected item is kept with a reason (`not-allowlisted`,
`over-candidate-budget`, `over-page-budget`, `over-energy-budget`, `duplicate`,
`no-experiment`, `no-page`). Nothing is silently dropped.

## Provenance and pairing

Each candidate records:

- the investigation rank, item id/kind/title, evidence tier and because lines;
- the target page and selector;
- the proposed experiment spec and note (not executed);
- **pairing**: site origin, page, the FES viewport, session id, session start and
  `source: fes-investigation`;
- provenance: source file and SHA-256, investigation method and rank.

The pairing key is `siteOrigin|pageKey|widthxheight`. It is a record for later
run/viewport matching; it does not join accessibility, performance or energy
evidence by itself. A candidate from a different viewport or session will have a
different key and must not be treated as the same run.

The queue ID is deterministic for the same source session, viewport, policy and
candidate outcomes. Re-running on the same result gives the same queue ID and
candidate IDs; a new result/session gives a new queue ID. This is not a
cross-run store.

## Why the queue is bounded

- **Allowlist** stops a stored third-party URL from being tested because it
  happened to appear in a crawl.
- **Page budget** stops a plan from becoming a site-wide scan.
- **Candidate budget** bounds review work.
- **Energy-run budget** bounds the physical measurement a person might start.
- **Dedup** stops the same target appearing twice.
- **No automatic execution** keeps a plan from becoming an unreviewed physical
  run, especially in CI.

The queue does not decide that a candidate will save energy. The existing
evidence rules still apply: an experiment must apply and hold, keep its checks,
report confidence separately from replication, and preserve null and
inconclusive results.

## What this does not do

- No browser or accessibility engine.
- No automatic experiment, especially no physical-energy run.
- No accessibility context import into candidates; that needs the pairing and
  selector work.
- No combined accessibility/performance/energy score.
- No cross-result idempotency store.
- No broad component attribution: the candidate target is still the
  investigation item and its selector, not a claim that the component caused a
  finding.

## Example from the fixture

```bash
node dist/cli/index.js queue tests/fixtures/fixture-site-result.json \
  --max-candidates 3 --max-pages 2 --max-energy-runs 24 --write
```

It selects one candidate and rejects the rest for energy budget, no experiment
or duplication. That is the intended shape: a small, auditable plan.

## Next: report navigation

The second P2 piece is the site → family → component → script → evidence
navigation, with reverse links and source/window/unit/boundary beside each
metric. This queue already carries the pairing key those links will use.
