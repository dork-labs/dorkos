# flow — the contract

> The contract for the `/flow` engine. This is the **promotion surface**: the v1
> contracts documented here are what the P5 server-side Flow Engine — Extension
> (Linear DOR-88…) promotes the proven harness into. P5 is additive, not a
> rewrite. The three v1 contracts P5 promotes are the **config schema**, the
> **`PMClient` verbs**, and the **`FlowRun` record** — all defined below.

See [`README.md`](./README.md) for the operator manual, [`CHARTER.md`](./CHARTER.md)
for the goals this contract implements, and the published
[guide series](../../docs/guides/flow/) for the user-facing reference.

## Stage model

The canonical nine-stage spine is the unit of "where work is." Spec status,
tracker state, labels, and loop phase are all **projected** from the stage via the
adapter — never authored independently.

```
CAPTURE → TRIAGE → IDEATE → SPECIFY → DECOMPOSE → EXECUTE → VERIFY → ⟦REVIEW⟧ → DONE → (MONITOR → SIGNAL)
```

- Each stage projects to a tracker `stage/*` label and (where applicable) a state
  **category** — `backlog | unstarted | started | completed | canceled`. The
  engine matches on **category**, never on a tracker's state display **name**, so
  it is portable across teams and trackers.
- `REVIEW` is a **human gate**: no command, no skill. The engine parks there and
  resumes (in P2) only on the human's approval.
- A thin `/flow:<stage>` command and a PM transition are two **triggers** for the
  same gerund-named stage skill. The mapping is defined by
  [`config.json`](./config.json) `stages` (and rendered in the README's command↔state
  map).

| Stage     | Skill               | Command           |
| --------- | ------------------- | ----------------- |
| CAPTURE   | `capturing-work`    | `/flow:capture`   |
| TRIAGE    | `triaging-work`     | `/flow:triage`    |
| IDEATE    | `ideating-features` | `/flow:ideate`    |
| SPECIFY   | `specifying-work`   | `/flow:specify`   |
| DECOMPOSE | `decomposing-work`  | `/flow:decompose` |
| EXECUTE   | `executing-specs`   | `/flow:execute`   |
| VERIFY    | `verifying-work`    | `/flow:verify`    |
| REVIEW    | — (human gate)      | —                 |
| DONE      | `closing-work`      | `/flow:done`      |

### Orchestrator — no-args cold start

A bare `/flow` (no stage, no item, no `auto`) resolves nothing to route. The
orchestrator MUST **offer four intents** rather than guess: **capture** a new
thought · **work on a project** (pick from the active projects via `getProjects`) ·
**continue the queue** · **triage** the backlog, with a specific item, `auto`, and any
explicit stage reachable as free text. In a terminal harness this is an `AskUserQuestion`;
in any other, the same four intents rendered as a numbered prompt. **Continue the queue**
is one tick of `auto`: the same `selectDispatch`
oracle claims the next-ranked eligible item and carries it to its review gate, but
bounded to a single item — it writes no auto-drain sentinel
(`.dork/flow/auto-run.json`) and never loops.

**Naming a project** (with arguments: `/flow <project>`, or the aliases `start` /
`resume`) resolves it via `resolveProject`, then routes by the project's state:
project-scoped single-item dispatch when it has `agent/ready` children (`getProjectWork` +
`selectDispatch`, honoring the `perProject` WIP cap), or advancing the project's umbrella
issue one stage when it has none yet. `/flow auto <project>` and `/flow continue <project>`
narrow the global queue modes to that one project.

## `PMClient` interface (promotion surface, P5)

In **v1 the `PMClient` does not exist as code.** It is realized as the
`linear-adapter` skill — a documented **prose** contract that owns every
`mcp__linear__*` / Composio call and fulfils the capability verbs below. Generic
stage skills call the adapter by naming a verb and never touch a tracker string
(a grep guard enforces this). The agnosticism win ("all tracker I/O in one place")
is real in v1 with no new infrastructure.

The typed `interface PMClient` documented here is what the **P5 server build**
promotes that prose contract into — same verbs, same `WorkItem` normalization,
now executable code:

```ts
interface PMClient {
  getCurrentUser(): Promise<Account>; // resolve identity.agent: "auto"
  getProjects(): Promise<WorkItemProject[]>;
  resolveProject(nameOrId: string): Promise<WorkItemProject[]>; // fuzzy name/slug/umbrella id → matches (len > 1 = disambiguate)
  getProject(id: string): Promise<WorkItemProject & { children: WorkItem[]; umbrella?: WorkItem }>; // single project + rollup
  getProjectWork(projectId: string): Promise<WorkItem[]>; // getEligibleWork scoped to one project (project dispatch)
  getEligibleWork(): Promise<WorkItem[]>; // feeds the dispatch policy (§4)
  getInbox(): Promise<InboxComment[]>; // for resume-on-reply (§5)
  getRelations(item: WorkItem): Promise<WorkItemRelations>;
  claim(item: WorkItem): Promise<void>; // durable agent/claimed label + state
  transition(item: WorkItem, toCategory: StateCategory): Promise<void>;
  comment(item: WorkItem, body: string): Promise<void>; // carries identity.marker
  assignToHuman(item: WorkItem): Promise<void>;
  attachEvidence(item: WorkItem, evidence: EvidencePlan): Promise<void>;
  needsInput(item: WorkItem, question: string): Promise<void>; // park on human
  link(a: WorkItem, b: WorkItem, type: RelationType): Promise<void>;
  createSubIssue(parent: WorkItem, body: string): Promise<WorkItem>; // size ≥ "xl"
}
```

### The `WorkItem` normalization shape

The adapter normalizes every tracker into one `WorkItem` so the generic layer
never sees a tracker-specific field (typed in `@dorkos/flow` `work-item.ts`):

```ts
WorkItem {
  id, identifier, title, description,
  type,            // idea | research | hypothesis | task | monitor | signal | meta
  stateCategory,   // matched on CATEGORY, never name
  stateName,       // display only
  priority,        // 0–4
  size,            // points / t-shirt (drives sub-issue promotion + ranking)
  project,         // { id, name, stateCategory, lead }
  parent, relations { blocks[], blockedBy[], children[], relatedTo[], duplicateOf? },
  labels[],        // includes stage/* and agent/*
  assignee,        // → classifyOwnership(): mine | reviewer | other | unassigned
  agentDisposition // ready | claimed | completed | needs-input
}
```

**Graceful degradation:** trackers lacking `project.stateCategory` / `priority` /
`size` (e.g. GitHub Issues) supply what exists; the dispatch policy treats missing
fields as neutral.

**Presenting to humans:** any surface that shows a `WorkItem` to a person renders
`identifier` then `title` (`DOR-157 - Title`), never the bare key; the identifier
is the link where the surface supports one. The v1 `linear-adapter` skill owns this
convention (its _Presenting a work item to a human_ section); the P5 `PMClient`
carries it forward.

## `FlowRun` record (promotion surface, P3)

The durable run record keys the **session↔issue** association — the bridge that
makes ephemeral sessions resumable. Written to `flow-state.json` (v1, disk) →
server SQLite (v2), following the ADR-0043 file-first write-through pattern (disk
is truth; the future DB is a derived cache). Typed in `@dorkos/flow`
`flow-run.ts`:

```ts
FlowRun {
  issueId, identifier;          // tracker id + "DOR-123" (worktree/branch key)
  sessionId;                    // Claude SDK JSONL id — the resume handle
  worktreePath, branch;         // ~/.dork/workspaces/<project>/<key>/, dork/<key>
  status;                       // queued | running | waiting_for_review | complete | failed
  attemptCount; workerPid;      // v1 single-machine liveness
  heartbeatAt?;                 // v2 (concurrent) liveness — unused in v1
  startedAt, completedAt?;
}
```

The **checkpoint is the git commit + the JSONL session**, so the next-tick
recovery ladder **resumes** (re-attach the worktree at HEAD, `resume` the
session) rather than restarts. v2 adds heartbeat, a fencing token, atomic
multi-claim, and a stall-detector — the server residue earmarked in DOR-89.

## The typed engine — v1 promotion surface (`@dorkos/flow`)

The engine's decision logic is **already typed code** in the `@dorkos/flow`
package — the v1 promotion surface P5 lifts server-side unchanged. Each module is
pure (config + inputs → a decision), table-driven, and unit-tested. This is the
contract task 5.1 verifies is documented here.

### Calibration ladder — `calibration.ts` (§5)

`resolveInvolvement(descriptor, config) → InvolvementDecision`. Walks the
five-row ladder top-down and returns the first match:

| Row | Condition                                                            | Behavior             |
| --- | -------------------------------------------------------------------- | -------------------- |
| 0   | Floor (irreversible · outward-facing · secrets/spend · scope-change) | `stop-and-ask`       |
| 1   | reversible + confident                                               | `proceed-silently`   |
| 2   | sticky + not-confident                                               | `stop-and-ask`       |
| 3   | reversible + not-confident (ambiguous middle)                        | routed by stage bias |
| 4   | sticky + confident                                                   | `proceed-with-trail` |

Stage bias routes row 3: intake stages (`intake`) → `stop-and-ask`; execution
stages (`execution`) → `proceed-with-trail`. Types: `DecisionDescriptor`,
`InvolvementDecision`, `FloorTrigger`, `Reversibility`, `Confidence`,
`DecisionStage`, `InvolvementBehavior`.

### Dispatch policy — `dispatch.ts` (§4)

`selectDispatch(items, options)` = `filterEligible` then `rankEligible`.
Eligibility removes non-dispatchable state, missing `agent/ready` (PM-driven),
open blockers, completed/canceled projects, WIP-capped items, and items the
`ownership` policy doesn't permit (`isClaimable`). Ranking applies the ordered
7-tier ladder (`unblockers → priority → projectStatus → type → size → age →
identifier`). Types: `DispatchConfig`, `OwnershipConfig`, `WipCap`, `RankFactor`.

### Gates + auto-merge recovery — `gates.ts` (§5, §6)

`planApprovalRequired(gates)`, `tripsCircuitBreaker(usage, gates)`, and
`evaluateAutoMerge(state, gates) → MergeDisposition` (the §6 ladder:
mergeable? · CI green? · functionally unchanged? → resolve / bounce / re-approve).
Types: `GatesConfig`, `ReviewGateConfig`, `CircuitBreakerConfig`, `MergeState`,
`MergeDisposition`, `CircuitBreakerTrip`.

### Comms routing + comment-response — `comms.ts`, `comment-response.ts` (§5)

`resolveCommsChannel(trigger, involvement) → CommsRoute` (`interactive` vs
`comment-and-assign`, inferred from the trigger). `shouldRespondToComment(comment,
context) → CommentDecision` enforces the hard rules then the conservative soft
zone (never answer its own comments; always respond when addressed; resume on a
non-agent reply to a `needs-input` item; stay out of `other`-owned threads; lean
quiet). Types: `CommsRoute`, `CommsChannel`, `InboxComment`, `CommentDecision`.

### Identity & ownership — `identity.ts` (§7)

`resolveIdentityMode(identity) → "two-account" | "shared"` (detected:
`reviewer` unset or == `agent` ⇒ shared). `classifyOwnership(item, identity) →
"mine" | "reviewer" | "other" | "unassigned"` — the **one primitive, two
consumers** that drives both dispatch eligibility and comment-handling. Types:
`Identity`, `IdentityMode`, `IdentityConfig`, `OwnershipScope`.

### Crash & stall recovery — `flow-run.ts` (§12)

`recoverOrphan(context) → RecoveryAction` runs the next-tick recovery ladder
keyed by `OrphanSignal` (`needs-input` → skip; `claimed-no-worker` → resume /
restart-clean / escalate per `attemptCount` vs `maxRetries`; `no-local-record` →
re-derive). Types: `FlowRun`, `RecoveryConfig`, `RecoveryContext`, `OrphanSignal`,
`RecoveryAction`.

### Evidence selection — `evidence.ts` (§13)

`selectEvidence(config, trigger) → EvidencePlan` chooses the proof-of-completion
capture per class (`ui` → GIF/WebM/none by interactive-vs-unattended trigger;
`temporal` → video; `logic` → test summary) and the `attachTo` targets. Types:
`EvidenceConfig`, `EvidencePlan`, `EvidenceCapture`, `EvidenceTrigger`.

### Task decomposition schema — `tasks-schema.ts` (§8)

`TasksFileSchema` / `TaskSchema` extend `03-tasks.json` with optional per-task
`issue` / `parentIssue` fields and the PM-agnostic `ProvenanceSchema` block (one
issue **or** project, never a flat `issues: []` list). `isPromotableToSubIssue`
fires only at `size ≥ subIssueThreshold` (default `"xl"`). Types: `TasksFile`,
`Task`, `TaskSize`, `Provenance`.

## Config schema reference

The configuration contract is the Zod `FlowConfigSchema` (`@dorkos/flow`
`config-schema.ts`), generated to [`config.schema.json`](./config.schema.json) via
`z.toJSONSchema` (`buildConfigJsonSchema`) and referenced from
[`config.json`](./config.json) via `$schema`. The resolved defaults encode the
spec's load-bearing decisions:

| Block                             | Default                                      | Decision |
| --------------------------------- | -------------------------------------------- | -------- |
| `gates.planApproval`              | `false` — flow DECOMPOSE → EXECUTE           | §7.4     |
| `decomposition.subIssueThreshold` | `"xl"` — XL-only sub-issue promotion         | §7.6     |
| `context.perIssue`                | `"fresh-session"` — fresh session/issue      | §7.7     |
| `autonomy.seat`                   | `"pulse"` — sole v1 seat (`watcher` planned) | §10      |
| `identity.agent` / `.reviewer`    | `"auto"` / `null` — resolved at runtime      | §7       |
| `gates.review.mergeOnApproval`    | `true` + the §6 recovery ladder              | §6       |

Top-level blocks: `tracker`, `identity`, `ownership`, `comments`, `stages`,
`autonomy`, `involvement`, `dispatch`, `gates`, `context`, `workspace`,
`recovery`, `decomposition`, `evidence`. The full annotated default set is in spec
§9; the authoritative shape is the Zod schema.

## P5 — the Flow Engine — Extension (NOT built here)

Phase 5 — the server-side **Flow Engine — Extension** (Linear DOR-88…) — is
**out of scope** for this spec and **not built here**. v1 is the proven,
server-free harness; P5 graduates it into the single full-stack DorkOS extension.
P5 is **additive**, not a rewrite — it promotes the three v1 contracts documented
above (the **config schema**, the **`PMClient` verbs**, the **`FlowRun` record**)
plus the typed engine, all of which already exist and are tested.

**What P5 promotes this harness into** (for context, NOT implementation):

- The server **`PMClient`** — the typed `interface PMClient` above, realized as
  executable code (the `linear-adapter` prose contract becomes a class).
- A webhook / `dorkos.ai` relay + full **Linear Agent Accounts** (true two-account
  identity, push-driven instead of polled).
- A server-side **`WorkspaceManager`** graduating the v1 `gtr` worktree flow.
- The **unattended evidence pipeline** — headless `recordVideo` → automated Linear
  `fileUpload` / `attachmentCreate` (binary upload), the deferred half of §13
  (**DOR-95**).
- **Heartbeat / fencing concurrency** — the v2 `FlowRun.heartbeatAt`, fencing
  token, atomic multi-claim, and stall-detector (the **DOR-89** server residue).
- A **second PM adapter** (Jira / GitHub Issues) that proves the agnosticism the
  one-adapter seam was built for.

**Non-goals reaffirmed (NOT in this spec):** do not build the server `PMClient`,
the webhook listener, the `WorkspaceManager` service, or the unattended evidence
pipeline here. v1 ships the proven contracts; P5 promotes them.
