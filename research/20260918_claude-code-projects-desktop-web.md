---
title: 'Claude Code Projects (desktop/web) — data model, threads, git, lifecycle'
date: 2026-09-18
type: external-best-practices
status: active
tags: [claude-code, anthropic, projects, threads, coordinator, cloud-sessions, git-worktrees]
searches_performed: 6
sources_count: 7
---

# Claude Code Projects — Research Report (2026-09-18)

Anthropic announced a redesigned "Projects" feature for Claude Code on **2026-09-17**, rolling out in beta on claude.ai/code (web), the desktop app's Code tab, and the Claude mobile apps. This report is built primarily from Anthropic's own documentation page (`code.claude.com/docs/en/claude-projects`) and blog post (`claude.com/blog/projects-redesigned`), cross-checked against independent coverage.

## Facts (sourced)

### 1. What a "project" is (data model)

- "A project is one ongoing conversation where Claude coordinates a stream of related work for you. You tell it what needs doing and it starts a thread for each task." — [Claude Code Docs: Let Claude coordinate ongoing work with Projects](https://code.claude.com/docs/en/claude-projects)
- A project is **not** a folder/repo binding by itself and not just a session group with no logic — it is described as "one coordinating conversation with Claude plus the threads it starts to do the work." Its parts, per the docs: (1) the project conversation (a long-running coordinator session), (2) threads (the workers, each a separate cloud session), (3) "what every thread starts with" — the project's repositories/files plus instructions and memory, each repo's `CLAUDE.md`/skills/plugins, claude.ai account connectors, and a cloud environment — and (4) the **Overview pane** (tabs: Threads, Library, Pull requests, Routines). — [Claude Code Docs](https://code.claude.com/docs/en/claude-projects)
- A project can contain zero, one, or many GitHub repositories, plus uploaded files/folders and Google Drive folders; it does not require a repository at all (non-code use case: e.g., analyzing a folder of contracts). — [Claude Code Docs](https://code.claude.com/docs/en/claude-projects)
- Note: this is a **new, distinct concept** from the pre-existing "Projects" in claude.ai chat and in "Cowork," which the docs describe as "the earlier Projects experience... which groups conversations and reference files without threads or a coordinator." Those legacy projects "keep working as they do today" during the rollout. — [Claude Code Docs](https://code.claude.com/docs/en/claude-projects)

### 2. Threads/sessions inside a project

- Each **thread is a full Claude Code cloud session**: "Each thread is a cloud session: Claude Code running in the cloud rather than on your machine," with "its own context window," working "on its own branch and its own copy of the repo[sitory]." — [Claude Code Docs](https://code.claude.com/docs/en/claude-projects); corroborated by [Claude blog](https://claude.com/blog/projects-redesigned) ("each thread is a Claude Code cloud session working on its own branch and copy of the repo") and [VentureBeat](https://venturebeat.com/orchestration/anthropic-launches-claude-code-projects-an-always-on-conversation-that-remembers-and-delegates-your-long-running-dev-work).
- Yes — a task generally becomes a thread. The coordinator ("Claude" in the project conversation) decides: a quick question gets answered inline; new work becomes a new thread or is routed to an existing thread already working in that area; several unrelated tasks in one message become separate threads. — [Claude Code Docs](https://code.claude.com/docs/en/claude-projects)
- Threads can themselves spawn subagents, loops, or workflows for complex sub-work. — [Claude Code Docs](https://code.claude.com/docs/en/claude-projects); [Unite.AI](https://www.unite.ai/anthropic-redesigns-claude-code-projects-to-coordinate-agent-threads/)
- **Parallelism / concurrency**: "There's no fixed number [of concurrently running threads]; Claude starts as many as the work calls for, and a limit you ask for is a preference rather than a cap." Users can _ask_ Claude in the conversation to cap concurrency (e.g., "Run at most two threads at a time") but this is an instruction Claude follows, not an enforced setting — unless codified in project instructions. The one **enforced, hard limit** documented is **200 new threads per day across a user's projects**. — [Claude Code Docs](https://code.claude.com/docs/en/claude-projects)
- The coordinator "sees what threads report back, not every step they take" — it does not micromanage each tool call.

### 3. Git integration

- **Branch**: by default a thread "works on a new branch, started from the repository's default branch." — [Claude Code Docs](https://code.claude.com/docs/en/claude-projects)
- **Pull requests**: a thread opens a PR when asked, and can open one autonomously for a bug fix or another concrete change. Once open, the thread "watches the pull request with auto-fix turned on ... It pushes fixes when CI fails, addresses review comments, and replies in the thread when checks pass and the pull request is ready for you." Auto-fix is turned on for project threads regardless of the user's default cloud-session setting. — [Claude Code Docs](https://code.claude.com/docs/en/claude-projects)
- The conversation UI surfaces action buttons on a thread's card: **Resolve conflicts, Fix CI, Address comments, Merge it** (each sends an instruction to that thread as if from the user), **Review PR** (opens the PR on GitHub), and **Create PR** (for an idle thread that pushed a branch without opening a PR). — [Claude Code Docs](https://code.claude.com/docs/en/claude-projects)
- **Merging**: the docs do not show an autonomous, unattended merge step by default — "Merge it" sends the thread an instruction to merge, and project instructions can explicitly forbid a thread from merging without asking ("Don't merge, force-push, or change CI configuration without asking me in the thread" is the docs' own example instruction). So **merging is user-directed by default**, though a thread could presumably be told to merge on its own if instructed. Not explicitly documented as a fully autonomous default.
- **Conflicts between parallel threads**: "When multiple threads modify the same code," the conflict "surfaces as an ordinary git merge conflict, the same as with any other pull request" — i.e., Anthropic does not build special conflict-resolution machinery; it degrades to normal git/PR conflict handling. — [Claude Code Docs](https://code.claude.com/docs/en/claude-projects); corroborated by [VentureBeat](https://venturebeat.com/orchestration/anthropic-launches-claude-code-projects-an-always-on-conversation-that-remembers-and-delegates-your-long-running-dev-work) and [Unite.AI](https://www.unite.ai/anthropic-redesigns-claude-code-projects-to-coordinate-agent-threads/).
- **Local git worktrees are explicitly NOT used for threads.** The docs draw a direct contrast: "Worktrees: a worktree gives each local session its own working copy of a repository so parallel sessions on your machine don't overwrite each other. Threads don't need them: each thread clones its repositories into its own cloud sandbox and works on its own branch." — [Claude Code Docs](https://code.claude.com/docs/en/claude-projects). Isolation for threads comes from cloud-sandbox + branch, not from the local-machine `git worktree` mechanism that Claude Code uses elsewhere for local parallel sessions.
- Requires GitHub.com (not GitHub Enterprise Server, GitLab, or Bitbucket) with the Claude GitHub App installed and push access; a token from `/web-setup` is not sufficient for project threads. — [Claude Code Docs](https://code.claude.com/docs/en/claude-projects)

### 4. Shared vs. isolated context

Shared across every new thread automatically (per the docs' own table):

- **Project memory**: notes Claude keeps (requirements, decisions, pitfalls) as files; every thread reads the index file `MEMORY.md` on start and opens other files as needed. Distinct from the local, on-machine Claude Code "auto memory," even though both use a `MEMORY.md` index naming convention.
- **Project instructions**: up to 16,000 characters, sent to every new thread and to the coordinator.
- **Repositories, files, and the cloud environment**: repos every thread clones; uploaded folders/files readable at `/mnt/project-files`; the shared cloud environment (network access, env vars, credentials, setup script).
  — [Claude Code Docs](https://code.claude.com/docs/en/claude-projects)

Isolated / per-thread:

- Each thread's own branch, repo clone/sandbox, and context window.
- **Permission rules, hooks, and `env` from `.claude/settings.json`**: these apply to a thread only when the project has a **single** repository (loaded from that repo's settings file). In a **multi-repository** project, none of these apply, because the thread starts "above" the clones where no single repo's settings file is authoritative.
- Plugin conflicts: if two repos in a multi-repo project disagree about a plugin, the project-level **Project settings > Plugins** setting takes precedence.
- Connectors (MCP) come from the user's claude.ai account (shared across all threads, not project-scoped), but the **project conversation itself has no connectors** — only threads do.
  — [Claude Code Docs](https://code.claude.com/docs/en/claude-projects)

### 5. Lifecycle

- The **Overview pane's Threads tab groups threads into six named states** (verbatim table from the docs):

| State            | Meaning                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ready for review | Thread's pull request is open and awaiting review                                                                                                   |
| Waiting on you   | Thread needs a reply/approval, or failed                                                                                                            |
| Working          | Thread still running                                                                                                                                |
| Landing          | Thread's pull request is approved or queued to merge                                                                                                |
| Idle             | Thread finished and isn't waiting on anything                                                                                                       |
| Resolved         | Thread marked done — by the user, by Claude once the last step (e.g. merge) is taken, or automatically after a week of no activity; can be reopened |

— [Claude Code Docs](https://code.claude.com/docs/en/claude-projects)

- **Approvals / permission prompts**: threads run in "auto mode" when the model supports it, so most tool calls proceed without asking. When approval is required, "the prompt is inside that thread and the thread waits until you answer it there" — telling the coordinator to "go ahead" in the main conversation does **not** unblock a waiting thread; you must answer inside the thread itself.
- **Human-in-the-loop / "waiting on a human"**: explicitly modeled as the "Waiting on you" thread state and surfaced via a dot on the Overview button plus (desktop-only) OS notifications when Claude posts, a thread errors, or a thread needs input.
- **Scheduled / background work**: a project can spin off **Routines** — Claude creates a Routine (a separate, documented Claude Code feature at `/docs/en/routines`) that runs as threads inside the project and appears on the project's Routines tab; routines created outside a project run independently.
- **Pause / Archive / Delete** (Project settings > General), verbatim distinctions:
  - **Pause**: "stops everything at once. Every running thread and the conversation are interrupted, no new threads start, routines don't run" until resumed.
  - **Archive**: "hides the project from the sidebar and archives its threads, which stops any thread that was running or watching a pull request." Threads must be unarchived individually.
  - **Delete**: "permanently removes the project along with its threads, its memory, and its files, and turns off the project's routines," irreversible; GitHub branches/PRs already pushed are unaffected.
- Threads persist as cloud sandboxes that "pause between turns and resume when the thread continues"; if the sandbox can't be resumed, the thread restarts from a fresh clone and uncommitted changes can be lost (docs recommend telling Claude to commit/push work in progress on long tasks).
  — [Claude Code Docs](https://code.claude.com/docs/en/claude-projects)

### 6. Collaboration

- **A project belongs to a single user.** Per the Limitations section: "A project belongs to one user. You can't share a project or its threads with another user, and thread transcripts don't have the share option other cloud sessions have. There are no organization-level controls for projects during the beta." — [Claude Code Docs](https://code.claude.com/docs/en/claude-projects)
- Multi-_agent_ work exists within a project (coordinator + many parallel worker threads, each of which can spawn subagents), but multi-_person_ collaboration on one project is explicitly not supported in this beta.
- Anthropic's adjacent, actually-multi-person product is **Claude Tag** ("Claude in your team's Slack channels, on Team and Enterprise plans"), described in the docs as the alternative when "several people [are] giving Claude work and steering it together in a Slack channel." The docs explicitly contrast the two: "A project is yours alone... it's on Pro and Max," vs. Claude Tag where "anyone in a channel can give it work, everyone in the channel sees and steers it." — [Claude Code Docs](https://code.claude.com/docs/en/claude-projects)
- Notifications: desktop app gives OS-level desktop notifications when Claude posts, a thread errors, or a thread needs input (configurable per-project to also notify on every thread turn, or to be turned off); in-browser there is only the dot indicator on the Overview button (no push notification documented for web).
- No "@mention" mechanic between people is documented (consistent with single-user ownership).

### 7. Naming / exact UI vocabulary

| Anthropic's term                          | What it refers to                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Project**                               | The coordinating conversation + its threads + its shared configuration/memory/library                            |
| **Thread**                                | A single unit of delegated work; implemented as a cloud session on its own branch/repo copy                      |
| **Cloud session**                         | The underlying session type each thread runs as ("Claude Code running in the cloud rather than on your machine") |
| **Coordinator**                           | Claude acting in the project's main conversation, directing/tracking threads                                     |
| **Project conversation**                  | The persistent top-level chat where the user talks to the coordinator                                            |
| **Overview (pane)**                       | The panel listing threads by state, plus Library / Pull requests / Routines tabs                                 |
| **Library (tab)**                         | Uploaded files + files/artifacts produced by threads                                                             |
| **Routines**                              | Scheduled/recurring work items a project can spin up (separate documented feature)                               |
| **Auto memory / Project memory**          | Files, indexed by `MEMORY.md`, that Claude writes/reads to retain project-level facts                            |
| **Project instructions**                  | Up to 16,000-char standing brief sent to every new thread and the coordinator                                    |
| **Cloud environment**                     | Network/env-var/credential/setup-script configuration threads run inside                                         |
| **Agent view**                            | A _different_, non-project feature for tracking multiple **local** sessions (no coordinator)                     |
| **Agent team**                            | A _different_ feature: one session spawning teammate sessions for a single task, ending with that task           |
| **Claude Tag**                            | A _different_, multi-person Slack-based product (Team/Enterprise)                                                |
| **"Projects" in claude.ai chat / Cowork** | The pre-existing, unrelated legacy "Projects" concept (folder-like, no threads/coordinator)                      |

Notably, Anthropic does **not** use the word "worktree" or "task" as the primary noun for a unit of work in this feature — the docs explicitly say local git worktrees are unnecessary for threads, and the unit of delegated work is called a "thread," not a "task." — [Claude Code Docs](https://code.claude.com/docs/en/claude-projects)

### 8. Availability

- **Platforms with Projects**: claude.ai/code (web), the Code tab of the desktop app, and the Claude mobile apps (iOS/Android) for viewing/steering. **Not available**: the terminal CLI, Amazon Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry. (The CLI has an unrelated `claude project` command that manages local per-directory state — explicitly called out as unrelated.) — [Claude Code Docs](https://code.claude.com/docs/en/claude-projects)
- **Plans**: Public beta on **Pro and Max** plans only; **not yet available on Team or Enterprise** plans. Rollout is gradual, starting with accounts that have already used cloud sessions and have no existing legacy projects in claude.ai chat/Cowork; users without access can join a waitlist. — [Claude Code Docs](https://code.claude.com/docs/en/claude-projects); [Claude blog](https://claude.com/blog/projects-redesigned)
- **Announcement date**: 2026-09-17. — [ClaudeDevs on X](https://x.com/ClaudeDevs/status/2100633571543367691); [Claude blog](https://claude.com/blog/projects-redesigned); [MarkTechPost](https://www.marktechpost.com/2026/09/17/anthropic-launches-claude-code-projects-in-beta-parallel-cloud-sessions-that-keep-running-after-you-close-your-laptop/)
- **Local execution**: threads currently run only in the cloud; the docs' Limitations section confirms "A local session can't be part of a project," and independent coverage (VentureBeat) reports Anthropic saying local-machine thread support is "coming very soon" — this specific phrase was not found verbatim on the current docs page, so treat it as secondary-source-only pending doc confirmation.
- **Model/effort defaults**: a new project runs **Opus** for both coordinator and threads by default, with **high effort** for threads and **low effort** for the coordinator conversation; both are independently configurable in Project settings. — [Claude Code Docs](https://code.claude.com/docs/en/claude-projects)
- **Usage/cost**: projects draw on the same Pro/Max plan limits as other Claude Code sessions (no separate project pricing), and use those limits faster because multiple full-session threads can run concurrently; a thread that hits a plan limit auto-retries after the limit resets (except routine-started threads, which stop with an error instead). — [Claude Code Docs](https://code.claude.com/docs/en/claude-projects)

## Inferred / unclear

- Whether a thread can autonomously **merge** its own PR without being told to is not explicitly stated either way; the documented default behavior and example project-instructions text ("Don't merge... without asking me") imply merging is normally user-gated, but this is inference, not an explicit blanket statement in the docs.
- The "coming very soon" language for local-machine thread execution appears only in secondary coverage (VentureBeat paraphrase), not verified verbatim on the docs page fetched for this report — treat as **not fully confirmed from a primary source**, though the docs do note local sessions "can't be part of a project" today, implying this is a known current limitation rather than a permanent one.
- Exact technical implementation of "cloud sandbox" per thread (e.g., container tech, isolation guarantees beyond what's stated) is not documented in detail — docs only describe behavior ("pauses between turns," "resumes," "fresh clone" fallback), not underlying infrastructure.
- Whether/how a project's coordinator model itself decides _when_ to close out a thread as "Resolved" beyond the three named triggers (user action, Claude confirming last step taken, one week idle auto-resolve) is not elaborated further.
- No pricing/limits detail specific to Team/Enterprise plans is available yet since Projects has not reached those plans.

## Concepts and vocabulary (summary table)

| Concept                               | Anthropic's term                                                        | Confirmed source                                        |
| ------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| Top-level container                   | Project                                                                 | [Docs](https://code.claude.com/docs/en/claude-projects) |
| Coordinating chat                     | project conversation / "Claude acts as coordinator"                     | [Docs](https://code.claude.com/docs/en/claude-projects) |
| Unit of delegated work                | Thread                                                                  | [Docs](https://code.claude.com/docs/en/claude-projects) |
| Underlying session type               | Cloud session                                                           | [Docs](https://code.claude.com/docs/en/claude-projects) |
| Per-repo isolation mechanism          | own branch + own repo clone in a cloud sandbox (NOT local git worktree) | [Docs](https://code.claude.com/docs/en/claude-projects) |
| Status dashboard                      | Overview pane (Threads / Library / Pull requests / Routines tabs)       | [Docs](https://code.claude.com/docs/en/claude-projects) |
| Persistent project-level facts        | Project memory (`MEMORY.md` index + files)                              | [Docs](https://code.claude.com/docs/en/claude-projects) |
| Standing brief                        | Project instructions                                                    | [Docs](https://code.claude.com/docs/en/claude-projects) |
| Scheduled/recurring work              | Routines                                                                | [Docs](https://code.claude.com/docs/en/claude-projects) |
| Multi-person equivalent               | Claude Tag (Slack, Team/Enterprise)                                     | [Docs](https://code.claude.com/docs/en/claude-projects) |
| Legacy/unrelated concept of same name | "Projects" in claude.ai chat / Cowork                                   | [Docs](https://code.claude.com/docs/en/claude-projects) |

## Search methodology

- Searches performed: 6 (2 initial broad WebSearch queries, plus targeted WebFetch of the official docs page, the official blog post, and three independent outlets for corroboration).
- Primary source: Anthropic's own Claude Code documentation page `code.claude.com/docs/en/claude-projects`, fetched in full and quoted extensively above — this is the highest-confidence source in this report.
- Secondary corroboration: Anthropic's own blog post, plus VentureBeat, MarkTechPost, and Unite.AI, all published 2026-09-17, all consistent with the docs on architecture, git behavior, and availability.
- No existing DorkOS `research/` file covered this topic (checked via Glob before starting).

## Sources

- [Let Claude coordinate ongoing work with Projects — Claude Code Docs](https://code.claude.com/docs/en/claude-projects) (primary, official documentation)
- [Projects redesigned: from folder to conversation — Claude by Anthropic](https://claude.com/blog/projects-redesigned) (official announcement)
- [ClaudeDevs announcement on X](https://x.com/ClaudeDevs/status/2100633571543367691)
- [Anthropic launches Claude Code Projects, an 'always-on' conversation... — VentureBeat](https://venturebeat.com/orchestration/anthropic-launches-claude-code-projects-an-always-on-conversation-that-remembers-and-delegates-your-long-running-dev-work)
- [Anthropic Launches Claude Code Projects in Beta... — MarkTechPost](https://www.marktechpost.com/2026/09/17/anthropic-launches-claude-code-projects-in-beta-parallel-cloud-sessions-that-keep-running-after-you-close-your-laptop/)
- [Anthropic Redesigns Claude Code Projects to Coordinate Agent Threads — Unite.AI](https://www.unite.ai/anthropic-redesigns-claude-code-projects-to-coordinate-agent-threads/)
- [Anthropic Adds a Coordinator to Claude Projects for Running AI Work in Parallel — DevOps.com](https://devops.com/anthropic-adds-a-coordinator-to-claude-projects-for-running-ai-work-in-parallel/) (found in search, not individually fetched)
