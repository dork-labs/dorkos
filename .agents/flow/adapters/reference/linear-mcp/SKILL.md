---
name: linear-mcp-adapter
description: Reference tracker adapter for /flow - Linear reached over an in-session MCP server. A concrete, forkable realization of the adapter contract (../../SPEC.md) built on the Linear MCP tools (the mcp__linear__* / mcp__plugin_linear_linear__* family). Implements all 16 capability verbs and normalizes Linear into the generic WorkItem shape. Adopters fork this directory at /flow:init when their tracker is Linear reached over MCP.
---

# Reference adapter: Linear over MCP

> **What this is.** A **reference tracker adapter** for the `/flow` engine: a
> concrete realization of the neutral contract in [`../../SPEC.md`](../../SPEC.md)
> (contract version `1.0.0`) over **one transport - the in-session Linear MCP
> server**. It owns every Linear call and normalizes Linear into the generic
> `WorkItem` shape so the dispatch policy and the stage skills run unchanged.
>
> **This is the template adopters fork at `/flow:init`.** It is a prose contract,
> not code (v1 is server-free and skill-based: the agent reads this and acts on
> it). Its sibling, [`../linear-composio/SKILL.md`](../linear-composio/SKILL.md),
> is the same adapter over the Composio CLI - the two share structure so a reader
> can diff transports verb-for-verb. Pick MCP when the Linear MCP server is
> authenticated; pick Composio when it is not.
>
> **Tracker strings live here legitimately.** This file is a concrete adapter, so
> it names `mcp__linear__*` tool strings on purpose. It sits under
> `.agents/flow/adapters/reference/`, outside the tracker-confinement guard's
> scanned roots. No generic stage skill or `/flow:*` command may name a tracker
> string; this reference adapter is where they are allowed.

---

## Reaching Linear over MCP

The Linear MCP server is the in-session transport. Tool names are
`mcp__plugin_linear_linear__*` (for example `list_issues`, `save_issue`,
`save_comment`, `get_authenticated_user`); the prose shorthand for the family is
`mcp__linear__*`. It reaches the DorkOS team (team key `DOR`, slug `dorkos`).

- **Auth.** The server must be authenticated (OAuth). If it is not, start the
  flow with `mcp__linear__authenticate`; do not fall back to a second transport
  from inside this adapter (the Composio reference adapter is the fallback, and
  the engine picks one transport per run).
- **Query hygiene (every read).**
  - Always pass `includeArchived: false` on `list_issues`. Linear defaults it to
    `true`, which pulls archived noise from deleted projects into the candidate
    set.
  - Do **not** pass `includeMembers: true` on `list_projects`: it triggers
    GraphQL query-complexity errors. Fetch member/lead detail separately.
- **Helper reads the verbs lean on.** `list_issue_statuses` gives the team's
  `name -> type` state map (the source of `stateCategory`); `list_issue_labels`
  gives the label group-to-leaf map (the source of re-namespacing). Cache both
  per tick; they change rarely.

This transport returns Linear's typed relation graph reliably, so `getRelations`
and the per-item `relations` on candidates are trustworthy here (this is the
sharpest difference from the Composio transport, where relations come back
`null`).

---

## Normalizing Linear into `WorkItem`

Every read verb returns work normalized into the `WorkItem` shape defined in
[`../../SPEC.md` section 2](../../SPEC.md) so the generic layer never sees a
Linear field name. The three mappings below are this adapter's core job; the
verb table downstream says which call sources each field.

### State `type` -> `stateCategory` (match on category, never display name)

A Linear workflow state's display **name** is team-customizable ("Triage", "In
Progress", "Shipped") and varies per team, so the engine branches only on the
**category**. Resolve a state to its category from its `type` (via
`list_issue_statuses`) and map:

| Linear state `type` | `stateCategory` |
| ------------------- | --------------- |
| `triage`            | `backlog` †     |
| `backlog`           | `backlog`       |
| `unstarted`         | `unstarted`     |
| `started`           | `started`       |
| `completed`         | `completed`     |
| `canceled`          | `canceled`      |

† Linear's **Triage** feature adds a sixth state `type` beyond the five
categories. It is the un-triaged holding state. Normalize it to `backlog`
(non-terminal, so it lists and recovers like any open item). Never emit a sixth
category (INV-1): the model has exactly five values. A Triage-state item is kept
out of dispatch by the **absent `agent/ready` label**, not by its category. The
good fixture's `DOR-6` is exactly this case: `stateName: "Triage"`,
`stateCategory: "backlog"`, no `agent/ready` label.

### Native labels -> generic families (re-namespacing is mandatory)

The engine matches **literal, namespaced** label strings (INV-4). Map every
Linear label into its generic family before placing it on `labels[]`:

- **`agent/*`** - the durable disposition state machine: `agent/ready`,
  `agent/claimed`, `agent/completed`, `agent/needs-input`.
- **`stage/*`** - the active spine-stage projection (`stage/triage`,
  `stage/ideate`, `stage/execute`, `stage/done`, ...).
- **`type/*`** - the work type (`type/task`, `type/research`, `type/idea`,
  `type/meta`, ...).

Linear stores these as **grouped labels**: a parent container label (`agent`,
`stage`, `type`) with leaf children (`ready`, `ideate`, `task`). The MCP
transport surfaces a label with its parent reachable via `list_issue_labels`, so
reconstruct the family form as `parent.name + "/" + leaf.name` (leaf `ready`
under parent `agent` -> `agent/ready`). A bare leaf left as `ready` fails INV-4
and **silently fails the readiness gate** (the dispatch policy matches the
literal `agent/ready`): re-namespacing is mandatory, not cosmetic.

### `type`, `agentDisposition`, `priority`, `size`

- **`type`** <- the `type/*` family (exactly one per item, mutually exclusive).
- **`agentDisposition`** <- the `agent/*` family: `agent/ready` -> `ready`,
  `agent/claimed` -> `claimed`, `agent/completed` -> `completed`,
  `agent/needs-input` -> `needs-input`. The `agent/*` labels are the **durable
  state machine**, not the ephemeral plan/checklist field.
- **`priority`** <- Linear's native priority field (`0` none, `1` urgent, `2`
  high, `3` medium, `4` low). Native field, never a label. Missing -> `undefined`
  (neutral), never `0`.
- **`size`** <- Linear's native estimate field (Fibonacci points / t-shirt).
  Native field, never a label. Drives sub-issue promotion and the dispatch size
  tier. Missing -> `undefined`, never `0` or smallest.

---

## The 16 verbs

Eight reads and eight writes (SPEC section 3). The generic layer only ever names
a verb; this adapter owns the MCP call. Each block gives the **call**, the
**normalization** into `WorkItem`, and the **durability + degradation** the
contract requires. Two degradation rules are universal: a read that cannot reach
the tracker **throws** (never returns `[]`, so the loop can tell "checked,
nothing matched" from "could not check"); a write that fails **surfaces loudly
and never reports success** (the `agent/*` labels are the only recoverable
state).

### Reads (8)

#### `getCurrentUser(): Account`

- **Call.** `mcp__plugin_linear_linear__get_authenticated_user`.
- **Normalize.** Return `{ id, name }`. Resolves an `identity.agent: "auto"`
  identity and supplies the actor that ownership classification and the
  comment-response rules compare against.
- **Durability + degradation.** Read-only. If the account cannot be resolved,
  **throw** (never a placeholder): a wrong identity corrupts ownership and
  self-comment detection.

#### `getProjects(): WorkItemProject[]`

- **Call.** `mcp__plugin_linear_linear__list_projects` (no `includeMembers`).
- **Normalize.** Each project -> `{ id, name, stateCategory?, lead? }`. Map the
  project's workflow-state category through the same five-category mapping;
  resolve `lead` to the lead account id.
- **Durability + degradation.** Read-only. No projects -> `[]`. An unavailable
  project category leaves `stateCategory` `undefined` (its project-status
  dispatch tier becomes a no-op), never a fabricated value.

#### `resolveProject(nameOrId): WorkItemProject[]`

- **Call.** `list_projects`, then case-insensitive fuzzy match on name / slug.
  For an umbrella identifier (a `type/meta` issue key), `get_issue` -> its
  `project`.
- **Normalize.** Return **all** matches as `WorkItemProject[]` so the caller
  disambiguates: one match means resolved, more than one means ask the human.
  This is the project-addressing primitive for `/flow <project>`.
- **Durability + degradation.** Read-only. No match -> `[]`. No projects in the
  tracker -> `[]` (the caller falls back to global dispatch).

#### `getProject(id): ProjectDetail`

- **Call.** `list_projects` (the one) + `list_issues` (project filter,
  `includeArchived: false`).
- **Normalize.** Return `WorkItemProject & { children: WorkItem[], umbrella?,
progress }`: `children` are the project's issues normalized, `umbrella` is the
  `type: 'meta'` anchor when present, `progress` is `{ done, total, currentStage }`
  (`done` = `completed`-category children; `currentStage` from the umbrella's
  `stage/*` label).
- **Durability + degradation.** Read-only. Missing umbrella omitted; missing
  category `undefined`; empty project -> `children: []`.

#### `getProjectWork(projectId): WorkItem[]`

- **Call.** `list_issues` (project filter, `includeArchived: false`).
- **Normalize.** `getEligibleWork` scoped to one project: the same full
  normalization (re-namespaced labels, resolved `stateCategory`, relations as
  identifiers) and the same **candidate** breadth (ready + shapeable).
- **Durability + degradation.** Read-only. Same as `getEligibleWork`, including
  the throw-on-unreachable rule.

#### `getEligibleWork(): WorkItem[]`

- **Call.** `mcp__plugin_linear_linear__list_issues` for the DOR team,
  `includeArchived: false`.
- **Normalize.** Fully normalize every item: required fields, re-namespaced
  labels, `stateCategory` resolved via `list_issue_statuses`, relations as
  identifiers. Return the **candidate** set, which is broader than "ready": items
  carrying `agent/ready` **plus** dispatchable-category items that lack it, so
  the loop can tell **done** (nothing shapeable) from **starved** (shapeable work
  behind the readiness gate). Do **not** pre-filter to `agent/ready` (INV-5): the
  engine's eligibility pass applies that gate.
- **Durability + degradation.** Read-only. `[]` is a real signal; an unreachable
  or erroring tracker **throws**. Per-item partial data degrades per field
  (`undefined` = neutral); a missing relation graph is **no known blockers**
  (neutral), never blocked.

#### `getInbox(): InboxEntry[]`

- **Call.** `list_issues` (assignee = the acting agent) +
  `mcp__plugin_linear_linear__list_comments` for items touched since the last
  tick.
- **Normalize.** Return `InboxEntry[]` = the items the agent must look at this
  tick (assigned-to-the-agent + @mentions of the agent + new comments since the
  last tick), each carrying its `WorkItem` and the triggering comment
  `{ author, mentions[], body }` (see the entry shape below).
- **Durability + degradation.** Read-only. Missing mention data degrades to "not
  mentioned" (the quiet-by-default bias keeps this safe); an unreachable tracker
  throws.

#### `getRelations(item): WorkItemRelations`

- **Call.** `mcp__plugin_linear_linear__get_issue` (returns the typed relations).
- **Normalize.** Map to `{ blocks[], blockedBy[], children[], relatedTo[],
duplicateOf? }`, every entry in the **human-key `identifier`** form (for
  example `DOR-2`), never a native node id (INV-3). MCP returns the typed graph
  reliably on this transport.
- **Durability + degradation.** Read-only. **Never** parse relations from
  description prose: typed relations only. An incomplete graph degrades to
  neutral ("no known blockers"), never to "blocked".

### Writes (8) - the single audit surface

#### `claim(item): void`

- **Call.** `mcp__plugin_linear_linear__save_issue` setting `labelIds` to add
  `agent/claimed` **and** `stateId` to a `started`-category state - label first,
  then the state move.
- **Durability + degradation.** **Durable and idempotent.** The `agent/claimed`
  label is the durable claim signal (the state machine is labels, not the plan
  field); it must survive a restart. Re-claiming is a no-op. A partial claim
  (label set, state not moved) must leave a state the recovery sweep detects and
  converges; a failed write surfaces loudly. After a crash, any `agent/claimed` +
  `started` + not-`agent/needs-input` item is recoverable as orphaned work.

#### `transition(item, to): void`

- **Call.** `save_issue` setting the `stage/*` label for `to.stageLabel`
  (replacing the prior `stage/*`) and, when `to.stateCategory` is given,
  `stateId` to a state of that category for the team.
- **Durability + degradation.** **Durable and idempotent.** The `stage/*` label
  and category are projected state; re-applying is a no-op. If the team has no
  state of the target category, set the label and leave the state as-is (never
  fabricate a category). A failed write surfaces loudly.

#### `comment(item, body): void`

- **Call.** `mcp__plugin_linear_linear__save_comment` with `{ issueId, body }`,
  the body carrying the agent identity marker (for example `- 🤖 /flow`).
- **Durability + degradation.** Durable (a posted comment persists). Idempotency
  is best-effort: check recent comments to avoid a duplicate post on retry, since
  a comment is user-visible. A failed post surfaces loudly and is never silently
  dropped (a comment carries `needsInput` and the review handoff).

#### `assignToHuman(item): void`

- **Call.** `save_issue` setting `assigneeId` to the reviewer / authenticated
  human (triggers a Linear notification).
- **Durability + degradation.** **Durable and idempotent.** Re-assigning to the
  same human is a no-op. If assignment is somehow unavailable, fall back to a
  comment that @mentions the human; if neither is possible, throw.

#### `attachEvidence(item, evidence): void`

- **Call.** `save_issue` attaching `evidence.links` as issue links / attachments
  per `evidence.attachTo`.
- **Durability + degradation.** Durable; idempotent (re-attaching the same URL
  deduplicates). Fall back to posting the evidence as a comment when attachments
  are unavailable. A failed attach surfaces loudly.

#### `needsInput(item, question): void`

The elicitation primitive - **four atomic effects, in order**:

1. `save_comment` posting `question` (multiple-choice when possible, carrying the
   marker).
2. `save_issue` adding the `agent/needs-input` label.
3. `assignToHuman(item)` (above).
4. **Stop** - the loop parks here; it resumes only on a non-agent reply surfaced
   by `getInbox`.

- **Durability + degradation.** **Durable park, idempotent.** Order the effects
  so the durable label lands before the stop; a retry after a partial failure
  converges on the full parked state (label present, question posted, assigned)
  without duplicating the question. If the label cannot be written the park has
  failed and must **surface loudly** rather than stop silently: a silent stop
  with no durable park is unrecoverable, and the stall sweep must never reclaim a
  genuinely parked item.

#### `link(a, b, type): void`

- **Call.** `save_issue` creating a typed relation (`blocks`, `related`,
  `duplicate`, ...) between `a` and `b`.
- **Durability + degradation.** Durable and idempotent (the relation already
  existing is a no-op). Typed relations live in the graph, **never** in
  description prose (or `getRelations` could not recover them). A failed write
  surfaces loudly.

#### `createSubIssue(parent, spec): WorkItem`

- **Call.** `mcp__plugin_linear_linear__save_issue` with `parentId = parent.id`,
  `title`, `description`, the `type/*` label for `spec.type`, and `estimate` for
  `spec.size`.
- **Normalize.** Return the created issue **normalized as a `WorkItem`** so the
  caller records its `identifier` as the task's canonical home (the per-task
  `issue` field in `03-tasks.json`). Sub-issue promotion fires only when `size`
  meets or exceeds the configured threshold.
- **Durability + degradation.** Durable; guard against duplicate creation on
  retry. Failed creation surfaces loudly and returns no fabricated item.

---

## `getInbox` entry shape

```
InboxEntry {
  item,                       // the WorkItem the comment is on
  comment: {
    author,                   // who wrote it (compared against identity.agent / marker)
    mentions[],               // @mentioned accounts (drives "directly addressed")
    body,                     // the comment text (may carry an explicit /flow token)
  }
}
```

The comment-response rules consume this (never answer its own comments; always
respond when directly addressed; resume an `agent/needs-input` item on a
non-agent comment; stay out of `other`-owned threads unless mentioned; soft zone
leans quiet). This adapter supplies the raw `assignee` and the triggering
comment; it does not itself classify ownership.

---

## Durability rules (the state machine)

- **The state machine is the `agent/*` labels**, not the ephemeral plan field. A
  label written via `save_issue` survives a restart; an in-memory plan does not.
- **`claim` is durable and atomic-in-intent**: label `agent/claimed` first, then
  the `started`-category move, so a crash leaves recoverable orphaned work.
- **`needsInput` parks durably**: label + comment + assign + stop. "Parked on a
  human" is a distinct durable state the stall sweep must never reclaim.
- **Answers become memory**: the resolution the agent receives is written where
  the next decision's evidence test will find it (decisions table / ADR /
  `config.json`). This adapter writes the tracker side (the comment + label
  change); the durable answer lives in the repo artifact.

---

## Graceful degradation

The `WorkItem` shape is the generic contract; anything missing is treated as
**neutral**, never fabricated.

- **No `project.stateCategory`** -> the project-status dispatch tier is a no-op;
  items rank on the remaining tiers.
- **No `priority`** -> `undefined` (sorts as "none", last in the priority tier),
  never excluded.
- **No `size`** -> `undefined` in the size tier; sub-issue promotion never fires.
- **No relation graph** -> treated as "no known blockers" (neutral), never
  blocked.

This adapter populates every field it **can** from Linear and leaves the rest
`undefined`; it never fabricates a value to satisfy the shape.

---

## Conformance

This reference produces `WorkItem`s that match the contract shape demonstrated in
[`../fixtures/work-items.good.json`](../fixtures/work-items.good.json) - all five
state categories (`backlog`, `unstarted`, `started`, `completed`, `canceled`),
the generic label families (`type/*`, `stage/*`, `agent/*`), `blockedBy`
resolution by `identifier`, and optionals left absent rather than fabricated. It
satisfies the SPEC section 4 invariants: **INV-1** (five categories only; Triage
-> `backlog`), **INV-2** (required fields present and typed; optionals absent or
typed), **INV-3** (relation references in human-key form, resolving in-set or
provably closed), **INV-4** (labels re-namespaced into the generic families), and
**INV-5** (the readiness gate is the literal `agent/ready` label, and
`getEligibleWork` / `getProjectWork` return the broader candidate set, never
pre-filtered). It targets contract version `1.0.0`.
