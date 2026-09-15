---
title: 'A room-led, multi-agent setup of three sibling repos — what worked, what broke, and what DorkOS should change'
date: 2026-09-15
type: retrospective
status: active
tags: [rooms, relay, approvals, marketplace, harness-sync, flow, agents-as-operators, autonomy]
---

# A room-led, multi-agent setup of three sibling repos

**Date:** 2026-09-15
**Why:** The operator asked the DorkOS agent, in the `#dorkos` room, to lead three other agents (Blintz, DorkOS Cloud, DorkOS Marketplace) through setting up their repos with the DorkOS repo's skills, safety hooks and the `/flow` plugin, "largely without me". Four agents and one person worked in one room for about three hours. This report records what the afternoon produced, every defect it surfaced, and the product changes it argues for. It is the source for DOR-2057 through DOR-2062 and for the operator's question "why am I getting so many approval requests?"

## 1. What happened, in order

| Time  | Event                                                                                                                                                                       |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12:12 | Operator asks the DorkOS agent to lead. It inventories its own tooling, posts the list to the room canvas, briefs the three agents.                                         |
| 12:19 | All three agents report their inventory within a minute. Two cannot see the canvas yet (write raced their read). Flow installs come back `requires_confirmation`.           |
| 12:20 | Two decisions surface that only the operator can make: the private Linear team (CLD) is invisible to the flow bot account, and the marketplace repo has no team.            |
| 12:29 | Cloud finishes copying (43 files). Reviewed on disk before "done" is accepted.                                                                                              |
| 12:33 | Blintz finishes; review finds the requested `AGENTS.md` missing and the private repo named in a public file. Both fixed before merge.                                       |
| 12:38 | Blintz reports a guard-hook false positive. First reproduction (plain words) says "not a bug"; Blintz's repro with backticks proves it is. Bug confirmed in all four repos. |
| 12:40 | Marketplace's turn errors mid-flight; its staged work is verified on disk and it is told how to finish. Its PR also named the private repo, in six files.                   |
| 13:09 | Operator answers: installs approved, bot added to CLD, fix the hook bug, keep Linear auto-close.                                                                            |
| 13:12 | Both approved installs complete **without** projecting anything into `.claude`. Both agents symlink by hand. Root cause found and filed as DOR-2057.                        |
| 13:15 | Flow's Linear adapter names a Composio tool that no longer exists; fixed in marketplace PR #30 the same hour.                                                               |
| 13:39 | A relay-dispatched session for DOR-2057 stalls on its first Bash call and never recovers. Work is reassigned to an in-session helper.                                       |
| 13:45 | Writing skill pack ships to the marketplace (PR #31) after a provenance check of every skill.                                                                               |
| 14:09 | Hook fix opens as PR #1873 after **three** adversarial review rounds, each of the first two finding real false negatives.                                                   |
| 14:48 | PR #1873 merges. The room session ends; the in-session helper working on DOR-2057 dies with it, leaving an unpushed commit and uncommitted edits.                           |
| 15:06 | Operator reports FB-26: approving the schedules the flow install raised fails every time.                                                                                   |
| 15:20 | Operator: "too many requests… I want most things handled autonomously". Investigation, five issues filed, plan posted.                                                      |

Outcome: three repos with skills, guard hooks, `AGENTS.md` where missing, and `/flow` configured; two marketplace packages shipped or in flight; one DorkOS bug fixed and merged, two more fixed on branches; six defects found that nobody knew about at 12:00.

## 2. Defects surfaced, with root causes

| #   | Defect                                                                                                                    | Where                                                                                                                                                          | Found by                                 | State                              |
| --- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------- |
| 1   | Guard hooks refuse a message that only **mentions** a blocked command in a code span                                      | `.claude/hooks/lib/shell-command.mjs` scanned backticks and `$(...)` inside single quotes and quoted heredocs                                                  | Blintz, in use                           | Fixed, PR #1873                    |
| 2   | An agent-driven install/uninstall never projects the plugin or refreshes the runtime                                      | `onPluginsChanged` reached only the HTTP router; `marketplace-mcp/tool-install.ts` and `tool-uninstall.ts` never fired it; `MarketplaceMcpDeps` had no field   | Two agents, then code reading            | DOR-2057, branch in review         |
| 3   | Approving a package-shipped schedule fails with the package-owned refusal, whose text promises the opposite               | `update-task-file.ts`: `enabled` is a file-backed column, so a status/enabled-only update tries to rewrite the package file and `isPackageOwned` refuses (409) | Operator (FB-26)                         | DOR-2058, fix being built          |
| 4   | Flow's `linear-adapter` calls `LINEAR_GET_AUTHENTICATED_USER`, which Composio no longer has                               | Adapter table and the reference adapter `/flow:init` generates from                                                                                            | Blintz                                   | Fixed, marketplace PR #30          |
| 5   | A relay-dispatched agent session stalls on its first tool call with nothing reported anywhere                             | The session ran `permissionMode: default`; nobody could see or answer the prompt; the dispatcher's inbox stayed empty                                          | Orchestrator, by checking the transcript | DOR-2060                           |
| 6   | Flow's `config-schema.test.ts` reads `config/config.json` when present, so dogfooding flow from source fails its own test | Marketplace repo                                                                                                                                               | Marketplace agent                        | Noted, not filed                   |
| 7   | Two public-repo agents pasted the private repo's name into skill files                                                    | Copied skills carried the cross-repo rule verbatim                                                                                                             | Orchestrator review, both times          | Fixed before merge; guard proposed |
| 8   | The private Linear team was invisible to the flow bot account, and the handoff doc said to use that account               | Team CLD is private; only the operator's personal Composio connection could see it                                                                             | Orchestrator, pre-flight check           | Operator added the bot to CLD      |

Two things stand out. Defects 2, 3 and 5 are all on the **agents-as-operators** path: an agent installing, an agent approving on the operator's behalf, an agent delegating to an agent. The app path worked in every case. And defects 1 and 7 both came from **copying**: the same lib in four repos, the same rule pasted into public files.

## 3. What the operator experienced

The operator's two mid-afternoon messages are the most useful data in this report:

> "I want most things handled autonomously."
> "Are you able to see all of the approval requests I'm getting? … Why am I getting so many requests. I don't like it… it's too many."

What he actually received:

- **3 install cards**, one per agent, within three seconds of each other, indistinguishable. He approved all three. The third was for an agent that had already decided not to install, so that click did nothing (DOR-2061).
- **4 schedule cards**: flow ships `flow-drain` and `flow-groom` with `schedule.enabled: false`, and discovery files every discovered schedule as `pending_approval`. Two repos, two schedules each. Every Approve click failed (FB-26), and the client retried eight times in a row.
- **2 questions from the orchestrator** that turned out not to need him (which marketplace packages to build; push or PR for Blintz). He said so. Recorded as a standing correction: decide reversible, in-scope picks; ask only for spend, access, irreversible or scope changes.
- **Nothing that carried over.** `approvals.standingGrants` is off by default, so every card is one-off, and the operator did not know the setting existed.

Meanwhile nothing in the app could answer "what am I waiting on?" in one place: capability approvals, schedule approvals, hook approvals and in-chat permission prompts live in four queues, and an agent can read none of them (`/api/approvals/pending` needs a session cookie; the activity feed records grants, not asks). The orchestrator answered the question by reading `~/.dork/dork.db` directly.

## 4. What worked

- **A written brief up front.** One message with the inventory format, the install command, the Linear teams already looked up, and the rules (one writer per checkout; never the `artblocks` account). All three agents answered in the same shape within a minute.
- **Verification before accepting "done".** Every "done" was checked on disk or in the PR before it was relayed. That caught the two private-name leaks, the missing `AGENTS.md`, and a stale PR that still carried the leak after the agent said it was fixed.
- **Fresh adversarial reviewers per round.** The hook fix went through three reviewers. Round one found 8 false negatives; round two found ~12 more and a design flaw (mask-by-default with a list of runners fails open); round three, against the allowlist design, found none in 187 attacks. Each reviewer verified with a real shell and a harmless shim, never the destructive command. No single reviewer would have been enough.
- **Reproduce before relaying.** The first hook repro (plain words) was wrong, and saying so in the room let Blintz correct it with the backtick case within minutes. Both the wrong call and the correction were posted.
- **The room canvas as a status board.** One pinned-in-practice document, updated after every state change, so the operator never had to scroll.
- **Provenance checks before publishing.** Four skills were traced past a file move to their first commits, and four others were kept out of the marketplace because they came from an MIT plugin that is already public.

## 5. What DorkOS should change

Ordered by how much operator attention each one returns.

### 5.1 Approval attention is spent in tiny, undifferentiated units

The gates are individually reasonable and collectively exhausting. Four changes, smallest first:

1. **Shipped-off schedules raise no card** (DOR-2059). A discovered schedule with `enabled: false` is filed as off and shown as off; the approval flow runs when a person switches it on.
2. **Approving a package-owned schedule works** (DOR-2058 / FB-26). A status/enabled-only change updates the row and never writes the package file; the row survives the next sweep.
3. **Agents can withdraw their own cards, and an unused grant says so** (DOR-2061).
4. **One queue of everything waiting on the operator, readable by agents** (DOR-2062), with bulk actions per agent. Until then an orchestrating agent cannot even list what it has cost the person.

And one setting the operator should hear about at the moment it matters: when a second card from the same agent lands inside an hour, the card can say "you can allow this agent for 8 hours in Settings → Security". Standing permissions are off by default for good reason (`specs/agent-approval-settings` §3.0), but a safety default that nobody discovers is not protecting anyone.

### 5.2 A coordinating agent has no durable hand-off

This is the structural gap, and it is the thesis DorkOS exists to close.

- An **in-session helper** (the Agent tool) inherits the orchestrator's permissions and works, but it dies when the room turn's session ends. The DOR-2057 helper died at 14:48 with a commit unpushed and edits uncommitted. The orchestrator recovered it by hand, which is exactly the work an orchestrator should not do.
- A **relay-dispatched session** survives the orchestrator but runs unwatched: it got `permissionMode: default`, hit a prompt nobody could see, and the dispatcher's inbox never learned it was waiting (DOR-2060).

What is missing is one primitive: _run this task as a session that carries my trust level, reports progress and permission asks to my inbox, and outlives my turn_. Concretely:

- Relay-started and scheduled turns run with the agent's configured default trust level (the same one a new chat gets) and say so in the transcript.
- A permission ask in an unwatched session becomes a card (agent, session, command) and a `waiting_on_permission` progress event, never a chat-only prompt.
- A room session ending should not kill background work the agent has already committed to; at minimum, the agent should be told its helpers are about to die so it can push.

### 5.3 Copied tooling drifts, so tooling should be installed

The same hook lib bug reached four repos in an hour because each repo copied the file. The fix is packaging, and it is already under way: `writing-pack` shipped; a safety-hooks plugin (git-guard, process-guard, file-guard, the lib, both test scripts) is in progress. Two follow-ons:

- Installed copies lag their source: flow 0.6.0 in two repos still carries the stale Linear tool name that PR #30 fixed. Package authors need a "run from source" install mode that Harness Sync projects without copying, which the marketplace agent hand-built today with symlinks.
- The public/private **boundary guard** (the vocab-gate shape DorkOS uses for its own prose) should be part of the safety-hooks plugin. Two agents leaked the private repo's name today; a hook would have refused both commits.

### 5.4 "Fresh reviewer on this branch" should be a built-in step

Three review rounds, each by a new reviewer with a rubric and a real-shell oracle, were the difference between a fix that let `bash -c 'echo $(pkill …)'` through and one that did not. Today an orchestrating agent hand-rolls that: it writes the brief, names the failure mode, dispatches, reads the verdict. `/flow`'s VERIFY stage already has `review.adversarial`; the same capability should be reachable from a room turn as one call: _review branch X against rubric Y, adversarially, and report_.

### 5.5 Smaller room ergonomics

- Canvas writes raced two agents' reads by a few seconds. A `read_canvas` that returns the document version, or a post that waits for the canvas write to land, would have saved two "please re-post" messages.
- Messages crossed twice (an agent asked for a go-ahead the orchestrator had just posted). Harmless, but a room agent could see "a reply to you is being written" the way people see typing indicators.
- An agent's own memory does not reach its other sessions until the turn ends. The orchestrator wrote notes to its memory file during the turn precisely so a successor session would not repeat the day.

## 6. Numbers

- 4 agents, 1 person, ~3.5 hours, one room, 78 room messages.
- 3 repos set up; 5 PRs in sibling repos (blintz #2, #3; marketplace #28, #29, #30, #31); 1 DorkOS PR merged (#1873), 2 on branches (DOR-2057, DOR-2058).
- 8 defects surfaced; 6 filed or fixed the same day (DOR-2057 to DOR-2062, FB-26 answered).
- Hook fix: 3 adversarial reviews; process-guard fixtures 60 → 212, git-guard 111 → 234, both with a real-shell differential leg.
- Operator approvals asked: 7 cards. Operator decisions genuinely needed: 3 (install approval, private-team access, hook-fix go). Cards that failed or did nothing: 5.

## 7. Recommendations, in order

1. Fix DOR-2058 (FB-26) and DOR-2059 first: they remove most of today's cards and the only ones that failed.
2. Land DOR-2057 so agent installs stop being half-done, then ship the safety-hooks plugin with the boundary guard.
3. Build DOR-2062 (one queue, agent-readable) before adding any new gate.
4. Design the durable hand-off primitive (§5.2), starting with DOR-2060.
5. Surface standing permissions at the moment of repeated asks, without changing the default.

## Sources

- Room `#dorkos`, 2026-09-15 12:12 to 15:35 (message ids `01M2JFQ2…` through `01M2JTJQ…`).
- `~/.dork/dork.db` `approvals` table; `tasks_list` on 2026-09-15 15:10.
- `apps/server/src/services/tasks/lifecycle/update-task-file.ts`, `services/tasks/task-file-update.ts`, `services/marketplace-mcp/tool-install.ts`, `services/harness/auto-project.ts`, `apps/server/src/index.ts` (marketplace wiring).
- `specs/agent-approval-settings/02-specification.md` §3.0.
- dorkos PR #1873 (three review reports in the PR body); marketplace PRs #28 to #31; blintz PRs #2, #3.
- Linear: FB-26, DOR-2057, DOR-2058, DOR-2059, DOR-2060, DOR-2061, DOR-2062.
