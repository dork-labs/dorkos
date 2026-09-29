---
slug: package-schedule-timing
number: 260924-002702
created: 2026-09-24
status: ideation
linear-issue: DOR-2302
project: Marketplace Package Management
---

# Let a person change when a package's schedule runs

**Slug:** package-schedule-timing
**Author:** Claude Code
**Date:** 2026-09-24

---

## 1) Intent & Assumptions

- **Task brief (DOR-2302):** a schedule that came with an installed package can be switched on and off on the Schedules page, but nobody can change when it runs. A `cron` or `timezone` edit is refused with 409 `schedule_package_owned`, and every sync copies the file's cron back onto the row. The only way to change the timing is to edit the package's file, which the next update replaces, and the edit also parks the schedule for approval again. Found while building DOR-2300 (flow's tick cadence).
- **Source design (reviewed in DOR-2300, preserved verbatim in the issue):** nullable override columns on `pulse_schedules`; `TaskSchema.cron`/`timezone` become the EFFECTIVE values, with `defaultCron`/`defaultTimezone` beside them; every cron reader uses the effective value; the approval key stays `[prompt, cron]` with cron meaning the effective value; `landsOnRowAlone` gains `cron` and `timezone`; a trusted edit re-approves in the same act, an agent's edit re-parks; reset puts the override back to null; a package update that changes only the default cron does not re-park an overridden row; the Schedules page shows the effective timing, marks an override and offers "Reset to the package's default".
- **Assumptions:**
  - Only a package-owned schedule ever gets an override. Every other schedule's timing still lives in its own SKILL.md, which DorkOS writes.
  - "Trusted" keeps its existing meaning: the caller cleared the agent bar (`clearsTheAgentBar`, `routes/tasks.ts`). Every MCP call is untrusted.
  - The Schedules page's existing Edit dialog is the entry point for changing timing. No new screen.
- **Out of scope:**
  - Overriding anything else on a package's schedule (prompt, name, permission level). Those still say what the schedule DOES, which is the package's to say.
  - The flow plugin's dials page pointing at the Schedules page for `flow-drain` — that lands in `dork-labs/marketplace` under DOR-2300 once this ships.
  - The agent-facing `scheduling-tasks` operating skill. The tool description carries the new argument; editing the pack means a version bump that collides with every other pack PR in flight.

## 2) Pre-reading Log

- `apps/server/src/services/tasks/task-store.ts`: `upsertFromFile` writes `cron: incomingCron` on both branches (lines 1260, 1338); `updateTask` maps `cron`/`timezone` onto the same columns (352-353); `recordApproval` keys the grant off the raw `cron` column (397-409); `rekeyMigratedFile` (465) and `backfillApprovalGrants` (542) do the same.
- `apps/server/src/services/tasks/file-sync-gates.ts:97-121`: builds `incoming` from the file and `approved` from the raw row, then asks both content gates. `keepsRowEnabled` (158) keeps a package schedule's switch on the row while its approval stands.
- `apps/server/src/services/tasks/schedule-permission-clamp.ts`: `scheduleContentKey` is `[prompt, cron]` (116); `keepsApprovedBypass` (139) and `resolveFileArmStatus` (249) both compare it. `CHANGED_REASON` says "this schedule's file changed".
- `apps/server/src/services/tasks/task-file-update.ts:137-176`: `ROW_ONLY_WHEN_PACKAGE_OWNED = {'enabled'}`; `landsOnRowAlone(changed)`; `fileBackedChanges` compares a request against the Task (so against whatever `mapTaskRow` says `cron` is), and counts `maxRuntime` as changed whenever it is present.
- `apps/server/src/services/tasks/lifecycle/update-task-file.ts:162-210`: the package-owned branch — row-only fields return `{ok: true, changesFile: false}`; anything else answers 409 `schedule_package_owned`.
- `apps/server/src/routes/tasks.ts:381-637`: PATCH — merged-cron validation (402), the bypass clamp (443), the file write, `updateTask`, the status re-assert (493), trusted re-approval gated on `changesFile` (515), registrar sync (522), the approve and park edges (579, 627). `withRunTimes` previews from `task.cron` (297).
- `apps/server/src/services/runtimes/claude-code/mcp-tools/task-tools.ts:505-705`: `tasks_update` — the same sequence for agents, on both MCP servers, and `REAPPROVAL_NOTE` (105).
- `apps/server/src/services/tasks/task-registrar.ts:89` and `task-scheduler-service.ts:677-708`: both read a mapped `Task`, never the raw column.
- `apps/server/src/services/tasks/task-row-mappers.ts:39`: the one place a row becomes a Task.
- `apps/server/src/services/tasks/task-write-policy.ts`: every update field needs a verdict; a drift test holds the table to the schemas.
- `packages/db/src/schema/tasks.ts`, `packages/db/drizzle/`: nullable columns, generated migrations (lefthook `db-migrations` runs `drizzle-kit generate`), per-migration tests in `packages/db/src/__tests__/` built by replaying the journal.
- `apps/client/src/layers/features/tasks/ui/TaskRow.tsx`, `TaskFormInner.tsx`, `task-form-values.ts`: the row prints `task.cron` in words; the edit form sends every field on every save.
- ADRs `260823-200726` (file-discovered schedules never auto-arm, one content key for both gates), `260823-200724` (schedulability is frontmatter), `260725-133221` (approvals bind to the exact action shown).

## 3) Codebase Map

- **Primary components/modules:** `task-store.ts` (persistence + grant), `file-sync-gates.ts` + `schedule-permission-clamp.ts` (the two content gates), `task-file-update.ts` + `lifecycle/update-task-file.ts` (what an edit may write where), `routes/tasks.ts` + `mcp-tools/task-tools.ts` (the two update doors), `task-row-mappers.ts` (row → Task), `features/tasks/ui/*` (the Schedules page).
- **Shared dependencies:** `@dorkos/shared/schemas` (`TaskSchema`, `UpdateTaskRequestSchema`), `@dorkos/db` (`pulseSchedules`), `@dorkos/test-utils` (`createMockTask`).
- **Data flow:** SKILL.md → discovery → `upsertFromFile` (default columns, gates on effective content) → row → `mapTaskRow` (effective `cron`/`timezone`) → registrar/scheduler, the API, the preview. A Schedules-page edit → PATCH → `applyTaskFileUpdate` (package-owned: timing lands on the row) → `updateTask` (override columns) → grant settled → registrar.
- **Feature flags/config:** none.
- **Potential blast radius:** every consumer of `Task` (they read effective values, which is the point), every Task fixture (three new fields), the Schedules edit form's request body (now only changed fields).

## 5) Research

- **Potential solutions:**
  1. **Override columns on the row (the reviewed design).** Pros: the file stays the package's, the person's choice survives updates, every reader keeps reading `cron`. Cons: one more pair of columns, and a gate that must compare effective content everywhere it compares content.
  2. **Write the person's timing into the package's file.** Refused already: the next update replaces it, it is shared by every agent that installed the package, and it re-parks.
  3. **A separate overrides table.** Pros: nothing on `pulse_schedules`. Cons: every read joins; the gates read a second table; a deleted row leaves an orphan. No gain over two nullable columns on the row they describe.
- **Recommendation:** option 1, with the refinements recorded below.

## 6) Decisions

| #   | Decision                                                      | Choice                                                                                                                                                                          | Rationale                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Where the person's timing lives                               | `pulse_schedules.cron_override` + `timezone_override`, nullable TEXT                                                                                                            | The reviewed design. Existing rows read NULL, so nothing moves on upgrade.                                                                                                                                                                                                                                                                          |
| 2   | How readers see it                                            | `mapTaskRow` resolves `cron`/`timezone` to the effective values; raw-row readers (`recordApproval`, the gates, the migration re-key, the grant back-fill) go through one helper | The registrar, the scheduler, the preview, the run system prompt and the approval card all read a mapped Task already, so resolving it in the mapper reaches them all with no per-reader change. The four raw readers are the only ones that can miss it, and they share one function so they cannot disagree.                                      |
| 3   | How the API exposes the default                               | `defaultCron`, `defaultTimezone` (the file's values) and `timingOverridden` (true when the row carries either override)                                                         | The design names the two defaults. The flag is added because "is this overridden" cannot be read off a comparison: the package can later ship the same value the person chose, and the override still stands.                                                                                                                                       |
| 4   | How a reset is asked for                                      | `resetTiming: true` on `UpdateTaskRequest` and `tasks_update`; sent together with `cron` or `timezone` it is refused                                                            | `cron: null` already means "no timer", so it cannot also mean "the package's timer". Refusing the mixed request beats picking an order for two contradictory instructions.                                                                                                                                                                          |
| 5   | A value equal to the package's default                        | Stored as no override                                                                                                                                                           | Choosing the package's own timing is not a custom timing, and the marker should say so.                                                                                                                                                                                                                                                             |
| 6   | Clearing the cron of a package schedule                       | Allowed: an override of `''` means "on demand"                                                                                                                                  | The column distinguishes NULL (no override) from `''`. Refusing it would need its own message for no safety gain; the grant still follows the content.                                                                                                                                                                                              |
| 7   | Where an agent's timing change goes (deviation from design)   | Parked at once, in the same request, with a DorkOS sentence that names what happened                                                                                            | The design leaves it to the next sync. But no file is written, so no watcher fires: the row stays `active` for up to five minutes and the registrar arms the agent's new timing at once — an approved schedule running at a time nobody approved. And when the sync did park it, the card would say "this schedule's file changed", which is false. |
| 8   | A trusted timing change                                       | Re-keys the grant in the same act when the grant covered the old timing                                                                                                         | The design's "re-approves in the same act". Keyed on the grant rather than on `status === 'active'`, so a person changing the timing of a switched-off or paused schedule they approved does not find it parked when it returns.                                                                                                                    |
| 9   | A timing edit that DOES write the file (not package-owned)    | Also clears that field's override                                                                                                                                               | A cron written to the file is the new timing; an override left behind would silently beat it.                                                                                                                                                                                                                                                       |
| 10  | The Schedules edit form (deviation, required for the feature) | Sends only the fields the person changed                                                                                                                                        | It sends every field on every save, and `maxRuntime` counts as a change whenever present, so any edit of a package schedule — timing included — would still answer 409. Sending the diff is also simply correct for a partial update.                                                                                                               |
| 11  | Timezone and approval                                         | Unchanged: timezone is not in the key, so a timezone-only change neither re-keys nor parks                                                                                      | The design, and what a timezone edit on an ordinary file already does.                                                                                                                                                                                                                                                                              |

Recommended next step: SPECIFY — the design is detailed; adapt it into the specification.
