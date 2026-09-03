# UI/UX Audit — Execution Plan

Orchestrator: session `ui-ux-component-review-sep` (2026-09-03). Source: [`01-findings.md`](01-findings.md) — 167 findings, 20 batches.

## Method (per batch)

1. **Worktree** from `origin/main` at `/Users/doriancollier/Keep/dork-os/worktrees/uiux-bNN` (branch `uiux/bNN-<slug>`), `pnpm install` + `pnpm --filter @dorkos/shared build` first.
2. **Implement** — Sonnet/Opus agent, batch findings verbatim from 01-findings.md. Playground updated alongside any changed shared primitive (maintaining-dev-playground skill).
3. **Verify** — targeted vitest for every touched package + every test rendering a changed component; typecheck + lint per package; **real-browser check** of changed surfaces: worktree client on its own port (`VITE_PORT=63NN DORKOS_PORT=6242 pnpm dev` in `apps/client`) proxying the live server, screenshotted headless via a standalone Playwright script (never the shared MCP browser — contention).
4. **Adversarial review** — separate Opus agent, REVIEW.md rubric, on the branch BEFORE the PR opens. Brief names the failure modes (the six defect shapes). Implementer fixes; reviewer re-verifies.
5. **PR** — labels per batch below; bare `gh pr merge --auto` (never `--squash` under the queue). Changelog fragment for user-visible changes (`changelog/unreleased/`); `skip-changelog` only for docs/dev-only batches.
6. **Tracker** — after each wave, one sync agent (linear-adapter skill) updates the wave's DOR issues: PR links, state transitions, Done on merge.

## Waves (≤4 concurrent worktrees; collisions decide placement)

| Wave | Batches                                                                            | Why grouped                                                                                  |
| ---- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1    | B1 overflow · B2 clipped layouts · B3 keyboard/SR · B16 docs                       | P1 visual/a11y bugs; near-zero file overlap; B16 pure docs                                   |
| 2    | B5 primitive states · B4 tokens · B6 row states · B7 touch targets                 | shared/ui core lands early so later batches build on it; B6 explicitly parallel-safe with B5 |
| 3    | B8 copy vocabulary · B9 copy register · B11 walls of text · B12 settings IA        | copy sweeps together; B10 must wait for B8+B9                                                |
| 4    | B13 session surface · B14 composition debt · B18 motion · B20 playground           | structure work after primitives settle                                                       |
| 5    | B10 copy stragglers · B15 shared/ui hygiene · B17 componentization · B19 FSD moves | dependents: B10←8/9, B15+B17←14, B19 last (moves collide with everything)                    |

Deferred-by-design: items the report flags as spec-sized (8.3, 14.1, 14.10) land in their batch when mechanical; if an implementer reports one as genuinely too large, it becomes its own follow-up issue rather than blocking the batch.

## Standing constraints

- Never touch the operator's processes (server :6242 stays up; my Vite :6241 stays mine).
- Hooks may starve under multi-agent load: hand-run the gates, `--no-verify` only when locally green (documented precedent).
- Queued PRs report `autoMergeRequest: null` (normal). CONFLICTING PRs get no CI: rebase, re-push, re-dispatch review.
- Main checkout keeps untracked `plans/ui-ux-audit-202609/`; before any `git pull` on main, remove the dir once the docs PR has merged (identical content, else pull refuses).
