---
id: 261008-061500
title: Give the complete server typecheck a measured compiler heap budget
kind: incident-fix
status: active
actor: agent
gates:
  - wf.typecheck.typecheck
prs: [2686]
hypothesis:
  metric: 'gate.wf.typecheck.typecheck.failure_rate@pull_request'
  baseline: 0.05
  baseline_source: 'origin/ci-steward-data snapshots/2026-10-06.json: wf.typecheck.typecheck@pull_request, 19 success, 1 failure, 3 cancelled; 1 / 20 decided. Supplemental incident: PR2686-FIRST-TYPECHECK-FAILURE.log, complete required server typecheck exited134 near4079MiB heap; current complete local compiler trace CURRENT-SERVER-TYPE-TRACE.raw reports6805files,1250015TypeScriptlines,5236653K memory at6144MiB old-space.'
  target: 0.01
  after_days: 14
ratchet-release: []
field-changes: []
---

PR 2686's required typecheck reached the server compiler's approximately 4 GiB heap ceiling
and aborted with exit 134. Narrowing test spies did not repair the complete check. The retained
Node 24.14.1 diagnostic checked the same complete server tsconfig at 6144 MiB old-space,
with 6,805 files and 1,250,015 TypeScript lines, and reported 5,236,653 K of memory used.
Its exit 0 is diagnostic evidence, not verification of this changed package script or the
required full-monorepo command. The original failure logs remain retained.

Change only the server's typecheck script to invoke the current Node with
`--max-old-space-size=6144` and its own installed `typescript/bin/tsc --noEmit`.
The package-local path resolves the declared TypeScript dependency on Windows, macOS and
Linux without a shell environment assignment or a global compiler. The same complete
configuration, strictness, included tests, exclusion ratchet and diagnostic exit remain.
No runtime, build, native qualification or other package receives this heap setting.
The required job still runs `pnpm exec turbo typecheck --continue`; no retries, timeout,
shard, required status or quality floor changes.

Capacity: typecheck.yml uses ubuntu-latest and Node 24. The repository is public; GitHub's
[standard public Linux runner documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
lists 4 CPU and 16 GB RAM for that label. This is a 6 GiB V8 old-space ceiling, not an RSS
limit or an allocation reservation. Turbo's existing concurrency is 15, so aggregate peak
memory with other compilers remains unmeasured and must be checked by the real required
command. Separate GitHub jobs use separate machines. Do not infer that concurrent package
tasks fit from the server-only trace. No wider workflow allocation is proposed here.

Verification before adoption/merge: run the actual package typecheck once freshly with
Node 24 and no caller NODE_OPTIONS override, followed by the original full required
`pnpm exec turbo typecheck --continue` in its ordinary runner environment. Preserve full
outputs and exit codes; inspect system memory pressure as well as heap OOM. Run CI census,
ledger-check and ledger coverage against the actual main merge base. The
full required concurrent command remains unverified. The actual changed package command
completed locally with exit 0 in 28.691 seconds, with caller NODE_OPTIONS removed and
original EOF/process-group return retained (CURRENT-SERVER-REQUIRED-HEAP-TYPES-RETURN.json).
CI census and ledger-check also passed locally. Do not substitute the traced command
or a reduced root set. Revisit/revert this allocation if the full job hits system
memory pressure or still aborts; investigate program size rather than blindly raising it.

The refreshed CI Steward snapshot is healthy (2026-10-06), with browser-shard timeout
headroom as the current pipeline constraint. This change addresses a new deterministic
compiler incident; it is not a claim to improve that separate constraint or browser
production resource admission. The collector owns the after-window verdict.
