# UI audit landing profile — DorkOS

How audit work lands in **this** repo. `run`, `pulse`, and `execute` read this file and behave
differently by its answers (`auditing-ui` SKILL.md §1). Captured 2026-09-07, during the first real
run (`lens:tokens`), by inferring from the repo and `AGENTS.md` rather than by interview.

| Question            | Answer                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Landing style**   | Merge queue. Everything lands via PR; direct pushes to `main` are rejected. Arm with a bare `gh pr merge --auto`, then verify armed **or** queued (a queued PR reports `autoMergeRequest: null`).                         |
| **Changelog**       | Per-change fragments in `changelog/unreleased/<id>-<slug>.md`. A docs-only PR uses the `skip-changelog` label instead.                                                                                                    |
| **Isolation**       | One worktree per batch, based on `origin/main`. Never branch-switch a shared checkout.                                                                                                                                    |
| **Formatting gate** | CI fails on formatting. Run last before every push: `pnpm lint:root && pnpm exec prettier --write <changed files>`.                                                                                                       |
| **Tracker mode**    | The `/flow` plugin's `linear-adapter` skill. **Team `DOR`.** No fixed project — audit items stay project-less until promotion routes them.                                                                                |
| **Browser leg**     | Yes. `VITE_PORT=<your port> DORKOS_PORT=6242 pnpm --filter @dorkos/client dev` from your own worktree. Ports **6241, 6242 and 4242 are the operator's, always**; pick your own (6251+) and stop only the PID you started. |
| **Run-log root**    | `audits/runs/ui/`.                                                                                                                                                                                                        |

## Notes that change behavior

- **The browser leg proxies to the operator's real server** (`:6242`), so the data behind your
  client is real. Navigate, resize, hover, screenshot, read the console — click nothing that
  creates, renames, deletes, sends, or archives.
- **A fresh worktree has no `node_modules`.** `pnpm install` there before the browser leg, or the
  Vite config cannot resolve `@dorkos/shared/constants` and the dev server never starts.
- **Fence labels.** `source/audit` (provenance) and `audit/claimed` (in-progress visibility) must
  exist in Linear before an emission references them. Never write an `agent/*` label — those are
  the workflow engine's own claim labels.
- **Run-log commits** carry the `skip-changelog` and `review:light` labels: they are docs.
