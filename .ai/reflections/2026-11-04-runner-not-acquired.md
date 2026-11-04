# 2026-11-04 — old requests asked for hosted Macs that never came

**Task:** Resolve runs 41861285854 and 41861250733 (issues #3, #7), both cancelled.

**Changed:** `src/cli/issue-parser.ts` (legacy `macos` now runs on Linux, with a note),
`scan-request.yml` (no `macos-latest`; a `report-not-started` job).

**Evidence:** both jobs: "The job was not acquired by Runner of type hosted even after
multiple attempts", labels `["macos-latest"]`, 15 minutes queued, no comment posted.
`npm test` → 510 passed.

**Worked:** reading the job's labels before blaming the code.

**Cost time:** a failure report that lives inside the job it reports on.

**Next:** after merge, add `rescan` to #3 and #7; maintainer.
