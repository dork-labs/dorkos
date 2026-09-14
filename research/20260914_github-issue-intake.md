---
title: 'GitHub issue intake — how issues on dork-labs/dorkos get discovered and handled today'
date: 2026-09-14
type: internal-architecture
status: active
tags: [feedback, github-issues, flow, linear, triage, intake]
---

# GitHub issue intake

**Date:** 2026-09-14
**Why:** DorkOS routes tracker work through `/flow`, whose only tracker adapter is `linear-adapter`, and user feedback that lands in Linear has a documented process (`/feedback:triage`). Some users report bugs by opening **GitHub issues** instead. This report answers whether anything reads those, how that compares with the Linear feedback process, what is open right now, and what to build so both doors get the same treatment.
**Method:** repo-internal sweep of the flow plugin (`.dork/plugins/flow/`), `.github/`, `scripts/`, `.claude/`, `contributing/`, `docs/`, `meta/`, the client and CLI feedback code; `gh` reads of the open and closed issue lists, labels and timelines; read-only Linear GraphQL reads (search, attachments, integrations) through the `dorkos` Composio account. No product code, issue, or tracker item was changed by this investigation.

## TL;DR

- **Nothing reads GitHub issues.** No flow adapter, no bridge, no workflow, no script, no scheduled task. The one GitHub-issues artifact in the repo, `.github/dorkbot-triage/`, shipped **off** (PR #235, 2026-07-26) and its queue is empty by construction because the `needs-triage` label it watches was never created.
- **GitHub is a real front door, not a side door.** The help menu's "Report on GitHub…", the `dorkos feedback` CLI, the README, and two docs pages all send people to `github.com/dork-labs/dorkos/issues/new`. Only the in-app "Send feedback" dialog reaches the Linear feedback (`FB`) team that `/feedback:triage` processes.
- **Two issues are open right now**, both filed 2026-09-13 by an external user, both zero comments, neither in Linear. The same reporter's earlier issue (#1458) was handled in 23 hours, entirely by the operator by hand.
- **Recommendation:** extend `/feedback:triage` with a GitHub intake step that mirrors each new open issue into the FB team, and a matching GitHub-side "shipped" comment in `--sweep`. Not a GitHub flow adapter (it would replace Linear, not add GitHub), and not Linear's GitHub Issues sync (it would leak internal triage comments onto the public issue).

## 1. Is there a GitHub-issues adapter, bridge, or reader?

No. Evidence, by place:

| Where                                             | What is there                                                                                                                                                                                                    | Reads GitHub issues?                                            |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `.dork/plugins/flow/adapters/reference/`          | `linear-composio/`, `linear-mcp/`, `fixtures/` only                                                                                                                                                              | no                                                              |
| `.dork/plugins/flow/config/config.schema.json`    | `"tracker": { "enum": ["linear"] }` — one tracker per install                                                                                                                                                    | no; a GitHub adapter would _replace_ Linear as flow's tracker   |
| `.dork/plugins/flow/skills/*`                     | 15 skills; GitHub Issues appears only as the hypothetical "second adapter that proves agnosticism" (`linear-adapter/SKILL.md:35`, `building-adapters/SKILL.md:43`, `docs/SPEC.md:328`, `scripts/work-item.ts:3`) | no                                                              |
| `.github/workflows/claude.yml`                    | `on: issue_comment` — answers an `@claude` mention, and only from `OWNER`/`MEMBER`/`COLLABORATOR`. No `issues:` trigger. An external reporter cannot summon it.                                                  | no (reactive, maintainer-only)                                  |
| `.github/workflows/claude-code-review.yml`        | `issues: read` permission, used to read PR comments via `repos/$REPO/issues/$PR_NUMBER/comments`                                                                                                                 | no                                                              |
| Scheduled workflows                               | `codeql.yml` (weekly), `merge-tail.yml` (every 10 min, PR auto-merge), `evals.yml` (daily)                                                                                                                       | no                                                              |
| `scripts/`, `.claude/hooks/`, `.claude/scripts/`  | zero matches for `gh issue` or `/issues`                                                                                                                                                                         | no                                                              |
| `~/.dork/tasks/` (this machine's scheduled tasks) | no task mentions GitHub or issues                                                                                                                                                                                | no                                                              |
| Linear workspace                                  | one `github` integration (created 2026-03-28) — the PR-link one. `attachmentsForURL` for issues #1458, #1840 and #1841 returns `[]`, so Linear's GitHub Issues sync is **not** on for any team.                  | no                                                              |
| `.github/dorkbot-triage/README.md` + `SKILL.md`   | a prose skill for DorkBot: label, dedupe, ask for repro on issues carrying `needs-triage`. "It ships **turned off**. Nothing here runs a live bot, and there is no GitHub Action."                               | designed to, never enabled; see §2 for why it could not run yet |

## 2. Is there a documented process for a GitHub issue?

Only the dormant DorkBot scaffold, and it has a broken precondition:

- `.github/ISSUE_TEMPLATE/bug.yml` declares `labels: ['bug', 'needs-triage']`, and `dorkbot-triage/SKILL.md` defines its queue as "open issues carrying the `needs-triage` label".
- `gh label list -R dork-labs/dorkos` shows: `bug documentation duplicate enhancement good first issue help wanted invalid question wontfix review:deep review:light skip-review re-review skip-changelog run-evals hold cloud-contract`. **There is no `needs-triage` label.** GitHub silently drops a template label that does not exist, which is why both open issues carry only `bug`.
- The in-app and CLI report builders (`packages/shared/src/feedback.ts`, `LABELS_BY_KIND`) apply only `bug` or `enhancement`, never `needs-triage`.

So even if someone turned the DorkBot skill on today, its queue would be empty. Nothing else exists: no AGENTS.md rule, no `contributing/` page, no `/feedback:*` or `/flow:*` command mentions GitHub issues. `meta/positioning-202607/09-gtm-plan.md` §3.7 planned "issue templates with labels wired to the Linear sync, and a triage agent (DorkBot) that labels, dedupes, and asks for missing repro info within the hour"; PR #235 shipped the templates and the skill scaffold and recorded "No GitHub↔Linear label sync exists in this repo today."

### The Linear feedback process, for comparison

`.claude/commands/feedback/triage.md` (ops runbook: `contributing/feedback-pipeline-ops.md`) is a complete loop over the **DorkOS User Feedback** team (`FB`, id `81f94d0d-…`):

| Step                      | Linear feedback (`/feedback:triage`)                                                                         | GitHub issue |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------ |
| Intake surface            | FB team Triage; every API-created issue lands there automatically                                            | none         |
| Reader                    | one GraphQL read scoped by `team(id:)`                                                                       | none         |
| Dedupe                    | `searchIssues` across FB and DOR; duplicate stays in Backlog with a `related` link to the same DOR issue     | none         |
| Accept                    | create a DOR issue, `related` relation FB→DOR, FB → Backlog                                                  | none         |
| Decline                   | comment reason, FB → Canceled; a drafted reply email if a `Reporter:` line exists, each one approved by hand | none         |
| Status mirror to reporter | Linear webhook → Neon → `dorkos.ai/feedback/<row-id>` page                                                   | none         |
| "Shipped" notice          | `--sweep` (release flow only) moves FB → Done, which fires the email                                         | none         |
| Anomaly report            | printed at the end of every run (no DOR link, early Done, stale Triage, canceled DOR)                        | none         |
| Provenance on every write | `agent:provenance` line                                                                                      | none         |

### The product has two feedback doors, and only one is watched

| Door                                                                                                           | Where it is offered                                                                                                                                                                                                       | Lands in     | Consumer               |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------- |
| **Send feedback** (in-app dialog, `apps/client/src/layers/features/feedback/`)                                 | command palette "Send feedback" (the primary path since the GitHub palette entry was demoted, `palette-contributions.ts:149`), help menu first row                                                                        | FB team      | `/feedback:triage`     |
| **Report on GitHub…** (`apps/client/src/layers/shared/model/report-issue/`, `packages/shared/src/feedback.ts`) | help menu `⋯` sub-menu (`HelpMenuItems.tsx:65`), `dorkos feedback` CLI (`packages/cli/src/commands/feedback.ts`), README "File an issue", `docs/getting-started/troubleshooting.mdx:150`, `docs/guides/cli-usage.mdx:244` | GitHub issue | **nobody, by process** |

`use-send-feedback.ts` even falls back to "a nudge toward the GitHub option on failure", so the GitHub door is the documented backstop for the watched door.

## 3. What could run on a schedule and pick up GitHub issues?

Nothing today.

- `/feedback:triage` (default mode) pulls only the FB team, by `team(id:)`; `--sweep` walks FB issues with DOR links. Neither names GitHub. Its `allowed-tools` are `Read, Bash(composio:*), Bash(curl:*), Bash(python3:*), Bash(node:*), AskUserQuestion` — no `gh`.
- `/flow:groom check` is the only cron-shaped flow skill (`flow-groom/SKILL.md`, `cron: '0 9 1 * *'`, `enabled: false`); it and `flow-drain` read the DOR team through the adapter. `/flow:capture` and `/flow:triage` take an operator's argument, not a feed.
- The three scheduled GitHub Actions (CodeQL, merge-tail, evals) never touch issues.
- The DorkBot scaffold's README says a live bot "would run as a scheduled DorkOS Task or a GitHub Action" and lists that as a future owner decision.

## 4. The current backlog (`gh issue list -R dork-labs/dorkos --state open`, 2026-09-14)

| #     | Opened               | Author                                    | Labels | Comments | Title                                                                                                                                                                  | In Linear?                                                                                             |
| ----- | -------------------- | ----------------------------------------- | ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| #1840 | 2026-09-13 19:15 UTC | karlohlemann (`author_association: NONE`) | `bug`  | 0        | Desktop enters ~12s reload loop when first paint exceeds 10s; late heartbeat resets recovery ladder (reporter: **High**, "repeatedly destroys unsaved operator input") | **No.** `searchIssues` on "reload loop", "heartbeat", "first paint": no DOR or FB match; no attachment |
| #1841 | 2026-09-13 19:43 UTC | karlohlemann                              | `bug`  | 0        | "Can't reach its server" panel is gated on the /api/config query rather than reachability (reporter: **Medium**, split out of #1840 on purpose)                        | **No.** Same searches, no match; no attachment                                                         |

Both are about one day old, both used the bug template by hand (the `### What did you expect?` / `### Steps to reproduce` headings are present), both are long, source-cited desktop reports against 0.74.0 on macOS arm64. Neither has been acknowledged.

**Would the Linear feedback process have caught each one?** If they had come through "Send feedback", yes: both would sit in FB Triage, `/feedback:triage` would dedupe them against DOR, accept them into DOR issues with a `related` link, and the reporter's status page would move as the DOR work moved. Because they came through GitHub, no command, cron, or runbook ever sees them; they surface only if the operator reads GitHub notifications.

**History (`--state closed`):** exactly one closed issue exists, #1458 (Remote Access tunnel fails to start, same reporter, 2026-09-02). The operator replied within 17 hours, four PRs (#1507, #1509, #1510, #1517) cross-referenced it, DOR-1738/1739/1741 cite it in their text, and it closed 23 hours after opening with a full write-up to the reporter. That is the right outcome, produced by the operator doing every step by hand, with no FB record, no status page, and no `agent:provenance` trail. It also means the one time a GitHub issue was handled, it got _better_ treatment than the process gives Linear feedback, but only because the operator happened to be looking.

## 5. Options considered

| Option                                                      | What it entails                                                                                                                                                                                                                                                                 | Verdict                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. GitHub flow adapter** (`building-adapters` skill)      | A ~500-line adapter `SKILL.md` implementing all 16 required verbs (8 reads + 8 writes), every optional verb declared, a `WorkItem` fixture, and a green `validate-adapter.ts` run. Also needs the `tracker` enum widened and GitHub-side `agent/*`, `stage/*`, `type/*` labels. | **No.** `tracker` is a single value; this makes GitHub Issues _the_ tracker for flow, not a second intake. The work items flow drives are DOR tasks, not user reports. Days of work to solve the wrong problem.                                        |
| **B. Linear's native GitHub Issues sync**                   | Toggle in Linear settings; mirrors issues into a team both ways, including comments and state.                                                                                                                                                                                  | **No.** FB team comments are internal by design ("a comment on the FB issue is never reporter-visible", `triage.md`); a two-way sync publishes them on the public issue. It also bypasses Neon, so the status page and shipped email never fire.       |
| **C. GitHub Action on `issues: opened`** that files into FB | A workflow calling the site's `POST dorkos.ai/api/feedback` with the issue body.                                                                                                                                                                                                | **Later, maybe.** Real-time is not needed for a queue processed by a command; it adds a token, a public-write surface, and CI minutes (the Free-plan runner cap already hurt the merge queue). Only worth it if the polling step in D proves too slow. |
| **D. Extend `/feedback:triage` with a GitHub intake step**  | See §6.                                                                                                                                                                                                                                                                         | **Yes.** One command already owns the loop, the dedupe, the anomaly report, and the release-time sweep. Adding a second source to it is the smallest change that gives both doors identical treatment.                                                 |

## 6. Recommendation: teach `/feedback:triage` to read GitHub

Build one thing: a **GitHub intake step at the top of `/feedback:triage` Mode 1**, plus a **GitHub half of `--sweep`**. Every GitHub issue then becomes an FB issue and rides the existing process unchanged.

**Intake (Mode 1, before the FB queue read):**

1. `gh issue list -R dork-labs/dorkos --state open --json number,title,body,author,createdAt,labels,url` (add `Bash(gh:*)` to the command's `allowed-tools`).
2. For each issue with no FB mirror yet (detect by a `Source: https://github.com/dork-labs/dorkos/issues/<n>` line in FB descriptions, read with the same GraphQL query the command already runs): create an FB issue through the same shape the site intake uses — kind label `Bug` or `Feature` from the GitHub label, title verbatim, description quoting the report with the `Source:` line, and `Reporter: @<github-login>` (a handle, never an email). It lands in FB Triage like every other report, and the rest of Mode 1 (dedupe, accept → DOR + `related`, decline → Canceled) applies without a special case.
3. Post one comment on the GitHub issue: "Tracked as FB-nn; we'll update this issue when it ships", ending with the `agent:provenance` line. That is the receipt email's twin. One comment per issue, ever; the FB mirror is the idempotency key.

**Sweep (`--sweep`, release flow only):** when an FB issue with a `Source:` GitHub line moves to Done, post "Shipped in vX.Y.Z" on the GitHub issue and close it as completed. Declined ones get the reason as a comment and close as not planned. This is the GitHub twin of the shipped email, gated by the same release-only rule.

**Anomaly report additions:** open GitHub issues with no FB mirror (intake failed), FB mirrors whose GitHub issue was closed by someone else (reporter gave up or a maintainer closed by hand).

**Cost:** about half a day. It is prose in one command file (~60 lines), one new section in `contributing/feedback-pipeline-ops.md`, and a `gh` allow-list entry; there is no product code. The `gh` CLI is already authenticated on the operator's machine, so no new token. Also fix the label gap while there: either create `needs-triage` (`gh label create needs-triage …`, the command the DorkBot README already prints) or drop it from `bug.yml`; the intake step above does not depend on it, so dropping it is the simpler choice.

**What it does not do, on purpose:** it does not run unattended. `/feedback:triage` is already a human-in-the-loop command (declines need per-email approval), and a bot that writes on a public repo needs the owner decision the DorkBot README describes. Once the intake step has run by hand a few times, scheduling it is a one-line DorkOS Task, the same route `flow-groom` documents.

**Interim manual step, starting today:** at the top of every `/feedback:triage` run, and in any case once a day until the step lands, run `gh issue list -R dork-labs/dorkos --state open` and file each new issue into FB by hand (Linear: new issue in DorkOS User Feedback, `Bug`/`Feature` label, `Source:` line with the GitHub URL, `Reporter: @login`), then reply on the GitHub issue that it is tracked. #1840 and #1841 are the two to do first.

## References

- `.claude/commands/feedback/triage.md` — the Linear feedback loop this report extends
- `contributing/feedback-pipeline-ops.md` — pipeline parts, credentials, verification
- `.github/dorkbot-triage/README.md`, `SKILL.md` — the dormant GitHub triage scaffold (PR #235, DOR-292)
- `.github/ISSUE_TEMPLATE/bug.yml`, `feature.yml`, `runtime.yml` — the templates (declare a label that does not exist)
- `packages/shared/src/feedback.ts` — the prefilled-issue URL builder shared by the app and the CLI
- `.dork/plugins/flow/skills/building-adapters/SKILL.md`, `.dork/plugins/flow/adapters/SPEC.md` — what a flow adapter costs (option A)
- `meta/positioning-202607/09-gtm-plan.md` §3.7 — the original "feedback rails" plan
