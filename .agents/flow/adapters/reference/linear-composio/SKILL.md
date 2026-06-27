---
name: linear-composio-adapter
description: Reference tracker adapter for /flow - Linear reached over the Composio CLI. A concrete, forkable realization of the adapter contract (../../SPEC.md) built on `composio execute LINEAR_*` calls. Implements all 16 capability verbs and normalizes Linear into the generic WorkItem shape. Adopters fork this directory at /flow:init when their tracker is Linear reached over Composio (the MCP server unauthenticated).
---

# Reference adapter: Linear over Composio

> **What this is.** A **reference tracker adapter** for the `/flow` engine: a
> concrete realization of the neutral contract in [`../../SPEC.md`](../../SPEC.md)
> (contract version `1.0.0`) over **one transport - the Composio CLI**. It owns
> every Linear call and normalizes Linear into the generic `WorkItem` shape so
> the dispatch policy and the stage skills run unchanged.
>
> **This is the template adopters fork at `/flow:init`.** It is a prose contract,
> not code (v1 is server-free and skill-based: the agent reads this and acts on
> it). Its sibling, [`../linear-mcp/SKILL.md`](../linear-mcp/SKILL.md), is the
> same adapter over the in-session MCP server - the two share structure so a
> reader can diff transports verb-for-verb. Pick Composio when the Linear MCP
> server is **unauthenticated** (Composio works without it); pick MCP otherwise.
>
> **Tracker strings live here legitimately.** This file is a concrete adapter, so
> it names `composio execute LINEAR_*` slugs on purpose. It sits under
> `.agents/flow/adapters/reference/`, outside the tracker-confinement guard's
> scanned roots. No generic stage skill or `/flow:*` command may name a tracker
> string; this reference adapter is where they are allowed.

---

## Reaching Linear over Composio

The Composio CLI is the transport (see the `composio-cli` skill). Linear slugs
are `LINEAR_*`; it reaches the DorkOS team (team key `DOR`, slug `dorkos`).

- **Auth - the account guard is load-bearing.** **Two Linear accounts are
  connected in Composio - always pass `--account personal`** (the DorkOS + Dunny
  workspace). The other account, `artblocks`, is unrelated work and must **never**
  receive DorkOS issues. A bare `composio execute` defaults to `personal` for
  Linear, but always pass the flag explicitly; it is the only thing keeping
  `artblocks` out (there is no team filter on the list slug - see below).

  ```bash
  composio execute LINEAR_LIST_LINEAR_TEAMS    --account personal -d '{}'
  composio execute LINEAR_LIST_LINEAR_PROJECTS --account personal -d '{}'
  # Rediscover a slug by intent when one 404s:
  composio search "list linear issues" "create a linear issue" --toolkits linear
  ```

- **DorkOS `team_id`** is `a171dbd5-3ccc-40ab-b58b-1fae7644fba8` (guards against
  the `artblocks` workspace where a slug accepts a team id).

### Composio transport gotchas (verified, v0.2.31)

The Composio transport diverges from MCP in ways that bite silently. These are
empirically verified against the live DorkOS workspace; trust them over a slug's
`--get-schema` guess when they conflict.

- **Prefer one GraphQL read over the field-poor list slug.**
  `LINEAR_RUN_QUERY_OR_MUTATION` is the richest read path and resolves the two
  worst traps below (missing category, flattened labels) in a single call:
  request `state{ name type }` for the category and
  `labels{ nodes{ name parent{ name } } }` to recover the namespace
  (reconstruct `agent/ready` as `parent.name + "/" + name`). It also returns
  `estimate` (size), `priority`, and accepts a label filter
  (`issues(filter:{ labels:{ name:{ eq:"ready" } } })`). The result nests under
  `.data.data.team` (note the **double** `data`). Reach for the per-verb slugs
  below for writes and simple lookups; reach for GraphQL for the full
  dispatch-ready read shape.
- **Slugs are doubly-prefixed; there is no `LINEAR_GET_ISSUE`.** The verbs are
  `LINEAR_LIST_LINEAR_ISSUES`, `LINEAR_GET_LINEAR_ISSUE`,
  `LINEAR_LIST_LINEAR_PROJECTS`, `LINEAR_GET_LINEAR_PROJECT`,
  `LINEAR_LIST_LINEAR_TEAMS`, `LINEAR_LIST_LINEAR_LABELS`,
  `LINEAR_LIST_LINEAR_STATES`. The un-doubled `LINEAR_GET_ISSUE` does **not**
  exist (`ToolRouterV2_ToolNotFound`).
- **`LINEAR_GET_LINEAR_ISSUE` takes the human identifier** (`-d
'{"issue_id":"DOR-149"}'`, no UUID). It returns the fields LIST omits:
  `state.type` (category), `estimate` (size), `priority`, `labels.nodes`,
  `project`, `parent`. **Caveat:** its `relations` field comes back `null` via
  Composio - the `blocks/blockedBy` graph is **not** reliably populated here.
- **`LINEAR_LIST_LINEAR_ISSUES` has a tiny filter schema - no team filter.**
  Allowed keys are only `after, first, project_id, assignee_id, original_cursor,
include_transitions, cursor_was_corrupted`. There is **no `team_id`** (passing
  it is silently dropped on the first call and hard-errors on a paginated one) and
  **no `include_archived`**. Scope to a project with `project_id`; the `personal`
  account's workspace is effectively DorkOS-only, so the unfiltered list is
  already team-correct (the `--account personal` guard, not a filter, keeps
  `artblocks` out).
- **Response shapes.** list -> `.data.issues[]` + `.data.page_info{ hasNextPage,
endCursor }` (**not** `.data.items`); get -> `.data.issue`; projects ->
  `.data.projects[]`; teams -> `.data.teams[]`.
- **Large reads spill to a file.** A big result returns `{ successful: true,
storedInFile: true, outputFilePath, tokenCount }` with **no inline data** - read
  `outputFilePath` with `jq` (do not slurp it into context). Paginate by passing
  `{ first, after: <endCursor> }` and **only** those keys (adding any filter key
  to an `after` call trips schema validation).

---

## Normalizing Linear into `WorkItem`

Every read verb returns work normalized into the `WorkItem` shape defined in
[`../../SPEC.md` section 2](../../SPEC.md) so the generic layer never sees a
Linear field name. The three mappings below are this adapter's core job; the
verb table downstream says which call sources each field.

### State `type` -> `stateCategory` (match on category, never display name)

A Linear workflow state's display **name** is team-customizable ("Triage", "In
Progress", "Shipped") and varies per team, so the engine branches only on the
**category**. Resolve a state to its category from its `type` and map:

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

**Composio-specific:** `state.type` (the category) is **absent from the LIST
call** - a listed issue's `state` is `{ name }` only. Resolve the category via
`LINEAR_GET_LINEAR_ISSUE` per item, or once via `LINEAR_LIST_LINEAR_STATES` (a
team-scoped `name -> type` map), or in a single `LINEAR_RUN_QUERY_OR_MUTATION`
read that already requests `state{ type }`.

### Native labels -> generic families (re-namespacing is mandatory)

The engine matches **literal, namespaced** label strings (INV-4). Map every
Linear label into its generic family before placing it on `labels[]`:

- **`agent/*`** - the durable disposition state machine: `agent/ready`,
  `agent/claimed`, `agent/completed`, `agent/needs-input`.
- **`stage/*`** - the active spine-stage projection (`stage/triage`,
  `stage/ideate`, `stage/execute`, `stage/done`, ...).
- **`type/*`** - the work type (`type/task`, `type/research`, `type/idea`,
  `type/meta`, ...).

**Composio-specific - labels arrive FLATTENED to leaf names.** A grouped Linear
label surfaces on the issue as its bare leaf: `ready` (not `agent/ready`),
`claimed` / `completed` / `needs-input` (not `agent/*`), `verify` / `ideate` (not
`stage/*`), `task` / `research` / `idea` / `meta` (not `type/*`). The group prefix
is a separate parent label **not** present on `labels.nodes`. Recover the
group-to-leaf map from `LINEAR_LIST_LINEAR_LABELS` (team-scoped; distinguishes
container vs leaf labels) and re-namespace leaf -> `family/leaf` before handing
`labels[]` to the policy, **or** request `labels{ nodes{ name parent{ name } } }`
in a `LINEAR_RUN_QUERY_OR_MUTATION` read and reconstruct `parent.name + "/" +
name`. A bare leaf left as `ready` fails INV-4 and **silently fails the readiness
gate** (the dispatch policy matches the literal `agent/ready`): re-namespacing is
mandatory, not cosmetic.

### `type`, `agentDisposition`, `priority`, `size`

- **`type`** <- the `type/*` family (exactly one per item, mutually exclusive).
- **`agentDisposition`** <- the `agent/*` family: `agent/ready` -> `ready`,
  `agent/claimed` -> `claimed`, `agent/completed` -> `completed`,
  `agent/needs-input` -> `needs-input`. The `agent/*` labels are the **durable
  state machine**, not the ephemeral plan/checklist field.
- **`priority`** <- Linear's native priority field (`0` none, `1` urgent, `2`
  high, `3` medium, `4` low; on `LINEAR_GET_LINEAR_ISSUE` / the GraphQL read, not
  LIST). Native field, never a label. Missing -> `undefined` (neutral), never `0`.
- **`size`** <- Linear's native `estimate` field (Fibonacci points / t-shirt;
  same caveat - absent from LIST). Native field, never a label. Drives sub-issue
  promotion and the dispatch size tier. Missing -> `undefined`, never `0` or
  smallest.

---

## The 16 verbs

Eight reads and eight writes (SPEC section 3). The generic layer only ever names
a verb; this adapter owns the Composio call. Each block gives the **call**, the
**normalization** into `WorkItem`, and the **durability + degradation** the
contract requires. Two degradation rules are universal: a read that cannot reach
the tracker **throws** (never returns `[]`, so the loop can tell "checked,
nothing matched" from "could not check"); a write that fails **surfaces loudly
and never reports success** (the `agent/*` labels are the only recoverable
state). Every call carries `--account personal`.

### Reads (8)

#### `getCurrentUser(): Account`

- **Call.** `composio execute LINEAR_GET_AUTHENTICATED_USER --account personal -d '{}'`.
- **Normalize.** Return `{ id, name }`. Resolves an `identity.agent: "auto"`
  identity and supplies the actor that ownership classification and the
  comment-response rules compare against.
- **Durability + degradation.** Read-only. If the account cannot be resolved,
  **throw** (never a placeholder): a wrong identity corrupts ownership and
  self-comment detection.

#### `getProjects(): WorkItemProject[]`

- **Call.** `LINEAR_LIST_LINEAR_PROJECTS` (response `.data.projects[]`).
- **Normalize.** Each project -> `{ id, name, stateCategory?, lead? }`.
  **Composio-specific:** project `state` comes back `null`, so `stateCategory` is
  `undefined` here (its project-status dispatch tier degrades to a no-op - the
  documented graceful-degradation behavior). Resolve `lead` when present.
- **Durability + degradation.** Read-only. No projects -> `[]`. The unavailable
  project category leaves `stateCategory` `undefined`, never a fabricated value.

#### `resolveProject(nameOrId): WorkItemProject[]`

- **Call.** `LINEAR_LIST_LINEAR_PROJECTS`, then case-insensitive fuzzy match on
  name / slug. For an umbrella identifier (a `type/meta` issue key),
  `LINEAR_GET_LINEAR_ISSUE` -> its `project`.
- **Normalize.** Return **all** matches as `WorkItemProject[]` so the caller
  disambiguates: one match means resolved, more than one means ask the human.
  This is the project-addressing primitive for `/flow <project>`.
- **Durability + degradation.** Read-only. No match -> `[]`. No projects -> `[]`
  (the caller falls back to global dispatch).

#### `getProject(id): ProjectDetail`

- **Call.** `LINEAR_GET_LINEAR_PROJECT` + `LINEAR_LIST_LINEAR_ISSUES` (`project_id`
  filter).
- **Normalize.** Return `WorkItemProject & { children: WorkItem[], umbrella?,
progress }`: `children` are the project's issues normalized, `umbrella` is the
  `type: 'meta'` anchor when present, `progress` is `{ done, total, currentStage }`
  (`done` = `completed`-category children; `currentStage` from the umbrella's
  `stage/*` label).
- **Durability + degradation.** Read-only. Missing umbrella omitted; missing
  category `undefined` (project `state` is `null` via Composio); empty project ->
  `children: []`.

#### `getProjectWork(projectId): WorkItem[]`

- **Call.** `LINEAR_LIST_LINEAR_ISSUES` (`project_id` filter), or a
  `LINEAR_RUN_QUERY_OR_MUTATION` read scoped to the project for the full shape in
  one call.
- **Normalize.** `getEligibleWork` scoped to one project: the same full
  normalization (re-namespaced labels, resolved `stateCategory`, relations as
  identifiers) and the same **candidate** breadth (ready + shapeable).
- **Durability + degradation.** Read-only. Same as `getEligibleWork`, including
  the throw-on-unreachable rule.

#### `getEligibleWork(): WorkItem[]`

- **Call.** Prefer one `LINEAR_RUN_QUERY_OR_MUTATION` read requesting
  `state{ name type }`, `labels{ nodes{ name parent{ name } } }`, `estimate`,
  `priority` (resolves category + flattened labels in a single call). The slug
  alternative is `LINEAR_LIST_LINEAR_ISSUES` (response `.data.issues[]`) plus
  per-item `LINEAR_GET_LINEAR_ISSUE` for the category and a
  `LINEAR_LIST_LINEAR_STATES` / `LINEAR_LIST_LINEAR_LABELS` lookup to resolve
  states and re-namespace labels.
- **Normalize.** Fully normalize every item: required fields, re-namespaced
  labels, resolved `stateCategory`, relations as identifiers. Return the
  **candidate** set, broader than "ready": items carrying `agent/ready` **plus**
  dispatchable-category items that lack it, so the loop can tell **done** from
  **starved**. Do **not** pre-filter to `agent/ready` (INV-5): the engine's
  eligibility pass applies that gate.
- **Durability + degradation.** Read-only. `[]` is a real signal; an unreachable
  or erroring tracker **throws**. Per-item partial data degrades per field
  (`undefined` = neutral); a missing relation graph is **no known blockers**
  (neutral), never blocked.

#### `getInbox(): InboxEntry[]`

- **Call.** `LINEAR_LIST_LINEAR_ISSUES` (`assignee_id` = the acting agent) +
  `LINEAR_LIST_COMMENTS` for items touched since the last tick.
- **Normalize.** Return `InboxEntry[]` = the items the agent must look at this
  tick (assigned-to-the-agent + @mentions of the agent + new comments since the
  last tick), each carrying its `WorkItem` and the triggering comment
  `{ author, mentions[], body }` (see the entry shape below).
- **Durability + degradation.** Read-only. Missing mention data degrades to "not
  mentioned" (the quiet-by-default bias keeps this safe); an unreachable tracker
  throws.

#### `getRelations(item): WorkItemRelations`

- **Call.** `LINEAR_GET_LINEAR_ISSUE` (`{"issue_id":"DOR-149"}`).
- **Normalize.** Map to `{ blocks[], blockedBy[], children[], relatedTo[],
duplicateOf? }`, every entry in the **human-key `identifier`** form (for
  example `DOR-2`), never a native node id (INV-3). **Composio-specific:** the
  `relations` field comes back `null` here - the typed graph is not reliably
  populated. Cross-check it with a `LINEAR_RUN_QUERY_OR_MUTATION` read that
  requests `relations{ nodes{ type relatedIssue{ identifier } } }`; if that is
  also unavailable, treat a missing graph as **"no known blockers"** (neutral).
- **Durability + degradation.** Read-only. **Never** parse relations from
  description prose: typed relations only. An incomplete graph degrades to
  neutral, never to "blocked".

### Writes (8) - the single audit surface

#### `claim(item): void`

- **Call.** `LINEAR_UPDATE_ISSUE` adding the `agent/claimed` label **and** setting
  `state_id` to a `started`-category state - label first, then the state move.
- **Durability + degradation.** **Durable and idempotent.** The `agent/claimed`
  label is the durable claim signal (the state machine is labels, not the plan
  field); it must survive a restart. Re-claiming is a no-op. A partial claim
  (label set, state not moved) must leave a state the recovery sweep detects and
  converges; a failed write surfaces loudly. After a crash, any `agent/claimed` +
  `started` + not-`agent/needs-input` item is recoverable as orphaned work.

#### `transition(item, to): void`

- **Call.** `LINEAR_UPDATE_ISSUE` setting the `stage/*` label for `to.stageLabel`
  (replacing the prior `stage/*`) and, when `to.stateCategory` is given,
  `state_id` to a state of that category for the team.
- **Durability + degradation.** **Durable and idempotent.** The `stage/*` label
  and category are projected state; re-applying is a no-op. If the team has no
  state of the target category, set the label and leave the state as-is (never
  fabricate a category). A failed write surfaces loudly.

#### `comment(item, body): void`

- **Call.** `LINEAR_CREATE_LINEAR_COMMENT` with the issue id and body, the body
  carrying the agent identity marker (for example `- 🤖 /flow`).
- **Durability + degradation.** Durable (a posted comment persists). Idempotency
  is best-effort: check recent comments to avoid a duplicate post on retry, since
  a comment is user-visible. A failed post surfaces loudly and is never silently
  dropped (a comment carries `needsInput` and the review handoff).

#### `assignToHuman(item): void`

- **Call.** `LINEAR_UPDATE_ISSUE` setting `assignee_id` to the reviewer /
  authenticated human (triggers a Linear notification).
- **Durability + degradation.** **Durable and idempotent.** Re-assigning to the
  same human is a no-op. If assignment is unavailable, fall back to a comment that
  @mentions the human; if neither is possible, throw.

#### `attachEvidence(item, evidence): void`

- **Call.** `LINEAR_UPDATE_ISSUE` attaching `evidence.links` per
  `evidence.attachTo`.
- **Durability + degradation.** Durable; idempotent (re-attaching the same URL
  deduplicates). Fall back to posting the evidence as a `LINEAR_CREATE_LINEAR_COMMENT`
  when attachments are unavailable. A failed attach surfaces loudly.

#### `needsInput(item, question): void`

The elicitation primitive - **four atomic effects, in order**:

1. `LINEAR_CREATE_LINEAR_COMMENT` posting `question` (multiple-choice when
   possible, carrying the marker).
2. `LINEAR_UPDATE_ISSUE` adding the `agent/needs-input` label.
3. `assignToHuman(item)` (above, via `LINEAR_UPDATE_ISSUE`).
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

- **Call.** `LINEAR_UPDATE_ISSUE` creating a typed relation (`blocks`, `related`,
  `duplicate`, ...) between `a` and `b`; if the update slug cannot express the
  relation, a `LINEAR_RUN_QUERY_OR_MUTATION` `issueRelationCreate` mutation.
- **Durability + degradation.** Durable and idempotent (the relation already
  existing is a no-op). Typed relations live in the graph, **never** in
  description prose (or `getRelations` could not recover them). A failed write
  surfaces loudly.

#### `createSubIssue(parent, spec): WorkItem`

- **Call.** `LINEAR_CREATE_LINEAR_ISSUE` with `parent_id = parent.id`, `title`,
  `description`, the `type/*` label for `spec.type`, and `estimate` for
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
  label written via `LINEAR_UPDATE_ISSUE` survives a restart; an in-memory plan
  does not.
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

- **No `project.stateCategory`** (always the case via Composio - project `state`
  is `null`) -> the project-status dispatch tier is a no-op; items rank on the
  remaining tiers.
- **No `priority`** -> `undefined` (sorts as "none", last in the priority tier),
  never excluded.
- **No `size`** -> `undefined` in the size tier; sub-issue promotion never fires.
- **No relation graph** (the common Composio case, `relations: null`) -> treated
  as "no known blockers" (neutral), never blocked.

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
provably closed), **INV-4** (labels re-namespaced from the flattened Composio
leaves into the generic families), and **INV-5** (the readiness gate is the
literal `agent/ready` label, and `getEligibleWork` / `getProjectWork` return the
broader candidate set, never pre-filtered). It targets contract version `1.0.0`.
