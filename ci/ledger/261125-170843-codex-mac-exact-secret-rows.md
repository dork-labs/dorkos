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
project `.npmrc` reads. Skipped on Linux, so `codex-sandbox` is unchanged. Adds
about half a minute to the macOS job. Revert if the npm or pnpm row turns flaky
on the hosted runner.
