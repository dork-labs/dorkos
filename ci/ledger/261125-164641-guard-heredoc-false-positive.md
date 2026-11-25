---
id: 261125-164641
title: The heavy-command guard reads `bash <script file>` as running a file, so quoted heredocs beside it stay text
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

Nov 25: once the user-level wrapper put every session under the guard, it refused honest commands. A quoted heredoc
(a PR body mentioning `pnpm vitest run`, a Python script with a backticked `tsc`) was parsed as commands whenever the
same line also ran `bash scripts/<x>.sh`, because any shell word made the guard unmask the whole line, and command
substitutions were read from the unmasked text.

Now a segment feeds a shell only for `bash -c`/`-s`, `eval`, or a shell with no script-file argument (piped into, or
`bash <<EOF`), and substitutions are read from the masked line unless a shell will run it. Still refused: `bash <<EOF`
and `cat <<EOF | bash` with a heavy body, `bash -s`, `sh -lc`, `eval`, a double-quoted `$(…)`, and a heavy command
beside `bash <script>`. `merge-guard.mjs` and `pr-create-guard.mjs` carry the same `feedsAShell`; aligning them is a
Security call. Revert if a heavy command is found to pass through a form this now reads as text.
