---
id: 261125-224135
title: Heavy jobs from any runtime go through the load gate by PATH shims that read real argv
kind: hygiene
status: proposed
actor: agent
gates: [wf.scripts-test.fixtures]
prs: []
ratchet-release: []
field-changes: []
---

The load gate is reached today only through command TEXT: `.claude/hooks/heavy-command-guard.mjs` in bare
Claude Code, and the server's classifier (`heavy-classifier.ts`) for Claude Code, Codex and OpenCode chats. A
heavy command inside a script, a variable or an alias walks past both, and Dork (DorkOS's own runtime) has no
gate at all. On Nov 25 the Mac panicked twice from memory, with about 600 typechecks and 2,200 vitest runs
outside the gate.

`scripts/heavy-shims/` (`pnpm`, `npx`, `tsc`, `vitest`, `turbo`; body `scripts/lib/heavy-shim.sh`) wraps the
programs themselves. Put first on PATH by DorkOS's new `runtimes.environment.pathPrepend` (product PR
`feat/runtime-path-prepend`), each shim judges the real argv by the hook's rules. A heavy run goes through
`heavy-run-lock.sh --job|--tests` by absolute path; anything else runs the real program unchanged. Recursion has
four independent stops. The gate gets the real path. PATH loses the shim folder under the gate, which survives
turbo's strict env. `DORKOS_HEAVY_SLOT_HELD` passes straight through. A depth cap of 3 holds. Self-resolution
is refused. 57 fixtures in `scripts/test-heavy-shims.sh`.

Hygiene, not an experiment: no catalogued metric counts heavy runs that skipped the gate. `tracked.machine-load`
is explicitly unscored, and `tracked.gate-cut-short` covers only hook runs. A future metric could count
`load_wait`/`lock_*` notes per runtime against process samples.

Not enabled anywhere by this change: the setting is off by default and the operator turns it on. Known limits:
a login shell can put `/opt/homebrew/bin` ahead of the shims (macOS `path_helper` plus `brew shellenv`; Codex
runs login shells, and Claude Code replays a login-shell PATH snapshot). And `scripts/load-gate/turn.ts` lets a
run through whenever ANY ancestor owns a running ticket. Under DorkOS that ancestor is the server, so a shim-gated
job skips the line while another agent's heavy job runs.

Revert if a shim ever loops, changes a light command's argv, stdin or exit code, or makes `pnpm` noticeably
slower for light commands.
