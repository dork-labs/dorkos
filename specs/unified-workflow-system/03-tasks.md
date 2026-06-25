# Task Breakdown — Unified Workflow System (the `/flow` engine)

**Spec:** [`02-specification.md`](./02-specification.md) · **Slug:** `unified-workflow-system` · **Spec #257**
**Mode:** Full · **Generated:** 2026-06-14

> Consolidate three overlapping harness subsystems (ideation/spec/execution, Linear integration, workspace management) into one PM-agnostic `/flow` workflow engine that runs one canonical stage model two ways — manual slash commands and autonomous PM-driven runs. v1 ships as a DorkOS marketplace `plugin`-type package whose manual mode is server-free and whose autonomous loop is seated on DorkOS Pulse.

This is primarily **unification + extraction + formalization** of pieces that already exist, not greenfield.

---

## Phase summary & critical path

| Phase | Name                                       | Tasks                        |
| ----- | ------------------------------------------ | ---------------------------- |
| P0    | Scaffold                                   | 0.1, 0.2, 0.3                |
| P1    | Extract & thin                             | 1.1, 1.2, 1.3, 1.4, 1.5, 1.6 |
| P2    | Unify the loop                             | 2.1, 2.2, 2.3, 2.4, 2.5      |
| P3    | Agent-as-team-member v1                    | 3.1, 3.2, 3.3                |
| P4    | Proof-of-completion                        | 4.1, 4.2                     |
| P5    | Later: Flow Engine — Extension (docs only) | 5.1                          |

**Critical path:** 0.1 → 0.3 → 1.1 → (2.1 + 2.2) → 2.3 → 2.4 → 2.5 → 3.3 → 4.1 → 4.2 → 5.1

**Parallel opportunities:**

- **P0:** 0.1 ∥ 0.3 (both seed the package; 0.2 follows 0.1).
- **P1:** the four stage-skill tasks 1.2, 1.3, 1.4 run in parallel after the adapter (1.1) lands; 1.6 (schema) runs alongside them (depends on 0.3, not 1.1). 1.5 (orchestrator + legacy removal) gates on 1.2–1.4.
- **P2:** 2.1, 2.2, 2.3 are largely parallel (2.3 wants 2.1's ladder); 2.4 then 2.5 are sequential integration.
- **P3:** 3.1 ∥ 3.2 (3.2 also wants 2.4); 3.3 runs alongside after 3.1 + 2.5.
- **P4:** 4.1 then 4.2 (docs/templates pull from many earlier tasks).

---

## P0 — Scaffold

### 0.1 — Stand up the `.agents/flow/` marketplace plugin-type package skeleton

- **Size:** medium · **Priority:** high
- **Dependencies:** none · **Can run parallel with:** 0.3

**Technical requirements**

- Create `.agents/flow/` as a DorkOS marketplace `plugin`-type package (Decision #24, §14) — the canonical root that makes the system one identifiable installable unit.
- v1 contributes only `commands`/`skills`/`hooks`/`templates` — **no `extensions` layer** (that's P5). `.agents/` stays the cross-harness glue.

**Implementation steps**

- Create `.agents/flow/README.md`, `.agents/flow/SPEC.md` (scaffold headings; full content in later phases).
- Create `.agents/flow/config.json` from the §9 JSONC defaults verbatim (`tracker:"linear"`, `gates.planApproval:false`, `decomposition.subIssueThreshold:"xl"`, `context.perIssue:"fresh-session"`, `autonomy.seat:"pulse"`, …).
- Create `.agents/flow/manifest.json` declaring every member + where it projects (skills synced, commands Claude-native, hook in settings.json, templates loaded by skills).
- Create empty `.agents/flow/skills/` and `.agents/flow/templates/` dirs.
- Create `.claude-plugin/plugin.json` (via `requiresClaudePlugin()`) so it is simultaneously a CC plugin + marketplace entry.

**Acceptance**

- [ ] `.agents/flow/` loads as a plugin
- [ ] `manifest.json` lists every member
- [ ] `pnpm lint`/`typecheck` clean

### 0.2 — Register the flow bundle in harness-sync wiring and verify symlink

- **Size:** small · **Priority:** high
- **Dependencies:** 0.1 · **Can run parallel with:** —

**Technical requirements**

- Ground truth: `.agents/harness.manifest.json` syncs **skills only** (symlink). Commands stay Claude-native in `.claude/commands/`; hooks stay in `.claude/settings.json`. See `project_dual_harness_skills`, `syncing-agent-skills/references/sync-harnesses-spec.md`.

**Implementation steps**

- Register the `flow` bundle in `.agents/harness.manifest.json` (follow existing bundle-declaration pattern).
- Run the skill-sync mechanism so `.agents/flow/skills/*` symlink into `.claude/skills/` (skills dir empty in P0 — establish registration + sync invocation, verify path resolution).
- Do not duplicate skill files — canonical in `.agents/`, symlinked into `.claude/`.

**Acceptance**

- [ ] The bundle's skills appear under `.claude/skills/` via symlink (verified once P1 populates the skills dir)
- [ ] Manifest registration is valid JSON; `pnpm lint`/`typecheck` clean

### 0.3 — Define the Zod config schema and generate `config.schema.json`

- **Size:** medium · **Priority:** high
- **Dependencies:** 0.1 · **Can run parallel with:** 0.1

**Technical requirements**

- Author the Zod schema for `.agents/flow/config.json`; generate `.agents/flow/config.schema.json` via `z.toJSONSchema` (the `conf` precedent — `reference_conf_and_config`, `adding-config-fields`).
- Validate the full §9 shape with resolved defaults: `identity` (`agent:"auto"`, `reviewer:null`, `marker:"— 🤖 /flow"`), `ownership`, `comments`, `stages` (execute/verify `stateCategory:"started"`; review `{stateCategory:"started", humanGate:true}` and no command; done `stateCategory:"completed"`), `autonomy` (`seat:"pulse"`, `wipCap`), `involvement.calibration`, `dispatch`, `gates` (`planApproval:false`, `review`, `circuitBreaker`), `context` (`perIssue:"fresh-session"`, `stageBudgets`), `workspace`, `recovery`, `decomposition` (`subIssueThreshold:"xl"`), `evidence`.

**Implementation steps**

- Place the Zod source consistent with repo conventions; generate `config.schema.json` to `.agents/flow/`, referenced by `config.json` `$schema`.
- Write unit tests: valid/invalid parse; `z.toJSONSchema` round-trip; default resolution asserting `planApproval:false`, `subIssueThreshold:"xl"`, `perIssue:"fresh-session"`, `seat:"pulse"`.

**Acceptance**

- [ ] `config.schema.json` generated from the Zod schema
- [ ] §9 `config.json` parses against it
- [ ] Config schema unit tests pass; `pnpm lint`/`typecheck` clean

---

## P1 — Extract & thin (no behavior change)

> **Phase acceptance:** every `/flow:<stage>` command ≤ ~40 LOC; a grep guard finds **zero** `mcp__linear__*`/Composio strings outside `adapters/linear/`; the legacy commands are removed (hard rename, no aliases); existing manual flows still work; `03-tasks.json` round-trips the new fields.

### 1.1 — Build the `adapters/linear/` adapter skill (the v1 PMClient)

- **Size:** large · **Priority:** high
- **Dependencies:** 0.1, 0.2 · **Can run parallel with:** —

**Technical requirements**

- `.agents/flow/skills/adapters/linear/` owns **every** `mcp__linear__*` / Composio call as a documented prose contract (the v1 `PMClient`; no code interface exists yet — typed `interface PMClient` is the P5 promotion).
- Linear MCP primary; Composio CLI v0.2.31 `--account personal`/DorkOS fallback (never artblocks). See `reference_linear_composio_access_dorkos`.
- Document the `WorkItem` normalization shape (id/identifier/title/description/type/`stateCategory` matched on CATEGORY/`stateName`/priority/size/project/parent/relations/labels/assignee/`agentDisposition`).
- Fulfil verbs: `getCurrentUser`, `getProjects`, `getEligibleWork`, `getInbox`, `getRelations`, `claim`, `transition`, `comment`, `assignToHuman`, `attachEvidence`, `needsInput`, `link`, `createSubIssue`.
- State machine = `agent/*` labels, not the ephemeral `plan` field. `getInbox` carries `{ item, comment: { author, mentions[], body } }`. `claim` durable (label + state). `needsInput` = elicitation. Graceful degradation for trackers lacking `project.stateCategory`/`priority`/`size`.

**Implementation steps**

- Author the adapter skill + prose verb contract.
- Add a grep/lint guard that finds zero tracker strings outside `adapters/linear/`.
- Mock Linear MCP/Composio; assert each verb maps to the right call.

**Acceptance**

- [ ] Grep guard finds zero `mcp__linear__*`/Composio strings outside `adapters/linear/`
- [ ] Adapter verb-contract tests pass
- [ ] Tracker writes confined to this single skill (single audit surface)

### 1.2 — Create intake-stage skills (`capturing-work`, `triaging-work`) + thin `/flow:capture`, `/flow:triage`

- **Size:** medium · **Priority:** high
- **Dependencies:** 1.1 · **Can run parallel with:** 1.3, 1.4, 1.5

**Technical requirements**

- `capturing-work/` absorbs `/linear:idea` + `capturing-linear-ideas` (→ `type/idea`, Triage). `triaging-work/` absorbs `/pm` triage/intake (→ type-label set, Backlog/Todo). `/pm`'s 7 jobs split into `triaging-work` + loop engine + `audit` skill.
- Thin commands `/flow:capture`, `/flow:triage` under `.claude/commands/flow/`, each ≤ ~40 LOC, invoke-only.

**Implementation steps**

- Build the two gerund skills; route all tracker I/O through `adapters/linear/`.
- Add the thin commands; remove legacy `/linear:idea` + the `/pm` triage path (hard rename, no aliases).

**Acceptance**

- [ ] Both commands ≤ ~40 LOC
- [ ] Grep guard finds zero tracker strings in these skills
- [ ] Legacy commands removed; manual capture/triage flows still work

### 1.3 — Wire `ideating-features` + create `specifying-work` + thin `/flow:ideate`, `/flow:specify`

- **Size:** medium · **Priority:** high
- **Dependencies:** 1.1 · **Can run parallel with:** 1.2, 1.4, 1.5

**Technical requirements**

- `ideating-features` (exists) → IDEATE, absorbs `/ideate`, repointed at the unified stage model; externalize the inline doc scaffolds into `templates/docs/`.
- `specifying-work/` (new) → SPECIFY, absorbs `/ideate-to-spec` + `/spec:create` (→ `stage/specify`).
- Thin commands `/flow:ideate`, `/flow:specify`, each ≤ ~40 LOC.

**Implementation steps**

- Build/repoint skills; route tracker I/O through `adapters/linear/`.
- Add thin commands; remove legacy `/ideate`, `/ideate-to-spec`, `/spec:create` (hard rename).

**Acceptance**

- [ ] Both commands ≤ ~40 LOC
- [ ] Grep guard finds zero tracker strings in `specifying-work`
- [ ] Legacy commands removed; manual flows still work; `/ideate` no longer carries inline doc templates

### 1.4 — Create `decomposing-work` + wire `executing-specs`/`verifying-work`/`closing-work` + thin commands

- **Size:** large · **Priority:** high
- **Dependencies:** 1.1 · **Can run parallel with:** 1.2, 1.3, 1.5

**Technical requirements**

- `decomposing-work/` (new) → DECOMPOSE, absorbs `/spec:decompose` + `/spec:tasks-sync` (→ `stage/decompose`, plan checklist).
- `executing-specs` (exists) → EXECUTE, absorbs `/spec:execute` + worktree setup/teardown (→ In Progress, `agent/claimed`), repointed.
- `verifying-work/` (new) → VERIFY, absorbs `/review-recent-work`, browser proof, code review (full pipeline in P4).
- `closing-work/` (new) → DONE, absorbs `/linear:done` + `closing-linear-loop` (→ Done, `agent/completed`).
- REVIEW = human gate, no skill (engine parks, handled in P2). MONITOR/SIGNAL out of v1 scope (Decision #25).
- Thin commands `/flow:decompose`, `/flow:execute`, `/flow:verify`, `/flow:done`, each ≤ ~40 LOC.

**Implementation steps**

- Build/repoint the four skills; route tracker I/O through `adapters/linear/`; collapse the ×4 copy-pasted breadcrumb logic into one adapter call.
- Add thin commands; remove legacy `/spec:decompose`, `/spec:execute`, `/review-recent-work`, `/linear:done`, `/spec:tasks-sync`.

**Acceptance**

- [ ] All four commands ≤ ~40 LOC
- [ ] Grep guard finds zero tracker strings in these skills
- [ ] Legacy commands removed; manual flows still work

### 1.5 — Add `/flow` orchestrator + remove legacy command surface (hard rename, no aliases)

- **Size:** medium · **Priority:** high
- **Dependencies:** 1.2, 1.3, 1.4 · **Can run parallel with:** —

**Technical requirements**

- Add `/flow` orchestrator under `.claude/commands/flow/` (routing skeleton ≤ ~40 LOC; `/flow auto` mode implemented in P2).
- Complete the hard rename: remove `/ideate`, `/ideate-to-spec`, `/pm`, `/linear:idea`, `/linear:done`, `/spec:create|decompose|execute|tasks-sync`, `/review-recent-work`; absorb `/worktree:*` into EXECUTE.
- Single canonical skill + sync (no `.claude/` vs `.agents/` duplication for the flow bundle).

**Implementation steps**

- Sequence deletions so no flow is left without a replacement at any commit.

**Acceptance**

- [ ] Legacy commands removed (hard rename, no aliases)
- [ ] `/flow` orchestrator ≤ ~40 LOC
- [ ] Command list presents one identifiable `/flow` system; manual flows work end-to-end

### 1.6 — Extend `03-tasks.json` schema with `issue`/`parentIssue` + PM-agnostic provenance block

- **Size:** medium · **Priority:** high
- **Dependencies:** 0.3 · **Can run parallel with:** 1.2, 1.3, 1.4

**Technical requirements**

- Add optional per-task `issue`/`parentIssue` (currently absent) — the only place the task→issue map lives. Flat top-level `issues:[…]` is **rejected**. Sub-issue promotion fires only at `size ≥ "xl"`; parent size does not additionally gate.
- Generalize scalar `linear-issue:` frontmatter into a PM-agnostic provenance block naming exactly one `issue` OR `project` (1:1 anchor); back-links bidirectional but ID-only; extend to ADRs + research.
- Link cardinality: spec → ONE tracker home; per-task `issue` carries the normalized 1:many; typed relations via adapter `link()`.
- Collapse the dual task system: `03-tasks.json` canonical; Task API becomes a projection. Ticket checklist generated from `03-tasks.json`, never hand-edited.

**Implementation steps**

- Extend the schema + provenance block; write unit tests (fields parse; promotion fires only at `size ≥ "xl"`; round-trip).

**Acceptance**

- [ ] `03-tasks.json` round-trips the new fields
- [ ] Provenance block names one issue-or-project; parses
- [ ] Schema-extension tests pass; dual task system collapsed

---

## P2 — Unify the loop

> **Phase acceptance:** `/flow auto` drains a ready queue sequentially in the terminal; a `flow-drain` Pulse schedule (server up) claims and advances one issue per tick in a fresh session; the calibration-ladder + recovery-ladder unit suites pass; gates are config-driven.

### 2.1 — Implement the calibration ladder (uncertainty-gated involvement)

- **Size:** large · **Priority:** high
- **Dependencies:** 1.1, 0.3 · **Can run parallel with:** 2.2, 2.3

**Technical requirements**

- The ladder (act on first matching row): row 0 Floor (irreversible/outward-facing/secrets-spend-prod/scope-change → stop & ask even at full confidence); row 1 reversible+confident → proceed silently; row 2 sticky+not-confident → stop & ask; row 3 reversible+not-confident → routed by stage bias; row 4 sticky+confident → proceed + announce.
- **Confident** = determined by frozen spec / ADR / strong convention / prior human answer (not a hunch). **Reversible** = cheap to undo inside the loop.
- Stage bias routes row 3 at the frozen-spec cut line: intent stages (CAPTURE/TRIAGE/IDEATE/SPECIFY) → ask; execution stages (DECOMPOSE/EXECUTE/VERIFY) → proceed + log.
- Only three behaviors: proceed-silently, proceed-with-a-trail, stop-and-ask. Non-obvious calls write `agent/assumption` comment + stage-artifact note. Answers become memory (decisions table / ADR / config.json).
- Drive from `involvement.calibration` config.

**Implementation steps**

- Implement the ladder + the evidence-based confident/reversible tests; write the table-driven unit suite (5 rows × {reversible/sticky} × {confident/not} × {intake/execution}).

**Acceptance**

- [ ] Calibration-ladder unit suite passes
- [ ] Three behaviors correctly routed for every row×stage combination

### 2.2 — Implement the dispatch policy (eligibility filter + ranking ladder)

- **Size:** large · **Priority:** high
- **Dependencies:** 1.1, 0.3 · **Can run parallel with:** 2.1, 2.3

**Technical requirements**

- **Eligibility filter out** if: `stateCategory` not dispatchable · lacks `agent/ready` (PM-driven) · `blockedBy` any open item · `project.stateCategory` completed/canceled · WIP cap reached · `classifyOwnership` class not in claim policy.
- **Ranking tiers** (later break ties): 1 unblockers → 2 priority → 3 project status → 4 type → 5 size → 6 age → 7 identifier. Weights in config (`dispatch.rank`, `dispatch.sizeOrder`). Missing priority/size = neutral.
- Consumes the normalized `WorkItem[]` (1.1) and `classifyOwnership` (3.1, stubbable for tests). Resolved direction: ranking runs inline in the dispatched session in v1.

**Implementation steps**

- Implement both passes; write the unit suite (ordered survivor list; blocked/other-owned/WIP-capped filtered; missing-field edge cases).

**Acceptance**

- [ ] Dispatch ranking + eligibility unit suite passes
- [ ] Blocked/other-owned/WIP-capped items filtered; survivor order matches the 7-tier ladder; missing fields neutral

### 2.3 — Implement config-driven gates + the auto-merge recovery ladder

- **Size:** large · **Priority:** high
- **Dependencies:** 1.1, 2.1, 0.3 · **Can run parallel with:** 2.2

**Technical requirements**

- Gates: (1) question/soft-escalation (calibration ladder); (2) plan-approval **off by default** (`gates.planApproval:false`, flow DECOMPOSE→EXECUTE, surface assumptions at review); (3) human-review **always on** (PR + evidence → In Review → assign → stop; on approval + CI green → auto-merge + close + teardown); (4) circuit breaker (`estimate × N` wall-clock or token budget).
- Auto-merge recovery ladder — three preconditions, each failure routed through the calibration ladder: **Mergeable?** (mechanical conflict → resolve+announce; real tradeoff → bounce `agent/needs-rebase`); **CI green?** (red → retry once; still red → re-enter EXECUTE→VERIFY); **Functionally unchanged?** (mechanical → merge+close+teardown; behavior-altering → re-request approval). Runaway bounce over `maxMergeAttempts:3` → circuit-breaker (`agent/blocked` + nudge).
- Tracker writes via `adapters/linear/`; calibration ladder (2.1) decides mechanical-vs-functional.

**Implementation steps**

- Implement gates + ladder driven by `gates.*` config; write the unit suite (mechanical vs functional → resolve+announce vs bounce vs re-approve).

**Acceptance**

- [ ] Gates config-driven (incl. `planApproval:false`, auto-merge-on-approval)
- [ ] Auto-merge recovery ladder unit suite passes; runaway bounce escalates via the circuit breaker

### 2.4 — Implement mode orthogonality, comms routing, and `/flow auto` terminal draining

- **Size:** large · **Priority:** high
- **Dependencies:** 2.1, 2.2, 2.3 · **Can run parallel with:** —

**Technical requirements**

- Trigger source (manual CLI vs PM-driven) orthogonal to execution mode (step vs autonomous).
- `/flow auto`: drain the ready queue sequentially from the terminal using the dispatch policy (2.2), carrying each issue to its review gate, uncertainty-gated (2.1). Runs server-free.
- Generalize the autonomous Stop-hook: replace `autonomous-check.mjs` (roadmap.json-coupled) with reading canonical stage state; update `.claude/settings.json` with the unified loop hook; remove the old hook.
- Comms inferred from trigger (`involvement.comms:"infer-from-trigger"`): CLI live → interactive (`AskUserQuestion`); PM-driven/away → comment + `agent/needs-input` + assign + resume on reply; optional Relay/Telegram nudge.
- Comment-response hard rules + soft zone (1 never self-reply; 2 always respond when addressed — overrides ownership; 3 resume on `needs-input` non-agent comment; 4 stay out of other-owned threads; 5 soft zone leans quiet). Consumes `classifyOwnership` (built in P3) as input.

**Implementation steps**

- Wire mode dispatch, `/flow auto`, the unified loop hook, comms routing; all tracker I/O via `adapters/linear/`.

**Acceptance**

- [ ] `/flow auto` drains a ready queue sequentially in the terminal
- [ ] Mode orthogonal to trigger; unified loop hook reads canonical stage state (old roadmap.json hook removed); comms infers channel from trigger; server-free manual mode unaffected

### 2.5 — Seat the autonomous loop on Pulse — `flow-drain` SKILL.md schedule + dispatch brief

- **Size:** large · **Priority:** high
- **Dependencies:** 2.4 · **Can run parallel with:** —

**Technical requirements**

- Seat v1 autonomous loop on DorkOS Pulse (croner) — no scheduler to build. Create `<project>/.dork/tasks/flow-drain/SKILL.md` (file-first; `pulseSchedules`/`pulseRuns` derived cache, ADR-0043). Use the §10 SKILL.md verbatim (`cron:"*/10 * * * *"`, `max-runtime:2h`, `permissions:acceptEdits`, the 4-step dispatch brief).
- One tick = one issue (`sessionId = run.id`, fresh per run). `croner protect:true` → sequential WIP-1; `maxConcurrentRuns`/`wipCap` govern raised concurrency. Activation needs only the server running (+ project agent registered for project tasks; global `~/.dork/tasks/` watched unconditionally). No build/migration. Honest README dependency statement. Portability fallback (`claude -p` watcher, `autonomy.seat:"watcher"`) documented, not built.
- Reference `apps/server/src/services/tasks/` (`TaskSchedulerService`, `TaskFileWatcher`).

**Implementation steps**

- Ship the SKILL.md template + wire the dispatch brief into the loop.
- Integration test: drop `flow-drain` SKILL.md into temp `.dork/tasks/`; assert `TaskFileWatcher` syncs to `pulseSchedules`, croner schedules, a fire dispatches one fresh session with resolved worktree cwd (use `FakeAgentRuntime`). Plus a stage→projection round-trip (transition writes the right `stage/*` label + state category through the mocked adapter).

**Acceptance**

- [ ] A `flow-drain` Pulse schedule (server up) claims and advances one issue per tick in a fresh session
- [ ] Pulse-seat integration test passes; stage→projection round-trip test passes

---

## P3 — Agent-as-team-member v1

> **Phase acceptance:** in a shared Linear, the agent claims only permitted classes, recognizes its own comments (marker), responds only when addressed, parks on `needs-input` and resumes on reply — verified against `classifyOwnership`/comment-rule suites + a live read-only dry run.

### 3.1 — Implement `classifyOwnership` + identity mode detection

- **Size:** medium · **Priority:** high
- **Dependencies:** 1.1, 0.3 · **Can run parallel with:** 3.2

**Technical requirements**

- Modes: two-account (distinct `identity.agent`/`identity.reviewer`) vs shared-account (acts as the human; claims via `agent/claimed` label, recognizes own comments by `identity.marker`, hands off by label + nudge). Mode **detected**: `identity.reviewer` unset or == `identity.agent` ⇒ shared.
- `classifyOwnership(item) → mine | reviewer | other | unassigned` (compares `assignee`/`project.lead` vs `identity.agent`/`identity.reviewer`). Drives both dispatch eligibility (2.2) and comment-handling (3.2). `ownership` config declares claimable classes, applied to issues + projects (`scope`). Shared mode never auto-claims items merely on the shared account without `agent/claimed`.
- No personal identity ships: `agent:"auto"`/`reviewer:null` resolve at runtime via adapter `getCurrentUser`.

**Implementation steps**

- Implement the primitive + detection; write the unit suite (two-account vs shared × {mine/reviewer/other/unassigned}).

**Acceptance**

- [ ] `classifyOwnership` unit suite passes for both modes × all four classes
- [ ] Mode detected from `identity.reviewer`; `agent:"auto"` resolves from the authenticated account; agent claims only permitted classes

### 3.2 — Implement inbox polling, comment/assign/handoff, soft-escalation, durable label claims

- **Size:** large · **Priority:** high
- **Dependencies:** 3.1, 2.4 · **Can run parallel with:** —

**Technical requirements**

- Inbox polling via `getInbox(agent)` (assigned + @mentions + new comments; each carries author/mentions/body).
- Comment-response rules consuming `classifyOwnership` (1 never self-reply; 2 always respond when addressed — overrides ownership; 3 resume on `needs-input` non-agent comment; 4 stay out of other-owned threads; 5 soft zone leans quiet, `comments.ambiguousBias:"quiet"`).
- Durable label claims (`claim` writes `agent/claimed` + moves state; survives restart). State machine = `agent/*` labels.
- Comment/assign/handoff: `comment`, `assignToHuman`, `needsInput` (label + comment + assign + stop). Soft-escalation when genuinely stuck (Decision #2a, driven by 2.1). Answers become memory (decisions/ADR/config).
- All tracker I/O via `adapters/linear/`. Config: `comments.respondWhen:"addressed"`.

**Implementation steps**

- Implement behaviors + the comment-rule unit suite; verify a live read-only dry run.

**Acceptance**

- [ ] Agent claims only permitted classes, recognizes own comments (marker), responds only when addressed, parks on `needs-input` + resumes on reply
- [ ] Verified against `classifyOwnership`/comment-rule suites + a live read-only dry run

### 3.3 — Implement crash/stall recovery — the `FlowRun` record + next-tick recovery ladder

- **Size:** large · **Priority:** high
- **Dependencies:** 3.1, 2.5 · **Can run parallel with:** 3.2

**Technical requirements**

- `FlowRun` record (issue-keyed, `flow-state.json` v1 → SQLite v2): `issueId`/`identifier`, `sessionId`, `worktreePath`/`branch`, `status` (queued|running|waiting_for_review|complete|failed), `attemptCount`/`workerPid` (v1 liveness), `heartbeatAt` (v2), `startedAt`/`completedAt`.
- Recovery ladder (disposition-driven): `agent/needs-input` → **skip** (never reclaimed); `agent/claimed`+In-Progress+no live worker → **adopt+resume** if worktree+session intact & under maxRetries, else **restart-clean**, `attemptCount++`; over maxRetries → **escalate** (`agent/blocked`); In-Progress + no local record → **re-derive** from tracker.
- Checkpoint = git commit + JSONL session ⇒ **resume** (re-attach worktree at HEAD, `resume` session), never restart. v1 sequential WIP-1 needs no heartbeat/lease (`workerPid` check). Startup/tick sweep adopts orphans; parked-on-human is a distinct state never reclaimed. v2 heartbeat/fencing/atomic-claim = DOR-89, not built here.
- Config: `recovery.maxRetries:2`, `onExhausted:"block"`, `staleAfter:"5m"` (v2). `flow-state.json` follows ADR-0043 file-first.

**Implementation steps**

- Implement the record + sweep + ladder; write the unit suite (each row → action; `needs-input` never reclaimed; `attemptCount` increments; over-retry escalates).

**Acceptance**

- [ ] Recovery-ladder unit suite passes; `needs-input` never reclaimed; `attemptCount` increments; over-`maxRetries` escalates to `agent/blocked`
- [ ] Recovery resumes (re-attach + session resume), never restarts

---

## P4 — Proof-of-completion

> **Phase acceptance:** a UI change run through VERIFY yields a recording linked on the PR and the tracker per the `evidence` config.

### 4.1 — Implement VERIFY browser proof-of-completion + evidence-class attachment

- **Size:** large · **Priority:** high
- **Dependencies:** 1.4, 2.3 · **Can run parallel with:** —

**Technical requirements**

- Run Playwright (`apps/e2e`) for the touched surface; capture per `evidence`: UI → annotated GIF (`gif_creator`, interactive) or WebM (`recordVideo`, unattended/`retain-on-failure`); `evidence.ui:"auto"` selects by trigger; temporal → video; logic → test-pass summary.
- Attach via the adapter: PR comment (ProofShot-style) and/or tracker `externalUrls` (`evidence.attachTo:["pr","tracker"]`).
- Scope: unattended/server headless pipeline (→ automated Linear `fileUpload`/`attachmentCreate`) is P5 (DOR-95). v1 attaches the `apps/e2e` WebM + any `gif_creator` capture. Wires into the `verifying-work` skill (1.4).

**Implementation steps**

- Implement the VERIFY proof pipeline; write the E2E test (VERIFY produces a WebM for a touched UI surface; bundle links onto a PR/tracker stub).

**Acceptance**

- [ ] A UI change run through VERIFY yields a recording linked on the PR + tracker per `evidence` config
- [ ] E2E proof-pipeline test passes

### 4.2 — Author the system templates set (records/docs/pr.md) + complete README/SPEC + docs

- **Size:** medium · **Priority:** medium
- **Dependencies:** 1.2, 1.3, 1.4, 2.4, 4.1 · **Can run parallel with:** —

**Technical requirements**

- `templates/records/` (PM records by type with `## Validation criteria` / `## On Completion`; generalizes + de-Linear-ifies `linear-loop/templates/`); `templates/docs/` (ideation/specification/`03-tasks.json`/ADR scaffolds, externalized in 1.3, formalized here); `templates/pr.md` (linked issue · test/validation summary · browser-proof links).
- Create `.agents/flow/README.md` (manual incl. the autonomous-mode server dependency), `.agents/flow/SPEC.md` (stage model, `PMClient` interface for P5, config schema), `contributing/flow-engine.md` (cross-link from `contributing/INDEX.md`).
- Update `AGENTS.md` (replace separate Linear/Worktrees/loop guidance with a `/flow` section + the "Compact Instructions" block); repoint `working-in-worktrees`/`executing-specs`/`ideating-features` skills at the unified stage model; confirm the `flow` bundle registration in `.agents/harness.manifest.json`.

**Implementation steps**

- Author templates + docs; update `AGENTS.md` + the three skills.

**Acceptance**

- [ ] Records/docs/pr.md template set exists and is loaded by the relevant skills
- [ ] README/SPEC/`contributing/flow-engine.md` complete; `AGENTS.md` carries the `/flow` section + Compact Instructions block; the three named skills point at the unified stage model

---

## P5 — Later: the Flow Engine — Extension (DOR-88…)

> **Phase acceptance:** out of scope for this spec; the v1 contracts (config schema, `PMClient` verbs, `FlowRun` record) are the promotion surface.

### 5.1 — Document the v1 promotion surface for the Flow Engine — Extension (NOT built here)

- **Size:** small · **Priority:** low
- **Dependencies:** 0.3, 1.1, 3.3, 4.2 · **Can run parallel with:** —

**Technical requirements**

- Phase 5 (server-side extension, DOR-88…) is explicitly **out of scope and not built here**. For context only, P5 promotes the harness into the single full-stack DorkOS extension: server `PMClient`, webhook/`dorkos.ai` relay + full Linear Agent Accounts, server-side `WorkspaceManager`, unattended evidence pipeline (DOR-95), heartbeat/fencing concurrency (DOR-89), and a second PM adapter.
- This task only verifies the v1 promotion surface is cleanly documented in `.agents/flow/SPEC.md`: the config schema (0.3), the `PMClient` verbs (1.1; typed `interface PMClient`), the `FlowRun` record shape (3.3).
- **Non-goals reaffirmed:** do not build the server `PMClient`, webhook listener, `WorkspaceManager`, or unattended evidence pipeline here.

**Implementation steps**

- Ensure SPEC.md documents the three promotion contracts; no server code.

**Acceptance**

- [ ] Out of scope for this spec — v1 contracts documented in `.agents/flow/SPEC.md` as the promotion surface; no server code written
