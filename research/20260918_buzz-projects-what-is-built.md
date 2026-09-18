---
title: 'Buzz projects: what is actually built (worktrees, channels, agents, git flow)'
date: 2026-09-18
type: source-dive
status: active
tags: [buzz, projects, worktrees, managed-agents, nip-34]
---

# Buzz "Projects": what is actually built

Source: `/Users/doriancollier/.opensrc/repos/github.com/block/buzz/main` (fetched 2026-09-18, `main`). Paths below are relative to that root. Read-only; nothing was modified.

## Headline

**Buzz does not model git worktrees at all.** No worktree entity, no table, no `git worktree add` anywhere in the repo, and no code that turns a branch or worktree into a channel or thread. The branches-as-channels story in `VISION_PROJECTS.md` is unimplemented aspiration. What ships is a **repository browser and NIP-34 forge UI** in the desktop app, plus a **managed-agent supervisor** whose agents all share one working directory. "Focused thread mode" is an unrelated chat-UI drawer.

## Summary table

| Question                 | Answer (shipped)                                                                                                     | Evidence                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| What is a Project        | A kind:30617 NIP-34 repo announcement projected to a TS type. One project == one repository. **No local DB table.**  | `desktop/src/features/projects/hooks.ts:69-83`, `:191-231`                                                      |
| Bound to                 | `(owner_pubkey, d-tag)` + clone URLs. Channel id read-only and vestigial. Disk link is _name-matched_, never stored. | `hooks.ts:207-214`; `lib/projectLocalRepos.ts:29-45`                                                            |
| Worktree entity          | **Does not exist.** Zero `git worktree` invocations repo-wide.                                                       | grep; only hits are dev notes (`AGENTS.md:416`) and a test dir named `worktree` (`project_git_branches.rs:269`) |
| Branch → channel         | **No.** Branch create/delete is a bare remote refspec push.                                                          | `commands/project_git_branches.rs:169-213`; `branchMutations.ts:12-33`                                          |
| "Focused thread mode"    | Chat drawer overlaying the channel content area. Nothing to do with git.                                             | `features/channels/lib/threadFocusLayout.ts:4`; v0.4.19 (#2108)                                                 |
| Agent ↔ project          | **None.** `grep project_id managed_agents/` → zero files.                                                            | `managed_agents/types.rs:190-330`                                                                               |
| Agent cwd                | One shared nest `~/.buzz` (`~/.buzz-dev` in dev) for every agent, resolved once per process.                         | `managed_agents/mod.rs:88-100`; `runtime.rs:1710-1712`; `nest.rs:62-68`                                         |
| Run unit                 | A **channel** (or DM), not a branch/worktree/task. Per-channel queue, session affinity per channel.                  | `crates/buzz-acp/src/queue.rs:93-107`; `pool.rs:555-561`                                                        |
| Who merges               | The desktop app, locally, as repo owner, in a throwaway temp clone.                                                  | `commands/project_git_workflow.rs:559-735`                                                                      |
| Approvals                | PR review = kind:1 note with a `t` label. **Not** kind:46011, and it gates nothing.                                  | `pullRequestReviews.ts:120-190`                                                                                 |
| Agent permission default | `bypassPermissions` — no per-tool human gate.                                                                        | `crates/buzz-acp/src/config.rs:425-438`, `:2164`                                                                |

---

## 1. Data model

`eventToProject` (`hooks.ts:191-231`) converts one kind:30617 event into `Project { id, dtag, name, description, cloneUrls, webUrl, owner, contributors, createdAt, projectChannelId, status, defaultBranch, repoAddress }` (`hooks.ts:69-83`). `id` is `${pubkey}:${d}`; `repoAddress` is the `30617:<owner>:<dtag>` coordinate. **There is no projects table** — no `CREATE TABLE` for projects exists in `desktop/src-tauri`, and the only relay-side project-adjacent table is `git_repo_names`, a name-uniqueness registry (`migrations/0002_git_repo_names.sql:20-26`). The relay event store is the model, with TanStack Query caching and a `localStorage` hide-list (`"buzz.projects.hidden-cards.v1"`, `hooks.ts:67`). Deletion is NIP-09 kind:5 with an `a` tag (`hooks.ts:172-181`, `:667-684`).

Kinds (`desktop/src/shared/constants/kinds.ts:59-68`): 30617 announcement, 30618 state (branches/tags/HEAD), 1617 patch, 1618 PR, 1621 issue, 1630/1631/1632/1633 open/merged/closed/draft. PR _updates_ are 1619; review artifacts are kind:1 notes carrying `t` labels (`hooks.ts:486,495`).

Hanging off a project: repo state (`RepoState`, `hooks.ts:85-90`), issues (status enum `Triage|Backlog|In Progress|In Review|Done|Closed`, `projectIssues.d.mts:3-9`), PRs, cross-project work items batched in one fan-out (`projectWorkItems.ts:58-157`), activity summaries, remote/local snapshots and diffs, sync status with `canPush`/`pushBlockReason` (`shared/api/projectGitTypes.ts:58-76`), and one OS terminal. **Not**: worktrees, threads, per-branch channels, or attached agents.

`projectChannelId` is read from an `h` or `project-channel` tag, and the code says outright that nothing writes those tags: _"read-side tolerance for extension tags no code writes today (the write path that emitted them was removed)"_ (`hooks.ts:207-212`). It drives one button, `Open Discussion` (`ui/ProjectDetailScreen.tsx:873`), and a label `"Discussion linked"` / `"No discussion"` (`lib/projectLabels.ts:4`).

Worse, there is a **tag-name split**: the desktop reads `h`/`project-channel`, while the relay's git-push authorizer and the web client read `buzz-channel` (`crates/buzz-relay/src/api/git/policy.rs:300-309`; `web/src/features/repos/use-repos.ts:34`). Nothing in either shipped client writes `buzz-channel` — only a unit test (`crates/buzz-sdk/src/builders.rs:2842`) and an e2e script (`scripts/e2e-git-perms.sh:406`). The consequence is live and visible: a non-owner push hits 403 `"no channel binding"` (`policy.rs:353`), which the UI translates to **"This repository is owned by another identity and is not linked to a project channel."** (`ProjectBranchDialogs.tsx:30-32`). That is a dead end with no in-app fix.

## 2. Worktree ↔ channel/thread mapping

There is none.

- Creating a branch calls `create_project_remote_branch` (`project_git_branches.rs:169-194`): validate name, push `commit:refs/heads/<new>` with a lease. Delete is the same shape. The React mutation only invalidates the project query (`branchMutations.ts:12-33`). Cross-checked by grep: `createChannel|createGroup|create_channel` has **zero hits** inside `features/projects/`, and `crates/buzz-relay/src/api/git/` never creates a channel.
- The only git↔channel link that ships is backwards and advisory: an agent opening a PR from chat passes `--channel <uuid>` (`crates/buzz-acp/src/base_prompt.md:27`; `crates/buzz-cli/src/commands/pr.rs:34,48`), landing as an `h` tag on the 1618. The UI renders _"linked from #channel (author-claimed)"_ with the tooltip _"Source channel is claimed by the pull request author and is not relay-verified."_ (`ui/ProjectPullRequestsPanel.tsx:365-384`).
- Archival has teeth, but at project level: archiving the `buzz-channel`-bound channel makes the repo read-only — `"channel is archived (read-only)"` (`policy.rs:306-318`).

"Focused thread mode" (v0.4.19 #2108; Escape-to-close v0.4.20 #2154; dismissal fix v0.4.25 #2644) is a drawer replacing the wide split thread pane, giving a thread a subject/body structure (`features/messages/ui/MessageThreadPanel.tsx:351`; `features/channels/ui/ChannelPane.tsx:517`).

## 3. Agents in a project

Agents are bound to a `(pubkey, relay_url)` pair — `ManagedAgentRuntimeKey` (`managed_agents/runtime_types.rs:8-31`) — never to a project, repo, or channel. The desktop is purely a **process supervisor**: it spawns one long-lived `buzz-acp` harness per pair and every notion of a turn lives inside that harness.

cwd is `default_agent_workdir()` (`runtime.rs:1710-1712`), a process-lifetime `OnceLock` taking **no agent argument** (`mod.rs:88-100`), resolving to the nest `~/.buzz`. `nest.rs:1-8` states the intent: _"Creates a shared knowledge directory on first launch so every Buzz-spawned agent starts with orientation."_ Layout `GUIDES/ RESEARCH/ PLANS/ WORK_LOGS/ OUTBOX/ .scratch/` (`nest.rs:29-35`), chmod 0700 (`nest.rs:246-301`), plus `REPOS` — a real dir or a **symlink to one global user-configured `repos_dir`** (`repos.rs:56-133`). The harness then injects that path into the prompt as a `[Workspace]` anchor telling the agent it is _their_ directory (`crates/buzz-acp/src/pool.rs:1165-1178`).

Work arrives as a **channel message that mentions the agent**: `SubscribeMode::Mentions` by default (`config.rs:327-330`), filter requiring a `p` tag equal to the agent pubkey (`filter.rs:390-397`), gated by `respond_to` defaulting to `owner-only` (`config.rs:440-446`). Events queue **per channel** (500 pending, 50 per batch — `queue.rs:24-27`), and `pool.try_claim` prefers an agent that already holds a session for that channel (`pool.rs:555-561`). So a session is per-channel, and a turn is one flushed batch.

**Concurrency**: the harness `--agents` default is 1 (range 1–32, `config.rs:292-294`), but the desktop overrides it to `DEFAULT_AGENT_PARALLELISM = 24` (`types.rs:733` → `runtime.rs:1861`). There is no cap on the _number_ of managed agents; boot restore spawns every eligible one in parallel, one OS thread each (`restore.rs:271-290`). No max-worktrees or max-runs ceiling exists, because neither concept does.

Handing work to an agent from Projects opens a **DM** with a repo-list footer — `"Workspace repositories:"` plus up to 8 `name (30617:owner:dtag)` lines, on the opening message only (`ui/ProjectsAgentPromptPage.tsx:76-91`, `:355-395`). No branch, issue, PR, or local path is ever passed. _Verified:_ that page has **zero importers** — `ProjectsScreen` renders only `ProjectsView`. The surface is built, tested, and unmounted.

## 4. Lifecycle and liveness

Harness ceilings (`crates/buzz-acp/src/config.rs`, `queue.rs`, `lib.rs`):

| Knob                                           | Default                                                 | Line                                |
| ---------------------------------------------- | ------------------------------------------------------- | ----------------------------------- |
| `idle_timeout` (silence before killing a turn) | 900s                                                    | `config.rs:27`, `:265-267`          |
| `max_turn_duration` (wall clock)               | 7200s; ceiling 604800s (7d)                             | `config.rs:31`, `:36`, `:270`       |
| in-flight deadline                             | max_turn + 100s buffer = 7300s                          | `queue.rs:39-42`                    |
| `turn_liveness_secs` (crash backstop ping)     | 10s; 0 or ≥5; capped 24h                                | `config.rs:299-303`, `:763`, `:837` |
| retries per channel                            | 10, 5s base → 300s cap, ±20% jitter                     | `queue.rs:30-36`, `:429-451`        |
| slot circuit breaker                           | 3 crashes / 60s → 300s cooldown; respawn backoff 1s→30s | `lib.rs:1008-1016`, `:1050-1065`    |

Desktop supervision detects **death only**, via `child.try_wait()` (`runtime.rs:1240-1315`), pulling a real error from the log tail (`storage.rs:749-784`). Orphan reaping runs **every 60s** (`desktop/src-tauri/src/lib.rs:578-611`) with a **two-tick grace** so a starting process is never mistaken for an orphan (`runtime.rs:714-728`). `runtime/sweep.rs` is boot-time process hygiene, not a run sweeper: it derives the expected `buzz-acp` path from the running executable and kills same-bundle processes not in the tracked set, with no grace (`sweep.rs:437-535`). Its correctness core is a live-descendant exemption checking PPID, PGID (covers reparent-to-init) and a bounded 32-hop ancestor walk (`sweep.rs:115`, `:184-229`).

**What the user sees**, posted into the channel:

- `"⚠️ I couldn't process the last request after multiple retries ({reason}). Please re-send if it's still needed."` — reason ∈ _"the turn timed out"_, _"the turn exceeded the maximum duration"_, _"the agent process exited"_ (`lib.rs:3145-3158`).
- Auth failure dead-letters immediately: `"⚠️ …authentication failed. Please re-authenticate the CLI (e.g. run `claude /login`or`codex login`) and then re-send."` (`lib.rs:3140-3143`).
- **Pool exhausted shows nothing.** The batch is silently requeued and logged `pool_exhausted` at debug (`lib.rs:2907-2916`). The message just waits.
- Runtime status chips: `"Here" | "Waking" | "Needs setup on this device" | "Unavailable"`, detail `"Stopped by you"` or the harness error (`features/agents/managedAgentRuntimeStatus.ts:3-33`). Front-end liveness: ping 10s, remove after 25s, max 4 concurrent turns shown per agent (`features/agents/activeAgentTurnsStore.ts:11-34`).
- If `repos_dir` fails to resolve at boot, agent restore is **skipped entirely** and says so on the console only (`repos.rs:242-276`) — deliberately fail-closed, since a clone into the wrong `REPOS` is unrecoverable.

## 5. Git flow

- **Branch**: lease-guarded remote refspec push, no local checkout. Blocked with `"Push the first local commit to {branch} before creating another branch."` when no commit is known (`lib/projectBranches.ts:62-72`).
- **Terminal / clone**: `open_project_terminal` resolves an existing checkout by name candidates (`owner--repo`, d-tag, repo) verified against `origin.url` (`project_repo_paths.rs:9-110`), else clones, then opens the OS terminal there (`project_terminal.rs:56-157`). **Per-repo, not per-branch** — the `default_branch` argument only affects a fresh clone; an existing checkout is never switched or fetched.
- **PR**: statuses 1630/1632/1633 are published from the UI; 1631 is deliberately excluded — _"Merged (1631) is intentionally excluded — merges happen through git, not this UI"_ (`pullRequestReviews.ts:28-30`).
- **Merge**: `merge_project_pull_request` runs in the desktop app as the repo owner — temp-dir clone (`--filter=blob:none --no-tags --single-branch`), fetch source, assert `FETCH_HEAD == expected_commit` else fail `branch_changed` (_"The pull request branch changed. Refresh the pull request before merging."_), `git merge --no-edit` as `Buzz User <pubkey@users.noreply.buzz>`, push `HEAD:<target>`, then publish the signed 1631 (`project_git_workflow.rs:559-735`). Conflicts classified via `git diff --diff-filter=U` (`:81-95`).
- **Conflict recovery**: fetches both sides into `refs/buzz/merge-recovery/<commit>` and `…-target/<commit>` and opens a terminal — _"The user's worktree is not switched or modified."_ (`project_terminal.rs:159-230`).
- **Protected branches**: shipped and enforced. `buzz-protect` tags are parsed by `crates/buzz-core/src/git_perms.rs` (≤50 rules, 256-char patterns, ≤3 wildcards, must start with `refs/`) and evaluated by the relay pre-receive endpoint (`policy.rs:400`). Model is _channel role = repo role_: owner (or verified managed-agent owner) → Owner; everyone else resolves role from the bound channel, Bot promoted to Member; fail-closed throughout (`policy.rs:1-26`, `:300-360`). CLI-only management (`buzz repos protect list|set|remove`, `crates/buzz-cli/src/commands/repos.rs:295-330`); no desktop UI.

## 6. Shared vs isolated context

**Shared**: the nest `~/.buzz` — cwd for every agent — its `AGENTS.md`, `GUIDES/RESEARCH/PLANS/WORK_LOGS/OUTBOX/.scratch`, and `REPOS`. Instruction loading walks the AGENTS.md chain from git root → cwd plus `~/AGENTS.md`, capped 128 KiB, with skills from `.agents/skills`, `.goose/skills`, `.claude/skills` at 32 KiB each (`crates/buzz-agent/src/hints.rs:6-8`, `:26-81`). Notably `find_git_root` handles a `.git` _file_, so it would work inside a worktree — the only worktree-awareness in the product (`hints.rs:26-37`).

**Isolated**: per-session MCP server instances, per-agent nostr key, per-agent memory (engrams, kind:30174), per-channel event queue.

**Not isolated, and this is the gap**: two agents on one machine share one checkout root, with only the 0700 bit protecting them from _other OS users_, not from each other. The sole mitigation is a sentence of prompt text — _"Make file changes in a worktree, not on the default branch. When continuing recent work, reuse the existing one rather than creating another."_ (`base_prompt.md:129`) — executed through the agent's shell tool. Nothing creates, tracks, limits, or cleans up worktrees. _Inference: worktree-per-task is the intended discipline and is entirely delegated to the model._

## 7. Permissions and approvals

- Managed agents default to **`bypassPermissions`**; the per-tool-call flow is skipped (`config.rs:425-438`, pinned by `default_config_uses_bypass_permissions` at `:2164`). `default`, `acceptEdits`, `dontAsk` exist but are opt-in.
- The real gate is inbound authorship: `respond_to` = `owner-only` by default (`config.rs:440-446`).
- Push is gated at the relay by channel role + `buzz-protect`, fail-closed; agents inherit owner authority via managed-agent owner lookup (`policy.rs:326-348`) — the NIP-OA idea, shipped.
- PR reviews are kind:1 notes labelled `t`, content `"Approved these changes"` / `"Requested changes"` / `"Requested a review from {label}"`; only the repo owner or a listed reviewer may review, never the author (`pullRequestReviews.ts:126-190`). **They do not gate the merge** — `merge_project_pull_request` never consults them.
- Agent creation from chat opens an owner-reviewed **draft** only (`base_prompt.md:35-41`). Agent Nostr projection (kind:30177) is an explicit opt-in allowlist that must never carry keys, auth tags, or env vars (`managed_agents/agent_events.rs:16-60`).

## 8. Vocabulary

| Concept      | Buzz's name                                     | UI strings                                                                                                                                                                                        |
| ------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project      | **Project** (= one repository)                  | nav `Overview`, `Repositories`, `Pull Requests`, `Issues` (`ProjectsToolbar.tsx:62-65`); dialog _"Projects are repositories published to this workspace's relay."_ (`CreateProjectDialog.tsx:91`) |
| Repository   | **Repository** / repo                           | create-menu items `Repository`, `Issue`, `Pull Request` (`ProjectsCreateMenu.tsx:95-113`)                                                                                                         |
| Project tabs | —                                               | `Files`, `Commits`, `Issues`, **`Pull Request`** (singular), `Contributors`; overview is icon-only `title="README"` (`ProjectWorkspaceTabList.tsx:29-63`)                                         |
| Branch       | **branch**                                      | `Create branch…`, `Delete branch?`, _"…may be rejected by repository protection rules."_ (`ProjectBranchDialogs.tsx:181-205`)                                                                     |
| Worktree     | _no term_                                       | —                                                                                                                                                                                                 |
| Channel      | **Channel** (`#name`)                           | `Open Discussion`; `Discussion linked` / `No discussion`                                                                                                                                          |
| Thread       | **thread**; focus mode = **focused thread**     | drawer, Escape closes                                                                                                                                                                             |
| PR           | **Pull request**                                | sub-tabs `Conversation`, `Commits`, `Checks`, `Files changed` — **Checks count is hardcoded `0`** (`ProjectWorkspaceTabList.tsx:90-93`)                                                           |
| Run          | **turn** (harness); **job** (kinds 43001-43006) | _"Agent turn exceeded the maximum duration"_                                                                                                                                                      |
| Agent        | **managed agent**; workspace = **nest**         | `Here` / `Waking` / `Needs setup on this device` / `Unavailable`; `Failed to reach the agent`                                                                                                     |
| Terminal     | **terminal**                                    | `Open in Terminal` / `Clone & open in Terminal` (`useOpenProjectTerminal.ts:9`)                                                                                                                   |

## 9. Vision vs shipped

Landed, per `CHANGELOG.md`: **v0.3.31** #1194 `ground agent workspace, migrate legacy nest, configurable repos_dir` · **v0.3.42** #1471 `repository-first projects with git workflows`, #1497 contribution heatmap · **v0.4.0** #1677 `projects overview v2 — aggregate rail, PR review flow, commit detail`, #1601 boot-time agent reconcile · **v0.4.7** #1851 `Projects v3 — overview redesign, activity feed, agent access & sync controls` · **v0.4.8** #1956 navigation hierarchy · **v0.4.19** #2108 `add focused thread mode` · **v0.4.20** #2119 `complete project git workflows`, #2159 actionable missing checkouts, #2135 archive managed agents on delete · **v0.4.22** #2212 `manage project branches`, #2213 branch workflow reliability, #2193 `manage repository protection rules` (CLI), #2231 immutable tags · **v0.4.25** #2510 `make pull request reviews actionable`.

The `VISION_PROJECTS.md:216-227` status table is **wrong in both directions**:

- _Project binding (kind:30617 + `buzz-` tags)_ is marked 📋 Designed, but `buzz-protect` parsing, evaluation and relay enforcement all ship, and `buzz-channel` is consumed by the relay and the web client. What is missing is a **writer** — so the non-owner push path reliably reaches `"no channel binding"` → 403.
- _Approval gates_ is marked 🚧 "executor wiring in progress", but for projects approvals were implemented as kind:1 labelled notes that gate nothing.

Purely aspirational with no corresponding code: **branches as channels** (`VISION_PROJECTS.md:47-67`), **branch channels archiving into a permanent record**, the **merge coordinator / merge train**, **CI results posting into a branch channel**, **NIP-34 issues on a forum surface**, and **web-of-trust reputation**. The hardcoded `0` on the PR "Checks" tab is the visible stub where CI would land.

**Two live defects found incidentally.** `hooks.ts:670` throws the user-visible string `"Only branch owners can delete branches."` from `deleteProject` — wrong noun, copy-paste. And `ProjectsAgentPromptPage.tsx` (626 lines with tests) has zero importers, so the entire project→agent handoff surface is dead code.

_Inference, clearly marked:_ Buzz's real shipped shape is **channel-first, repo-second**. Chat is the primary surface; the forge is a read-and-act panel bolted onto NIP-34 events. The multi-agent isolation problem that worktrees-as-channels would solve is today handled by one sentence of prompt text over one shared checkout root.
