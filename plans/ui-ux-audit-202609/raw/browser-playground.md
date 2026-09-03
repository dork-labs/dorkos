# Browser Audit — Dev Playground (lens 6, plus cross-cutting observations)

**Auditor beat:** live browser pass over `http://localhost:6241/dev` and its ~24 sub-pages, per the charter's 12-lens rubric, focused on lens 6 (Playground organization & coverage) but instructed to also note tokens/states/responsiveness/console issues encountered along the way.

**Result: zero pages could be audited.** The DorkOS client failed to boot on every route tested, in every navigation attempt, for the full duration of this session. This is reported as a single P1 finding below, followed by the coverage log proving the scope of the attempt.

---

## Finding 1 — Dev server fails to boot the client on every route (environment blocker, not a playground defect)

- **Lens:** cross-cutting (blocks lenses 1, 6, 8, 9 for this beat entirely)
- **Severity:** P1 — nothing renders; the app is completely unusable at the audited URL
- **Effort:** N/A — this is a dev-environment/infra issue, not an application code defect. No `file:line` fix applies; the remediation is operational (restart the Vite dev server for `apps/client`, optionally after clearing its dep cache).

**What I saw:**

Every navigation to `http://localhost:6241/` (root), `http://localhost:6241/dev` (playground), and `http://localhost:6241/activity` (a non-playground route, used to check whether the failure was playground-specific) rendered either a blank white page or the app's own top-level error boundary:

> **"DorkOS couldn't finish starting."**
> "Try again first. If that doesn't help, copy the details below and send them to us."
> Technical details: `DorkOS could not finish starting. ... Failed to load http://localhost:6241/src/main.tsx`

Screenshots (1440×900):

- `/private/tmp/claude-501/-Users-doriancollier-Keep-dork-os-dorkos/7e747ff4-181e-4e1e-b81d-0c31854b5004/scratchpad/audit-shots/dev-boot-failure-1440x900.png` — `/dev`
- `/private/tmp/claude-501/-Users-doriancollier-Keep-dork-os-dorkos/7e747ff4-181e-4e1e-b81d-0c31854b5004/scratchpad/audit-shots/root-boot-failure-1440x900.png` — `/`

Browser console showed the same 2 errors on **every single navigation** (8 attempts, across 3 distinct routes, over ~8 minutes):

```
[ERROR] Failed to load resource: the server responded with a status of 404 (Not Found)
  @ http://localhost:6241/node_modules/.vite/deps/chunk-LKT7LX4K.js?v=38ebc2ba:0
[ERROR] Failed to load resource: the server responded with a status of 404 (Not Found)
  @ http://localhost:6241/node_modules/.vite/deps/chunk-ITYIG5EM.js?v=38ebc2ba:0
```

**Root cause, as far as it could be diagnosed from outside the running process:**

- `curl` directly against the Vite dev server (bypassing the browser entirely) reproduces the same 404s for both chunk URLs — this is a server-side condition, not a browser cache artifact.
- `apps/client/node_modules/.vite/deps/_metadata.json` reports `browserHash: 38ebc2ba` — matching what the browser requests — so the running server believes this optimize-deps output is current and valid.
- The deps directory contains 628 files, all written at the same timestamp (08:04, ~8 minutes before this audit started), consistent with one completed optimize-deps run — but the two chunk files referenced by the live bundle graph are simply absent from disk. Their immediate siblings in the request sequence (e.g. `chunk-MSTPUB5V.js`, `chunk-EJRUY2ZA.js`) return 200 fine, so this is not a wholesale re-optimization race, it looks like a partial/corrupted write of two specific chunks from that run.
- Neither chunk hash appears anywhere in `_metadata.json` or in any other file in the deps directory (`grep -lE "chunk-LKT7LX4K|chunk-ITYIG5EM" *.js` finds nothing) — so the reference to them is baked into Vite's in-memory transform cache for some already-transformed source module, not recoverable by re-requesting source files.
- Disk is not full (21 GiB free on the data volume) so this isn't the known `ENOSPC` gotcha from project memory, though it has the same _shape_ of failure.

**Why I didn't attempt a fix:** the Vite process (PID 82475) is the operator's own long-running dev server, not one I started. Hard Rule 7 and this task's "look, don't touch" mandate both rule out killing or restarting someone else's process, and editing files under `apps/client/node_modules/.vite` on disk would not change the already-broken in-memory state of a running server — it needs a clean restart to pick up a consistent optimize-deps output. I did not touch any source file, config, or process.

**Recommendation:** restart the `apps/client` Vite dev server (stop the existing `pnpm dev`/`pnpm dev:dogfood` process the normal way, then start it again). If the failure recurs, force a clean re-optimization first: delete `apps/client/node_modules/.vite` before restarting. Once the app boots, re-run this playground audit beat — none of the 24 pages, hover states, or mobile viewports could be evaluated this session.

---

## Coverage

**Examined:** the charter (`plans/ui-ux-audit-202609/00-charter.md`) and `apps/client/src/dev/playground-pages.ts` (source-level enumeration of the 24 registered playground pages, confirming the page count and IDs the charter references, listed below for the re-run). Attempted live navigation to `/`, `/dev`, and `/activity` at 1440×900, 8 separate times over ~8 minutes, plus direct `curl` probes against the dev server to localize the failure to the server rather than the browser.

**Skipped (entirely, due to the boot failure above):** all 24 playground pages, every showcase within them, all hover-state checks, all console-error checks per page, and the 6-page mobile (390×844) spot-check the task specified. No `browser_click`, `browser_hover`, or any mutating interaction was attempted anywhere in the app, consistent with the safety rules — the boot failure occurred before any such interaction was possible.

**The 24 playground pages that need re-auditing once the environment is fixed** (from `PAGE_COMPONENTS` in `apps/client/src/dev/playground-pages.ts:56-81`):

`overview`, `tokens`, `forms`, `components`, `conversation`, `entry-actions`, `features`, `identity`, `topology`, `promos`, `command-palette`, `simulator`, `filter-bar`, `error-states`, `onboarding`, `tables`, `settings`, `marketplace`, `gen-ui`, `rooms`, `tour-spotlight`, `sidebar-model`, `sidebar-boot`, `one-bar` — 24 total, matching the charter's count.

**Not examined at all:** playground source code beyond the page registry (i.e., no code-reading fallback audit was substituted for the browser pass — that is the code-audit lens's job, not this browser beat's; this report covers only what a live browser pass could see, which this session was zero).
