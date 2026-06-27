# Verb implementation checklist (all 16)

The per-verb checklist for the adapter you generate in Step 3. It restates the
contract ([`.agents/flow/adapters/SPEC.md`](../../../adapters/SPEC.md) section 3)
as an implementation worksheet, **tracker-neutral**: each verb lists its binding
placeholder (the concrete tracker call _you_ fill in), its durability requirement,
and its graceful degradation. Where the SPEC and this file disagree, the SPEC wins.

For every verb, your generated adapter must document three things:

1. **Binding** - the concrete tracker call (the MCP tool, CLI command, or REST
   request) this verb maps to. Shown below as a generic placeholder such as
   `<list-open-items>`; you replace it with your tracker's real call.
2. **Durability** - whether the write must be durable and idempotent (reads are
   read-only).
3. **Degradation** - what to return or do when the tracker, or a field, is
   unavailable.

Two universal rules apply to every verb:

- **A read that cannot reach the tracker MUST throw**, never return `[]`. Empty is
  "checked, nothing matched"; a throw is "could not check". The loop must
  distinguish them or it will falsely conclude the queue is drained.
- **A write that fails MUST surface loudly and never report success.** A write
  reported as success but not persisted is unrecoverable.

---

## The 8 reads

### `getCurrentUser(): Account`

- **Binding.** `<get-authenticated-account>`.
- **Must do.** Return the authenticated account `{ id, name? }` the adapter acts
  as. Resolves an `"auto"` agent identity; supplies the actor that ownership
  classification and the comment-response rules compare against.
- **Degradation.** If the account cannot be resolved, **throw** (never a
  placeholder). A wrong identity corrupts ownership classification and self-comment
  detection.

### `getProjects(): WorkItemProject[]`

- **Binding.** `<list-projects>`.
- **Must do.** Return all projects normalized to `{ id, name, stateCategory?, lead? }`.
- **Degradation.** A tracker without projects returns `[]`. A project whose
  workflow category is unavailable leaves `stateCategory` `undefined` (the
  project-status dispatch tier becomes a no-op), never a fabricated value.

### `resolveProject(nameOrId: string): WorkItemProject[]`

- **Binding.** `<list-projects>` then fuzzy-match, plus `<get-item>` to resolve an
  umbrella identifier.
- **Must do.** Resolve a fuzzy project reference (name, slug, or umbrella
  identifier; case-insensitive) to matching projects. Return **all** matches so the
  caller disambiguates: one match means resolved, more than one means ask the
  human. The project-addressing primitive for project-scoped routing.
- **Degradation.** No match returns `[]`. A tracker without projects returns `[]`
  (the caller falls back to global dispatch).

### `getProject(id: string): ProjectDetail`

- **Binding.** `<get-project>` + `<list-items scoped to the project>`.
- **Must do.** Return one project with its `children[]` (the project's
  `WorkItem`s), its `umbrella` item (the `type: 'meta'` anchor) when present, and a
  progress rollup (`done`/`total`, current stage).
- **Degradation.** A missing umbrella is omitted. A missing project category is
  `undefined`. An empty project returns `children: []`.

### `getProjectWork(projectId: string): WorkItem[]`

- **Binding.** `<list-items scoped to the project>`.
- **Must do.** `getEligibleWork` scoped to one project: the candidate `WorkItem[]`
  for project-scoped dispatch, under the **same** normalization and degradation as
  `getEligibleWork` (including the candidate-set rule, INV-5).
- **Degradation.** Same as `getEligibleWork`, including the throw-on-unreachable
  rule.

### `getEligibleWork(): WorkItem[]`

- **Binding.** `<list-open-items in the active workspace>`.
- **Must do.** Return the **candidate** `WorkItem[]` the dispatch policy filters
  and ranks. Scope to the active workspace; exclude archived or deleted noise.
  Normalize every item fully: all required fields, re-namespaced labels, resolved
  `stateCategory`, and the relation graph as identifiers. The set is **broader than
  "ready"**: it includes items carrying `agent/ready` **and** dispatchable items
  that lack it, so the loop can tell **done** (nothing shapeable) from **starved**
  (shapeable work waiting behind the readiness gate). The engine applies the
  `agent/ready` gate, not this read (INV-5).
- **Degradation.** `[]` is a real signal. An unreachable or erroring tracker MUST
  **throw**. Partial per-item data degrades per field (`undefined` = neutral); a
  missing relation graph is **no known blockers** (neutral), never blocked.

### `getInbox(): InboxEntry[]`

- **Binding.** `<list-items assigned to the agent>` + `<list-recent-comments>`.
- **Must do.** Return the items the acting agent must look at this tick:
  assigned-to-the-agent, plus @mentions of the agent, plus new comments since the
  last tick. Each `InboxEntry` carries its `WorkItem` and the triggering comment
  `{ author, mentions[], body }`, so the comment-response rules decide
  respond/act/ignore and a parked `agent/needs-input` item resumes on a non-agent
  reply.
- **Degradation.** A tracker without a comment or mention surface returns the
  assigned-to-agent subset only; missing mention data degrades to "not mentioned".
  An unreachable tracker throws.

### `getRelations(item: WorkItem): WorkItemRelations`

- **Binding.** `<get-item with its typed relation graph>`.
- **Must do.** Return the typed dependency graph
  (`blocks`/`blockedBy`/`children`/`relatedTo`/`duplicateOf`) for one item, as
  **identifiers** (human keys).
- **Degradation.** If the tracker exposes no typed relation graph, or returns it
  incomplete, treat the unknown portion as **empty** (neutral, "no known
  blockers"). **Never** parse relations out of description prose: typed relations
  only. A missing graph degrades to neutral, never to "blocked".

---

## The 8 writes (the single audit surface)

### `claim(item: WorkItem): void`

- **Binding.** `<update-item: set label + state>`.
- **Must do.** Write the `agent/claimed` label **and** move the item into a
  `started`-category state, **in that order** (label first, so the durable claim
  signal lands even if the state move fails).
- **Durability.** **Durable and idempotent.** The `agent/*` label is the durable
  state machine; it must survive a process restart. Re-claiming is a no-op. After a
  crash, any `agent/claimed` + `started` + not-`agent/needs-input` item is
  recoverable as orphaned work; the ordering guarantees this recovery shape.
- **Degradation.** A failed write surfaces loudly. A partial claim must leave a
  state the recovery sweep can detect and converge, never a silent half-claim.
  Re-running converges.

### `transition(item: WorkItem, to: StageProjection): void`

- **Binding.** `<update-item: set stage label + state>`.
- **Must do.** Project the item onto the target stage: set the stage's `stage/*`
  label and, when the stage carries one, move the item into a state of the target
  `stateCategory`. Drives the stage-to-projection round-trip the engine reads back.
- **Durability.** **Durable and idempotent.** Re-applying the same transition is a
  no-op.
- **Degradation.** A failed write surfaces loudly. If the tracker has no state of
  the target category, set the label and leave the state as-is; never fabricate a
  category.

### `comment(item: WorkItem, body: string): void`

- **Binding.** `<create-comment>`.
- **Must do.** Post a comment. The agent's own comments **must carry the agent
  identity marker** so the comment-response rules recognize them (and never answer
  themselves) in shared-account mode.
- **Durability.** Durable. Idempotency is best-effort: avoid duplicate posts on
  retry (for example by checking recent comments), since a comment is user-visible.
- **Degradation.** A failed post surfaces loudly and is never silently dropped. A
  comment is often the carrier for `needsInput` and the review handoff, so a
  dropped comment reported as success would strand the human.

### `assignToHuman(item: WorkItem): void`

- **Binding.** `<update-item: set assignee>`.
- **Must do.** Set the item's assignee to the reviewer or authenticated human,
  triggering the tracker's notification. Used at the review gate and in handoff.
- **Durability.** **Durable and idempotent.** Re-assigning to the same human is a
  no-op.
- **Degradation.** A tracker without assignment falls back to a comment that
  @mentions the human (so the handoff still reaches them). If neither is possible,
  throw.

### `attachEvidence(item: WorkItem, evidence: EvidencePlan): void`

- **Binding.** `<update-item: attach links>` or `<create-comment with the links>`.
- **Must do.** Attach proof-of-completion (a recording, a test summary, a change or
  PR link) to the item per the evidence plan's attach target.
- **Durability.** Durable; idempotent (re-attaching the same evidence reference
  deduplicates by URL).
- **Degradation.** A tracker without attachments falls back to posting the evidence
  as a comment (durable and visible). A failed attach surfaces loudly.

### `needsInput(item: WorkItem, question: string): void`

- **Binding.** `<create-comment>` + `<update-item: label + assignee>` + **stop**.
- **Must do.** The elicitation primitive: **four atomic effects in order**:
  (1) post the `question` as a comment (multiple-choice when possible, carrying the
  marker); (2) apply the `agent/needs-input` label; (3) `assignToHuman`; (4)
  **stop** (the loop parks here). Resumes only on a non-agent reply surfaced by
  `getInbox`.
- **Durability.** **Durable park, idempotent.** "Parked on a human" is a distinct
  durable state the stall sweep must never reclaim. Order the effects so the
  durable label lands before the stop; a retry after a partial failure converges on
  the full parked state (label present, question posted, assigned) without
  duplicating the question.
- **Degradation.** Every effect must be durable, or the park is unsafe. If the
  label cannot be written, the park has failed and must **surface loudly** rather
  than stop silently: a silent stop with no durable park is unrecoverable.

### `link(a: WorkItem, b: WorkItem, type: RelationType): void`

- **Binding.** `<create-typed-relation>`.
- **Must do.** Create a typed relation of `type` between two items. Typed relations
  live in the graph, never in description prose.
- **Durability.** Durable and idempotent (the relation already existing is a
  no-op).
- **Degradation.** A tracker without the requested relation kind falls back to the
  nearest supported kind, or records the link as structured metadata the adapter
  can read back. **Never** encode it in prose where `getRelations` cannot recover
  it. A failed write surfaces loudly.

### `createSubIssue(parent: WorkItem, spec: SubIssueSpec): WorkItem`

- **Binding.** `<create-item with parent set>`.
- **Must do.** Create a child item under `parent` (sub-issue promotion, which fires
  when `size` meets or exceeds the configured threshold). Return the created item
  **normalized as a `WorkItem`**, so the caller records its `identifier` as the
  task's canonical home.
- **Durability.** Durable. Guard against duplicate creation on retry (idempotency
  by a stable key where the tracker supports one).
- **Degradation.** A tracker without parent/child nesting falls back to a
  standalone item plus a typed `link(parent, child, 'related')`, so the relation is
  still recoverable. Failed creation surfaces loudly and returns no fabricated item.

---

## Supporting types (SPEC section 3)

- `Account = { id: string, name?: string }`.
- `WorkItemProject = { id, name, stateCategory?, lead? }`.
- `ProjectDetail = WorkItemProject & { children: WorkItem[], umbrella?: WorkItem, progress: { done, total, currentStage? } }`.
- `StageProjection = { stageLabel: string /* a stage/* label */, stateCategory?: StateCategory }`.
- `EvidencePlan = { attachTo, links: string[], summary? }`.
- `RelationType = 'blocks' | 'related' | 'duplicate' | ...`.
- `SubIssueSpec = { title, description, type, size? }`.
- `InboxEntry = { item: WorkItem, comment: { author: string, mentions: string[], body: string } }`.
