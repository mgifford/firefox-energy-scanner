# 2026-10-26 — CrUX arrives as a fourth indicator, and stays out of the way

**Task:** Add optional Chrome UX Report field data beside the lab and energy results,
without replacing Lighthouse.

**Changed:** `src/core/crux.ts`, `src/report/crux-html.ts`, `src/cli/index.ts`,
`tests/crux.test.ts`, `docs/crux.md`, TDR-011, README.

**Evidence:** `npm test` → 423 passed, 21 new. `measure … --crux` with no key failed in
0.245 s, before Firefox launched; `crux http://localhost:8080/` refused before sending,
and a test asserts the fetch was never called.

**Worked:** making `no-data` a status, not an exception — a 404 on a low-traffic preview
is the common case.

**Cost time:** a test caught the report calling a `PHONE` record "all form factors": it
read the request, not the response.

**Next:** run the live checklist in `docs/crux.md`; the maintainer supplies the key.
