---
slug: fix-relay-cwd-passthrough
number: 108
created: 2026-03-10
status: ideation
---

# Fix Relay CWD Passthrough

**Slug:** fix-relay-cwd-passthrough
**Author:** Claude Code
**Date:** 2026-03-10
**Branch:** preflight/fix-relay-cwd-passthrough

---

## 1) Intent & Assumptions

- **Task brief:** The `?dir=` URL parameter is ignored when creating new sessions with Relay enabled. The `cwd` value is correctly included in the relay message payload by the server route, but `ClaudeCodeAdapter.handleAgentMessage()` never reads it — so the agent always runs in the server's default working directory instead of the user-specified directory.
- **Assumptions:**
  - The CWD must reach the agent via the relay payload (it's the only channel available for web client sessions without Mesh context)
  - The fix should mirror the pattern already used in `handlePulseMessage()`, which correctly extracts `cwd` from its payload
  - `ensureSession` is a no-op when the session already exists, so the fix only matters for new sessions (first message)
- **Out of scope:**
  - Changing the relay payload schema (cwd is already in it)
  - The `permissionMode: 'default'` hardcode in `handleAgentMessage` — since `ensureSession` is a no-op when the session already exists (set via the client's PATCH call), this is benign for normal flows
  - Client-side changes (the client already sends cwd correctly)
  - Model selection persistence issues observed during self-test (separate bug)

---

## 2) Pre-reading Log

- `test-results/chat-self-test/20260310-065059.md`: Self-test evidence — agent reported CWD `/Users/doriancollier/Keep/dork-os/core/apps` when URL specified `?dir=/Users/doriancollier/Keep/temp/empty`. JSONL confirmed: session created in wrong project directory.
- `apps/server/src/routes/sessions.ts`: `publishViaRelay()` at line 173 correctly puts `{ content, cwd, correlationId }` in the relay message payload. The POST `/api/sessions/:id/messages` handler extracts `cwd` from the request body (line 202) and passes it through.
- `packages/relay/src/adapters/claude-code-adapter.ts`: `handleAgentMessage()` resolves CWD only from Mesh agent context (line 372: `const agentCwd = context?.agent?.directory`). `payloadObj` is already parsed (lines 402-405) but `cwd` is never extracted from it. `ensureSession` and `sendMessage` both use only `agentCwd`.
- `packages/relay/src/adapters/claude-code-adapter.ts:595-596`: `handlePulseMessage()` correctly extracts `cwd` from payload: `const { scheduleId, runId, prompt, cwd, permissionMode } = payload; const effectiveCwd = cwd ?? context?.agent?.directory ?? this.config.defaultCwd;`
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts:175-201`: `ensureSession()` only creates a session if one doesn't already exist (`if (!this.sessions.has(sessionId))`). If the client sent a PATCH first, the session is pre-created with correct permissionMode, and the adapter's `ensureSession` call is harmless.
- `packages/shared/src/schemas.ts:110-116`: `SendMessageRequestSchema` includes `cwd: z.string().optional()` — the field is already in the schema and in the payload.

---

## 3) Codebase Map

**Primary file to change:**

- `packages/relay/src/adapters/claude-code-adapter.ts` — `handleAgentMessage()` method around lines 372-441: add `cwd` extraction from `payloadObj` (which is already parsed) and pass `effectiveCwd` to `ensureSession` and `sendMessage`

**Supporting files (read-only, for context):**

- `apps/server/src/routes/sessions.ts` — `publishViaRelay()` (line 152): puts `cwd` in the relay payload. No changes needed.
- `packages/shared/src/schemas.ts` — `SendMessageRequestSchema`: `cwd` field already present. No changes needed.
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` — `ensureSession()` and `sendMessage()`: accept optional `cwd` in `SessionOpts`. No changes needed.

**Test files:**

- `packages/relay/src/adapters/__tests__/claude-code-adapter.test.ts` (if exists) — add test case for cwd passthrough via payload
- `apps/server/src/services/relay/__tests__/adapter-manager.test.ts` — may need a coverage check

**Potential blast radius:**

- Direct: 1 file (`claude-code-adapter.ts`)
- Indirect: 0 files (all callers go through the relay message envelope)
- Tests: 1-2 test files need a new test case

---

## 4) Root Cause Analysis

**Repro steps:**

1. Start DorkOS with Relay enabled (`DORKOS_RELAY_ENABLED=true`)
2. Open `http://localhost:4241/?dir=/some/custom/directory`
3. Click "+ New session"
4. Send a message: "Run pwd in bash and tell me the result"
5. Observe reported CWD

**Observed vs Expected:**

- Observed: Agent reports `/Users/doriancollier/Keep/dork-os/core/apps` (server's default CWD)
- Expected: Agent reports `/some/custom/directory` (from the `?dir=` URL param)

**Evidence:**

- JSONL file created in `~/.claude/projects/-Users-doriancollier-Keep-dork-os-core-apps/` instead of `~/.claude/projects/-Users-doriancollier-Keep-some-custom-directory/`
- Server `api/config` response: `workingDirectory: /Users/doriancollier/Keep/dork-os/core/apps/server` — confirms server's default CWD is being used
- Relay publish payload (sessions.ts:175): `{ content, cwd, correlationId }` — cwd IS in the payload
- Adapter handleAgentMessage (adapter line 372): `const agentCwd = context?.agent?.directory` — cwd is NOT read from payload

**Root-cause hypotheses:**

- **[HIGH CONFIDENCE] Missing payload extraction in handleAgentMessage**: The `payloadObj` is parsed on lines 402-405 to extract `correlationId` (line 421) but `cwd` is never extracted from it. The code only reads CWD from `context?.agent?.directory` (Mesh agent context), which is `undefined` for web client sessions without Mesh.
- [VERY LOW] Client not sending cwd: Ruled out — `sessions.ts:202` shows `cwd` is extracted from request body and `sessions.ts:175` passes it to `publishViaRelay`.
- [VERY LOW] Schema missing cwd: Ruled out — `SendMessageRequestSchema` includes `cwd: z.string().optional()`.

**Decision:** The high-confidence hypothesis is confirmed. The fix is to extract `cwd` from `payloadObj` in `handleAgentMessage()` before the `ensureSession` call, using the same precedence as `handlePulseMessage`: `payloadCwd ?? agentCwd`.

---

## 5) Research

Skipped per user instruction ("you can skip the deep research"). The fix pattern is directly observable from `handlePulseMessage()` in the same file.

**Pattern to follow (handlePulseMessage, line 595-596):**

```typescript
const { scheduleId, runId, prompt, cwd, permissionMode } = payload;
const effectiveCwd = cwd ?? context?.agent?.directory ?? this.config.defaultCwd;
```

**Applied to handleAgentMessage:**

```typescript
// After payloadObj is resolved (line ~405), before ensureSession call (line ~380):
const payloadCwd = payloadObj?.cwd as string | undefined;
const agentCwd = context?.agent?.directory;
const effectiveCwd = payloadCwd ?? agentCwd;

// Replace both uses of agentCwd with effectiveCwd:
this.deps.agentManager.ensureSession(ccaSessionKey, {
  permissionMode: 'default',
  hasStarted: true,
  ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
});
// ...
const eventStream = this.deps.agentManager.sendMessage(ccaSessionKey, prompt, {
  ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
});
```

Note: `payloadObj` is currently resolved after the `ensureSession` call (line ~402). The `payloadObj` resolution block needs to move before `ensureSession`, or `cwd` extraction needs to happen at the same time as the existing `agentCwd` resolution (line 372). Moving just the cwd extraction is cleaner.

---

## 6) Decisions

No ambiguities identified — the task brief and code analysis converge on a single, obvious fix. The Pulse path already shows the correct pattern.

| #   | Decision                     | Choice                                                       | Rationale                                                                                                                                                                               |
| --- | ---------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Where to extract payload cwd | Before `ensureSession` call, alongside `agentCwd` resolution | `ensureSession` is the session creation point — cwd must be resolved before it's called                                                                                                 |
| 2   | Fallback precedence          | `payloadCwd ?? agentCwd` (no server default fallback)        | Matches Pulse pattern minus the server default; for web sessions, undefined is fine — the SDK will use its own default, which is the session's stored cwd or the server's process.cwd() |
| 3   | Scope of fix                 | CWD only; do NOT add permissionMode to payload               | permissionMode is correctly handled via the separate PATCH endpoint; adding it to the relay payload would create a competing update channel                                             |
