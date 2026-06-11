---
title: 'Workspace Strategy — Industry Conventions, OpenAI Symphony, and a DorkOS Workspace Architecture'
date: 2026-06-11
type: external-best-practices
status: active
tags:
  [
    workspaces,
    worktrees,
    isolation,
    agent-runtimes,
    symphony,
    orchestration,
    claude-code,
    cursor,
    codex,
    opencode,
  ]
searches_performed: 40+
sources_count: 50+
---

## Research Summary

This report surveys how every major coding agent isolates work into workspaces (Claude Code, Cursor, Codex CLI/App/Cloud, OpenCode, Conductor, Sculptor, Dagger container-use), reviews the OpenAI Symphony spec and its Elixir reference implementation in depth, and derives a runtime-agnostic workspace architecture for DorkOS. It also identifies the near-term changes that keep the current gtr-based harness workflow compatible with that future.

Companion artifacts: `contributing/parallel-execution.md` (current workflow), Symphony source cached at `~/.opensrc/repos/github.com/openai/symphony/main`.

---

## Key Findings

1. **The industry has converged on home-rooted global workspace directories, keyed `<tool-home>/<project>/<workspace>`.** Six of seven tools surveyed put workspaces outside the repo: Cursor (`~/.cursor/worktrees/<repo>/<id>`), Codex App (`~/.codex/worktrees/<id>/<repo>`), OpenCode (`~/.local/share/opencode/worktree/<project-id>/<branch>`), Conductor (`~/conductor/workspaces/<repo>/<name>`), Sculptor (`~/.sculptor/workspaces/<id>/code`), container-use (`~/.config/container-use/worktrees/<env>`). Claude Code is the lone outlier (in-repo `.claude/worktrees/`) and has open issues requesting configurability (#28242). **DorkOS should use `~/.dork/workspaces/<project>/<key>/` via `dork-home.ts`.**

2. **The workspace unit is the unit of work (issue/task/thread), not the session.** Symphony keys workspaces by sanitized issue identifier and reuses them across run attempts. Conductor is per-task with multiple chats per workspace. Codex App is per-thread with reuse on resume. Claude Code desktop's per-session auto-worktree is the outlier and generates sustained user complaints (#31896 et al.). **DorkOS sessions should _attach to_ workspaces; a workspace outlives any one session.**

3. **Provisioning belongs in version-controlled, repo-owned hook config.** Cursor: `.cursor/worktrees.json` (`setup-worktree` commands, `$ROOT_WORKTREE_PATH`). Codex App: setup scripts in `.codex/`. Conductor: `setup`/`run`/`archive` scripts in `.conductor/settings.toml`. OpenCode: `commands.start`. Symphony: `after_create`/`before_run`/`after_run`/`before_remove` hooks in `WORKFLOW.md` front matter. DorkOS's `.gtrconfig` postCreate hooks are already this pattern.

4. **Symphony's workspace model is minimal and portable — and DorkOS already has every other component of Symphony.** Workspace = `<workspace.root>/<sanitized_issue_identifier>` (sanitize to `[A-Za-z0-9._-]`), populated entirely by hooks (no VCS assumptions), reused across attempts, cleaned on tracker terminal state. Symphony's other layers map 1:1 onto existing DorkOS subsystems (see §5). The only missing DorkOS piece is a WorkspaceManager.

5. **Cleanup is the industry's biggest failure mode — be conservative.** Documented data-loss incidents: Claude Code auto-cleanup deleted 10 days of uncommitted work (#46444); Cursor force-deleted user branches during cleanup and silently ran `git stash + git reset HEAD` mid-session. Retention designs vary (Cursor cap 25, Codex App cap 15 + pinned "permanent" worktrees, Claude Code 30-day sweep, Symphony terminal-state removal). **Never auto-delete a workspace with uncommitted/unpushed work; tie cleanup to unit-of-work terminal state; support pinning.**

6. **Port isolation is an unsolved gap DorkOS can own.** Only Conductor solves it natively (`CONDUCTOR_PORT` = first of a block of 10 consecutive ports per workspace, injected as env). Everyone else leaves it to community hash-the-branch-name scripts (exactly what `worktree-setup.sh` does). A server that allocates port blocks per workspace and injects them as env is a genuine DorkOS differentiator — DorkOS _has_ a server; the others don't.

7. **Runtime-native isolation is a different layer than workspace isolation — compose, don't conflate.** Codex CLI sandboxes _in place_ (sandbox-exec/landlock policies; cwd is the workspace; `.git/` and config carved out read-only). Sculptor and container-use isolate via containers. These compose with directory-level workspaces: DorkOS assigns the directory; the runtime applies its own sandbox inside it.

---

## 1. OpenAI Symphony Review

Repo: `github.com/openai/symphony` — a 2,185-line SPEC.md plus reference implementations (Elixir primary; TS/Go/Rust/Java/Python used to de-ambiguate the spec). Symphony polls Linear, creates an isolated workspace per issue, and runs a Codex app-server session inside it until the issue is done.

### 1.1 Architecture layers (SPEC §3.2)

| Symphony layer         | Responsibility                               | DorkOS analog                                   |
| ---------------------- | -------------------------------------------- | ----------------------------------------------- |
| Policy (`WORKFLOW.md`) | Repo-owned prompt + config front matter      | `AGENTS.md`, skills, specs                      |
| Configuration          | Typed getters, defaults, env indirection     | `config-manager` (conf + Zod)                   |
| Coordination           | Poll loop, eligibility, concurrency, retries | `services/tasks/`, `/pm` loop                   |
| Execution              | Workspace lifecycle + agent subprocess       | `AgentRuntime` + **(missing) WorkspaceManager** |
| Integration            | Linear adapter                               | Linear MCP / composio                           |
| Observability          | Logs, status dashboard, REST API             | Console, session streams, `/api/docs`           |

### 1.2 Workspace model (SPEC §9, §5.3.3–5.3.4)

- **Layout**: `<workspace.root>/<sanitized_issue_identifier>`; root defaults to `<system-temp>/symphony_workspaces`, configurable, normalized absolute.
- **Keying**: sanitize issue identifier to `[A-Za-z0-9._-]`, replace others with `_`.
- **Population**: no built-in VCS behavior. `after_create` hook (typically `git clone`) does everything. The spec is deliberately VCS-agnostic.
- **Hooks**: `after_create` (fatal on failure), `before_run` (fatal), `after_run` (logged+ignored), `before_remove` (logged+ignored). Run via `sh -lc` with workspace as cwd, default 60s timeout.
- **Persistence**: workspaces are _reused across run attempts_ for the same issue; successful runs do not auto-delete.
- **Cleanup**: reconciliation removes the workspace when the tracker issue reaches a terminal state; a startup sweep removes workspaces for already-terminal issues.
- **Safety invariants (§9.5)**: (1) agent subprocess cwd MUST equal the workspace path; (2) workspace path MUST be inside workspace root (canonical prefix check); (3) sanitized directory names only.

### 1.3 Implementation notes (Elixir `workspace.ex`, ~480 lines)

- Full lifecycle (create/reuse/hooks/remove/validate) is small and clean — a DorkOS port is a modest service, not a project.
- Supports **remote workspaces over SSH** (`worker_host`) with the same contract — workspaces don't have to be local.
- Path validation detects **symlink escapes** (expanded-inside-root but canonical-outside-root is a distinct error).
- Hook output is sanitized/truncated (2 KB) before logging.

### 1.4 Agent coupling (SPEC §10)

The agent protocol is pinned to the Codex app-server (launched via `bash -lc` in the workspace; thread/turn IDs; pass-through `approval_policy`/`thread_sandbox` config). Symphony acknowledges this is the targeted protocol, not an abstraction. **DorkOS's `AgentRuntime` interface is precisely the generalization Symphony lacks** — a DorkOS Symphony implementation would swap §10 for `runtime.ensureSession()` + `runtime.sendMessage()` with `cwd` set to the workspace.

---

## 2. Industry Survey (condensed)

| Tool                   | Workspace location                                                                          | Keying                                                    | Unit                                                      | Provisioning                                                                                             | Cleanup                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Claude Code CLI        | `<repo>/.claude/worktrees/<name>/` (in-repo; hook can relocate)                             | name or adjective-noun; branch `worktree-<name>`          | session                                                   | `.worktreeinclude` copy + `WorktreeCreate` hook (replaces default logic, prints path)                    | exit-time prompt; 30-day sweep (`cleanupPeriodDays`); data-loss bug #46444       |
| Claude Code desktop    | same                                                                                        | random adjective-noun                                     | per-session (forced; no opt-out)                          | same                                                                                                     | same                                                                             |
| Cursor (local)         | `~/.cursor/worktrees/<repo>/<id>/` (not configurable)                                       | 3-char id; branch `<repo>-<n>-<id>`                       | task                                                      | `.cursor/worktrees.json` `setup-worktree[-os]` commands, `$ROOT_WORKTREE_PATH`                           | cap 25 (`worktreeMaxCount`) + interval sweep; force-delete and silent-stash bugs |
| Cursor Cloud           | remote Ubuntu VM                                                                            | n/a                                                       | task                                                      | snapshot / Dockerfile via `.cursor/environment.json`                                                     | VM lifecycle                                                                     |
| Codex CLI              | sandboxes in place (no separate dir); `workspace-write` policy, `.git/` read-only carve-out | n/a                                                       | invocation                                                | n/a                                                                                                      | n/a                                                                              |
| Codex App              | `~/.codex/worktrees/<id>/<repo>/`, detached HEAD                                            | internal id                                               | thread (reused on resume; "permanent" worktrees pinnable) | setup scripts in repo `.codex/`, OS variants                                                             | cap 15 most-recent; delete on thread archive; snapshot before delete             |
| Codex Cloud            | microVM `/workspace/<project>/`                                                             | n/a                                                       | task                                                      | two-phase: setup (online) / agent (offline); `codex-universal` image; 12h cache + maintenance script     | ephemeral                                                                        |
| OpenCode               | `~/.local/share/opencode/worktree/<project-id>/<branch>/` (project-id = root-commit SHA)    | branch; prefix `opencode/`                                | session                                                   | `commands.start`; plugin adds `postCreate`/`preDelete`, copyFiles/symlinkDirs                            | plugin: two-phase delete on `session.idle`                                       |
| Conductor              | `~/conductor/workspaces/<repo>/<city>/`                                                     | city names; agent renames branch to match task            | task (multi-chat)                                         | `.conductor/settings.toml` setup/run/archive scripts; **`CONDUCTOR_PORT` = block of 10 ports/workspace** | archive script on teardown                                                       |
| Sculptor               | `~/.sculptor/workspaces/<id>/code/` + Docker container                                      | internal id                                               | task                                                      | container image; repo cloned per workspace                                                               | explicit merge/discard                                                           |
| container-use (Dagger) | `~/.config/container-use/worktrees/<env>/` mounted at `/workdir`                            | adverb-animal; branches `<env>` remote / `cu-<env>` local | agent-session ↔ environment 1:1                           | Dagger pipeline code                                                                                     | explicit merge/apply/discard; state as git notes                                 |

Cross-tool: `AGENTS.md` is the ratified behavioral standard (Linux Foundation AAIF, Dec 2025; 32 KiB Codex cap) but defines **no workspace-layout conventions** — layout is still tool-by-tool. Community-neutral in-repo patterns (`.worktrees/`, `.trees/<TASK-ID>/`) exist for mixed-tool teams.

---

## 3. What This Means for DorkOS

### 3.1 The gap and the asset

DorkOS already has: per-session `cwd` in the runtime contract (`SessionOpts.cwd`, `MessageOpts.cwd` — every runtime receives a working directory), a runtime registry, a Linear loop, a task service, config management, and observability. It is missing exactly one Symphony component: a **workspace lifecycle manager**. That is the whole integration surface — no `AgentRuntime` changes are required to add isolated workspaces, because binding is just `session.cwd = workspace.path`.

### 3.2 Recommended architecture

**Workspace as a first-class server entity** (`services/core/` or new `services/workspace/`):

```ts
interface Workspace {
  id: string;
  projectKey: string; // sanitized repo/project identifier
  key: string; // sanitized unit-of-work key (issue id, spec slug)
  path: string; // absolute, under workspace root
  source: string; // origin repo path or URL
  branch?: string;
  provider: 'worktree' | 'clone'; // later: 'container' | 'remote'
  status: 'provisioning' | 'ready' | 'failed' | 'removing';
  pinned: boolean;
  createdAt: string;
  lastUsedAt: string;
}
```

**`WorkspaceProvider` interface** (hexagonal, like `Transport`/`AgentRuntime`): `create`, `list`, `get`, `remove`, hook execution. Two initial providers:

- `worktree` — `git worktree add` from an existing local checkout (fast, shared object store; what gtr does today)
- `clone` — fresh clone Symphony-style (works when DorkOS manages repos the user hasn't checked out locally)

**Location**: `~/.dork/workspaces/<projectKey>/<key>/` resolved via `lib/dork-home.ts` (hard rule: no `os.homedir()`); dev = `apps/server/.temp/.dork/workspaces/`. Matches the 6-of-7 industry pattern and keeps repos and their parents clean.

**Keying**: per unit of work, not per session. `key` = sanitized (`[A-Za-z0-9._-]`) issue identifier or spec slug. Sessions attach; several sessions (or several runtimes!) can share one workspace over its life. Branch naming `dork/<key>`.

**Hooks**: adopt Symphony's four hooks _with Symphony's exact names and failure semantics_ (`after_create` fatal, `before_run` fatal, `after_run`/`before_remove` logged-ignored, 60s default timeout, cwd = workspace). Config lives in a repo-owned versioned file — `.dork/workspace.json` fits the existing `.dork/agent.json` precedent. Name-compatibility makes a future Symphony adoption (or a DorkOS Symphony extension) a config copy, not a migration.

**Safety invariants** (Symphony §9.5 + lessons from CC/Cursor incidents):

1. Agent session cwd MUST equal the workspace path (validate before dispatch).
2. Workspace path MUST canonicalize inside the workspace root (detect symlink escapes, per the Elixir impl).
3. Keys sanitized to `[A-Za-z0-9._-]`.
4. **Never auto-remove a workspace with uncommitted changes, untracked files, or unpushed commits** — require explicit confirmation (this is where Claude Code and Cursor both shipped data-loss bugs).
5. Cleanup triggers: unit-of-work terminal state (issue Done / branch merged), plus an optional retention cap and age sweep, all gated on check 4; `pinned` exempts a workspace entirely (Codex "permanent worktrees" precedent).

**Ports**: lift the `worktree-setup.sh` hash into the WorkspaceManager as a server-side port-block allocator (Conductor model: contiguous block per workspace, injected as env — `DORKOS_PORT`, `VITE_PORT`, or a generic `DORKOS_WORKSPACE_PORT_BASE`). Server-side allocation eliminates hash collisions outright and works identically for every runtime.

**Runtime composition**: DorkOS assigns the directory; runtimes layer their own isolation inside it (Codex `workspace-write` sandbox, Claude Code permissions, future container providers). Never build DorkOS features on runtime-native worktree tools (e.g. Claude's `EnterWorktree` — which also doesn't fire `WorktreeCreate` hooks, bug #36205).

### 3.3 Symphony as a DorkOS extension

Feasible and mostly assembly: tracker client → Linear MCP/composio (exists), orchestrator state machine + poll loop → new but small (the Elixir reference is instructive), workspace → the WorkspaceManager above, agent runner → `AgentRuntime` (already generalizes Symphony's Codex pinning), observability → console + streams (exceeds the spec's optional dashboard). The differentiating DorkOS claim: Symphony semantics, but **runtime-agnostic** — the same issue can be dispatched to Claude Code, Codex, or OpenCode runtimes.

---

## 4. Near-Term Workflow Changes (keep today compatible with tomorrow)

1. **Keep the gtr-based `/worktree:*` flow** — its interface (create/list/remove + repo-owned postCreate hooks + port assignment) is already the future shape; gtr is the interim `worktree` provider.
2. **Relocate gtr worktrees to the future home** — DONE (PR #12): `gtr.worktrees.dir = ~/.dork/workspaces/core` in `.gtrconfig`; worktrees now live in the layout the WorkspaceManager will own.
3. **Keep keying worktrees by unit of work** (`spec-<slug>`, `DOR-123`) — executing-specs Phase 0 already does this; it matches Symphony reuse semantics.
4. **Keep provisioning logic in hook scripts** (`.gtrconfig` postCreate + `worktree-setup.sh`) — they port verbatim into `after_create` under any future system. Plan to migrate port assignment server-side when the WorkspaceManager exists.
5. **Keep cleanup terminal-state-driven** (`/linear:done` integration) and conservative (dirty-tree refusal) — already aligned with Symphony and the industry's hard-won lessons.
6. **Confine `EnterWorktree`/`ExitWorktree` to harness UX** (skills/commands). DorkOS product code binds sessions to workspaces exclusively via `SessionOpts.cwd`.

## 5. Naming Layer: Vercel Portless (`.localhost` subdomains)

[vercel-labs/portless](https://github.com/vercel-labs/portless) attacks the same collision problem from the naming side: a local HTTPS proxy routes stable named URLs (`myapp.localhost`, `api.myapp.localhost`) to dev servers it started, assigning each a random ephemeral port (4000–4999, injected as `PORT`) and keeping a file-locked route registry under `~/.portless`. It is **worktree-aware**: in a linked worktree it prepends the branch name automatically (`fix-ui.myapp.localhost`), which is exactly our per-workspace naming problem.

**Why it matters beyond aesthetics — origin scoping.** Cookies are domain-scoped and _ignore ports_ (RFC 6265), so parallel dev servers on `localhost:4310` and `localhost:4320` share one cookie jar — auth/session state bleeds between workspaces. `localStorage`/`IndexedDB` are origin-scoped (scheme+host+port) and already isolated by ports. Distinct `.localhost` subdomains give each workspace its own cookie scope _and_ its own storage origin, plus production-like multi-origin behavior.

**Downsides:**

- **Privilege or ugliness**: clean no-port URLs require `portless service install` — a root/SYSTEM daemon binding 443 and inserting a locally-generated CA into the system trust store (a MITM-capable root if the key leaks). Unprivileged mode works but URLs carry the proxy port (`myapp.localhost:1355`), undercutting the pitch (issue #123).
- **Resolver gaps**: `.localhost` subdomains resolve in Chrome/Firefox/Edge only. Safari, curl, and Node's resolver need `/etc/hosts` syncing (`portless hosts sync`) — fragile for agent-driven testing and server-to-server calls, which must keep using `127.0.0.1:<port>` or set Host headers.
- **Proxy-in-the-middle bugs**: Vite-to-Vite proxying without `changeOrigin` causes `508 Loop Detected`; Next.js LAN mode needs `allowedDevOrigins`; HMR/WebSocket flows depend on proxy fidelity.
- **Pre-1.0 Vercel Labs project**: state-dir format changes between releases; Node 24+ requirement.
- **It is its own port allocator**: portless assigns random ports itself, overlapping the WorkspaceManager's allocation role.

**Verdict for DorkOS**: complementary, not competing — ports are the _substrate_ (something must own collision-free numeric allocation; portless's random-port + registry is just a simpler allocator), naming is the _surface_. Three composition options, in rough order of preference: (a) WorkspaceManager allocates port blocks and _optionally registers them with portless_ via `portless alias <name> <port>` for users who run it; (b) DorkOS server (which already exists and runs persistently) grows its own `.localhost` route table and proxy — owning the naming layer without a second daemon, but inheriting the 443-privilege problem; (c) ignore naming, ship port blocks only. Recommend (c) for the WorkspaceManager v1 with (a) as a fast-follow integration — don't take a hard dependency on a pre-1.0 root daemon, but design the workspace entity so a `url`/`hostname` field can join `portBase` later.

## Open Questions

- Project identity: repo name (human-friendly, collision-prone) vs OpenCode's root-commit SHA (stable, opaque) vs both (`<name>-<shortsha>`)?
- Naming layer: if portless (or a DorkOS-owned `.localhost` proxy) is adopted, do branch subdomains follow portless's `<branch>.<app>.localhost` or DorkOS's `<key>.<project>.localhost`?
- Should `.dork/workspace.json` subsume `.gtrconfig`, or should the gtr provider translate one into the other?
- Container/remote providers: container-use's MCP-server approach suggests a `container` provider could be an _adapter to container-use itself_ rather than a reimplementation.
- Workspace UI: where do workspaces surface in the console (per-agent? per-project? status-bar)?

## Sources

Symphony: [openai/symphony](https://github.com/openai/symphony), [SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md), [announcement](https://openai.com/index/open-source-codex-orchestration-symphony/). Claude Code: [worktrees docs](https://code.claude.com/docs/en/worktrees), [hooks reference](https://code.claude.com/docs/en/hooks), issues [#28242](https://github.com/anthropics/claude-code/issues/28242), [#31896](https://github.com/anthropics/claude-code/issues/31896), [#36205](https://github.com/anthropics/claude-code/issues/36205), [#46444](https://github.com/anthropics/claude-code/issues/46444), [tfriedel/claude-worktree-hooks](https://github.com/tfriedel/claude-worktree-hooks). Cursor: [worktrees](https://cursor.com/docs/configuration/worktrees), [cloud agents](https://cursor.com/docs/cloud-agent), forum threads on location/cleanup/data-loss. Codex: [sandboxing](https://developers.openai.com/codex/concepts/sandboxing), [app worktrees](https://developers.openai.com/codex/app/worktrees), [cloud environments](https://developers.openai.com/codex/cloud/environments), [openai/codex#10599](https://github.com/openai/codex/issues/10599). OpenCode: [docs](https://opencode.ai/docs/config/), [sst/opencode DeepWiki](https://deepwiki.com/sst/opencode/2.7-project-and-worktree-management), [kdcokenny/opencode-worktree](https://github.com/kdcokenny/opencode-worktree). Conductor: [workspaces](https://www.conductor.build/docs/concepts/workspaces-and-branches), [settings](https://www.conductor.build/docs/reference/settings). Sculptor: [imbue-ai/sculptor](https://github.com/imbue-ai/sculptor). container-use: [dagger/container-use](https://github.com/dagger/container-use). AGENTS.md: [InfoQ](https://www.infoq.com/news/2025/08/agents-md/). Portless: [vercel-labs/portless](https://github.com/vercel-labs/portless), [issue #123 (port in URLs)](https://github.com/vercel-labs/portless/issues/123), [Portless + Conductor + worktrees](https://community.vercel.com/t/using-portless-with-conductor-git-worktrees/34557).
