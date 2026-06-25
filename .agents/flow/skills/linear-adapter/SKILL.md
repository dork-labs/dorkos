---
name: linear-adapter
description: The /flow engine's tracker adapter — the single skill that owns EVERY Linear MCP / Composio call and normalizes Linear into the generic WorkItem shape. Use whenever a /flow stage skill or the loop engine needs to read or write the tracker (claim, transition, comment, inbox, relations, evidence, sub-issues). All flow tracker I/O routes through here; no other flow skill or command may touch a tracker string.
---

# Linear Adapter — the v1 `PMClient`

> **What this is.** The `/flow` engine's **work model + tracker adapter**. It is
> the v1 realization of the `PMClient` contract (spec §3): it normalizes Linear
> into one generic `WorkItem` shape and fulfils 13 capability verbs, so every
> generic stage skill and the dispatch policy can work _without ever touching a
> Linear-specific field or a tracker API string_.
>
> **This is a prose contract, not code.** In v1 there is no DorkOS server and
> nothing imports a TypeScript adapter at runtime — the engine is server-free and
> skill-based. The agent _reads this skill and follows it_. The typed
> `interface PMClient` documented in [`../../SPEC.md`](../../SPEC.md) is what the
> **P5 server build** promotes this prose contract into. Building a TS adapter
> class now would be dead code (this repo forbids dead code), so we do not.

## The one rule

**All `/flow` tracker I/O lives here.** No other flow skill or `/flow:*` command
may contain a `mcp__linear__*` / `mcp__plugin_linear_linear__*` string, a
`composio` invocation, or a `LINEAR_*` slug. Generic stage skills call _this_
skill ("via the linear-adapter, claim DOR-123") instead of touching the tracker.
This gives the agnosticism win ("all Linear in one place") and a single audit
surface for every tracker write (spec §Security). An executable grep guard
(`packages/flow/src/__tests__/tracker-confinement.test.ts`) enforces this for the
flow bundle.

The P5 server build swaps this skill for a typed `PMClient`; a second adapter
(Jira / GitHub Issues) proves the agnosticism. Because the generic layer only
ever speaks `WorkItem` + the 13 verbs, that swap is additive, not a rewrite.

---

## Accessing Linear (primary + fallback)

Two interchangeable access paths reach the **same** workspace and DorkOS team
(team key `DOR`, slug `dorkos`). The adapter is the only place either appears.

1. **Linear MCP tools (primary).** The in-session MCP server. Tool names are
   `mcp__plugin_linear_linear__*` (e.g. `list_issues`, `save_issue`,
   `save_comment`, `get_authenticated_user`). Requires the MCP server to be
   authenticated (OAuth); if it is not, start the flow with
   `mcp__linear__authenticate`. Spec/prose shorthand for the family is
   `mcp__linear__*`.
2. **Composio CLI (fallback).** Works even when the MCP server is
   unauthenticated (see the `composio-cli` skill). Linear slugs are `LINEAR_*`.
   **Two Linear accounts are connected in Composio — always pass
   `--account personal`** (the DorkOS + Dunny workspace). The other account,
   `artblocks`, is unrelated work and must **never** receive DorkOS issues.

   ```bash
   composio execute LINEAR_LIST_LINEAR_TEAMS    --account personal -d '{}'
   composio execute LINEAR_LIST_LINEAR_PROJECTS --account personal -d '{}'
   # Discover other slugs by intent:
   composio search "list linear issues" "create a linear issue" --toolkits linear
   ```

**Query hygiene** (applies to every read):

- **MCP only:** always pass `includeArchived: false` on `list_issues` — Linear
  defaults to `true`, pulling archived noise from deleted projects. The Composio
  `LINEAR_LIST_LINEAR_ISSUES` has **no** `include_archived` param (see the
  schema gotcha below); passing it errors on a paginated call.
- Do **not** pass `includeMembers: true` on `list_projects` — it triggers
  GraphQL query-complexity errors. Fetch member/lead detail separately.

### Composio CLI — verified schemas, response shapes & gotchas

The Composio fallback diverges from the MCP transport in ways that bite silently.
These are empirically verified against `composio` v0.2.31 and the live DorkOS
workspace; trust them over a slug's `--get-schema` guess when they conflict.

- **Prefer one GraphQL read over the field-poor list slug.**
  `LINEAR_RUN_QUERY_OR_MUTATION` is the richest read path and resolves the two
  worst traps below (missing category, flattened labels) in a single call —
  request `state{ name type }` for the category and `labels{ nodes{ name parent{
name } } }` to recover the namespace (reconstruct `agent/ready` as
  `parent.name + "/" + name`; `ready`→`parent:agent`, `research`→`parent:type`).
  It also returns `estimate` (size) and `priority`, and accepts a label filter
  (`issues(filter:{ labels:{ name:{ eq:"ready" } } })`). The result nests under
  `.data.data.team` (note the **double** `data`). Reach for the per-verb slugs
  below for writes and simple lookups; reach for GraphQL when you need the full
  dispatch-ready shape.

- **Slugs are doubly-prefixed; there is no `LINEAR_GET_ISSUE`.** The verbs are
  `LINEAR_LIST_LINEAR_ISSUES`, `LINEAR_GET_LINEAR_ISSUE`,
  `LINEAR_LIST_LINEAR_PROJECTS`, `LINEAR_GET_LINEAR_PROJECT`,
  `LINEAR_LIST_LINEAR_TEAMS`, `LINEAR_LIST_LINEAR_LABELS`,
  `LINEAR_LIST_LINEAR_STATES`. The un-doubled `LINEAR_GET_ISSUE` does **not**
  exist (`ToolRouterV2_ToolNotFound`). When a slug 404s, rediscover it with
  `composio search "<intent>" --toolkits linear`.
- **`LINEAR_GET_LINEAR_ISSUE` takes the human identifier** — `-d '{"issue_id":"DOR-149"}'`,
  no UUID needed. It returns the fields the LIST call omits: `state.type` (the
  category), `estimate` (the `size`), `priority`, `labels.nodes`, `project`,
  `parent`. **Caveat:** its `relations` field comes back `null` via Composio — the
  typed `blocks/blockedBy` graph that feeds dispatch eligibility is **not**
  reliably populated. Treat a missing graph as "no known blockers" (neutral), and
  cross-check the dependency graph another way before trusting it.
- **`LINEAR_LIST_LINEAR_ISSUES` has a tiny filter schema — no team filter.**
  Allowed top-level keys are only `after, first, project_id, assignee_id,
original_cursor, include_transitions, cursor_was_corrupted`. There is **no
  `team_id`** (passing it is silently dropped on the first call and hard-errors on
  a paginated one) and **no `include_archived`**. Scope to a project with
  `project_id`; there is no team scoping, but the `personal` account's workspace
  is effectively DorkOS-only, so the unfiltered list is already team-correct (the
  `--account personal` guard is what keeps `artblocks` out, not a filter).
- **Response shapes:** list → `.data.issues[]` + `.data.page_info{ hasNextPage,
endCursor }` (**not** `.data.items`); get → `.data.issue`; projects →
  `.data.projects[]`; teams → `.data.teams[]`. DorkOS `team_id` is
  `a171dbd5-3ccc-40ab-b58b-1fae7644fba8`.
- **Large reads spill to a file.** A big result returns `{ successful: true,
storedInFile: true, outputFilePath, tokenCount }` with **no inline data** — read
  `outputFilePath` with `jq` (don't slurp it into context). Paginate by passing
  `{ first, after: <endCursor> }` and **only** those keys (adding any filter key
  to an `after` call trips schema validation).
- **Labels arrive FLATTENED to leaf names.** A grouped Linear label surfaces on
  the issue as its bare leaf: `ready` (not `agent/ready`), `claimed`/`completed`/
  `needs-input` (not `agent/*`), `verify`/`ideate` (not `stage/*`),
  `task`/`research`/`idea`/`meta` (not `type/*`). The group prefix is a separate
  parent label that is **not** present on `labels.nodes`. This is a real
  normalization trap: the dispatch policy matches the literal `agent/ready`
  (`@dorkos/flow` `AGENT_READY_LABEL`), so a raw Composio `ready` will **silently
  fail eligibility**. The adapter MUST re-namespace leaf → group before handing
  `labels[]` to the policy. Recover the group↔leaf map from
  `LINEAR_LIST_LINEAR_LABELS` (team-scoped; distinguishes container vs leaf
  labels).
- **The category (`state.type`) is absent from the LIST call.** A listed issue's
  `state` is `{ name }` only — no `type`. Since the generic layer matches on
  category, resolve it via `LINEAR_GET_LINEAR_ISSUE` per item, or once via
  `LINEAR_LIST_LINEAR_STATES` (a team-scoped `name → type` map). A `triage`-type
  state is real here (see the category table's † note).
- **Project `state` is `null` via Composio.** `LINEAR_LIST_LINEAR_PROJECTS`
  returns `{ id, name, state: null }` — the project workflow-state category is not
  populated, so the dead-project dispatch tier degrades to a no-op (the documented
  graceful-degradation behavior; here it is always neutral).

---

## The `WorkItem` normalization shape

Every read verb returns work normalized into this shape, so the generic layer
never sees a Linear field name. The adapter's job is the mapping in the third
column.

```
WorkItem {
  id,              // tracker-native id (Linear node id)
  identifier,      // human key, e.g. "DOR-123" — the worktree/branch key
  title,
  description,
  type,            // idea|research|hypothesis|task|monitor|signal|meta
  stateCategory,   // backlog|unstarted|started|completed|canceled
                   //   MATCHED ON CATEGORY, NEVER ON DISPLAY NAME (see below)
  stateName,       // display only ("In Progress", "Triage", …) — never matched on
  priority,        // 0–4  (0 none · 1 urgent · 2 high · 3 medium · 4 low)
  size,            // points / t-shirt — drives sub-issue promotion + ranking
  project,         // { id, name, stateCategory, lead }
  parent,          // parent WorkItem id (sub-issue) or null
  relations {      // the dependency graph — read from typed Linear relations
    blocks[],      // items THIS blocks
    blockedBy[],   // items that block THIS  (feeds dispatch eligibility)
    children[],    // sub-issues
    relatedTo[],
    duplicateOf?,
  },
  labels[],        // ALL labels, including stage/* and agent/*
  assignee,        // → classifyOwnership(): mine|reviewer|other|unassigned
  agentDisposition // ready|claimed|completed|needs-input  (derived from agent/* labels)
}
```

### `stateCategory` is matched on CATEGORY, never on display name

Linear workflow states each belong to one of five **categories**:
`backlog · unstarted · started · completed · canceled`. The display **name** is
team-customizable ("Triage", "In Progress", "Shipped", …) and varies per team —
matching on it is brittle and breaks the moment a team renames a state. The
generic layer therefore branches **only** on `stateCategory`; `stateName` is
carried for display only. The adapter resolves a state to its category via
`list_issue_statuses` (each status carries its `type`/category) and maps:

| Linear state `type` | `stateCategory` |
| ------------------- | --------------- |
| `triage`            | `backlog` †     |
| `backlog`           | `backlog`       |
| `unstarted`         | `unstarted`     |
| `started`           | `started`       |
| `completed`         | `completed`     |
| `canceled`          | `canceled`      |

† Linear's **Triage** feature adds a sixth state `type`, `triage`, beyond the
five `StateCategorySchema` values. It is the un-triaged holding state (an item
that has not yet been classified or routed). Normalize it to `backlog` —
non-terminal, so it lists and recovers like any open item — but note it is kept
**out of dispatch by the absent `agent/ready` label, not by its category**: an
un-triaged item carries no `agent/*` label, so `filterEligible` drops it
regardless. The TRIAGE stage is what moves it into a true `backlog`/`unstarted`
state _and_ applies `agent/ready`. Never fabricate a distinct `triage` category —
the typed enum has only five values.

### `type`, `agentDisposition`, `priority`, `size` mappings

- **`type`** ← the `type/*` label group (idea, research, hypothesis, task,
  monitor, signal, meta). Mutually exclusive — exactly one per issue.
- **`agentDisposition`** ← the `agent/*` label group: `agent/ready` → `ready`,
  `agent/claimed` → `claimed`, `agent/completed` → `completed`,
  `agent/needs-input` → `needs-input`. **The `agent/*` labels are the durable
  state machine** (spec §3, the Huginn durability lesson) — _not_ the ephemeral
  `plan`/checklist field, which does not survive a restart.
- **`priority`** ← Linear's native priority field (`0` none, `1` urgent, `2`
  high, `3` medium, `4` low). Native field, never a `priority/*` label.
- **`size`** ← Linear's native estimate field (Fibonacci points). Native field,
  never a label. Drives sub-issue promotion (`size ≥ decomposition.subIssueThreshold`)
  and the dispatch size tier.

---

## Presenting a work item to a human

Every `WorkItem` this adapter returns carries `title` alongside `identifier`, so
the title is always in hand with no extra fetch. **Never surface a bare tracker
key to a human reader.** Whenever a stage skill, a `/flow` command, or the loop
reports a work item to a person (terminal output, a status line, a report, an
`AskUserQuestion` option, a PR or commit body), render the identifier followed by
the title:

```
DOR-157 - Connect Claude Code account
```

- **Order + separator.** Identifier first, then a space-hyphen-space, then the
  title. The hyphen keeps the line readable when the title itself contains a
  colon (`DOR-149 - Harness portability: dry-run loop`). If a title is long or
  unwieldy, a 3-6 word summary may stand in for it, but the bare `DOR-157` alone
  is never acceptable.
- **Link the identifier, not the title.** Where the surface supports a link, the
  identifier is the anchor and the title stays plain text, so variable title
  punctuation can never break link parsing. The structure is identical on every
  surface; only the link syntax adapts:
  - Markdown and Obsidian: `[DOR-157](<issue-url>) - Title` (a standard link,
    never an Obsidian `[[wikilink]]`, since the target is an external tracker URL).
  - HTML: `<a href="<issue-url>">DOR-157</a> - Title`.
  - Slack mrkdwn: `<<issue-url>|DOR-157> - Title`.
  - Auto-linking surfaces (Linear, GitHub, Slack with the Linear app): the bare
    `DOR-157 - Title` already links the key, so do not double-link.
- **Tracker comments are exempt.** Comments this adapter posts live inside the
  tracker, whose own UI already shows the title, so pairing there is redundant.
  This convention governs agent-to-human surfaces _outside_ the tracker.

---

## The 13 capability verbs

Each verb is mapped to its concrete Linear MCP call (primary) and Composio
fallback. The generic layer only ever names these verbs; the adapter owns the
call.

### Reads

| Verb                            | What it returns                                                                                                                                                                                                           | Linear MCP (primary)                                                                       | Composio fallback (`--account personal`)                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| **`getCurrentUser()`**          | the authenticated account (resolves `identity.agent: "auto"`, drives `classifyOwnership`)                                                                                                                                 | `mcp__plugin_linear_linear__get_authenticated_user`                                        | `LINEAR_GET_AUTHENTICATED_USER`                                                           |
| **`getProjects()`**             | projects normalized to `{ id, name, stateCategory, lead }`                                                                                                                                                                | `mcp__plugin_linear_linear__list_projects` (no `includeMembers`)                           | `LINEAR_LIST_LINEAR_PROJECTS`                                                             |
| **`resolveProject(nameOrId)`**  | one `WorkItemProject` for a fuzzy name / spec slug / umbrella identifier (case-insensitive). Returns ALL matches when more than one, so the caller disambiguates. The project-addressing primitive for `/flow <project>`. | `list_projects` then match on name; resolve an umbrella id via `get_issue` → its `project` | `LINEAR_LIST_LINEAR_PROJECTS` then match (+ `LINEAR_GET_LINEAR_ISSUE` for an umbrella id) |
| **`getProject(id)`**            | one project with its `children[]` (project issues), its umbrella issue (the `type/meta` anchor), and a progress rollup (`done`/`total`, current stage).                                                                   | `list_projects` (the one) + `list_issues` (project filter, `includeArchived: false`)       | `LINEAR_GET_LINEAR_PROJECT` + `LINEAR_LIST_LINEAR_ISSUES` (project filter)                |
| **`getProjectWork(projectId)`** | `getEligibleWork` **scoped to one project**: the candidate `WorkItem[]` for project-scoped dispatch (same normalization + graceful-degradation rules as `getEligibleWork`).                                               | `list_issues` (project filter, `includeArchived: false`)                                   | `LINEAR_LIST_LINEAR_ISSUES` (project filter)                                              |
| **`getEligibleWork()`**         | `WorkItem[]` of candidate work for the dispatch policy (issues for the DOR team, `includeArchived: false`)                                                                                                                | `mcp__plugin_linear_linear__list_issues`                                                   | `LINEAR_LIST_LINEAR_ISSUES`                                                               |
| **`getInbox(agent)`**           | the agent's inbox (see shape below) — assigned-to-me + @mentions + new comments since the last tick                                                                                                                       | `list_issues` (assignee filter) + `mcp__plugin_linear_linear__list_comments`               | `LINEAR_LIST_LINEAR_ISSUES` + `LINEAR_LIST_COMMENTS`                                      |
| **`getRelations(item)`**        | the typed relation graph (`blocks/blockedBy/children/relatedTo/duplicateOf`) for a single item                                                                                                                            | `mcp__plugin_linear_linear__get_issue` (returns relations)                                 | `LINEAR_GET_LINEAR_ISSUE`                                                                 |

### Writes (all confined here; the single audit surface)

| Verb                                 | Durable effect                                                                                                                                                                                                                                                                                        | Linear MCP (primary)                                           | Composio fallback (`--account personal`)               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------ |
| **`claim(item)`**                    | Writes the `agent/claimed` **label** AND moves state into a `started`-category state — both, in that order, so the claim survives a restart. The label is the durable claim signal (state machine = labels, not the plan field).                                                                      | `mcp__plugin_linear_linear__save_issue` (set labels + stateId) | `LINEAR_UPDATE_ISSUE`                                  |
| **`transition(item, stage)`**        | Sets the stage's `stage/*` label and, when the stage carries one, its `stateCategory` (resolved to a concrete state of that category for the team). Drives the stage→projection round-trip.                                                                                                           | `save_issue` (labels + stateId)                                | `LINEAR_UPDATE_ISSUE`                                  |
| **`comment(item, body)`**            | Posts a comment. The agent's own comments carry `identity.marker` (`— 🤖 /flow`) so the comment-response rules can recognize them in shared-account mode.                                                                                                                                             | `mcp__plugin_linear_linear__save_comment`                      | `LINEAR_CREATE_LINEAR_COMMENT`                         |
| **`assignToHuman(item)`**            | Sets the issue assignee to the reviewer / authenticated human (triggers a Linear notification). Used at the review gate and in handoff.                                                                                                                                                               | `save_issue` (assigneeId)                                      | `LINEAR_UPDATE_ISSUE`                                  |
| **`attachEvidence(item, evidence)`** | Attaches proof-of-completion (browser recording, test summary, PR link) to the issue via its external URLs / attachment links per `evidence.attachTo`.                                                                                                                                                | `save_issue` (links/attachments)                               | `LINEAR_UPDATE_ISSUE`                                  |
| **`needsInput(item, question)`**     | The elicitation primitive — **four atomic effects**: (1) post the question as a `comment` (multiple-choice when possible, carrying the marker); (2) apply the `agent/needs-input` label; (3) `assignToHuman`; (4) **stop** (the loop parks here). Resumes only on a non-agent reply (see `getInbox`). | `save_comment` + `save_issue` (label + assignee)               | `LINEAR_CREATE_LINEAR_COMMENT` + `LINEAR_UPDATE_ISSUE` |
| **`link(a, b, type)`**               | Creates a typed relation (`blocks`, `related`, `duplicate`, …) between two items. Typed relations live in the graph, never in description prose.                                                                                                                                                      | `save_issue` (relation)                                        | `LINEAR_UPDATE_ISSUE`                                  |
| **`createSubIssue(parent, spec)`**   | Creates a child issue under `parent` (sub-issue promotion: fires only when `size ≥ decomposition.subIssueThreshold`, default `"xl"`). The new issue's canonical home is the per-task `issue` field in `03-tasks.json`.                                                                                | `mcp__plugin_linear_linear__save_issue` (parentId set)         | `LINEAR_CREATE_LINEAR_ISSUE`                           |

> Slugs shown in the Composio column follow the `LINEAR_*` convention; confirm
> the exact slug with `composio search "<intent>" --toolkits linear` if a call
> errors — Composio occasionally revises slug names. `LIST_LINEAR_TEAMS` and
> `LIST_LINEAR_PROJECTS` are confirmed in use today.

---

## `getInbox` shape

`getInbox(agent)` returns the items the agent must look at this tick:
assigned-to-me + @mentions + new comments since the last tick. Each carries the
triggering comment so the comment-response rules (spec §5) can decide whether to
act:

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

The comment-response rules that consume this (implemented in P2/P3, listed here
because the inbox shape exists to serve them):

1. **Never answer its own comments** — `author == identity.agent`, or the body
   carries `identity.marker`. In shared-account mode the marker is the _only_
   signal. Breaks self-reply loops.
2. **Always respond when directly addressed** — an @mention of the agent's
   account, or (shared mode) an explicit `/flow` / `@flow` token in the body.
   This overrides ownership, even on a teammate's issue.
3. **Resume when an `agent/needs-input` item gets a non-agent comment** — that
   reply is the answer the agent parked for via `needsInput`.
4. **Stay out of `other`-owned threads unless mentioned.**
5. **Soft zone leans quiet** (`comments.ambiguousBias: "quiet"`) —
   over-responding is the worse failure; silence is the safe default.

`classifyOwnership(item)` (built in P3, spec §7) consumes the `assignee`/
`project.lead` this adapter normalizes, compared against `identity.agent` /
`identity.reviewer`, to label each item `mine | reviewer | other | unassigned`.
The adapter supplies the raw `assignee`; it does not itself classify.

---

## Durability rules (the state machine)

- **The state machine is the `agent/*` labels**, not the ephemeral plan/checklist
  field. A label written via `save_issue` survives a process restart; an
  in-memory plan does not (Huginn durability lesson, spec §3).
- **`claim` is durable and atomic-in-intent**: it writes the `agent/claimed`
  label **and** moves the issue into a `started`-category state. After a crash,
  any `agent/claimed` + `started` + not-`agent/needs-input` item is recoverable
  as orphaned work (the P3 recovery ladder relies on exactly this).
- **`needsInput` parks durably**: label `agent/needs-input` + comment + assign to
  human + stop. "Parked on a human" is a distinct, durable state the stall sweep
  must never reclaim — it resumes only on the human's reply, surfaced by
  `getInbox`.
- **Answers become memory**: resolutions the agent receives are written where the
  next decision's evidence-test will find them (decisions table / ADR /
  `config.json`) — not in a separate store. The adapter writes the tracker side
  (the comment + label change); the durable answer lives in the repo artifact.

---

## Graceful degradation (other trackers)

The `WorkItem` shape is the generic contract; a non-Linear tracker supplies what
it has and the dispatch policy treats anything missing as **neutral** (spec §3,
§4). Documented here so a future Jira / GitHub-Issues adapter (P5) follows the
same contract:

- **No `project.stateCategory`** (e.g. GitHub Issues has no projects with
  workflow categories) → the project-status dispatch tier is a no-op; items rank
  on the remaining tiers.
- **No `priority`** → treated as neutral (sorts as "none", i.e. last in the
  priority tier) rather than excluded.
- **No `size`** → treated as neutral in the size tier; sub-issue promotion simply
  never fires (no size to exceed the threshold).
- **No native estimate/points** → `size` is `undefined`, not `0`; "neutral" must
  never be confused with "smallest".

The adapter populates every field it _can_ from the underlying tracker and leaves
the rest `undefined`; it never fabricates a value to satisfy the shape.

---

## Promotion path (P5)

This prose contract is the **promotion surface**. The P5 server-side Flow Engine
— Extension promotes it into a typed `interface PMClient` (documented in
[`../../SPEC.md`](../../SPEC.md)) with the same 13 verbs and the same `WorkItem`
shape, backed by the Linear Agent Accounts API and a webhook relay instead of
in-session MCP calls. A second adapter (Jira / GitHub Issues) proves the
agnosticism. Because the generic layer speaks only `WorkItem` + verbs, the swap
is additive — this skill is the seam.
