---
id: 261125-214317
title: The macOS pnpm row caps the sandboxed command's processes, not Codex's helpers
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-4358 follow-up. The pnpm row in `default-permissions.binary.test.ts` (run by
`codex-binary-macos`) capped every new process under the Codex app-server at 6,
but Codex starts its own helpers beside the command (`codex`, and `sandbox-exec`
for its own tools), 7–11 of them, so the probe failed on a runner (run 45703195902) with no runaway. It now counts only the command's shell (a `zsh`,
`bash` or `sh` child of the app-server) and what runs under it, found by
`pgrep -l` (program names, never command lines), and falls back to the whole
tree if no poll saw the shell. Polls every 25 ms. The 10 s kill, the 40-process
whole-tree kill, the `ulimit` line and the version check are unchanged. Locally:
8 of 8 green, with the command at 2 processes (zsh, node) against a whole tree
of 10–11. Revert if the shell is ever missed and the fallback reds the row.
