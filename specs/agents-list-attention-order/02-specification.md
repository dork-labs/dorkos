# Specification — Agents list, ordered by attention

- **Work item:** DOR-459
- **Spec id:** 260725-112204
- **Design:** `.dork/visual-companion/25701-1784974088/content/agents-list.html` — **option A (attention-ordered roster)** chosen over B (keep the table, add an attention strip above it)
- **Lens:** the same one as [`specs/composer-status-redesign/04-design-decisions.md`](../composer-status-redesign/04-design-decisions.md) and ADR [260725-004456](../../decisions/260725-004456-status-bar-items-are-registry-driven-and-quiet-by-default.md), applied one page over

## Goal

Make `/agents` answer **"who needs me"** instead of **"who exists."** Rows group into _needs you / working / quiet_ and the derivation lives in one pure, unit-tested function. `Last Seen` becomes `Activity` and says what the agent did, not just when. `taskCount` surfaces. `Runtime` and `Project` demote into the identity cell.

## Non-goals

- The `/agents` topology, denied, and access views. Untouched.
- Sortable column headers. The filter bar's sort menu stays the single sort control (see [§4](#4-sort-versus-group)).
- Any change to the mesh API or `TopologyAgent`. Everything this needs is already in the payload.
- Agent health computation. The server's thresholds (`active` < 1h, `inactive` 1–24h, `stale` > 24h or never, `unreachable` when the folder is gone) are taken as given.

---

## 1. The problem

The table rendered seven columns: Agent, Status, Runtime, Project, Sessions, Last Seen, Actions. It was an alphabetically-ordered inventory. Two failures, both the ones the status-bar redesign named:

**Wallpaper.** `Runtime`, `Project`, and `Status` are near-constant per row. A fleet runs one or two runtimes; each agent's project never changes; most agents sit at the same health for days. Three of seven columns were a fixed label repeated down the page — the same reason a status item that always reads 34% stops registering, which is what makes the 91% invisible too.

**Unused payload.** `TopologyAgent` already ships `taskCount` and `lastSeenEvent`, and the table rendered **neither**. It could say an agent was seen 4 minutes ago but not _what it did_, and nothing at all about the 7 scheduled tasks waiting on it. (`relayAdapters` is also unrendered, and stays that way — which adapters an agent is reachable on is configuration, not news, and it belongs in the Agent Hub next to the switches that set it.)

Kai runs ten agents across five projects. Opening a filing cabinet is not the answer to "which of these is stuck?" Sort order is, and it is a stronger answer than any column.

## 2. Attention states

Three groups, rendered in this order, each with a header row carrying its count:

| Group       | Header      | Meaning                                            |
| ----------- | ----------- | -------------------------------------------------- |
| `needs-you` | `Needs you` | Something is broken, blocked, or silently failing. |
| `working`   | `Working`   | Chats are live, or the agent checked in this hour. |
| `quiet`     | `Quiet`     | Idle, dormant, or brand new. Nothing to do.        |

`resolveAgentAttention()` in `features/agents-list/lib/agent-attention.ts` is a pure function of five facts — `healthStatus`, `lastSeenAt`, `taskCount`, `chatState`, `isPastOnboardingGrace` — with no React and no clock. The rules, first match wins, and rule order matches severity order so the two can never disagree:

| #   | Rule                                                            | Group       | Severity |
| --- | --------------------------------------------------------------- | ----------- | -------- |
| 1   | `healthStatus === 'unreachable'`                                | `needs-you` | 30       |
| 2   | `chatState === 'needs-attention'`                               | `needs-you` | 25       |
| 3   | `stale` **and** `taskCount > 0` **and** `isPastOnboardingGrace` | `needs-you` | 20       |
| 4   | `chatState === 'active'`                                        | `working`   | 20       |
| 5   | `healthStatus === 'active'`                                     | `working`   | 10       |
| 6   | anything else                                                   | `quiet`     | 0        |

**Why rule 1 outranks everything.** An unreachable agent's project folder moved or was deleted. Every session and every scheduled run against it fails, and no other fact about it matters until that is fixed. It wins even when chats are live, and even when it has never been seen.

**Where `chatState` comes from, and why not a count.** `useAgentAttentionMap` in `entities/session` — the app's single source of per-agent "does this need my eyes?" truth (DOR-339). It folds live session lifecycle off the global `/api/events` stream (`streaming` / `pendingApproval` / `error`, matched to agents by exact cwd) with the fleet-wide `agentActivity` recency map from `GET /api/sessions/recent`, which the server computes before its own trim so every agent gets a reading.

The obvious-looking alternative — count the sessions belonging to each agent — is wrong twice, and both ways were shipped in the first cut of this feature before review caught them. `useSessions()` lists only the **selected working directory**, so at most one row in the whole fleet could ever have a non-zero count and rule 4 was structurally dead for every other agent. And a `Session` is a **transcript**: `SessionSchema` carries no live/open field and `selectAgentSessions` filters on `cwd` alone, so the number is a lifetime count. A long-lived project would have read "40 sessions open" and outranked an agent that genuinely checked in minutes ago. A rule that can only ever fire for one row, on a number that does not mean what its label says, is exactly the failure mode [§the honesty burden](#2-attention-states) warns about.

**Why `taskCount` alone never promotes (rule 3).** Most agents carry the same handful of schedules for months, so "has scheduled tasks" is exactly the fixed label this change is removing. `taskCount` counts **enabled scheduled tasks** assigned to the agent (`mesh.ts` → `taskStore.getTasks()` filtered on `task.enabled && task.agentId`) — it is not a queue depth, so a non-zero value is not a backlog. It earns attention only paired with silence, where it stops being a static count and becomes _work that is coming due against an agent that has stopped reporting_.

**Why rule 3 gates on registration age, not on "has been seen before."** A DorkBot created seconds ago in onboarding is `stale` with a `null` last-seen — the same shape a genuinely dormant agent reaches after 24h — and its first scheduled run may not have come due. Flagging it would make a fresh install look broken. But "has never reported" is not the same fact as "was created recently": an agent registered months ago that has never reported while carrying enabled schedules is _precisely_ the quietly-failing case rule 3 exists to catch, and a last-seen gate would bury it in Quiet forever. So the gate is `isPastOnboardingGrace` — registered longer ago than `ONBOARDING_GRACE_MS`, set to 24h to match the server's own `stale` threshold. An agent has to have existed at least as long as the silence window before its silence is a fact about the agent.

`isPastOnboardingGrace()` is the one clock-dependent piece, so it lives beside the rules as its own tested function and is resolved by the caller. That keeps `resolveAgentAttention` clock-free, which is what makes the layer most likely to be argued about the cheapest one to verify.

**Why there is no system-agent carve-out.** A DorkBot whose folder is gone breaks exactly as much as any other agent. `isSystem` is not an input to the derivation, and a test asserts the absence.

**Ordering within a group.** Severity descending, then most-recently-active first (never-seen and unparseable timestamps last), then display name ascending. The name tie-break is what makes the order total: without it, two agents in the same state with the same timestamp would swap places on every refetch, which reads as the table twitching.

**The honesty burden.** Same trade as the status bar's promotion rules: a wrong rule here does not merely add clutter, it hides a real problem inside "Quiet". That is why the derivation is pure and separately tested — the layer most likely to be argued about is the cheapest to verify.

## 3. Columns

Seven columns become four.

| Column      | Carries                                                     | Was                                    |
| ----------- | ----------------------------------------------------------- | -------------------------------------- |
| `Agent`     | avatar (health ring), name, default star, project · runtime | Agent + Runtime + Project              |
| `Activity`  | what it last did, and when                                  | Last Seen + Sessions                   |
| `Scheduled` | scheduled task count                                        | _new — `taskCount` was never rendered_ |
| _(actions)_ | chat, manage                                                | unchanged                              |

**`Status` is gone as a column.** Health is now carried three ways that all beat a repeated word: the attention group a row sits in, the avatar's health ring, and the Activity cell's wording and tone for the states that are news. The **status filter still works** — filtering never depended on the column.

**`Sessions` is gone as a column, and no count replaces it.** The only count this page can reach is a lifetime transcript count for the one folder that happens to be selected ([§2](#2-attention-states)), so there is no honest number to render. Chat state reaches the row instead — through the attention group it sits in, and through the Activity cell when a chat is blocked on you.

**The agent description is dropped from the row.** It was already `max-sm:hidden`, so it was never load-bearing, and a static self-description is precisely the wallpaper this change removes. It remains in the Agent Hub and the topology detail panel.

**It stays a search field even though it left the row,** and that asymmetry is deliberate. `capabilities` has always been searchable with no column of its own, and for the same reason: search is for _finding_ an agent you already have some memory of, and a remembered phrase from a description is a perfectly good handle. Rendering every searchable field would put the wallpaper back. What search must never do is match something a user could not have known — and a self-written description is not that.

### 3.1 Activity copy

`lastSeenEvent` is a **free-form string**, not an enum. DorkOS writes three values today:

| Raw value           | Written by                                       | Reads as             |
| ------------------- | ------------------------------------------------ | -------------------- |
| `message_sent`      | `message-sender.ts` when a message is dispatched | **Got a message**    |
| `response_complete` | `message-sender.ts` when a turn finishes         | **Finished a reply** |
| `heartbeat`         | `POST /api/mesh/agents/:id/heartbeat` default    | **Checked in**       |

`HeartbeatRequestSchema.event` accepts any string, so the set is open-ended. `humanizeAgentEvent()` therefore has a fallback rather than a lookup miss: any run of punctuation or separators collapses to a single space, each word is lowercased **unless it is a short all-caps initialism**, the result is sentence-cased, and it is capped at 32 code points with an ellipsis. `tool_error` → "Tool error"; `sync::failed!` → "Sync failed"; `MCP_tool_call` → "MCP tool call"; `A2A_message` → "A2A message". A value with no readable characters falls back to "Checked in", because the agent demonstrably did check in and only the label is missing. **No raw value ever reaches a person.**

Acronyms are recognised as all-caps runs of 2–5 characters. Beyond that a run is a shouted word rather than an initialism, so `HEARTBEAT_FAILED` reads as "Heartbeat failed". Splitting and truncation both count code points, so a value carrying an astral character can never be cut into a lone surrogate.

Three states override the event, because an agent's last action is not the news when something about its present state is worse:

| State                             | Primary             | Secondary                          | Tone               |
| --------------------------------- | ------------------- | ---------------------------------- | ------------------ |
| `unreachable`                     | `Cannot be reached` | `<event> · <when>` or `never seen` | `text-destructive` |
| `chatState === 'needs-attention'` | `A chat needs you`  | `<event> · <when>`                 | `text-destructive` |
| never active                      | `Not used yet`      | —                                  | muted              |
| `active`                          | `<event>`           | `<when>`                           | foreground         |
| `inactive` / `stale`              | `<event>`           | `<when>`                           | muted              |

`A chat needs you` covers both live blocked states, because `useAgentAttentionMap` folds "waiting on an approval" and "stopped on an error" into one signal and this page cannot tell them apart. It says only what it knows; the chat itself says which.

The never-active row's secondary is empty on purpose: there is no time to report and nothing else the cell can honestly add.

### 3.2 Scheduled

Header **`Scheduled`**, cell `7 tasks` / `1 task` / `—`. The header carries the qualifier the mockup put in the cell ("4 queued"), because these are scheduled task definitions, not a queue — calling them queued would overstate what the number means.

## 4. Sort versus group

Grouped ordering and a user-chosen sort genuinely conflict. **Resolution: the grouping is the default answer, not a cage.**

- `attention` is a first-class entry in the sort menu and the route's default (`sort=attention:asc` in `agentsSearchSchema`, replacing `lastSeen:desc`). Rows group, needs-you first.
- Picking **any other field** — Name, Last seen, Status, Registered — **flattens the groups** and sorts purely by that field. `AgentFleetTable` simply stops receiving `groupBy`.
- The direction arrow on `attention` reverses the whole comparison, so `desc` leads with the quiet fleet. It is a real view, not a broken toggle.

There are **no sortable column headers**, and none are added. This table has never had them; the filter bar's sort menu is the one sort control, and adding a second would create two competing sort states on one surface. The operator's intent ("clicking a column header should flatten the groups") is honoured through the control that actually exists.

`attention` carries no field accessor, because attention is not a field — it is derived from five facts together and applied by `sortAgentsByAttention()`. `agentSortMenuOptions` lists it for display; `agentSortOptions` keeps only the real field sorts.

`FilterBarSort.defaultField` exists so the trigger can name that default instead of rendering "Sort: " with nothing after it. Two other surfaces had the same empty label and are fixed alongside: `/tasks` (which has no `validateSearch` at all, so a fresh visit always arrives with `sort` undefined) now names and applies `TASK_DEFAULT_SORT_FIELD` — soonest `nextRun` first, the useful lead for a page about scheduled work — and the FilterBar playground names and applies `name`. In both cases the list is ordered by the field the trigger claims: a label naming a default the list does not actually use would be the same class of lie as "N sessions open".

## 5. Implementation

| File                                                      | Change                                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `lib/agent-attention.ts`                                  | **New.** Groups, severities, comparator, `sortAgentsByAttention`, `isPastOnboardingGrace`, group header copy.            |
| `lib/agent-activity-display.ts`                           | **New.** `isNeverActive`, `humanizeAgentEvent`, `agentActivityDisplay`.                                                  |
| `lib/agent-health-display.ts`                             | **Deleted.** `agentStatusDisplay` and `lastSeenLabel` died with the Status and Last Seen columns; `isNeverActive` moved. |
| `lib/agent-columns.tsx`                                   | Four columns; `IdentityCell` and `ActivityCell`.                                                                         |
| `lib/agent-filter-schema.ts`                              | `ATTENTION_SORT_FIELD`, `agentSortMenuOptions`.                                                                          |
| `ui/AgentFleetTable.tsx`                                  | **New.** The table half of the page, so the dev playground renders the same component.                                   |
| `ui/AgentsList.tsx`                                       | Filter → enrich → order. Reads `useAgentAttentionMap`. Filter bar unchanged.                                             |
| `shared/ui/data-table.tsx`                                | `groupBy`, `tableClassName`, `meta.headClassName` / `meta.cellClassName`.                                                |
| `shared/ui/filter-bar/FilterBarSort.tsx`                  | `defaultField`, so the trigger names the real default instead of reading "Sort: ".                                       |
| `features/tasks/*`, `dev/showcases/FilterBarShowcase.tsx` | Name and apply their own default sort field — the two surfaces that actually rendered "Sort: " empty.                    |
| `router.tsx`                                              | `/agents` default sort → `attention:asc`.                                                                                |

**Filter → enrich → order,** in that order, because the attention rules read `chatState` and `isPastOnboardingGrace`, which only the enriched row carries. The explicit-sort path stays on the shared `applySortAndFilter`; the attention path filters through the schema and orders after enrichment.

**Grouping is presentational.** `DataTable.groupBy` emits a header wherever the group key changes, so the caller must pass already-grouped rows — which keeps the ordering decision with the code that owns it, and makes flattening a matter of not passing `groupBy`.

## 6. Mobile

`meta.hideOnMobile` drops from three columns to one (`Scheduled`). Two changes make the rest fit at 375px:

- **`table-fixed` with column widths** (`Agent` 42% → 38% at `md`, `Scheduled` 110px, actions 88px). Auto layout sizes a table to its content, so `truncate` inside a cell has nothing to truncate against — which is why the old table pushed its action buttons off-screen into a horizontal scroll that `touch-action: pan-y` on an ancestor makes hard to reach.
- **`w-full` on the identity button.** Without it the flex container sizes to `max-content` and spills past the fixed cell, overlapping the next column.

Under `table-fixed` a column width is the whole budget, cell padding included. The actions column needs 68px of content box for two `size-8` buttons and their 4px gap, plus the 16px `TableHead`/`TableCell` padding takes — so 84px is the exact fit and 88px leaves a little air. At 76px the first button sat 8px outside its content box, flush against the Activity column's border: no horizontal overflow, but no gutter either.

**Everything on this table flips at one breakpoint, `md` (768px)** — the same one `DataTable`'s `meta.hideOnMobile` uses via `useIsMobile()`. Below it the runtime name drops off the identity line (project alone identifies the agent) and the default badge shows its star without the word. These were `sm` (640px) in the first cut, which left a 640–767px band getting the wide identity treatment with the narrow column set. One number, one story: the identity line and the column set now always change together.

## 7. No ADR (rubric applied)

Checked against the `writing-adrs` significance rubric and concluded **no new ADR**.

It clears "chooses between alternatives" (A over B, and the sort-versus-group resolution) and weakly clears "lasting consequences" (`DataTable.groupBy` is now shared). But it fails the strongest test in the other direction: **single-feature scope**. It changes one page, and the architectural decision it rests on — quiet by default, promotion as a pure testable function, the honesty burden living in the rules — is already accepted as [260725-004456](../../decisions/260725-004456-status-bar-items-are-registry-driven-and-quiet-by-default.md). Writing a second ADR that re-states an accepted one is how a decision log stops being readable.

The one genuinely reusable rule — **a user-chosen sort flattens a default grouping** — is a paragraph, and it lives where a future implementer will actually meet it: [§4](#4-sort-versus-group) and the TSDoc on `DataTable.groupBy`.

## 8. Verification

- `resolveAgentAttention` / `sortAgentsByAttention`: every state, every severity rank per group, ties (recency then display name), `null` `lastSeenAt`, an unparseable timestamp, zero `taskCount` having no influence at all, a system agent getting no carve-out, an empty fleet, and group contiguity (which the header emission depends on).
- **Fleet-wide behaviour, with more than one agent** — the property no single-row test could catch: `Working` reaches several agents at once across different folders, and a chat signal never outranks a genuine heartbeat.
- `isPastOnboardingGrace`: moments-old, either side of the 24h boundary, months-old, and an unparseable registration date.
- `humanizeAgentEvent`: known events, case and whitespace, unknown identifiers, punctuation, acronyms (`MCP`, `A2A`, leading and mid-phrase), a long all-caps run getting sentence-cased instead of shouted, over-long values, an astral character at the truncation boundary, unreadable values. `agentActivityDisplay`: every override, no copy claiming an open session at any chat state, no fabricated time, plus an exhaustive sweep asserting the primary line is never empty.
- `AgentsList`: group order and headers, `Working` populated for two agents in two folders, a blocked chat reading `A chat needs you`, the copy never mentioning sessions, the grace rule both ways (a long-registered silent scheduler flagged, a just-registered one not), flattening under a field sort, the sort trigger naming "Attention", humanized activity with the raw event absent, `Not used yet` for a new agent, identity subtitle, task counts and singular/plural, and the preserved filter bar, empty-filter state, skeleton, star badge, and row actions.
- `DataTable`: no headers without `groupBy`, one header per group with its count, `colSpan` across visible columns, no false `scope` on the header cell, no headers on empty data.
- Browser-verified at 1440px and 375px with several registered agents: all groups render with counts, `Working` populated for an agent outside the selected working directory, the action buttons keeping their gutter, the sort trigger reading "Sort: Attention", `?sort=name:asc` flattening, and neither width scrolling horizontally.

### 8.1 Input audit

Every fact `resolveAgentAttention` reads was traced to the code that writes it, after two rounds of a field turning out not to mean what this spec assumed (`taskCount`, then `sessionCount`):

| Input           | Written by                                                                                                                 | Verdict                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `healthStatus`  | `agent-registry.ts` → `computeHealthStatus(lastSeenAt)`; persisted `unreachable` overrides                                 | ✅ `active` <60min, `inactive` 60–1440min, `stale` >1440min **or never** |
| `lastSeenAt`    | `updateHealth()` on a heartbeat POST, `message_sent`, or `response_complete`                                               | ✅ genuinely last activity; `null` only if none ever                     |
| `lastSeenEvent` | same writes; `HeartbeatRequestSchema.event` is `z.string()`, and only claude-code's message-sender writes the two literals | ✅ free-form, as [§3.1](#31-activity-copy) says — never rendered raw     |
| `taskCount`     | `mesh.ts` `enrichTopology` — `task.enabled && task.agentId` matches                                                        | ✅ enabled scheduled task definitions, not a queue depth                 |
| `registeredAt`  | `AgentManifestSchema`, required `z.string().datetime()`, read straight off the row                                         | ✅ always present                                                        |
| `chatState`     | `useAgentAttentionMap` — global event stream + `agentActivity` computed pre-trim                                           | ✅ fleet-wide, and live vs. recency, not a transcript count              |
