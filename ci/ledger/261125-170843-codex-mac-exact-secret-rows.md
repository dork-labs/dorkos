---
id: 261125-170843
title: The Codex default-permissions binary test runs the macOS exact-secret rows
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-4358. On macOS the Codex profile now names each secret file exactly
instead of a deep `**` glob, which had stopped every folder under the home
and project from being removed or renamed. `default-permissions.binary.test.ts`
(run by both `codex-sandbox` and `codex-binary-macos`) gains a macOS-only block
on the real Seatbelt sandbox: a `.env` made in one turn is shut in the next; a
named secret can't be read, moved, unlinked or hard-linked and keeps its folder;
folders without one can be removed and renamed (with a control that the old
globs still lock them); `npm ci` runs twice and pnpm installs twice with a
bounded process count; `known_hosts` reads but never writes and a tracked
project `.npmrc` reads. A matrix row runs an unlink and then a write at three
protected paths under the previous profile and this one, at acceptEdits and
Full, judged by each call's exit status and the file read from outside the
sandbox: on macOS 26.7.2 a shell inside the sandbox no longer sees such a file,
so a check from inside (`[ -e ]`) can't tell whether it is still there. The
macOS rows are registered only on macOS, because the Linux `codex-sandbox` job
requires every row it runs to pass, so that job is unchanged.
In `app-server.binary.test.ts`, the protected-probe row's first-turn check of
its mid-turn secret is skipped on macOS by design; the secret is kept for the
next two turns, whose renders must cover it. Adds
about half a minute to the macOS job. Revert if the npm or pnpm row turns flaky
on the hosted runner.
