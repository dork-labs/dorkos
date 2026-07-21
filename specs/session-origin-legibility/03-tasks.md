# Tasks: session-origin-legibility

Spec: `specs/session-origin-legibility/02-specification.md`  
Generated: 2026-07-21T15:46:22Z  
Mode: full

## Phase 1: Server truth

### Task 1.1: Add SessionOrigin schema and origin/originLabel fields to SessionSchema

- **Size:** small
- **Priority:** high
- **Dependencies:** none
- **Parallel with:** none
- **Active form:** Adding SessionOrigin schema and origin/originLabel fields to SessionSchema

In `packages/shared/src/schemas.ts`, add a new exported schema and two new optional fields on `SessionSchema` (currently defined at line 112, closing at line 147 just before `.openapi('Session')`). Insert the new schema definition directly above `SessionSchema`:

```ts
export const SessionOriginSchema = z
  .enum(['user', 'agent', 'channel', 'task', 'external'])
  .openapi('SessionOrigin');
export type SessionOrigin = z.infer<typeof SessionOriginSchema>;
```

Then add two new fields to the `SessionSchema` object, placed after the existing `lastAutoCompactAt: z.string().datetime().optional(),` field (line 144) and before `cwd: z.string().optional(),` (line 145):

```ts
/**
 * Best-effort classification of what initiated this session, derived from
 * durable markers in the transcript head (never persisted, never trusted as
 * a security boundary). ABSENT means user-initiated — the unmarked default —
 * so runtimes that never receive automated traffic need no changes.
 */
origin: SessionOriginSchema.optional(),
/**
 * Short human-readable origin descriptor for non-user origins, e.g.
 * "Telegram", "warden (agent)", "Scheduled task · daily-digest", "A2A client".
 * Absent when `origin` is absent or no better label than the kind exists.
 */
originLabel: z.string().optional(),
```

Both fields are optional so the change is wire-compatible in both directions: older clients ignore the new fields, and runtimes that never see relay/Pulse/A2A traffic (codex, opencode) need zero code changes — their sessions simply never populate `origin`, and the absence of `origin` means `user`.

`Session` (the inferred type, `export type Session = z.infer<typeof SessionSchema>;` at line 149) will now include `origin?: SessionOrigin` and `originLabel?: string` automatically — no separate type export is needed.

Acceptance criteria:

- `SessionOriginSchema` exported from `packages/shared/src/schemas.ts`, enum values exactly `['user', 'agent', 'channel', 'task', 'external']`, tagged `.openapi('SessionOrigin')`.
- `SessionOrigin` type exported.
- `SessionSchema` gains `origin: SessionOriginSchema.optional()` and `originLabel: z.string().optional()`, each with the TSDoc shown above (hard rule 4).
- `pnpm --filter @dorkos/shared typecheck` passes.
- No other schema in the file changes.
- Rebuild the shared package dist after this change (`pnpm --filter @dorkos/shared build`) so downstream packages (server, client) resolve the new fields instead of a stale dist — a documented repo gotcha: stale `@dorkos/shared` dist causes false-red type errors elsewhere that look unrelated to this change.

### Task 1.2: Add classifyOrigin pure classifier with table-driven tests

- **Size:** medium
- **Priority:** high
- **Dependencies:** 1.1
- **Parallel with:** none
- **Active form:** Adding classifyOrigin pure classifier with table-driven tests

New file `apps/server/src/services/runtimes/claude-code/sessions/classify-origin.ts` exporting a pure function:

```ts
export function classifyOrigin(firstRawUserMessageRaw: string): {
  origin?: SessionOrigin;
  originLabel?: string;
};
```

Import `SessionOrigin` as a type from `@dorkos/shared/types`, matching the import style already used in this directory (e.g. `transcript-reader.ts` imports `import type { Session, PermissionMode, ... } from '@dorkos/shared/types';`).

Behavior — apply these rules against the raw text of the session's FIRST user message, in this exact order:

1. If the text does NOT start with `<relay_context>`:
   - If it starts with `=== TASK SCHEDULER CONTEXT ===`, return `{ origin: 'task' }`. (This branch exists defensively per the testing strategy; in practice the direct/relay-disabled Pulse branch injects this marker via `systemPromptAppend`, which is unlikely to ever appear as literal JSONL user-message content — Pulse task classification is primarily handled by the separate aggregation-layer overlay built in a later task, not this function. Do not rely on this branch working in production; it exists so the rule table is complete and testable.)
   - Otherwise return `{}` (absent origin means user).
2. If the text DOES start with `<relay_context>`, parse the `From: <value>` line from inside the block. The block is produced by `formatPromptWithContext` in `packages/relay/src/adapters/claude-code/agent-handler.ts` (lines 416-444), which builds this exact shape:

```
<relay_context>
Agent-ID: {agentId}
Session-ID: {sdkSessionId}
From: {envelope.from}
Message-ID: {envelope.id}
Subject: {envelope.subject}
Sent: {envelope.createdAt}
...
</relay_context>

{content}
```

Extract the value of the line beginning with `From: ` (case-sensitive, colon-space-separated, value runs to end of line) from within the `<relay_context>...</relay_context>` span. If no `From:` line is found (malformed block), fall through to the "anything else" rule below (`{ origin: 'external', originLabel: 'Relay' }`).

Match the extracted `<value>` against these rules, FIRST MATCH WINS:

| `From:` value                                                                                                                         | origin          | originLabel                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `a2a-gateway`                                                                                                                         | `external`      | `A2A client`                                                                                                                                                                                     |
| `relay.external.mcp`                                                                                                                  | `external`      | `External MCP client`                                                                                                                                                                            |
| `relay.system.tasks.scheduler` (or any value starting with `relay.system.tasks.`)                                                     | `task`          | `Scheduled task` (this generic label is overwritten by the Pulse aggregation-layer overlay task when a real task name is known — do not attempt to look up a task name here)                     |
| `relay.human.console`                                                                                                                 | absent (`user`) | absent — return `{}`; an operator using the Relay console is still the operator                                                                                                                  |
| value contains the substring `telegram` (case-insensitive; matches `telegram:12345`, `relay.human.telegram.*`, `telegram….bot`, etc.) | `channel`       | `Telegram`                                                                                                                                                                                       |
| value contains the substring `slack` (case-insensitive)                                                                               | `channel`       | `Slack`                                                                                                                                                                                          |
| value contains `webhook`, OR starts with `relay.human.` and did not match telegram/slack above (an unrecognized channel type)         | `channel`       | `Webhook` if it contained `webhook`, else `Channel`                                                                                                                                              |
| value starts with `relay.agent.` or `relay.session.`                                                                                  | `agent`         | the trailing dot-segment of the value, truncated to 24 characters, with ` (agent)` appended — e.g. `relay.agent.01H8ABCDEF...` yields segment `01H8ABCDEF...` truncated to 24 chars + ` (agent)` |
| anything else (including a `<relay_context>` block with no `From:` line at all)                                                       | `external`      | `Relay`                                                                                                                                                                                          |

Match ordering matters because some rules are substring checks that could otherwise overlap (e.g. a hypothetical value containing both `slack` and `telegram` — real callers never produce this, but table order still resolves it deterministically since the `telegram` check runs first).

Classification runs purely on the string already read into the existing 8KB head buffer in `extractSessionMeta` — no additional file IO, no async work. `classifyOrigin` itself must be synchronous and side-effect free.

Write `apps/server/src/services/runtimes/claude-code/sessions/__tests__/classify-origin.test.ts`, table-driven over every `From:` row in the table above, plus:

- No marker at all (plain text) yields `{}`.
- `<relay_context>` block with no `From:` line yields `{ origin: 'external', originLabel: 'Relay' }`.
- `From: relay.human.console` yields `{}` (user).
- `=== TASK SCHEDULER CONTEXT ===` marker as the first line yields `{ origin: 'task' }`.
- A coupling test: build a `<relay_context>` block using a copy of `formatPromptWithContext`'s exact line format (with a comment in the test pointing at `packages/relay/src/adapters/claude-code/agent-handler.ts:417-444` explaining why the fixture is shaped this way), so that if the real function's output format ever drifts from this fixture, a reviewer/CI catches it because the fixture was not updated in lockstep. Do not import `formatPromptWithContext` directly — it is unexported from `agent-handler.ts`, and pulling it in would require exporting relay internals across a package boundary the spec explicitly says not to touch.

Acceptance criteria:

- `classifyOrigin` is pure, synchronous, exported from the new file, with TSDoc per hard rule 4.
- Every row of the table above has a corresponding test case with an exact expected `{ origin, originLabel }` (or `{}`).
- `pnpm vitest run apps/server/src/services/runtimes/claude-code/sessions/__tests__/classify-origin.test.ts` passes.

### Task 1.3: Hook classifyOrigin into extractSessionMeta's head-scan

- **Size:** medium
- **Priority:** high
- **Dependencies:** 1.2
- **Parallel with:** none
- **Active form:** Hooking classifyOrigin into extractSessionMeta's head-scan

Wire `classifyOrigin` (previous task) into the existing head-scan loop in `TranscriptReader.extractSessionMeta` (`apps/server/src/services/runtimes/claude-code/sessions/transcript-reader.ts`).

Current loop shape (lines 272-347): `let firstUserMessage = '';` is declared at line 272; inside the `for (const line of lines)` loop (starts line 278), the block at lines 325-344 does:

```ts
// Extract first user message for title
if (!firstUserMessage && parsed.type === 'user' && parsed.message) {
  const text = extractTextContent(parsed.message.content);
  if (
    text.startsWith('<local-command') ||
    text.startsWith('<command-name>') ||
    text.startsWith('<command-message>') ||
    text.startsWith('<task-notification>') ||
    text.startsWith('<relay_context>')
  ) {
    continue;
  }
  if (text.startsWith('This session is being continued')) {
    continue;
  }
  const cleanText = stripSystemTags(text);
  if (!cleanText.trim()) continue;

  firstUserMessage = cleanText.trim();
}
```

Note this block SKIPS (via `continue`) any message starting with `<relay_context>` (and other wrapper types) when deriving the TITLE — that skip behavior must not change; title derivation stays exactly as-is.

Add a new variable `let firstRawUserMessage = '';` alongside the `let firstUserMessage = '';` declaration at line 272. Inside the same `if (!firstUserMessage && parsed.type === 'user' && parsed.message)` block, immediately after computing `const text = extractTextContent(parsed.message.content);` and BEFORE the `if (text.startsWith(...)) { continue; }` skip checks, add:

```ts
if (!firstRawUserMessage) {
  firstRawUserMessage = text;
}
```

This captures the very first user message's raw text (pre-skip, pre-strip) on first encounter, whether or not it turns out to be a wrapper message that gets skipped for title purposes. Because `firstUserMessage` and `firstRawUserMessage` are both gated by the outer `if (!firstUserMessage && ...)`, and `firstRawUserMessage` is set unconditionally inside (guarded only by its own `!firstRawUserMessage` check), a session whose first message IS a `<relay_context>` block gets `firstRawUserMessage` set to that block's raw text while `firstUserMessage` (and therefore the derived title) continues past it to the next real user message — exactly matching current title-derivation behavior.

After the loop ends (after line 347's early-break check, before the `derivedTitle` computation at line 350), call the classifier:

```ts
const { origin, originLabel } = classifyOrigin(firstRawUserMessage);
```

Import `classifyOrigin` from `./classify-origin.js` at the top of `transcript-reader.ts` alongside the other local imports.

Add `origin` and `originLabel` to the `session: Session` object literal constructed at line 359, only when defined — either spread them in directly (both fields are `undefined`-safe since `Session`'s `origin`/`originLabel` are optional and a missing/undefined key satisfies Zod's `.optional()`), or follow the `if (tailStatus.model) session.model = ...` conditional-assignment pattern already used a few lines below for tail-derived optional fields. Pick whichever reads more naturally next to the existing object literal.

Test extensions — extend `apps/server/src/services/session/__tests__/transcript-reader.test.ts` (NOT the `claude-code/__tests__/` directory — this is the file that already contains the `listSessions()` describe block and the existing `'skips relay_context when extracting session title'` test at line 785, which stubs a JSONL with a `<relay_context>\nAgent-ID: abc\n</relay_context>` first message followed by a real `'Analyze logs'` user message, currently asserting only `sessions[0].title === 'Analyze logs'`):

- Extend that exact test (or add a sibling test using the same fixture shape) to additionally assert `sessions[0].origin` is set from the relay-context block's classification. That existing fixture's `<relay_context>` block has NO `From:` line, so per the classifier's rule table it classifies as `{ origin: 'external', originLabel: 'Relay' }` — assert exactly that, alongside the still-correct title `'Analyze logs'` (title derivation is unaffected by this change).
- Add a new test with a `<relay_context>` block that DOES include a `From: relay.agent.01H8SOMEULID` line (or similar), asserting `sessions[0].origin === 'agent'` while the title still derives from the next real user message.
- Add a new test confirming a plain session (no relay-context, no task-scheduler marker) yields `sessions[0].origin === undefined` (absent).

Acceptance criteria:

- `firstRawUserMessage` capture does not alter existing title-derivation test results — all existing tests in `transcript-reader.test.ts` remain green unmodified except for the origin assertion additions.
- `classifyOrigin` is called exactly once per `extractSessionMeta` invocation.
- No additional file IO introduced (classification only touches strings already in the 8KB head buffer).
- `pnpm vitest run apps/server/src/services/session/__tests__/transcript-reader.test.ts` passes.

### Task 1.4: Add Pulse-run task-origin overlay at the session aggregation layer

- **Size:** medium
- **Priority:** high
- **Dependencies:** 1.1
- **Parallel with:** 1.2, 1.3
- **Active form:** Adding Pulse-run task-origin overlay at the session aggregation layer

Pulse (the task scheduler) records a run's session id durably in the `pulse_runs` table (`pulseRuns.sessionId`, `packages/db/src/schema/tasks.ts`, nullable `text('session_id')` column on the table defined starting line 29, written via `TaskStore.updateRun`). This task overlays `origin: 'task'` onto any listed session whose id matches a Pulse run, sourced from that durable table rather than transcript-head heuristics — this is what makes task classification work for BOTH the relay-enabled Pulse branch (already classified `task` by the `classifyOrigin`/`extractSessionMeta` tasks via the `relay.system.tasks.*` `From:` rule) AND the direct/relay-disabled Pulse branch (which the transcript-head classifier explicitly cannot reliably see), and it overwrites the transcript-head classifier's generic `'Scheduled task'` label with the real job name.

**1. Add a batched lookup to `TaskStore`** (`apps/server/src/services/tasks/task-store.ts`) — a new method:

```ts
/**
 * Resolve Pulse task origin for a batch of session ids, keyed by the id.
 * One indexed IN query over pulse_runs joined to pulse_schedules — O(1)
 * queries regardless of list size, used by the session-list origin
 * overlay (never called per-session).
 *
 * @param sessionIds - Session ids to look up; sessions with no matching run are absent from the returned map
 */
resolveTaskOrigins(sessionIds: string[]): Map<string, { taskName: string }> {
  if (sessionIds.length === 0) return new Map();
  const rows = this.db
    .select({ sessionId: pulseRuns.sessionId, taskName: pulseSchedules.name })
    .from(pulseRuns)
    .innerJoin(pulseSchedules, eq(pulseRuns.scheduleId, pulseSchedules.id))
    .where(inArray(pulseRuns.sessionId, sessionIds))
    .all();
  const map = new Map<string, { taskName: string }>();
  for (const row of rows) {
    if (row.sessionId) map.set(row.sessionId, { taskName: row.taskName });
  }
  return map;
}
```

`eq` and `inArray` are already imported from `drizzle-orm` at the top of `task-store.ts`; `pulseRuns` and `pulseSchedules` are already imported from `@dorkos/db`. Check the existing query style used elsewhere in this class (whether `.all()` or a plain synchronous call is the established pattern for better-sqlite3 reads here) before finalizing the exact call shape — match it.

**2. Add the overlay function.** New file `apps/server/src/services/session/task-origin-overlay.ts`:

```ts
export type ResolveTaskOrigins = (sessionIds: string[]) => Map<string, { taskName: string }>;

/**
 * Overlay Pulse task origin onto listed sessions, in place. Sessions with a
 * matching Pulse run get `origin: 'task'` and `originLabel: 'Scheduled task
 * · <taskName>'`, overwriting any origin the transcript-head classifier
 * already assigned. Sessions with no matching run pass through untouched.
 * A no-op when `resolveTaskOrigins` is undefined (Tasks subsystem disabled).
 */
export function applyTaskOriginOverlay(
  sessions: Session[],
  resolveTaskOrigins: ResolveTaskOrigins | undefined
): void {
  if (!resolveTaskOrigins || sessions.length === 0) return;
  const origins = resolveTaskOrigins(sessions.map((s) => s.id));
  if (origins.size === 0) return;
  for (const session of sessions) {
    const match = origins.get(session.id);
    if (match) {
      session.origin = 'task';
      session.originLabel = `Scheduled task · ${match.taskName}`;
    }
  }
}
```

**3. Wire it at the composition root** (`apps/server/src/index.ts`). `TaskStore` is constructed conditionally (`let taskStore: TaskStore | undefined;` around line 656, assigned `taskStore = new TaskStore(db);` around line 659 only when the Tasks subsystem is enabled), so `resolveTaskOrigins` must also be optional. Follow the existing `app.locals.meshCore = meshCore;` pattern (index.ts line 1014, and `app.locals.relayCore = relayCore;` at line 979) — add, guarded by `if (taskStore) { ... }`:

```ts
if (taskStore) {
  app.locals.resolveTaskOrigins = (sessionIds: string[]) =>
    taskStore!.resolveTaskOrigins(sessionIds);
}
```

**4. Call the overlay from `apps/server/src/routes/sessions.ts`** at both existing session-read sites:

- `GET /` (lines 65-90): after `const { sessions, warnings } = await aggregateSessionList({ runtimes, projectDir });` (line 80) and the existing `applyStoredSettings` overlay loop (lines 83-88), read `const resolveTaskOrigins = req.app.locals.resolveTaskOrigins as ResolveTaskOrigins | undefined;` and call `applyTaskOriginOverlay(page, resolveTaskOrigins);` on the paginated `page` array (the same array `applyStoredSettings` already mutates in place) before `res.json(...)`.
- `GET /:id` (lines 127-148): after `const stored = await runtimeRegistry.getSessionSettings(internalSessionId); if (stored) applyStoredSettings(session, stored);` (lines 145-146), call `applyTaskOriginOverlay([session], resolveTaskOrigins);` before `res.json(session);`.

Import `applyTaskOriginOverlay` and the `ResolveTaskOrigins` type from `../services/session/task-origin-overlay.js` (or the domain barrel `../services/session/index.js` if it already re-exports sibling session-service functions — check that barrel's existing pattern before deciding).

If wiring `TaskStore` through `app.locals` proves awkward once in the code (e.g. `routes/sessions.ts` turns out to already have a cleaner dependency-injection seam — a factory function rather than a bare default-exported `Router()` — check this before assuming `app.locals` is required), a narrow injected function defined at the composition root is still the requirement. The constraint that must hold regardless of mechanism: no import of `services/tasks/*` from inside a runtime adapter directory (`services/runtimes/claude-code/`), keeping `transcript-reader.ts` and `classify-origin.ts` dependency-free of the Tasks subsystem.

**Tests:**

- `apps/server/src/services/session/__tests__/task-origin-overlay.test.ts`: a fake `resolveTaskOrigins` function returning a `Map` with one or two entries; assert matching sessions get `origin: 'task'` and the exact `Scheduled task · <taskName>` label, non-matching sessions are untouched (including a session that already had `origin: 'agent'` — confirm the overlay overwrites it, since Pulse-run-backed sessions are authoritatively `task` regardless of what the transcript head said), and that `resolveTaskOrigins: undefined` is a safe no-op.
- `apps/server/src/services/tasks/__tests__/task-store.test.ts`: extend with a test for `resolveTaskOrigins` — seed a `pulse_schedules` row and a `pulse_runs` row with a `sessionId`, call `resolveTaskOrigins([thatSessionId, 'unrelated-id'])`, assert the map has exactly one entry keyed by the seeded session id with the correct `taskName`, and assert `resolveTaskOrigins([])` returns an empty map without querying.

Acceptance criteria:

- `TaskStore.resolveTaskOrigins` is a single batched `IN` query, never called per-session.
- The overlay runs at both `GET /api/sessions` and `GET /api/sessions/:id`.
- Tasks-subsystem-disabled installs (`taskStore` undefined) see no behavior change and no errors.
- `pnpm --filter @dorkos/server typecheck` and the two new/extended test files pass.

### Task 1.5: Confirm @dorkos/test-utils session factory passes through origin/originLabel

- **Size:** small
- **Priority:** medium
- **Dependencies:** 1.1
- **Parallel with:** 1.2, 1.3, 1.4
- **Active form:** Confirming @dorkos/test-utils session factory passes through origin/originLabel

`createMockSession` in `packages/test-utils/src/mock-factories.ts` (lines 14-24) has the signature `createMockSession(overrides: Partial<Session> = {}): Session` and spreads `...overrides` last over a small set of hardcoded defaults (`id`, `title`, `createdAt`, `updatedAt`, `permissionMode`, `runtime`) — it does NOT enumerate every `Session` field individually. Once the schema task adds `origin?: SessionOrigin` and `originLabel?: string` to the `Session` type, `createMockSession({ origin: 'agent', originLabel: 'warden (agent)' })` already type-checks and passes both fields through with zero code changes to this factory, via the existing spread mechanism — the same way `contextTokens` and `lastAutoCompactAt` already pass through today (see the neighboring `createMockSessionWithReading` helper at lines 36-43, a thin wrapper adding claude-code-shaped reading defaults on top of the same spread).

This task is a verification-and-documentation step, not a functional change:

1. After the schema task lands and `@dorkos/shared` is rebuilt, run `pnpm --filter @dorkos/test-utils typecheck` and confirm `createMockSession({ origin: 'task', originLabel: 'Scheduled task · daily-digest' })` type-checks (a scratch call, or rely on the Phase 2 RTL tests that will exercise this in practice — those tests are the real proof).
2. Add one short sentence to the existing TSDoc on `createMockSession` (line 13, currently `/** Create a mock Session with sensible defaults. */`) noting that `origin`/`originLabel` (and every other optional `Session` field) pass through via `overrides`, e.g.:

```ts
/**
 * Create a mock Session with sensible defaults. Every optional `Session`
 * field — including `origin`/`originLabel` (session-origin-legibility) and
 * `contextTokens`/`lastAutoCompactAt` — passes through via `overrides`
 * with no changes needed here; add fields to `overrides`, not new params.
 */
```

3. Do NOT add a dedicated `origin`/`originLabel` default to `createMockSession`'s base object — the whole point of the existing design is that origin defaults to absent (`user`), matching production's "absent means user" semantics; a factory default of `origin: 'user'` would be redundant with absence and would diverge from how every other optional field in this factory already behaves.

Acceptance criteria:

- No functional change to `mock-factories.ts` beyond the TSDoc addition.
- `createMockSession({ origin: ..., originLabel: ... })` type-checks and round-trips correctly (verified in practice by its use in Phase 2's RTL tests).

### Task 1.6: Regenerate the OpenAPI snapshot for the new Session origin fields

- **Size:** small
- **Priority:** medium
- **Dependencies:** 1.1, 1.2, 1.3, 1.4
- **Parallel with:** none
- **Active form:** Regenerating the OpenAPI snapshot for the new Session origin fields

`docs/api/openapi.json` is a generated snapshot exported by `scripts/export-openapi.ts` (run via `pnpm docs:export-api`, a script defined in the root `package.json`). The `.github/workflows/docs-openapi-check.yml` CI job (the "openapi-fresh" check) fails the PR if this committed snapshot is stale relative to what the live `@asteasolutions/zod-to-openapi` registry (`apps/server/src/services/core/openapi-registry.ts`) produces from the current Zod schemas.

The schema task (1.1) adds `SessionOriginSchema` (tagged `.openapi('SessionOrigin')`) and two new optional fields to `SessionSchema` (tagged `.openapi('Session')`) — both will change the generated OpenAPI document's `components.schemas.Session` and add a new `components.schemas.SessionOrigin` entry.

Steps:

1. Ensure `@dorkos/shared` is rebuilt with the schema task's changes (`pnpm --filter @dorkos/shared build`) — confirm whether `scripts/export-openapi.ts` reads the built dist or source directly by checking its imports before running it.
2. Run `pnpm docs:export-api` from the repo root.
3. Diff `docs/api/openapi.json` — confirm the diff is limited to: a new `SessionOrigin` schema component, and the `Session` schema component gaining `origin` and `originLabel` properties (both absent from `required`, matching their `.optional()` Zod definition). No other schema or path should change.
4. Stage and include the regenerated `docs/api/openapi.json` in this change.

Acceptance criteria:

- `docs/api/openapi.json` reflects the new fields.
- The diff touches only the `Session`/`SessionOrigin` schema components — no incidental changes from stale generation elsewhere.
- CI's `docs-openapi-check` workflow would pass (no drift): verify locally by re-running `pnpm docs:export-api` a second time and confirming a clean `git diff` (idempotent regeneration).

## Phase 2: Client surfaces

### Task 2.1: Add the origin descriptor registry (origin-descriptors.ts)

- **Size:** small
- **Priority:** high
- **Dependencies:** 1.1
- **Parallel with:** none
- **Active form:** Adding the origin descriptor registry (origin-descriptors.ts)

New file `apps/client/src/layers/entities/session/config/origin-descriptors.ts` (a new `config/` segment in `entities/session`, mirroring `entities/runtime/config/runtime-descriptors.ts`). Define:

```ts
import type { ComponentType } from 'react';
import type { SessionOrigin } from '@dorkos/shared/types';

/** Visual identity for one non-user session origin. `user` has no entry — it is never marked (calm-tech: automation is marked, humans are not). */
export interface OriginDescriptor {
  origin: SessionOrigin;
  /** Fallback label shown when the session's own `originLabel` is absent. */
  label: string;
  /** Icon component. Renders at 12px by default in `OriginMark`; pass `size` to override. */
  icon: ComponentType<{ size?: number; className?: string }>;
  /** Accent color as a CSS color value (theme `--color-*` variable). */
  accent: string;
}
```

Registry, keyed by every `SessionOrigin` value EXCEPT `'user'`:

```ts
export const ORIGIN_DESCRIPTORS: Partial<Record<SessionOrigin, OriginDescriptor>> = {
  agent: { origin: 'agent', label: 'Agent', icon: Bot, accent: 'var(--color-violet-500)' },
  channel: {
    origin: 'channel',
    label: 'Channel',
    icon: MessagesSquare,
    accent: 'var(--color-sky-500)',
  },
  task: {
    origin: 'task',
    label: 'Scheduled task',
    icon: CalendarClock,
    accent: 'var(--color-amber-500)',
  },
  external: { origin: 'external', label: 'External', icon: Globe, accent: 'var(--color-teal-500)' },
};
```

Import `Bot`, `MessagesSquare`, `CalendarClock`, `Globe` from `lucide-react` (all four already used elsewhere in the app; no new icon dependency).

Lookup function:

```ts
/**
 * Resolve the visual identity for a session origin. Returns `undefined` for
 * `'user'` or any unrecognized origin — callers (chiefly OriginMark) treat
 * `undefined` as "render nothing," matching calm-tech: unmarked means you,
 * marked means automation.
 */
export function getOriginDescriptor(
  origin: SessionOrigin | undefined
): OriginDescriptor | undefined {
  if (!origin || origin === 'user') return undefined;
  return ORIGIN_DESCRIPTORS[origin];
}
```

Note the deliberate difference from `getRuntimeDescriptor` (`entities/runtime/config/runtime-descriptors.ts`), which NEVER returns `undefined` (it falls back to a neutral descriptor for unknown runtime types, because every session must show SOME runtime identity). Origin is the opposite: absence/unknown/`user` must all resolve to "no descriptor, render nothing" — there is no neutral fallback origin glyph, because the whole point is that human conversations stay unmarked.

Acceptance criteria:

- File exports `OriginDescriptor`, `ORIGIN_DESCRIPTORS`, `getOriginDescriptor`, each with TSDoc per hard rule 4.
- `getOriginDescriptor('user')` and `getOriginDescriptor(undefined)` both return `undefined`.
- `getOriginDescriptor('agent' | 'channel' | 'task' | 'external')` each return the descriptor with the icon/accent/label specified above.
- No FSD violation: only imports from `lucide-react` and `@dorkos/shared/types` (cross-package imports are fine per FSD rules; no other `layers/` code is imported).

### Task 2.2: Add the OriginMark component

- **Size:** small
- **Priority:** high
- **Dependencies:** 2.1
- **Parallel with:** none
- **Active form:** Adding the OriginMark component

New file `apps/client/src/layers/entities/session/ui/OriginMark.tsx`, mirroring the existing `entities/runtime/ui/RuntimeMark.tsx` pattern (non-interactive span + `Tooltip` + default 12px icon + muted styling):

```tsx
import { cn } from '@/layers/shared/lib';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';
import type { SessionOrigin } from '@dorkos/shared/types';
import { getOriginDescriptor } from '../config/origin-descriptors';

interface OriginMarkProps {
  /** Session's resolved origin. `undefined`/`'user'`/unrecognized all render nothing. */
  origin?: string;
  /** The session's own `originLabel`, when present — takes priority over the descriptor's generic fallback label. */
  label?: string;
  /** Icon size in pixels. Defaults to a subtle 12px mark, matching RuntimeMark. */
  size?: number;
  className?: string;
}

/**
 * Small origin-identity icon with a tooltip naming the origin, rendered ONLY
 * for non-user sessions — mirrors RuntimeMark's icon+tooltip shape but
 * inverts its never-blank default: returns `null` for `user`/absent/unknown
 * origins (the AgentActivityBadge render-null precedent), so unmarked rows
 * read as "you" and only automation gets a glyph.
 */
export function OriginMark({ origin, label, size = 12, className }: OriginMarkProps) {
  const descriptor = getOriginDescriptor(origin as SessionOrigin | undefined);
  if (!descriptor) return null;

  const Icon = descriptor.icon;
  const text = label ?? descriptor.label;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={`Origin: ${text}`}
          className={cn('inline-flex shrink-0 items-center', className)}
        >
          <Icon size={size} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
```

The `origin` prop is typed `string` (not `SessionOrigin`) so callers can pass `session.origin` directly without a cast even though `Session.origin` is `SessionOrigin | undefined` — this matches `RuntimeMark`'s `type: string` prop (which accepts `session.runtime: string`). Internally narrow via `getOriginDescriptor`, which already treats anything that isn't a recognized `SessionOrigin` value as "no descriptor."

Non-interactive: clicks pass through to the surrounding row (no `onClick`, no `button`), exactly like `RuntimeMark`.

Test: `apps/client/src/layers/entities/session/ui/__tests__/OriginMark.test.tsx` (jsdom environment, RTL) — table-driven over `agent`/`channel`/`task`/`external` asserting the icon renders and the tooltip trigger has `aria-label="Origin: <label>"` (use the descriptor's fallback label when no `label` prop is passed, and confirm a passed `label` prop overrides it); assert `origin="user"`, `origin={undefined}`, and an unrecognized string like `origin="bogus"` all render nothing (no tooltip trigger found in the query).

Acceptance criteria:

- Returns `null` for `user`/absent/unknown origin (verified by test).
- Renders icon + tooltip for each of the four non-user origins.
- `aria-label="Origin: <text>"` on the trigger span.
- TSDoc per hard rule 4.

### Task 2.3: Add partitionSessionsByOrigin selector with unit tests

- **Size:** small
- **Priority:** high
- **Dependencies:** 1.1
- **Parallel with:** 2.1, 2.2
- **Active form:** Adding partitionSessionsByOrigin selector with unit tests

New file `apps/client/src/layers/entities/session/lib/partition-sessions-by-origin.ts`:

```ts
import type { Session } from '@dorkos/shared/types';

/** Result of partitioning a session list by origin. */
export interface SessionOriginPartition {
  /** Sessions whose resolved origin is `user` (absent `origin` defaults to `user`). */
  conversations: Session[];
  /** Every non-user-origin session, in the same relative order as the input. */
  automated: Session[];
}

/**
 * Split a session list into user-initiated conversations and everything
 * else (agent/channel/task/external), preserving relative order within each
 * bucket. `origin` absent on a session means `user` — the unmarked default —
 * so untouched runtimes (codex, opencode) put every session in `conversations`.
 * Pure and synchronous; callers slice each bucket to their own row cap
 * (MAX_PREVIEW_SESSIONS in AgentListItem, MAX_RECENT_ROWS in
 * RecentSessionsSection) AFTER partitioning, not before — partitioning must
 * see the full list so a conversation doesn't get bumped out of the cap by
 * automated sessions ahead of it in raw recency order.
 */
export function partitionSessionsByOrigin(sessions: Session[]): SessionOriginPartition {
  const conversations: Session[] = [];
  const automated: Session[] = [];
  for (const session of sessions) {
    if (!session.origin || session.origin === 'user') {
      conversations.push(session);
    } else {
      automated.push(session);
    }
  }
  return { conversations, automated };
}
```

Test: `apps/client/src/layers/entities/session/lib/__tests__/partition-sessions-by-origin.test.ts` — pure unit tests (no RTL, no jsdom needed): empty input yields both buckets empty; all-user input puts everything in `conversations`, `automated` empty; mixed input yields the correct split, preserving each bucket's relative order; a session with `origin: undefined` and one with `origin: 'user'` both land in `conversations`; every non-user origin value (`agent`/`channel`/`task`/`external`) lands in `automated`.

Acceptance criteria:

- Function is pure, synchronous, exported with TSDoc.
- `pnpm vitest run apps/client/src/layers/entities/session/lib/__tests__/partition-sessions-by-origin.test.ts` passes.
- File lives in `entities/session/lib/` and imports `@dorkos/shared/types` only — no FSD violation.

### Task 2.4: Export OriginMark, origin descriptors, and the partition selector from the entities/session barrel

- **Size:** small
- **Priority:** high
- **Dependencies:** 2.1, 2.2, 2.3
- **Parallel with:** none
- **Active form:** Exporting OriginMark, origin descriptors, and the partition selector from the entities/session barrel

`apps/client/src/layers/entities/session/index.ts` is the module's public API — per the FSD rule "always import from barrel index.ts, never internal paths" (`.claude/rules/fsd-layers.md`), everything the row and sidebar integration tasks need must be re-exported here before those tasks can consume it.

Add these exports to `apps/client/src/layers/entities/session/index.ts`, following the file's existing grouping convention (hooks/model exports first, then a `// UI — session row display primitive` comment block at the bottom with `SessionRow`/`SessionContextGauge` exports at lines 82-86):

```ts
// Origin — session-origin-legibility: descriptor registry, the row glyph, and the sidebar partition selector.
export { ORIGIN_DESCRIPTORS, getOriginDescriptor } from './config/origin-descriptors';
export type { OriginDescriptor } from './config/origin-descriptors';
export { OriginMark } from './ui/OriginMark';
export { partitionSessionsByOrigin } from './lib/partition-sessions-by-origin';
export type { SessionOriginPartition } from './lib/partition-sessions-by-origin';
```

Place this new block near the existing `// UI — session row display primitive` section since `OriginMark` is UI, but keep the `getOriginDescriptor`/`partitionSessionsByOrigin` exports together with it in one clearly-commented group rather than scattering them — this barrel already groups by feature area (see the `// Context-health merge resolver` and `// Fleet-level context rollup` comment groups earlier in the file), so match that convention rather than strictly grouping by segment type (model vs ui vs lib).

Acceptance criteria:

- `import { OriginMark, getOriginDescriptor, partitionSessionsByOrigin } from '@/layers/entities/session';` resolves from any `features/` or `widgets/` consumer.
- No internal-path imports introduced anywhere: once later tasks land, grepping for `entities/session/ui/OriginMark` or `entities/session/config/origin-descriptors` should find zero imports outside the entity's own directory.
- `pnpm --filter @dorkos/client typecheck` passes.

### Task 2.5: Render OriginMark on SessionRowCompact, RecentSessionRow, and SessionRowFull (+ detail-panel Origin line)

- **Size:** medium
- **Priority:** high
- **Dependencies:** 2.4
- **Parallel with:** none
- **Active form:** Rendering OriginMark on SessionRowCompact, RecentSessionRow, and SessionRowFull

Three session row components each need the new glyph, in three slightly different places:

**`apps/client/src/layers/entities/session/ui/SessionRowCompact.tsx`** — currently renders, inside the row's trailing `<span className="flex shrink-0 items-center gap-1">` block (around lines 137-143):

```tsx
<RuntimeMark type={session.runtime} model={session.model} className="text-muted-foreground/50" />
```

Add `<OriginMark origin={session.origin} label={session.originLabel} className="text-muted-foreground/50" />` immediately BEFORE this `RuntimeMark` (reading order: pending-approval hand icon, then OriginMark, then RuntimeMark, then relative time) — matching the spec's exact placement instruction "immediately before RuntimeMark." Import `OriginMark` from the sibling file directly (`./OriginMark`), exactly as this file already imports `SessionContextMenu` from `./SessionContextMenu` — a component never imports its own module's barrel, only cross-module consumers do.

**`apps/client/src/layers/features/dashboard-sidebar/ui/RecentSessionRow.tsx`** — currently renders `<AgentAvatar>`, then the truncated title span, then the relative-time span (lines 45-47). Add `<OriginMark origin={session.origin} label={session.originLabel} />` BETWEEN the title span and the timestamp span, per the spec's placement instruction "between title and timestamp." Import `OriginMark` from `@/layers/entities/session` (the barrel — this is a features-layer file consuming an entities-layer export, which must go through the barrel per FSD rules; this file already imports `sessionDisplayTitle` that way at line 8). This row still gets NO `RuntimeMark` — that stays explicitly out of scope per the spec ("Still no runtime mark here — out of scope").

**`apps/client/src/layers/entities/session/ui/SessionRowFull.tsx`** — two changes:

1. On "Line 2" (the title row, rendered when `!isRenaming`, around lines 220-233), which already shows `<RuntimeMark type={session.runtime} model={session.model} className="text-muted-foreground/50" />` beside the truncated title — add `<OriginMark origin={session.origin} label={session.originLabel} className="text-muted-foreground/50" />` beside it (spec: "OriginMark beside RuntimeMark on line 2"), matching the existing `gap-1.5` flex layout already wrapping `RuntimeMark` + the title `div`.
2. In the expanded detail panel's `DetailRow` list (currently `Session ID` / `Created` / `Updated` / `Runtime` / `Permissions`, around lines 272-277), add a new `Origin` row directly after `Runtime` and before `Permissions` (matching the panel's existing field ordering: identity fields, then behavior fields). Per the spec, the value is `originLabel ?? descriptor.label ?? 'You'`; since `getOriginDescriptor` returns `undefined` for `user`/absent origin, the correct expression is:

```tsx
<DetailRow
  label="Origin"
  value={session.originLabel ?? getOriginDescriptor(session.origin)?.label ?? 'You'}
/>
```

Import `getOriginDescriptor` via the same relative-sibling convention as `OriginMark` above (`../config/origin-descriptors`) — this file lives inside `entities/session/ui/`, so it imports sibling segments directly, never through its own module's barrel (that would be a needless indirection and, in some lint configs, a circular-import risk). This sits alongside the file's existing `import { RuntimeMark, getRuntimeDescriptor } from '@/layers/entities/runtime';` line, which is a cross-module barrel import (correct, since `runtime` is a different entity) — do not follow that same pattern for `getOriginDescriptor`, which is same-module.

Test coverage: extend `apps/client/src/layers/entities/session/__tests__/SessionRow.test.tsx` (the existing shared test file covering both row variants) with cases for each of the three components: a session with `origin: 'channel', originLabel: 'Telegram'` shows the `OriginMark` tooltip trigger with `aria-label="Origin: Telegram"`; a plain `origin: undefined` session shows no such element; `SessionRowFull`'s expanded panel shows a `DetailRow` with label `Origin` and the expected value string, both for a non-user session (uses `originLabel`) and for a user session (falls back to `'You'`).

Acceptance criteria:

- All three components render `OriginMark` at the specified position; rows render unchanged (no glyph) for user-origin sessions.
- `SessionRowFull`'s detail panel Origin row uses exactly the `originLabel ?? descriptor.label ?? 'You'` fallback chain.
- `pnpm --filter @dorkos/client typecheck`, `pnpm --filter @dorkos/client lint`, and the extended `SessionRow.test.tsx` all pass.

### Task 2.6: Default AgentListItem's session preview to conversations, with a + N automated reveal row

- **Size:** medium
- **Priority:** high
- **Dependencies:** 2.4
- **Parallel with:** none
- **Active form:** Defaulting AgentListItem's session preview to conversations, with a + N automated reveal row

`apps/client/src/layers/features/dashboard-sidebar/ui/AgentListItem.tsx` currently computes `const previewSessions = sessions.slice(0, MAX_PREVIEW_SESSIONS);` (line 107, where `MAX_PREVIEW_SESSIONS = 3` is defined at line 24) directly off the `sessions` prop, then renders each row via `<SessionRow variant="compact" session={session} ... />` inside an `AnimatePresence`-staggered list (lines 254-286), followed by a `New session` button.

Change the slicing to partition BEFORE slicing, using the `partitionSessionsByOrigin` selector:

```ts
const { conversations, automated } = useMemo(() => partitionSessionsByOrigin(sessions), [sessions]);
const previewSessions = conversations.slice(0, MAX_PREVIEW_SESSIONS);
```

Import `partitionSessionsByOrigin` from `@/layers/entities/session` — this file already imports `useAgentHottestStatus, usePulseMotion, SessionRow` from there at line 16, so add it to that same import statement. `useMemo` is already imported at line 1.

Add local component state for the reveal toggle: `const [automatedExpanded, setAutomatedExpanded] = useState(false);` (add `useState` to the existing `useCallback, useMemo` import at line 1). Per the spec, "Toggle is component state (useState), not persisted" — no Zustand store, no `~/.dork/config.json` field, nothing crosses a reload.

After the existing `previewSessions.map(...)` block (lines 254-286) and its trailing `New session` button block (lines 288-315), add: when `automated.length > 0`, render one quiet row:

```tsx
{
  automated.length > 0 && (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setAutomatedExpanded((prev) => !prev);
      }}
      className="text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors duration-100"
      aria-expanded={automatedExpanded}
    >
      {automatedExpanded ? 'Hide' : `+ ${automated.length} automated`}
    </button>
  );
}
```

Match the row height and text styling of the existing `New session` button (lines 303-313) — same className shape, same `text-muted-foreground` quiet treatment per the spec's "quiet reveal."

When `automatedExpanded` is true, render the automated sessions using the SAME compact `SessionRow` rendering as the conversations list above, capped at `MAX_PREVIEW_SESSIONS`:

```tsx
{
  automatedExpanded &&
    automated
      .slice(0, MAX_PREVIEW_SESSIONS)
      .map((session) => (
        <SessionRow
          key={session.id}
          variant="compact"
          session={session}
          isActive={session.id === activeSessionId}
          onClick={() => onSessionClick(session.id)}
          onFork={onForkSession}
          onRename={onRenameSession}
        />
      ));
}
```

Handle the empty-conversations case explicitly. Per the spec: "Empty conversations + non-empty automated: show the reveal row (never an empty section pretending there are no sessions)." The existing `'First session'` empty-state block (lines 230-252, shown when `!isLoadingSessions && previewSessions.length === 0`) currently assumes zero sessions total means a brand-new agent — but now `previewSessions.length === 0` can also mean "this agent has automated sessions but no conversations yet," a different situation. Gate that empty-state block so it only shows when BOTH `previewSessions.length === 0` AND `automated.length === 0` (a genuinely session-less agent); when `previewSessions` is empty but `automated` is not, skip straight to rendering the `+ N automated` reveal row instead of the "First session" placeholder.

Test: extend `apps/client/src/layers/features/dashboard-sidebar/__tests__/AgentListItem.test.tsx` — a mix of user and non-user sessions shows only the user ones in the initial 3-row preview (using `createMockSession({ origin: 'agent' })` etc. from `@dorkos/test-utils`); the `+ N automated` row appears with the correct count and is absent when there are zero automated sessions; clicking it toggles the automated sessions into view; an agent with automated-only sessions (empty conversations) shows the reveal row, not the "First session" placeholder; an agent with genuinely zero sessions still shows "First session" as before (regression check).

Acceptance criteria:

- Preview always shows conversations first, capped at `MAX_PREVIEW_SESSIONS`.
- `+ N automated` row renders only when `automated.length > 0`; toggling reveals up to `MAX_PREVIEW_SESSIONS` automated sessions using the same compact row rendering.
- Toggle state is local (`useState`), resets on remount, not persisted anywhere.
- "First session" placeholder only shows for agents with zero sessions of any origin.
- `pnpm --filter @dorkos/client typecheck` and the extended `AgentListItem.test.tsx` pass.

### Task 2.7: Default RecentSessionsSection to conversations, with a + N automated reveal row

- **Size:** medium
- **Priority:** high
- **Dependencies:** 2.4
- **Parallel with:** 2.6
- **Active form:** Defaulting RecentSessionsSection to conversations, with a + N automated reveal row

`apps/client/src/layers/features/dashboard-sidebar/ui/RecentSessionsSection.tsx` currently computes `const rows = sessions.slice(0, MAX_RECENT_ROWS);` (line 59, `MAX_RECENT_ROWS = 5` at line 16) directly off the `sessions` prop, then renders `RecentSessionRow` for each (lines 86-98, inside the `!recentsCollapsed` block).

Apply the identical partition-then-slice-then-reveal pattern used in the AgentListItem task, scoped to this component's simpler (non-animated, non-nested-toggle) row list:

```ts
const { conversations, automated } = useMemo(() => partitionSessionsByOrigin(sessions), [sessions]);
const rows = conversations.slice(0, MAX_RECENT_ROWS);
```

Import `partitionSessionsByOrigin` from `@/layers/entities/session` — this file currently imports `Session`/`SessionListWarning` types from `@dorkos/shared/types` and `RecentSessionRow` from the sibling file, so add a new import line for the barrel. Add `useMemo` to the existing `import { useEffect } from 'react';` at line 1.

Add local `const [automatedExpanded, setAutomatedExpanded] = useState(false);` (add `useState` to the same React import). Inside the `<SidebarMenu>` block (lines 81-99), after the `rows.map(...)` rendering, add the same-shaped `+ N automated` quiet reveal button (reuse the exact button markup pattern from the AgentListItem task — same className, same `+ N automated` / `Hide` text, same `aria-expanded`), and when expanded, render `automated.slice(0, MAX_RECENT_ROWS)` through the SAME `RecentSessionRow` component used for `rows` above (same `agent`/`displayName` resolution logic already present in the `.map()` at lines 86-98 — reuse it for the automated rows rather than duplicating the lookup).

Same empty-state honesty rule as the AgentListItem task: if `rows.length === 0` but `automated.length > 0`, do not silently render an empty `SidebarMenu` — show the reveal row so the automated sessions remain discoverable. Confirm by reading the current render logic whether this component has any dedicated "no recent sessions" placeholder to worry about gating (unlike `AgentListItem`'s "First session" state); if none exists, no additional empty-state handling is needed beyond ensuring the reveal row itself always renders when `automated.length > 0`.

Test: extend `apps/client/src/layers/features/dashboard-sidebar/__tests__/DashboardSidebar.test.tsx` if `RecentSessionsSection` is exercised there, OR add a new `apps/client/src/layers/features/dashboard-sidebar/__tests__/RecentSessionsSection.test.tsx` if no dedicated test file exists yet (check both before choosing) — assert conversations-only sessions show in the initial `MAX_RECENT_ROWS` rows across agents; `+ N automated` reveal row appears/toggles as in the AgentListItem task; membership/glyph lookups (the `agents`/`displayNames` props resolving each row's `AgentAvatar`) are unchanged for both conversation and automated rows.

Acceptance criteria:

- Cross-agent Recent list shows conversations first, capped at `MAX_RECENT_ROWS`.
- `+ N automated` reveal row behaves identically to the AgentListItem task's (same visual/interaction pattern, applied to this component's row shape).
- `pnpm --filter @dorkos/client typecheck` and the relevant test file pass.

### Task 2.8: Add a muted origin chip to the session header when origin is not user

- **Size:** medium
- **Priority:** high
- **Dependencies:** 2.4
- **Parallel with:** 2.5, 2.6, 2.7
- **Active form:** Adding a muted origin chip to the session header

The chat screen's session header is `apps/client/src/layers/features/top-nav/ui/SessionHeader.tsx`, currently a simple breadcrumb (`Agents / <agentName> / Session`) plus a `CommandPaletteTrigger`, with the signature `SessionHeader({ agentName }: { agentName: string | undefined })`. It is composed in `apps/client/src/AppShell.tsx`'s `useHeaderSlot` function, in the `case '/session':` branch (around lines 174-178): `content: <SessionHeader agentName={agentName} />`.

`AppShell.tsx` already tracks `const [activeSessionId] = useSessionId();` (around line 200) and fetches `const { data: currentAgent } = useCurrentAgent(selectedCwd);` (around line 208), but does NOT currently hold the full active `Session` object (with its `origin`/`originLabel`) anywhere in this render path. Locate whatever hook or cache the session route already uses to read the active session's other fields (title, runtime, etc.) — check the session-chat feature/widget that actually renders inside the `/session` route's `<Outlet />`, since that is most likely where the full `Session` object is already fetched/cached (e.g. via `useSessionListSessions`/`useSessionListStore`, `useSessions`, or a dedicated single-session query hook) — and either lift that same data source to `AppShell` to pass an extra prop into `SessionHeader`, or have `SessionHeader` itself read the session by `activeSessionId` from whatever shared cache already holds it. Do NOT introduce a brand-new network fetch for data the app already has cached somewhere in this render tree.

Add an `origin`/`originLabel` (or a resolved `session: Session | undefined`) prop to `SessionHeaderProps`, and render a muted chip — icon + text, following this header's existing chip/marker conventions (the breadcrumb's muted `text-muted-foreground` styling, the `ChevronRight` separator pattern) — ONLY when the resolved origin is not `user`/absent. Reuse `OriginMark` for the icon+tooltip if a plain icon-only glyph fits the header's visual density, OR render the descriptor's icon plus the label as inline text (icon + `originLabel ?? descriptor.label`) if the header's existing style is closer to `AgentIdentity`'s icon+text composition than to a bare glyph — check the header's current visual weight (currently just breadcrumb text and `ChevronRight`-separated segments) before choosing, and prefer whichever reads as "one more quiet breadcrumb-adjacent segment" rather than a heavy badge.

Per the spec: "If the header proves contested/complex, the SessionRowFull detail-panel Origin line is the required minimum and the header chip must still ship in this PR — it is small." The detail-panel line already ships in a prior task; this task's header chip is REQUIRED, not optional — budget it as genuinely small (a few lines wiring existing pieces together), and if the "locate the right session-data source" step above turns out to need a larger refactor of `AppShell`'s data flow than expected, prefer the smallest correct wiring (e.g. a dedicated lightweight lookup of the one active session from an already-fetched list in the session-list store) over restructuring how `AppShell` fetches session data.

Test: add or extend a test for `SessionHeader` (check for an existing `apps/client/src/layers/features/top-nav/__tests__/` directory; create `SessionHeader.test.tsx` if none exists) asserting the origin chip renders for a non-user session and is absent for a user session.

Acceptance criteria:

- Opening any non-user-origin session shows a muted origin identity in the header (icon + `originLabel ?? descriptor.label`).
- User-origin sessions show no chip (header looks exactly as it does today).
- No new network fetch introduced — the header reuses whatever cache already holds the active session's data in this render path.
- `pnpm --filter @dorkos/client typecheck` and the new/extended header test pass.

### Task 2.9: Write the changelog fragment for session origin legibility

- **Size:** small
- **Priority:** medium
- **Dependencies:** none
- **Parallel with:** 2.1, 2.2, 2.3, 2.5, 2.6, 2.7, 2.8
- **Active form:** Writing the changelog fragment for session origin legibility

Add a new fragment file to `changelog/unreleased/`, named `<timestamp-id>-session-origin.md` where `<timestamp-id>` is a fresh `YYMMDD-HHMMSS` id generated the same way ADRs and specs get theirs (`.claude/scripts/id.ts`, coordination-free per ADR-0312). Do NOT reuse this spec's own id (`260721-153518`) — generate a new one at the time this fragment is actually written; fragment ids and spec ids are independent sequences. Never edit `CHANGELOG.md` directly — fragments compile into it at release time (ADR 260707-231641, `changelog/README.md`).

Follow the `writing-for-humans` register (plain enough for a smart 9th grader who doesn't code — no jargon like "origin classification," "transcript head," "aggregation layer," or "SessionSchema"; describe what changed for the person using the product). Model the tone off the most recent fragments in `changelog/unreleased/` — e.g. `260721-135819-mesh-topology-honesty.md`'s `### Fixed` section style (plain declarative sentences, "no longer"/"before, now" framing) — but this is a `### Added` entry, not a fix, since it's new capability, not corrected behavior.

Content should describe, in plain language: the sidebar now shows a small, unobtrusive icon next to sessions that were not you talking to the agent directly (things like automated scheduled runs, another agent messaging this one, or a message that came in through Slack or Telegram); by default, your own recent conversations show first in the sidebar, with a quiet "+ N automated" line to reveal the rest when you want them; opening a session also shows this same information at the top of the chat. Do NOT use em dashes (project convention — use colons, parens, commas, or hyphens instead). Keep it to 2-4 short sentences/bullets, matching the length of the example fragments read above.

Acceptance criteria:

- New file at `changelog/unreleased/<fresh-timestamp-id>-session-origin.md`.
- `### Added` header, plain-language body, no em dashes, no internal jargon.
- `CHANGELOG.md` itself is untouched.

### Task 2.10: Verify the full session-origin-legibility change: typecheck, lint, and targeted tests

- **Size:** small
- **Priority:** high
- **Dependencies:** 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9
- **Parallel with:** none
- **Active form:** Verifying the full session-origin-legibility change: typecheck, lint, and targeted tests

Close the loop on every task above before this spec is considered implementation-complete. Run, in order, and fix any failures found — do not just report them:

1. `pnpm --filter @dorkos/shared build` (rebuild shared dist so downstream packages see the new `SessionOrigin`/`origin`/`originLabel` types — a documented repo gotcha: a stale `@dorkos/shared` dist causes false-red type errors elsewhere that look unrelated to this change).
2. `pnpm --filter @dorkos/shared typecheck`, `pnpm --filter @dorkos/server typecheck`, `pnpm --filter @dorkos/client typecheck`, `pnpm --filter @dorkos/test-utils typecheck` — one package at a time (faster than a full monorepo typecheck: roughly 4s vs 28s, per this repo's documented targeted-verification guidance).
3. `pnpm --filter @dorkos/server lint` and `pnpm --filter @dorkos/client lint`.
4. Every test file touched or added across the classifier, transcript-reader, task-overlay, test-utils, and client tasks, run individually via `pnpm vitest run <path>` for a fast signal:
   - `apps/server/src/services/runtimes/claude-code/sessions/__tests__/classify-origin.test.ts`
   - `apps/server/src/services/session/__tests__/transcript-reader.test.ts`
   - `apps/server/src/services/session/__tests__/task-origin-overlay.test.ts`
   - `apps/server/src/services/tasks/__tests__/task-store.test.ts`
   - `apps/client/src/layers/entities/session/ui/__tests__/OriginMark.test.tsx`
   - `apps/client/src/layers/entities/session/lib/__tests__/partition-sessions-by-origin.test.ts`
   - `apps/client/src/layers/entities/session/__tests__/SessionRow.test.tsx`
   - `apps/client/src/layers/features/dashboard-sidebar/__tests__/AgentListItem.test.tsx`
   - the `RecentSessionsSection` test file (wherever it landed)
   - the `SessionHeader` test file (wherever it landed)
5. Full suite: `pnpm test -- --run` (turbo-orchestrated). Do NOT use a bare `pnpm vitest run` for the full-suite pass — it falsely fails 2 unrelated tests in this dev environment (a documented repo gotcha, not a regression to chase); `pnpm test -- --run` is the correct full-run command.
6. Confirm `docs/api/openapi.json` is still clean by re-running `pnpm docs:export-api` and checking `git diff` is empty.
7. `pnpm knip` is not required for this change (no dead code expected — every new export introduced across this spec's tasks is consumed by the task immediately after it in the dependency chain), but a quick sanity pass is reasonable if time allows.

Acceptance criteria:

- All typecheck, lint, and test commands above pass with zero failures.
- Any failure surfaced by this task is fixed (not deferred) before this task is marked done — this is the loop-closer for the whole spec, not a report-only step.
- `docs/api/openapi.json` regeneration is idempotent (clean diff on a second run).
