# Tracker Adapter Contract

> **Contract version: 1.0.0** (semver). See [Versioning](#5-versioning).
>
> This is the **generic, tracker-neutral** contract every `/flow` tracker adapter
> must satisfy. It names no tracker, no API, and no slug. Reference adapters
> demonstrate a concrete tracker separately; this document stays neutral so any
> tracker can conform to it.

---

## 1. Purpose

The `/flow` engine separates the **generic workflow** from the **tracker**. One
unit, the **tracker adapter**, is the single tracker-aware component in the whole
system: it is the only place that knows a tracker's API, field names, label
namespaces, pagination, or auth. Everything else (the dispatch policy, the stage
skills, ownership classification, the inbox, the autonomous loop) speaks only the
generic `WorkItem` model and the capability verbs defined here. This is charter
goal **G8**: the generic engine and stage skills never embed a tracker string;
all tracker I/O is confined to the adapter, which is therefore the **single audit
surface** for every read and write.

An adopter targeting a new tracker **generates a concrete adapter** that conforms
to this contract. As long as the adapter returns `WorkItem`-shaped reads, honors
the verb semantics, and passes the conformance invariants (section 4), the entire
engine runs unchanged. Adopting a tracker is additive, never a rewrite of the
engine.

Two realizations of this contract exist, and both honor it identically:

- **Prose realization (skill-based, server-free).** A documented skill that owns
  every tracker call and follows these verbs and this normalization by hand. The
  agent reads the skill and acts on it; nothing imports an adapter at runtime.
- **Typed realization (the promotion surface).** A typed `PMClient` interface
  with the same verbs and the same `WorkItem` shape, backed by a tracker's API
  and a webhook relay instead of in-session calls. The server build promotes the
  prose contract into this code with no change to the generic layer.

A staff engineer must be able to implement a conforming adapter from this
document alone.

---

## 2. The `WorkItem` model

Every **read** verb returns work normalized into the `WorkItem` shape, so the
generic layer never sees a tracker-native field name. Mapping the tracker's
native representation into these fields is the adapter's core job.

| Field              | Type                                                                                | Meaning                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`               | `string`                                                                            | Tracker-native id. Opaque outside the adapter; never surfaced to the generic layer for matching.                                                                                                 |
| `identifier`       | `string`                                                                            | Human key (for example `ABC-123`). The worktree/branch key **and** the key used in every relation array. Non-empty.                                                                              |
| `title`            | `string`                                                                            | Item title. Always carried so a human-facing surface can render `identifier` then `title` with no extra fetch.                                                                                   |
| `description`      | `string`                                                                            | Item body.                                                                                                                                                                                       |
| `type`             | `'idea' \| 'research' \| 'hypothesis' \| 'task' \| 'monitor' \| 'signal' \| 'meta'` | The work type, sourced from the `type/*` label family. Mutually exclusive: exactly one per item.                                                                                                 |
| `stateCategory`    | `'backlog' \| 'unstarted' \| 'started' \| 'completed' \| 'canceled'`                | The workflow-state **category**. **The only state field the engine branches on** (see the hard rule below).                                                                                      |
| `stateName`        | `string`                                                                            | Display-only state name (for example "In Progress", "Triage", "Shipped"). Carried for rendering; **never matched on**.                                                                           |
| `priority`         | `0 \| 1 \| 2 \| 3 \| 4` (optional)                                                  | `0` none, `1` urgent, `2` high, `3` medium, `4` low. A missing priority is `undefined` (neutral), never `0`.                                                                                     |
| `size`             | `string` (optional)                                                                 | Estimate, as points or a t-shirt size. Drives sub-issue promotion and the dispatch size tier. Missing is `undefined` (neutral), never `0` or smallest.                                           |
| `project`          | `WorkItemProject` (optional)                                                        | `{ id, name, stateCategory?, lead? }`. The project the item belongs to, or `undefined` when unset.                                                                                               |
| `parent`           | `string \| null`                                                                    | `identifier` of the parent item (sub-issue), or `null` for a top-level item.                                                                                                                     |
| `relations`        | `WorkItemRelations`                                                                 | `{ blocks[], blockedBy[], children[], relatedTo[], duplicateOf? }`. Arrays carry **identifiers** (human keys), never native ids. Read from the tracker's typed relation graph, never from prose. |
| `labels`           | `string[]`                                                                          | ALL labels on the item, **re-namespaced into the generic families** (see below). Includes `stage/*` and `agent/*`.                                                                               |
| `assignee`         | `string` (optional)                                                                 | Account id of the assignee, or `undefined` when unassigned. Raw input to ownership classification; the model does not itself classify.                                                           |
| `agentDisposition` | `'ready' \| 'claimed' \| 'completed' \| 'needs-input'` (optional)                   | Derived from the `agent/*` label family (the durable state machine).                                                                                                                             |
| `createdAt`        | `string` (optional)                                                                 | ISO-8601 creation timestamp. Feeds the dispatch age tier (oldest first). Missing is `undefined` (neutral).                                                                                       |

`WorkItemProject = { id: string, name: string, stateCategory?: StateCategory, lead?: string }`.

`WorkItemRelations = { blocks: string[], blockedBy: string[], children: string[], relatedTo: string[], duplicateOf?: string }`.

### Hard rule: match on the state CATEGORY, never on the display name

Every tracker workflow state belongs to exactly one of **five categories**:
`backlog`, `unstarted`, `started`, `completed`, `canceled`. The display `stateName`
is team-customizable ("Triage", "In Progress", "Shipped") and varies per team, so
matching on it is brittle and breaks the moment a team renames a state. **The
generic layer branches only on `stateCategory`.** `stateName` is carried for
display and nothing else.

A tracker may have a holding or un-triaged state outside the five (an item that
has not yet been classified). **Normalize any such state to `backlog`** (it is
non-terminal, so it lists and recovers like any open item). **Never invent a
sixth category**: the model has exactly five values. An un-triaged item is kept
out of dispatch by the **absent `agent/ready` label**, not by a special category.

### Label re-namespacing: native labels map into the generic families

The engine matches **literal, namespaced** label strings. The adapter MUST map a
tracker's native labels into the generic families before placing them on
`labels[]`:

- **`agent/*`** - the durable disposition state machine: `agent/ready`,
  `agent/claimed`, `agent/completed`, `agent/needs-input`. `agentDisposition` is
  derived from this family.
- **`stage/*`** - the active spine stage projection.
- **`type/*`** - the work type (`type` is derived from this family).
- Other generic families an adopter's stages introduce follow the same
  `family/leaf` form.

A tracker that stores a label as a bare leaf (for example `ready`) or under a
tracker-specific grouping MUST be re-namespaced to the generic family form (for
example `agent/ready`) by the adapter, **or the engine will silently fail to
match it** (the dispatch readiness gate matches the literal `agent/ready`). This
is a real normalization trap: re-namespacing is mandatory, not cosmetic.

`priority` and `size` are **native fields**, never labels.

---

## 3. The capability verbs

There are **16 verbs**: **8 reads** and **8 writes**. The generic layer only ever
names a verb; the adapter owns the call. Signatures below use the typed
promotion-surface form (the `PMClient` port); the prose realization fulfils the
same verbs by hand.

```ts
interface TrackerAdapter {
  // Reads
  getCurrentUser(): Promise<Account>;
  getProjects(): Promise<WorkItemProject[]>;
  resolveProject(nameOrId: string): Promise<WorkItemProject[]>;
  getProject(id: string): Promise<ProjectDetail>;
  getProjectWork(projectId: string): Promise<WorkItem[]>;
  getEligibleWork(): Promise<WorkItem[]>;
  getInbox(): Promise<InboxEntry[]>;
  getRelations(item: WorkItem): Promise<WorkItemRelations>;

  // Writes (the single audit surface)
  claim(item: WorkItem): Promise<void>;
  transition(item: WorkItem, to: StageProjection): Promise<void>;
  comment(item: WorkItem, body: string): Promise<void>;
  assignToHuman(item: WorkItem): Promise<void>;
  attachEvidence(item: WorkItem, evidence: EvidencePlan): Promise<void>;
  needsInput(item: WorkItem, question: string): Promise<void>;
  link(a: WorkItem, b: WorkItem, type: RelationType): Promise<void>;
  createSubIssue(parent: WorkItem, spec: SubIssueSpec): Promise<WorkItem>;
}
```

Supporting types: `Account` is the acting account `{ id, name? }`.
`ProjectDetail = WorkItemProject & { children: WorkItem[], umbrella?: WorkItem, progress: { done: number, total: number, currentStage?: string } }`.
`StageProjection = { stageLabel: string /* a stage/* label */, stateCategory?: StateCategory }`.
`EvidencePlan = { attachTo, links: string[], summary? }`.
`RelationType = 'blocks' | 'related' | 'duplicate' | ...`.
`SubIssueSpec = { title, description, type, size? }`.
`InboxEntry = { item: WorkItem, comment: { author: string, mentions: string[], body: string } }`.

Each verb below states: what it must do, its **durability** requirement (which
writes must be durable and idempotent), and its **graceful degradation** (what to
do when the tracker, or a field, is unavailable). Two degradation rules are
universal and worth stating once:

- **A read that cannot reach the tracker MUST throw**, never return `[]`. An empty
  result is a real signal ("checked, nothing matched"); a thrown error is "could
  not check". The loop must distinguish them, or it will falsely conclude the
  queue is drained.
- **A write that fails MUST surface loudly and never report success.** The
  `agent/*` labels are the only recoverable state; a write reported as success but
  not persisted is unrecoverable.

### Reads

#### `getCurrentUser(): Promise<Account>`

- **Must do.** Return the authenticated account the adapter acts as. Resolves an
  `"auto"` agent identity and supplies the actor that ownership classification and
  the comment-response rules compare against.
- **Durability.** Read-only.
- **Degradation.** If the account cannot be resolved, **throw** (never return a
  placeholder). Identity is load-bearing: a wrong identity corrupts ownership
  classification and self-comment detection.

#### `getProjects(): Promise<WorkItemProject[]>`

- **Must do.** Return all projects, normalized to `{ id, name, stateCategory?, lead? }`.
- **Durability.** Read-only.
- **Degradation.** A tracker without projects returns `[]`. A project whose
  workflow category is unavailable leaves `stateCategory` `undefined` (the
  project-status dispatch tier becomes a no-op for it), never a fabricated value.

#### `resolveProject(nameOrId: string): Promise<WorkItemProject[]>`

- **Must do.** Resolve a fuzzy project reference (name, slug, or umbrella
  identifier; case-insensitive) to matching projects. Return **all** matches so
  the caller disambiguates: one match means resolved, more than one means ask the
  human. This is the project-addressing primitive for project-scoped routing.
- **Durability.** Read-only.
- **Degradation.** No match returns `[]`. A tracker without projects returns `[]`
  (project routing is unavailable; the caller falls back to global dispatch).

#### `getProject(id: string): Promise<ProjectDetail>`

- **Must do.** Return one project with its `children[]` (the project's
  `WorkItem`s), its `umbrella` item (the `type: 'meta'` anchor) when present, and a
  progress rollup (`done`/`total` and the current stage).
- **Durability.** Read-only.
- **Degradation.** A missing umbrella is omitted. A missing project category is
  `undefined`. An empty project returns `children: []`.

#### `getProjectWork(projectId: string): Promise<WorkItem[]>`

- **Must do.** `getEligibleWork` scoped to one project: the candidate
  `WorkItem[]` for project-scoped dispatch, under the **same** normalization and
  degradation rules as `getEligibleWork`.
- **Durability.** Read-only.
- **Degradation.** Same as `getEligibleWork`, including the throw-on-unreachable
  rule.

#### `getEligibleWork(): Promise<WorkItem[]>`

- **Must do.** Return the **candidate** `WorkItem[]` the dispatch policy filters
  and ranks. Scope to the active workspace; exclude archived or deleted noise.
  Normalize every item fully: all required fields, re-namespaced labels, resolved
  `stateCategory`, and the relation graph as identifiers. The set is **broader
  than "ready"**: it includes both items carrying `agent/ready` and dispatchable
  items that lack it, so the loop can tell **done** (nothing shapeable) from
  **starved** (shapeable work waiting behind the readiness gate). The engine's
  eligibility pass applies the `agent/ready` gate, not this read (see INV-5).
- **Durability.** Read-only.
- **Degradation.** An empty result (`[]`) is a real signal. An unreachable or
  erroring tracker MUST **throw**. Partial per-item data degrades per field
  (`undefined` = neutral); a missing relation graph is treated as **no known
  blockers** (neutral), never as blocked.

#### `getInbox(): Promise<InboxEntry[]>`

- **Must do.** Return the items the acting agent must look at this tick:
  assigned-to-the-agent, plus @mentions of the agent, plus new comments since the
  last tick. Each entry carries its `WorkItem` and the triggering comment
  `{ author, mentions[], body }`, so the comment-response rules can decide
  respond/act/ignore and so a parked `agent/needs-input` item resumes on a
  non-agent reply.
- **Durability.** Read-only.
- **Degradation.** A tracker without a comment or mention surface returns the
  assigned-to-agent subset only; missing mention data degrades to "not mentioned"
  (the quiet-by-default bias keeps this safe). An unreachable tracker throws.

#### `getRelations(item: WorkItem): Promise<WorkItemRelations>`

- **Must do.** Return the typed dependency graph
  (`blocks`/`blockedBy`/`children`/`relatedTo`/`duplicateOf`) for one item, as
  identifiers (human keys).
- **Durability.** Read-only.
- **Degradation.** If the tracker does not expose a typed relation graph, or
  returns it incomplete, treat the unknown portion as **empty** (neutral, "no
  known blockers"). **Never** parse relations out of description prose: typed
  relations only. A missing graph degrades to neutral, never to "blocked".

### Writes (the single audit surface)

#### `claim(item: WorkItem): Promise<void>`

- **Must do.** Mark the item as claimed by the agent: write the `agent/claimed`
  label **and** move the item into a `started`-category state, in that order (label
  first, so the durable claim signal lands even if the state move fails).
- **Durability.** **Durable and idempotent.** The `agent/*` label is the durable
  state machine; it must survive a process restart (an in-memory claim does not).
  Re-claiming an already-claimed item is a no-op. After a crash, any
  `agent/claimed` + `started` + not-`agent/needs-input` item is recoverable as
  orphaned work; the ordering guarantees this recovery shape.
- **Degradation.** A failed write surfaces loudly and never reports success. A
  partial claim (label set but state not moved, or the reverse) must leave a state
  the recovery sweep can detect and converge, never a silent half-claim.
  Re-running converges.

#### `transition(item: WorkItem, to: StageProjection): Promise<void>`

- **Must do.** Project the item onto the target stage: set the stage's `stage/*`
  label and, when the stage carries one, move the item into a state of the target
  `stateCategory`. Drives the stage-to-projection round-trip the engine reads
  back. (The typed promotion surface may narrow `to` to a bare `StateCategory`
  because the stage-to-label mapping is derivable from the engine's stage model;
  an adapter may accept either form as long as both the `stage/*` label and the
  category are projected.)
- **Durability.** **Durable and idempotent.** The `stage/*` label and category are
  projected state; re-applying the same transition is a no-op.
- **Degradation.** A failed write surfaces loudly. If the tracker has no state of
  the target category, set the label and leave the state as-is (the engine
  branches on the label plus whatever category is representable); never fabricate a
  category.

#### `comment(item: WorkItem, body: string): Promise<void>`

- **Must do.** Post a comment on the item. The agent's own comments **must carry
  the agent identity marker** so the comment-response rules recognize them (and
  never answer themselves) in shared-account mode.
- **Durability.** Durable (a posted comment persists). Idempotency is best-effort:
  avoid duplicate posts on retry (for example by checking recent comments), since a
  comment is user-visible.
- **Degradation.** A failed post surfaces loudly and is never silently dropped. A
  comment is often the carrier for `needsInput` and the review handoff, so a
  dropped comment reported as success would strand the human.

#### `assignToHuman(item: WorkItem): Promise<void>`

- **Must do.** Set the item's assignee to the reviewer or authenticated human,
  triggering the tracker's notification. Used at the review gate and in handoff.
- **Durability.** **Durable and idempotent.** Re-assigning to the same human is a
  no-op.
- **Degradation.** A tracker without assignment falls back to a comment that
  @mentions the human (so the handoff still reaches them). If neither is possible,
  throw.

#### `attachEvidence(item: WorkItem, evidence: EvidencePlan): Promise<void>`

- **Must do.** Attach proof-of-completion (a recording, a test summary, a change
  or PR link) to the item per the evidence plan's attach target.
- **Durability.** Durable; idempotent (re-attaching the same evidence reference
  deduplicates by URL).
- **Degradation.** A tracker without attachments falls back to posting the
  evidence as a comment (durable and visible). A failed attach surfaces loudly.

#### `needsInput(item: WorkItem, question: string): Promise<void>`

- **Must do.** The elicitation primitive: **four atomic effects** in order: (1)
  post the `question` as a comment (multiple-choice when possible, carrying the
  marker); (2) apply the `agent/needs-input` label; (3) `assignToHuman`; (4)
  **stop** (the loop parks here). Resumes only on a non-agent reply surfaced by
  `getInbox`.
- **Durability.** **Durable park, idempotent.** "Parked on a human" is a distinct
  durable state the stall sweep must never reclaim. Order the effects so the
  durable label lands before the stop, and a retry after a partial failure
  converges on the full parked state (label present, question posted, assigned)
  without duplicating the question.
- **Degradation.** Every effect must be durable, or the park is unsafe. If the
  label cannot be written, the park has failed and must **surface loudly** rather
  than stop silently: a silent stop with no durable park is unrecoverable.

#### `link(a: WorkItem, b: WorkItem, type: RelationType): Promise<void>`

- **Must do.** Create a typed relation of `type` between two items. Typed relations
  live in the graph, never in description prose.
- **Durability.** Durable and idempotent (the relation already existing is a
  no-op).
- **Degradation.** A tracker without typed relations of the requested kind falls
  back to the nearest supported kind, or records the link as structured metadata
  the adapter can read back. Never encode it in prose where `getRelations` cannot
  recover it. A failed write surfaces loudly.

#### `createSubIssue(parent: WorkItem, spec: SubIssueSpec): Promise<WorkItem>`

- **Must do.** Create a child item under `parent` (sub-issue promotion, which
  fires when `size` meets or exceeds the configured threshold). Return the created
  item **normalized as a `WorkItem`**, so the caller records its `identifier` as
  the task's canonical home.
- **Durability.** Durable. Should guard against duplicate creation on retry
  (idempotency by a stable key where the tracker supports one).
- **Degradation.** A tracker without parent/child nesting falls back to a
  standalone item plus a typed `link(parent, child, 'related')`, so the relation is
  still recoverable. Failed creation surfaces loudly and returns no fabricated
  item.

---

## 4. Conformance invariants

These are the checkable rules `validate-adapter.mjs` (built later) asserts against
an adapter's normalized output. Each carries a short id the validator references.

**INV-1 - All five state categories are representable.** Every `stateCategory` the
adapter emits is one of exactly `backlog | unstarted | started | completed |
canceled`. The validator feeds states of each native category and asserts each
maps to one of the five; a holding or un-triaged native state maps to `backlog`.
No sixth category is ever emitted.

**INV-2 - Required fields present and correctly typed.** Every `WorkItem` carries
the required fields with correct types: `id` (non-empty `string`), `identifier`
(non-empty `string`), `title` (`string`), `description` (`string`), `type` (one of
the seven `WorkItemType` values), `stateCategory` (one of the five categories),
`stateName` (`string`), `parent` (`string | null`), `relations` (an object whose
`blocks`/`blockedBy`/`children`/`relatedTo` are `string[]` and whose `duplicateOf`
is an optional `string`), and `labels` (`string[]`). Optional fields (`priority`,
`size`, `project`, `assignee`, `agentDisposition`, `createdAt`) are either absent
or correctly typed (`priority` in `{0,1,2,3,4}`; `size` a `string`;
`agentDisposition` one of its four values). A missing optional MUST be `undefined`,
never a fabricated value (neutral is not "smallest" or "lowest").

**INV-3 - Relation references resolve.** Every identifier in `relations.blockedBy`
(and in `blocks`, `children`, `relatedTo`, `duplicateOf`) is in the **human-key
`identifier` form**, never a tracker-native id. Within a single `getEligibleWork()`
or `getProjectWork()` response, each `blockedBy` reference to an item that is still
open resolves to a member of the returned set; a reference absent from the set is a
closed or out-of-scope item and is treated as non-blocking (neutral). The validator
asserts: no `blockedBy` id has a native-id shape, and every `blockedBy` id either
resolves in-set or is provably terminal/closed.

**INV-4 - Labels are re-namespaced into the generic families.** `labels[]`
contains generic-family labels, not raw native leaf labels or tracker-specific
groupings. The validator asserts the disposition, stage, and type signals appear in
their namespaced form: `agentDisposition` is consistent with an `agent/*` label,
the stage projection appears as a `stage/*` label, and `type` matches a `type/*`
label. A bare leaf (for example `ready` instead of `agent/ready`) fails this
invariant.

**INV-5 - The readiness gate is the `agent/ready` label.** The dispatch
eligibility pass admits an item **only if** it carries the literal, re-namespaced
`agent/ready` label; the adapter must express readiness as that label and nothing
else (not a bare leaf, not a separate field). `getEligibleWork()` and
`getProjectWork()` return the full **candidate** set (items carrying `agent/ready`
**plus** dispatchable-category items that lack it, the "shapeable" set), so the loop
can distinguish done from starved; the engine's eligibility pass, not the adapter,
drops the non-ready items. The validator asserts: (a) every item the eligibility
pass admits carries `agent/ready`, and (b) the readiness signal never appears as a
bare leaf label, which would silently fail the gate.

> Note on INV-5: the verb is named `getEligibleWork`, but it returns **candidates**,
> not pre-filtered eligible work. The `agent/ready` gate is enforced downstream by
> the engine's eligibility pass; the candidate set deliberately includes shapeable,
> not-yet-ready items so starvation ("ready: 0 but shapeable work waits") is
> detectable rather than silently read as "done". An adapter that pre-filters to
> only `agent/ready` items would break starvation detection, so it must not.

---

## 5. Versioning

This contract carries a **semver version** (see the top of this file). An adapter
**declares the contract version it targets** (an exported `CONTRACT_VERSION`
constant or a manifest field), and `validate-adapter.mjs` checks that declaration
against the contract's current version.

- **MAJOR bump** - a breaking change to the `WorkItem` shape, a verb signature, or
  an invariant. Adopters MUST re-validate and likely regenerate their adapter; an
  adapter pinned to an older major is not guaranteed to conform.
- **MINOR bump** - additive only (a new optional field, a new verb, a relaxed
  rule). Existing adapters keep working but SHOULD re-validate to adopt the
  addition.
- **PATCH bump** - clarification or wording only; no behavioral change.

Adopters **pin** the contract version they generated against and **re-validate on
every contract bump**, so drift between the engine and a concrete adapter is caught
at validation time rather than at runtime.
