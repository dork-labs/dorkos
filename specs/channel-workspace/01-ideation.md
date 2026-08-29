---
slug: channel-workspace
id: 260726-162747
created: 2026-07-26
status: superseded
superseded-by: 260827-202452
---

# Ideation: Channel workspaces

**Superseded 2026-08-29 by [`specs/project-rooms/`](../project-rooms/02-specification.md)**
(id `260827-202452`). See the supersession note in this spec's `02-specification.md` for what
carried over and what changed.

- **Slug:** channel-workspace
- **Date:** 2026-07-26
- **Author:** Claude (directed by Dorian)
- **Tracker:** unassigned (rooms track; adjacent to DOR-455 multi-participant message list)

## 1) Intent & Assumptions

**Task brief.** DorkOS is heading toward **rooms** — group chats where several humans and several agents participate. A room may own a **channel workspace**: a shared place that carries the room's _working context_, not its messages. The insight to build on is that a channel workspace should look like an agent workspace — it can carry its own `AGENTS.md`, skills, hooks, and commands, and those get **layered onto** each participating agent's existing setup rather than replacing it.

**Assumptions carried in from the brief:**

- A channel workspace **is a git repo distributed by clone**, not a shared folder. Rooms will eventually span machines (Dorian and Ikechi in one channel on two computers, each with their own agents), and nothing shared at the filesystem level means nothing needs distributed locking.
- The layering mechanism **already exists**: `@dorkos/harness` projects five kinds of config from a canonical source into every harness's native on-disk layout. A channel workspace should become another _source_ that engine composes, not a parallel mechanism.
- **Local-only rooms first.** The design must work on one machine and extend to many without a rewrite, but must not build the remote case now.
- A channel workspace is **not** where agents do task work. Each main agent keeps its own working directory for that.

**Out of scope:**

- The room/channel entity itself (membership, message log, presence). This spec assumes a room exists and can name a channel workspace; it designs only the workspace.
- Multi-machine transport, community servers, identity, and invites — `research/20260724_multi-user-communities.md` owns that design space.
- The agent's own workspace binding — sibling spec `specs/agent-workspace-binding/`, being written concurrently. Referenced, not designed.

## 2) Pre-reading Log

- `contributing/harness-sync.md` — the projection engine: five config kinds, one canonical source, per-harness native layouts, an honest drop list, `<pkg>__<name>` namespacing, `_dorkosHarness` sentinel for merged hooks, ephemeral/gitignored projections for non-authored provenance. This is the mechanism the brief is right about.
- `packages/harness/src/` — `project(repoRoot, opts?: { dorkHome?: string })` composes `scanInstalledPlugins` + manifest + Claude hooks into `buildPlan`. `Provenance = 'authored' | 'installed' | 'adopted'`; `ProjectionKind` already includes `'merge'` (engine-owned entries into a user-owned file).
- `packages/harness/src/plan/instructions.ts` — **the finding that reshaped the design.** Instructions are one canonical `AGENTS.md` plus per-harness _pointers_. `CLAUDE_INSTRUCTION_CONTENT` is the literal `@../AGENTS.md\n`. Codex, Cursor, and OpenCode are `native` — they read `AGENTS.md` directly, with no import mechanism. `applyScaffold` is write-if-absent and never rewrites an existing pointer. There is no merging or layering of instruction files anywhere in the engine, by decision (ADR-0302).
- `packages/harness/src/apply/settings-hooks.ts` — hooks merge into `.claude/settings.local.json` under the `_dorkosHarness` sentinel; ownership is explicit, never inferred from the command string; a corrupt file is a hard stop, not a clobber. **Multiple hooks on one event are plain concatenation — no precedence, no dedup, no conflict detection between two plugins.**
- `contributing/workspace-manager.md` — the file-first sidecar pattern (`<key>.workspace.json` is truth, the SQLite row is a rebuilt cache), conservative dirty-state cleanup, and a 5-minute reconciler. The right shape to copy for channel bookkeeping.
- `apps/server/src/services/runtimes/{claude-code/messaging/message-sender.ts,codex/turn-input.ts,opencode/turn-input.ts}` — all three runtimes honor `messageOpts.systemPromptAppend`, concatenated after a DorkOS-built base append. The Tasks scheduler already uses it. This is a shipped, runtime-neutral seam for standing instructions.
- `apps/server/src/services/core/{approvals,capabilities}/` — the shipped approval primitive (single-use, input-hash-bound, TTL, standing grants, decision authority) and the `observe`/`act`/`destructive` tier gate. The consent machinery already exists; nothing here needs a new one.
- `research/20260724_multi-user-communities.md` — the rooms design space. Establishes **community → member → channel**; Part 7 names harness distribution as a differentiator ("A community distributing shared skills, workflows, and conventions through it is a genuine differentiator Buzz has no equivalent for"); open question 5 asks whether the marketplace becomes community-scoped and notes it changes the trust model. **This spec is the concrete answer to that line.**
- `specs/multi-participant-message-list/02-specification.md` — D2 defers the wire-level author shape to "the room model that phase 3 introduces". Confirms the room model is anticipated and unspecified.
- `specs/channels-and-agent-adapters/`, `specs/channel-sender-identity/` — **"Channel" is already the user-facing name for a Relay adapter** (a Telegram/Slack/webhook transport bound to one agent). Naming collision; see Decision 8.

## 3) Codebase Map

- **Projection engine:** `packages/harness/src/` — `engine.ts` (compose), `plan/projector.ts` (`buildPlan`, the pure core), `sources/installed.ts` (the second source), `plan/installed-projector.ts` (per-plugin projection + hook merge planning), `apply/` (realize + sweep), `manifest/schema.ts` (`.agents/harness.manifest.json`, `.strict()`).
- **Sync triggers:** `apps/server/src/services/harness/auto-project.ts` (`runAutoProjection`, fired by the marketplace's `onPluginsChanged`); `packages/cli/src/harness-sync-command.ts` (`dorkos harness sync [--check|--fix] [--harness <id>]`).
- **Turn assembly:** `apps/server/src/services/session/trigger-turn.ts` → runtime adapters' `systemPromptAppend` / `additionalContext` (ADR-0273).
- **Consent + gates:** `apps/server/src/services/core/approvals/`, `services/core/capabilities/tier-enforcement.ts`.
- **Directory bookkeeping precedent:** `apps/server/src/services/workspace/` (file-first sidecar, provider seam, reconciler).
- **Blast radius:** `packages/harness` (new source + a generalized projector), `apps/server/src/services/{harness,session}`, a new `services/channel/` domain, `packages/shared` (channel entity + Zod), `apps/client` (join/leave, "what does this channel add to my agents"), `~/.dork/` layout, repo `.gitignore` patterns.

## 4) Research

### 4a. Distribution — how does a channel workspace reach a member?

| Option                                          | Verdict                                                                                                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared network filesystem                       | **Rejected.** Distributed locking and latency; the worst version of this.                                                                                                                       |
| **A git repo each member clones**               | **Chosen.** Nothing is shared at the filesystem level, so nothing needs distributed locking. Members' agents get identical rules without touching the same disk. Agents already understand git. |
| No shared workspace; coordinate work items only | Viable and composable with the above, but does not deliver shared _rules_, which is the point.                                                                                                  |

The git choice also earns its keep on **one machine**, which is the case being built first, and this is the stronger argument: a plain folder gives no history, no atomic update boundary, no pinnable version, no way to say "this turn ran against _that_ set of rules", and no path to the remote case. A local repo with no remote gives all four for the cost of one `git init`.

### 4b. Can harness sync actually be extended, or is a parallel mechanism needed?

Answer differs by artifact kind. This is the central research finding.

- **Skills and commands — yes, near-exactly.** A channel is shaped like an installed marketplace plugin: a directory with `skills/` and `commands/`. `scanInstalledPlugins` already enumerates that layout; `installed-projector.ts` already projects it with mandatory `<pkg>__<name>` namespacing, per-harness targets, generated command wrappers with an ownership marker, ephemeral gitignore, and an orphan sweep. A channel source needs a new `Provenance` value and to feed the same projector. `isEphemeralProvenance` already treats anything non-`authored` as gitignored, so ephemerality is free.
- **Instructions — no, and the reason is concrete, not a preference.** Four sub-options, all disqualified:
  1. _Generate a composed instruction file._ Directly contradicts ADR-0302 (`AGENTS.md` is hand-authored and canonical; the engine scaffolds pointers and never rewrites a body). It also re-introduces the exact duplication that ADR rejected.
  2. _Extend the scaffolded pointer to import both files._ `applyScaffold` is write-if-absent by design — an existing `.claude/CLAUDE.md` is never rewritten, and every real repo has one. The channel import would land only in repos that had no pointer yet.
  3. _Managed-block merge into the pointer_ (the `ProjectionKind: 'merge'` model that `.claude/settings.local.json` already uses). Architecturally consistent, but `.claude/CLAUDE.md` and root `AGENTS.md` are **committed** files. Layering a channel this way writes another organization's content into a member's git history on every sync. Disqualifying.
  4. _Rely on the `@import` syntax generally._ Only Claude Code has one. Codex, Cursor, and OpenCode read `AGENTS.md` as plain prose. There is no cross-harness import primitive to extend.
- **Hooks — mechanically yes, but see 4c.** `mergeHookConfigs` + the `_dorkosHarness` sentinel would accept a channel's hooks with no engine change beyond an owner tag.

So the honest split: **skills and commands ride the projector; instructions ride the turn.** The turn seam is not a parallel invention — `systemPromptAppend` is shipped, runtime-neutral, already used by the Tasks scheduler, and lands above the harness boundary where all three runtimes agree. It is also strictly better here: zero residue in a member's repo, revocable at the next turn, and never committed.

### 4c. Hooks — the trust boundary

A hook is a command line executed on the member's machine, under the member's user account, on every matching tool call, with no sandbox. `PreToolUse` fires before the model sees anything, so there is no "the agent declined" path. Joining a channel that ships hooks is arbitrary code execution granted by a social act.

Worse, a channel workspace is a git repo **whose contents change after you consent**. Consent-at-join covers the tree at join time; every later pull is a new grant. That is the `event-stream` supply-chain shape exactly: benign at adoption, hostile at update.

Options considered:

1. _Hooks allowed, consent at join._ Rejected — consent to a moving target is not consent.
2. _Hooks allowed, re-approve the diff on every pull._ Rejected twice over. It produces approval fatigue, which converts into rubber-stamping; and the diff is a set of shell commands, which Ikechi (non-developer founder persona) cannot evaluate. Asking a person to approve what they cannot read is a dark pattern wearing a consent dialog.
3. **Hooks excluded from v1; declared and dropped honestly.** Chosen. The engine's drop list already exists for exactly this — a channel's `hooks/hooks.json` is enumerated, reported, and never written.
4. _Declarative hooks in a later version._ The intended path: a fixed vocabulary of DorkOS-implemented effects (deny tool X, require approval for tool Y, inject a reminder) evaluated by DorkOS and never shelled out. That is a capability grant, which the shipped tier/approval model already knows how to gate. Named as future work, not built.

Note also the direction of hook composition if they ever are allowed: concatenation means a channel hook can **block** something the member's own hook allowed, but cannot **allow** something the member's hook blocked. Fail-closed is the safe direction, and it comes free from the existing merge. That is an argument for eventually allowing them — not an argument for allowing free-form shell in v1.

### 4d. What about skills? They are not innocent either

A skill is prose, but prose that says "run `curl … | sh`" is a prompt-injection payload aimed at an agent that holds Bash. The mitigation is that the gates deciding what an agent may _actually do_ sit below the instruction layer and are member-owned: permission mode, `.claude/settings.json`, the capability tier gate, standing grants. So the invariant to hold is **a channel workspace can never change a member's permission posture** — enforced by construction, because the channel source contributes only instructions, skills, and commands, and every other artifact type is a refused drop.

## 5) Decisions carried into SPECIFY

| #   | Decision                                                                                                                                                                                       | Rationale                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A channel workspace is a **git repo, cloned per member**, one clone per machine.                                                                                                               | No shared filesystem, so no distributed locking; works identically at 1 and N machines; gives history, pinning, and an atomic update boundary.                                    |
| 2   | **Skills and commands** project through `@dorkos/harness` as a new source with `Provenance: 'channel'`.                                                                                        | The installed-plugin path already does exactly this — namespacing, ephemerality, sweep. Extending it is a generalization, not a copy.                                             |
| 3   | **Instructions do NOT project to disk.** They ride `systemPromptAppend` at turn assembly.                                                                                                      | Disk projection requires writing into a committed file in a member's repo (4b). The turn seam is shipped, runtime-neutral, and leaves no residue.                                 |
| 4   | **Hooks are excluded from v1** and appear on the drop list with a reason.                                                                                                                      | Free-form hooks are unsandboxed code execution granted by a social act, over a repo that changes after consent. No consent design survives that (4c).                             |
| 5   | Precedence: **channel adds, never overrides**. Skills/commands are namespaced so collision is impossible; prose precedence is a **stated contract inside the composed block**, not positional. | The harness loads the agent's own `CLAUDE.md`/`AGENTS.md` itself; DorkOS controls only the append. Positional precedence is therefore unavailable and claiming it would be false. |
| 6   | Sync is **pin-and-fetch**: the projection always reads a recorded commit sha; the pin auto-advances by default, and never mid-turn.                                                            | A turn must be reproducible against a known rule set. Auto-advance is defensible only because hooks are excluded; a per-channel manual pin is the escape hatch.                   |
| 7   | Clone lives at `{dorkHome}/channels/<channelId>/checkout/`, with a DorkOS-owned sidecar **outside** the clone.                                                                                 | Mirrors `workspaces/` and `agents/`; the channel's own repo must never be able to write its own consent record.                                                                   |
| 8   | Ship the internal vocabulary as **community → channel** (per the rooms research), and flag the collision with the existing "Channels" adapter UI as a product call this spec does not settle.  | Three-way overload ("Relay channel" vs "community channel" vs a hypothetical room) would confuse users. Naming the collision beats silently adding to it.                         |

## 6) Open questions for SPECIFY

Carried into `02-specification.md` §Open Questions rather than resolved here: which entity owns the channel↔repo binding once the room model lands; whether a channel workspace and a marketplace package should be the same artifact; whether an agent may ever be a member of a channel independently of its owner; and the "Channels" naming collision (Decision 8).
