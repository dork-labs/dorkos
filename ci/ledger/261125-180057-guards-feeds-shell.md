---
id: 261125-180057
title: merge-guard and pr-create-guard read `bash <script file>` as running a file, so quoted heredocs beside it stay text
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

Nov 25: the same false positive #4436 fixes in the heavy-command guard. Any shell word on a line (`bash`, `source`,
`.`, ...) made these two guards read quoted heredoc bodies as commands, so a PR body heredoc naming `gh pr merge
--admin` or `gh pr create` beside `bash scripts/open-pr.sh` was refused. Security asked on #4436 for the two guards to
be aligned.

Now a segment feeds a shell only for `eval`, `ssh`, `-c`/`-s` (also `-lc`), or a shell with no script file (piped into,
`bash <<EOF`, `bash << EOF`). Stricter than #4436 on purpose, since these are security guards: the script file still
counts as text when it is `/dev/stdin`, a `<(...)` or a file the same line writes (`cat > m.sh <<'EOF' ... bash m.sh`,
`echo ... > m.sh && bash m.sh`, `tee`). #4436's masked substitution read is NOT applied: the shared reader's text-taker
allowlist is what keeps `git rebase -x 'echo $(gh pr merge 1 --admin)'` and `trap '...'` refused, and masking would let
them through. Revert if an admin merge or a raw PR create is found to pass through a form this now reads as text.
