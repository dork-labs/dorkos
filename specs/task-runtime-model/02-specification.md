# Specification: per-task runtime, model, and effort

**Spec:** task-runtime-model (260828-002928) · **Tracker:** DOR-1615, DOR-1347 (folded), DOR-1614 (PR3)
**Status:** specified · **Date:** 2026-08-28

Line numbers below are hints from a 2026-08-27 survey, not contracts — verify
against the live file before editing. The settled decisions in `01-ideation.md`
§2 are contracts.

## PR1 — server core (DOR-1615 + DOR-1347)

### 1. Schema, both sides of the drift guard

- `packages/skills/src/schedule-schema.ts` — `ScheduleBlockSchema` gains
  `runtime` (optional string; validate against the three execution runtimes
  `claude-code|codex|opencode` loosely — accept unknown strings with `.catch`
  degradation matching the block's existing style, since registration is a
  runtime question, not a parse question), `model` (optional non-empty string),
  `effort` (optional; reuse the shared effort enum). `scheduleToFrontmatter`
  must write all three (omit when absent). Round-trip tests.
- `packages/shared/src/schemas.ts` — `TaskSchema`, `CreateTaskRequestSchema`,
  `UpdateTaskRequestSchema` gain the same three optional fields (update accepts
  `null` to clear, matching its existing convention if one exists — verify).
- `packages/skills/src/__tests__/task-request-drift.test.ts` — extend so the
  agreement holds WITH the new fields (this test failing means one side was
  missed).

### 2. Persistence

- `packages/db/src/schema/tasks.ts` — `pulse_schedules` gains `runtime`,
  `model`, `effort` (nullable text) + migration. `pulse_runs` gains
  `resolved_runtime`, `resolved_model` (nullable text) + migration — the run
  records what actually ran.
- `apps/server/src/services/tasks/task-row-mappers.ts` — map all new columns.
- `apps/server/src/services/tasks/task-store.ts` `upsertFromFile` — carry the
  three fields file→row on both insert and update branches.
- `apps/server/src/services/tasks/task-file-update.ts` — `SCHEDULE_FIELD` map
  gains `runtime→runtime`, `model→model`, `effort→effort`;
  `FILE_BACKED_COLUMN`/`touchesFile` updated so an API write rewrites the file.
- `apps/server/src/services/tasks/skills-root-discovery.ts` — the block travels
  whole; verify nothing drops the new keys.

### 3. Resolution + execution (direct path)

- New module `apps/server/src/services/tasks/resolve-run-execution.ts` (name
  flexible): given a task, return `{ runtimeType, runtime, settings: {model?,
effort?} }` by the ladder in `01-ideation.md` §2.4. Compose from
  `runtimeRegistry` + `readAgentExecutionDefaults` /
  `resolveUnattendedSessionDefaults`
  (`apps/server/src/services/session/resolve-session-defaults.ts`) + the skill
  file's top-level `model`/`effort` (claude-code tier only). Unit-test every
  tier and the cross-runtime model-drop rule.
- `apps/server/src/services/tasks/task-scheduler-service.ts` — the service
  takes the registry (or the resolver) instead of one `agentManager`.
  `SchedulerAgentManager` port widens to accept `model`/`effort` in both
  `ensureSession` and `sendMessage` opts (or is replaced by resolving an
  `AgentRuntime` per run — prefer whichever keeps the port test-fake story in
  `@dorkos/test-utils` intact). `executeRunDirect` passes the resolved
  settings. Unregistered/disabled runtime → run fails with a clear error
  message naming the runtime; test this.
- Sticky sessions (`session/sticky-session.ts` seam): when the resolved runtime
  differs from the previous session's runtime
  (`runtimeRegistry.getSessionRuntimeType`), do not resume — mint a fresh
  session id. Test.
- `apps/server/src/services/tasks/scheduled-run-power.ts` — `TASK_RUNTIME`
  constant replaced by the per-task resolved runtime (the trust-stop → mode
  mapping uses that runtime's capability profile).
- Stamp `resolved_runtime`/`resolved_model` onto the run row at dispatch.
- `apps/server/src/index.ts` — scheduler wiring: hand it the registry;
  `schedulerAgentManager` boot binding goes away or becomes the registry
  default. Test-mode behavior preserved (test-mode runtime registered as
  default there).

### 4. Relay dispatch parity (claude-code leg only, v1)

- Routing rule in `executeRun`: `viaRelay` only when the resolved runtime is
  claude-code (and relay enabled); otherwise direct. Comment points at
  DOR-1614.
- `packages/shared/src/relay-envelope-schemas.ts` `TaskDispatchPayloadSchema` +
  `apps/server/src/services/tasks/relay-dispatch.ts` payload gain
  `model?`/`effort?`; `packages/relay/src/adapters/claude-code/task-handler.ts`
  spreads them into `ensureSession`/`sendMessage` (mirror how
  `agent-handler.ts` spreads `executionSettings`). Conformance/relay tests.

> **Handshake with PR3 (DOR-1614), which landed first.** PR3 shipped the
> receiving half and deliberately built no task-runtime resolution, so two lines
> are PR1's to close and nothing else in the repo will fail without them:
>
> 1. **`apps/server/src/services/tasks/relay-dispatch.ts` must set
>    `payload.runtime`** to the runtime the scheduler resolved for the task.
>    `TaskDispatchPayloadSchema` already carries the optional field, and
>    `ClaudeCodeAdapter` already routes on it; absent, every dispatch keeps
>    running on the relay's default runtime.
> 2. **Widen the `viaRelay` guard** above from "resolved runtime is claude-code"
>    to "resolved runtime is present in the relay adapter map" — the map the
>    composition root now fills from `runtimeRegistry.listRuntimes()`. A runtime
>    the relay does not hold is refused by name at the adapter, so the guard is
>    what keeps such a task on the direct path instead.

### 5. Doors: MCP + CLI

- `apps/server/src/services/runtimes/claude-code/mcp-tools/task-tools.ts` (and
  the external `/mcp` twin registered from the same definitions) —
  `tasks_create`/`tasks_update` gain `runtime`, `model`, `effort`.
  `permissionMode`/`status` refusals unchanged.
- `packages/cli/src/commands/task.ts` — `create` gains `--runtime`, `--model`,
  `--effort`.
- Route handlers (`apps/server/src/routes/tasks.ts` +
  `services/tasks/lifecycle/create-task.ts`) pass the fields through.

### 6. Changelog

feat fragment (user-facing): scheduled tasks can pick which agent runtime and
model they run on. Plain language per `writing-for-humans`.

## PR2 — client UI + docs + operating skill (after PR1 merges)

- `TaskFormInner.tsx`: `TASK_RUNTIME` constant removed. Runtime select
  (options: "Agent's runtime (<name>)" default + the registered primary
  runtimes) and model select ("Agent default" + `useModels({runtime})`), effort
  where the runtime supports it (`RuntimeSettingsCapability.supportsEffort`).
  Trust dial capabilities keyed off the selected (or agent-derived) runtime.
  Mismatch warning chip via the existing `use-execution-exceptions` pattern.
- `TaskRow.tsx`: override chip (runtime icon + model) only when the task sets
  either. `TaskRunHistoryPanel.tsx`: show resolved runtime/model per run.
- `packages/operating-skills/src/skills/scheduling-tasks.ts`: document the new
  fields + bump `OPERATING_SKILLS_VERSION` in `pack.ts`.
- `docs/guides/task-scheduler.mdx`: field table gains the three keys, with the
  runtime-id-space explanation and the "unset = agent default" rule. Note the
  marketplace shape declaration does not carry them yet.
- Changelog: covered by PR1's fragment or its own — whichever the fragment gate
  requires.

## PR3 — relay multi-runtime (DOR-1614, parallel with PR1)

- Codex + OpenCode `RuntimeAdapter` subclasses under
  `packages/relay/src/adapters/` on the existing abstract base — thin: SDK
  calls, event shapes, teardown. The base owns queueing/streaming/retry.
  Follow the claude-code subclass as the reference; the relay conformance
  suites must pass for each.
- `apps/server/src/index.ts`: adapter-manager map gets every registered-and-
  enabled runtime, not one.
- `resolveSessionCreatorRuntime` (`binding-subsystem.ts`): chat-originated
  sessions resolve the TARGET AGENT's manifest runtime (via
  `runtimeRegistry.resolveForAgent` semantics) instead of single-runtime
  fallback; keep the honest log line for genuinely unregistered runtimes.
- `createTurnExecutionSettingsResolver` call sites keyed by resolved runtime.
- Relay task dispatch: with adapters present, the PR1 claude-code-only routing
  guard widens to "any runtime with a registered relay adapter" (coordinate:
  if PR1 not merged yet, land the guard here behind the same predicate).
- Scope discipline: do NOT touch rooms (`room-turn-runner`) — already
  multi-runtime.

## Cross-cutting bars

- `pnpm verify` green per package touched; run neighbours' tests after any
  merge of main.
- Every new behavior has a test that fails without the change (state which).
- No new `os.homedir()`, SDK imports stay in their adapter dirs (Hard Rules).
- Fragments: `covers:` names commit subjects verbatim.
- Browser verification for PR2 (real form interaction via the dev app) before
  its review round.
