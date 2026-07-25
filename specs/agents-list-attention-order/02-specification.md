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

**Unused payload.** `TopologyAgent` already ships `taskCount`, `lastSeenEvent`, and `relayAdapters`, and the table rendered **none of the three**. It could say an agent was seen 4 minutes ago but not _what it did_, and that it had 2 sessions but not that it had 7 scheduled tasks waiting on it.

Kai runs ten agents across five projects. Opening a filing cabinet is not the answer to "which of these is stuck?" Sort order is, and it is a stronger answer than any column.

## 2. Attention states

Three groups, rendered in this order, each with a header row carrying its count:

| Group       | Header      | Meaning                                      |
| ----------- | ----------- | -------------------------------------------- |
| `needs-you` | `Needs you` | Something is broken or silently failing.     |
| `working`   | `Working`   | In a session, or checked in within the hour. |
| `quiet`     | `Quiet`     | Idle, dormant, or brand new. Nothing to do.  |

`resolveAgentAttention()` in `features/agents-list/lib/agent-attention.ts` is a pure function of four facts — `healthStatus`, `lastSeenAt`, `taskCount`, `sessionCount` — with no React and no clock. The rules, first match wins:

| #   | Rule                                                           | Group       | Severity |
| --- | -------------------------------------------------------------- | ----------- | -------- |
| 1   | `healthStatus === 'unreachable'`                               | `needs-you` | 30       |
| 2   | `stale` **and** `taskCount > 0` **and** has been active before | `needs-you` | 20       |
| 3   | `sessionCount > 0`                                             | `working`   | 20       |
| 4   | `healthStatus === 'active'`                                    | `working`   | 10       |
| 5   | anything else                                                  | `quiet`     | 0        |

**Why rule 1 outranks everything.** An unreachable agent's project folder moved or was deleted. Every session and every scheduled run against it fails, and no other fact about it matters until that is fixed. It wins even when sessions are open, and even when it has never been seen.

**Why `taskCount` alone never promotes (rule 2).** Most agents carry the same handful of schedules for months, so "has scheduled tasks" is exactly the fixed label this change is removing. `taskCount` counts **enabled scheduled tasks** assigned to the agent (`mesh.ts` → `taskStore.getTasks()` filtered on `task.enabled && task.agentId`) — it is not a queue depth, so a non-zero value is not a backlog. It earns attention only paired with silence, where it stops being a static count and becomes _work that is coming due against an agent that has stopped reporting_.

**Why a never-active agent is excluded from rule 2.** A DorkBot created seconds ago in onboarding is `stale` with a `null` last-seen — the same shape a genuinely dormant agent reaches after 24h. Flagging it would make a fresh install look broken, which is the failure `isNeverActive` was written to prevent. It stays `quiet` and reads "Not used yet".

**Why there is no system-agent carve-out.** A DorkBot whose folder is gone breaks exactly as much as any other agent. `isSystem` is not an input to the derivation, and a test asserts the absence.

**Ordering within a group.** Severity descending, then most-recently-active first (never-seen and unparseable timestamps last), then display name ascending. The name tie-break is what makes the order total: without it, two agents in the same state with the same timestamp would swap places on every refetch, which reads as the table twitching.

**The honesty burden.** Same trade as the status bar's promotion rules: a wrong rule here does not merely add clutter, it hides a real problem inside "Quiet". That is why the derivation is pure and separately tested — the layer most likely to be argued about is the cheapest to verify.

## 3. Columns

Seven columns become four.

| Column      | Carries                                                     | Was                                    |
| ----------- | ----------------------------------------------------------- | -------------------------------------- |
| `Agent`     | avatar (health ring), name, default star, project · runtime | Agent + Runtime + Project              |
| `Activity`  | what it last did; when, plus open sessions                  | Last Seen + Sessions                   |
| `Scheduled` | scheduled task count                                        | _new — `taskCount` was never rendered_ |
| _(actions)_ | chat, manage                                                | unchanged                              |

**`Status` is gone as a column.** Health is now carried three ways that all beat a repeated word: the attention group a row sits in, the avatar's health ring, and the Activity cell's wording and tone for the states that are news. The **status filter still works** — filtering never depended on the column.

**The agent description is dropped from the row.** It was already `max-sm:hidden`, so it was never load-bearing, and a static self-description is precisely the wallpaper this change removes. It remains in the Agent Hub and the topology detail panel.

### 3.1 Activity copy

`lastSeenEvent` is a **free-form string**, not an enum. DorkOS writes three values today:

| Raw value           | Written by                                       | Reads as             |
| ------------------- | ------------------------------------------------ | -------------------- |
| `message_sent`      | `message-sender.ts` when a message is dispatched | **Got a message**    |
| `response_complete` | `message-sender.ts` when a turn finishes         | **Finished a reply** |
| `heartbeat`         | `POST /api/mesh/agents/:id/heartbeat` default    | **Checked in**       |

`HeartbeatRequestSchema.event` accepts any string, so the set is open-ended. `humanizeAgentEvent()` therefore has a fallback rather than a lookup miss: any run of punctuation or separators collapses to a single space, the result is sentence-cased, and it is capped at 32 characters with an ellipsis. `tool_error` → "Tool error"; `sync::failed!` → "Sync failed"; a value with no readable characters falls back to "Checked in", because the agent demonstrably did check in and only the label is missing. **No raw value ever reaches a person.**

Two states override the event, because an agent's last action is not the news when its present state is worse:

| State                | Primary             | Secondary                          | Tone               |
| -------------------- | ------------------- | ---------------------------------- | ------------------ |
| `unreachable`        | `Cannot be reached` | `<event> · <when>` or `never seen` | `text-destructive` |
| never active         | `Not used yet`      | open sessions only                 | muted              |
| `active`             | `<event>`           | `<when>` · `N sessions open`       | foreground         |
| `inactive` / `stale` | `<event>`           | `<when>` · `N sessions open`       | muted              |

The relative time and the session count share the second line, so `Sessions` needs no column of its own.

### 3.2 Scheduled

Header **`Scheduled`**, cell `7 tasks` / `1 task` / `—`. The header carries the qualifier the mockup put in the cell ("4 queued"), because these are scheduled task definitions, not a queue — calling them queued would overstate what the number means.

## 4. Sort versus group

Grouped ordering and a user-chosen sort genuinely conflict. **Resolution: the grouping is the default answer, not a cage.**

- `attention` is a first-class entry in the sort menu and the route's default (`sort=attention:asc` in `agentsSearchSchema`, replacing `lastSeen:desc`). Rows group, needs-you first.
- Picking **any other field** — Name, Last seen, Status, Registered — **flattens the groups** and sorts purely by that field. `AgentFleetTable` simply stops receiving `groupBy`.
- The direction arrow on `attention` reverses the whole comparison, so `desc` leads with the quiet fleet. It is a real view, not a broken toggle.

There are **no sortable column headers**, and none are added. This table has never had them; the filter bar's sort menu is the one sort control, and adding a second would create two competing sort states on one surface. The operator's intent ("clicking a column header should flatten the groups") is honoured through the control that actually exists.

`attention` carries no field accessor, because attention is not a field — it is derived from three facts together and applied by `sortAgentsByAttention()`. `agentSortMenuOptions` lists it for display; `agentSortOptions` keeps only the real field sorts.

## 5. Implementation

| File                                     | Change                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `lib/agent-attention.ts`                 | **New.** Groups, severities, comparator, `sortAgentsByAttention`, group header copy.                                     |
| `lib/agent-activity-display.ts`          | **New.** `isNeverActive`, `humanizeAgentEvent`, `agentActivityDisplay`.                                                  |
| `lib/agent-health-display.ts`            | **Deleted.** `agentStatusDisplay` and `lastSeenLabel` died with the Status and Last Seen columns; `isNeverActive` moved. |
| `lib/agent-columns.tsx`                  | Four columns; `IdentityCell` and `ActivityCell`.                                                                         |
| `lib/agent-filter-schema.ts`             | `ATTENTION_SORT_FIELD`, `agentSortMenuOptions`.                                                                          |
| `ui/AgentFleetTable.tsx`                 | **New.** The table half of the page, so the dev playground renders the same component.                                   |
| `ui/AgentsList.tsx`                      | Filter → enrich → order. Filter bar unchanged.                                                                           |
| `shared/ui/data-table.tsx`               | `groupBy`, `tableClassName`, `meta.headClassName` / `meta.cellClassName`.                                                |
| `shared/ui/filter-bar/FilterBarSort.tsx` | `defaultField`, so the trigger names the real default instead of reading "Sort: ".                                       |
| `router.tsx`                             | `/agents` default sort → `attention:asc`.                                                                                |

**Filter → enrich → order,** in that order, because the attention rules read `sessionCount`, which only the enriched row carries. The explicit-sort path stays on the shared `applySortAndFilter`; the attention path filters through the schema and orders after enrichment.

**Grouping is presentational.** `DataTable.groupBy` emits a header wherever the group key changes, so the caller must pass already-grouped rows — which keeps the ordering decision with the code that owns it, and makes flattening a matter of not passing `groupBy`.

## 6. Mobile

`meta.hideOnMobile` drops from three columns to one (`Scheduled`). Two changes make the rest fit at 375px:

- **`table-fixed` with column widths** (`Agent` 42% → 38% at `sm`, `Scheduled` 110px, actions 76px). Auto layout sizes a table to its content, so `truncate` inside a cell has nothing to truncate against — which is why the old table pushed its action buttons off-screen into a horizontal scroll that `touch-action: pan-y` on an ancestor makes hard to reach.
- **`w-full` on the identity button.** Without it the flex container sizes to `max-content` and spills past the fixed cell, overlapping the next column.

Below `sm` the runtime name drops off the identity line (project alone identifies the agent) and the default badge shows its star without the word.

## 7. No ADR (rubric applied)

Checked against the `writing-adrs` significance rubric and concluded **no new ADR**.

It clears "chooses between alternatives" (A over B, and the sort-versus-group resolution) and weakly clears "lasting consequences" (`DataTable.groupBy` is now shared). But it fails the strongest test in the other direction: **single-feature scope**. It changes one page, and the architectural decision it rests on — quiet by default, promotion as a pure testable function, the honesty burden living in the rules — is already accepted as [260725-004456](../../decisions/260725-004456-status-bar-items-are-registry-driven-and-quiet-by-default.md). Writing a second ADR that re-states an accepted one is how a decision log stops being readable.

The one genuinely reusable rule — **a user-chosen sort flattens a default grouping** — is a paragraph, and it lives where a future implementer will actually meet it: [§4](#4-sort-versus-group) and the TSDoc on `DataTable.groupBy`.

## 8. Verification

- `resolveAgentAttention` / `sortAgentsByAttention`: every state, both severity ranks per group, ties (recency then display name), `null` `lastSeenAt`, an unparseable timestamp, zero `taskCount` having no influence at all, a system agent getting no carve-out, an empty fleet, and group contiguity (which the header emission depends on).
- `humanizeAgentEvent`: known events, case and whitespace, unknown identifiers, punctuation, over-long values, unreadable values. `agentActivityDisplay`: every override, plus an exhaustive sweep asserting the primary line is never empty.
- `AgentsList`: group order and headers, flattening under a field sort, the sort trigger naming "Attention", humanized activity with the raw event absent, `Not used yet` for a new agent, identity subtitle, task counts and singular/plural, and the preserved filter bar, empty-filter state, skeleton, star badge, and row actions.
- `DataTable`: no headers without `groupBy`, one header per group with its count, `colSpan` across visible columns, no headers on empty data.
- Browser-verified at 1440px and 375px: all three groups render with counts, the sort trigger reads "Sort: Attention", `?sort=name:asc` flattens, and neither width scrolls horizontally.
