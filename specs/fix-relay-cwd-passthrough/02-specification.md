---
slug: fix-relay-cwd-passthrough
number: 108
title: Fix Relay CWD Passthrough in handleAgentMessage
status: draft
created: 2026-03-10
authors:
  - Claude Code
---

# Fix Relay CWD Passthrough in handleAgentMessage

## Status

Draft

## Authors

Claude Code — 2026-03-10

---

## Overview

When a user opens DorkOS with `?dir=/some/path` and creates a new session with Relay enabled, the
agent always starts in the server's default working directory instead of the user-specified path.
The `cwd` value is correctly transmitted in the relay message payload by the server route, but
`ClaudeCodeAdapter.handleAgentMessage()` never reads it — it only consults Mesh agent context
(`context?.agent?.directory`), which is `undefined` for web client sessions without a Mesh
registration. This is a one-file, surgical fix that mirrors the pattern already used in
`handlePulseMessage()` in the same adapter.

---

## Background / Problem Statement

### Data Flow

```
Client (?dir=/some/path)
  → POST /api/sessions/:id/messages  { cwd: "/some/path", content: "..." }
  → sessions.ts:publishViaRelay()    { content, cwd, correlationId }   ← cwd in payload ✅
  → Relay publish → RelayCore.deliver()
  → ClaudeCodeAdapter.handleAgentMessage()
      agentCwd = context?.agent?.directory  ← undefined (no Mesh)      ← BUG ❌
      ensureSession(key, { /* no cwd */ })
      sendMessage(key, prompt, { /* no cwd */ })
  → SDK session created in server process.cwd()
```

### Evidence

From self-test `test-results/chat-self-test/20260310-065059.md`:

- Agent reported CWD `/Users/doriancollier/Keep/dork-os/core/apps` when URL was `?dir=/Users/doriancollier/Keep/temp/empty`
- JSONL created in `~/.claude/projects/-Users-doriancollier-Keep-dork-os-core-apps/` (server CWD), not the specified dir

### Root Cause

`payloadObj` (the parsed relay envelope payload) is resolved at line 402 — **after** `ensureSession`
is called at line 380. Even though `cwd` is in the payload, it is never extracted for use in
`ensureSession` or `sendMessage`. The code only reads CWD from `context?.agent?.directory`, which is
populated only for Mesh-registered agents.

### Existing Correct Pattern

`handlePulseMessage()` in the same file correctly extracts `cwd` from its payload (line 595–596):

```typescript
const { scheduleId, runId, prompt, cwd, permissionMode } = payload;
const effectiveCwd = cwd ?? context?.agent?.directory ?? this.config.defaultCwd;
```

`handleAgentMessage()` must follow the same pattern — without the `this.config.defaultCwd` fallback
(for web sessions, `undefined` is correct; the SDK uses its own default, which respects the
session's previously stored CWD).

---

## Goals

- When `?dir=` is set in the URL and the client sends a message on a new Relay session, the agent
  starts in the specified directory
- The debug log emitted at the start of `handleAgentMessage` reflects the CWD resolution including
  the payload source
- A new unit test validates the cwd-from-payload code path

---

## Non-Goals

- Changing the relay payload schema (`cwd` is already present in `SendMessageRequestSchema`)
- Adding `permissionMode` passthrough via relay payload (handled via the separate PATCH endpoint)
- Client-side changes (the client already sends `cwd` correctly)
- Fixing model selection persistence (separate bug, noted in ideation)
- Adding a server-default fallback (`this.config.defaultCwd`) to `handleAgentMessage` — Pulse
  includes it because scheduled tasks have a configured project dir; agent messages from the web
  client should not override a session's pre-existing stored CWD

---

## Technical Dependencies

- **TypeScript** — no new dependencies; change is additive within existing types
- `packages/relay/src/adapters/claude-code-adapter.ts` — primary change
- `packages/relay/src/adapters/__tests__/claude-code-adapter.test.ts` — new test case

No schema changes. No new packages. No migration needed.

---

## Detailed Design

### Change: Inline CWD Extraction Before `ensureSession`

The cleanest approach (per ideation Section 5) is to extract `cwd` from the envelope payload
**inline**, at the same location as the existing `agentCwd` resolution (line 372), without moving
the full `payloadObj` parse block.

#### Current Code (lines 368–384, 439–441)

```typescript
// Resolve agent working directory from authoritative context only.
// When context is undefined (no Mesh agent), do NOT override with
// process.cwd() — let the session's stored CWD (set by BindingRouter
// from binding.projectPath) take precedence via AgentManager fallback.
const agentCwd = context?.agent?.directory;
const log = this.deps.logger ?? console;
log.debug?.(
  `[CCA] handleAgentMessage agentId=${agentId} ccaSessionKey=${ccaSessionKey}, ` +
    `context.agent.directory=${context?.agent?.directory ?? '(none)'}, ` +
    `resolvedCwd=${agentCwd ?? '(deferred to session)'}`
);

this.deps.agentManager.ensureSession(ccaSessionKey, {
  permissionMode: 'default',
  hasStarted: true,
  ...(agentCwd ? { cwd: agentCwd } : {}),
});
// ...
const eventStream = this.deps.agentManager.sendMessage(ccaSessionKey, prompt, {
  ...(agentCwd ? { cwd: agentCwd } : {}),
});
```

#### After Fix (same lines)

```typescript
// Resolve agent working directory.
// Priority: relay payload cwd (from ?dir= URL param via web client)
//   > Mesh agent context directory (for registered agents)
// No server-default fallback — for web sessions, undefined defers to
// the session's stored CWD or the SDK's own process.cwd() default.
const payloadCwd =
  typeof envelope.payload === 'object' && envelope.payload !== null
    ? ((envelope.payload as Record<string, unknown>).cwd as string | undefined)
    : undefined;
const agentCwd = context?.agent?.directory;
const effectiveCwd = payloadCwd ?? agentCwd;
const log = this.deps.logger ?? console;
log.debug?.(
  `[CCA] handleAgentMessage agentId=${agentId} ccaSessionKey=${ccaSessionKey}, ` +
    `payloadCwd=${payloadCwd ?? '(none)'}, ` +
    `context.agent.directory=${context?.agent?.directory ?? '(none)'}, ` +
    `resolvedCwd=${effectiveCwd ?? '(deferred to session)'}`
);

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

#### Why Inline Extraction (Not Moving `payloadObj`)

The full `payloadObj` parse block at lines 402–405 gates on several `unknown` → `Record<string,
unknown>` type assertion patterns shared with stream-event filtering and `correlationId` extraction.
Moving it before `ensureSession` would intermingle CWD resolution with the stream-event skip path
(which is intentionally placed after `ensureSession` + trace span updates). Extracting `cwd`
inline is minimal, readable, and doesn't disturb the established control flow.

### Fallback Precedence

| Source                    | Condition                | `effectiveCwd`                                 |
| ------------------------- | ------------------------ | ---------------------------------------------- |
| Payload `cwd`             | Web client sends `?dir=` | `/user/specified/path`                         |
| `context.agent.directory` | Mesh-registered agent    | Agent's project dir                            |
| `undefined`               | Neither present          | SDK uses session stored CWD or `process.cwd()` |

This exactly mirrors the Pulse path minus the final `this.config.defaultCwd` fallback.

### Files Changed

| File                                                                | Change                                                                                                                        |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `packages/relay/src/adapters/claude-code-adapter.ts`                | Inline `payloadCwd` extraction; update debug log; replace `agentCwd` with `effectiveCwd` in `ensureSession` and `sendMessage` |
| `packages/relay/src/adapters/__tests__/claude-code-adapter.test.ts` | New test case: cwd from payload                                                                                               |

---

## User Experience

**Before:** Navigating to `http://localhost:4241/?dir=/my/project` and starting a new Relay-mode
session silently ignores `/my/project`. The agent runs in the server's default working directory.
`pwd` reports the wrong path; JSONL files land in the wrong `~/.claude/projects/` slug.

**After:** The specified directory is respected. The agent's first `pwd` returns `/my/project`.
JSONL files are created under the correct project slug. Behavior is identical to non-Relay mode.

---

## Testing Strategy

### New Unit Test

Add to `packages/relay/src/adapters/__tests__/claude-code-adapter.test.ts`:

```typescript
it('passes cwd from relay payload to ensureSession and sendMessage when no agent context', async () => {
  // Purpose: Validates the bug fix — relay payload cwd must be extracted and
  // forwarded even when context.agent.directory is undefined (web client sessions).
  await adapter.start(relay);
  const envelope = createTestEnvelope({
    payload: { content: 'Run pwd', cwd: '/my/project', correlationId: 'corr-123' },
  });

  const result = await adapter.deliver(envelope.subject, envelope, undefined /* no context */);

  expect(result.success).toBe(true);
  expect(agentManager.ensureSession).toHaveBeenCalledWith(
    'session-abc',
    expect.objectContaining({ cwd: '/my/project' })
  );
  const sendArgs = vi.mocked(agentManager.sendMessage).mock.calls[0];
  expect(sendArgs[2]).toEqual(expect.objectContaining({ cwd: '/my/project' }));
});

it('prefers payload cwd over agent context directory', async () => {
  // Purpose: Validates fallback precedence — payload cwd wins over Mesh agent context
  // to allow web clients to override the registered agent's project directory.
  await adapter.start(relay);
  const envelope = createTestEnvelope({
    payload: { content: 'Run pwd', cwd: '/payload/path', correlationId: 'corr-456' },
  });
  const context: AdapterContext = {
    agent: { directory: '/mesh/agent/path', runtime: 'claude-code' },
  };

  await adapter.deliver(envelope.subject, envelope, context);

  expect(agentManager.ensureSession).toHaveBeenCalledWith(
    'session-abc',
    expect.objectContaining({ cwd: '/payload/path' })
  );
});

it('falls back to agent context directory when payload has no cwd', async () => {
  // Purpose: Ensures Mesh agent routing is not regressed — when payload cwd is absent,
  // context.agent.directory still wins.
  await adapter.start(relay);
  const envelope = createTestEnvelope(); // payload: { content: 'Run the budget report' }
  const context: AdapterContext = {
    agent: { directory: '/projects/myapp', runtime: 'claude-code' },
  };

  await adapter.deliver(envelope.subject, envelope, context);

  expect(agentManager.ensureSession).toHaveBeenCalledWith(
    'session-abc',
    expect.objectContaining({ cwd: '/projects/myapp' })
  );
});
```

> **Note:** The third test (`falls back to agent context directory`) already passes before the fix,
> serving as a non-regression guard for Mesh-context sessions.

### Existing Tests (Non-Regression)

The existing test `'delivers agent message — calls AgentManager with correct cwd and formatted prompt'`
already verifies that `context.agent.directory` is forwarded correctly. It must continue to pass
unchanged.

### Manual Verification

1. Start DorkOS with `DORKOS_RELAY_ENABLED=true`
2. Open `http://localhost:4241/?dir=/tmp/test-relay-cwd`
3. Click "+ New session" → send "Run pwd in bash"
4. Confirm agent reports `/tmp/test-relay-cwd`
5. Confirm JSONL under `~/.claude/projects/-tmp-test-relay-cwd/`

---

## Performance Considerations

None. The inline extraction (`typeof envelope.payload === 'object'`) is a single type check
that runs once per message. No additional I/O, no new allocations beyond two local variables.

---

## Security Considerations

The `cwd` value originates from the client URL parameter (`?dir=`), which passes through Zod
validation in `SendMessageRequestSchema` on the server before being placed in the relay payload.
The SDK `sendMessage` call receives `cwd` as a parameter — the SDK itself enforces that the path
must exist (or creates sessions in the OS default). No new attack surface is introduced.

---

## Documentation

No user-facing documentation update needed. The `?dir=` parameter behavior is already documented
as working — this fix makes reality match the documented intent.

The debug log change (`payloadCwd=${...}`) is observable at `LOG_LEVEL=debug` and aids future
debugging of CWD resolution.

---

## Implementation Phases

### Phase 1 — Core Fix

1. In `claude-code-adapter.ts`, add inline `payloadCwd` extraction before `ensureSession`
2. Introduce `effectiveCwd = payloadCwd ?? agentCwd`
3. Replace both `agentCwd` references in `ensureSession` and `sendMessage` with `effectiveCwd`
4. Update debug log to include `payloadCwd` field

### Phase 2 — Test Coverage

5. Add three new test cases to `claude-code-adapter.test.ts` (payload cwd, precedence, fallback)
6. Run `pnpm vitest run packages/relay/src/adapters/__tests__/claude-code-adapter.test.ts` — all green

---

## Open Questions

None. All decisions resolved in ideation Section 6.

---

## Related ADRs

- **ADR-0076** (`decisions/0076-mesh-ulid-vs-sdk-uuid-dual-id-traceability.md`) — Dual-ID session
  key strategy; `ccaSessionKey` is the canonical key used in `ensureSession`
- **ADR-0075** (`decisions/0075-promise-chain-queue-for-cca-concurrency.md`) — CCA concurrency
  model; this fix does not alter the semaphore or promise chain
- **ADR-0094** (`decisions/0094-per-message-correlation-id-for-relay-event-filtering.md`) —
  `correlationId` is extracted from `payloadObj` after `ensureSession`; this fix does not change
  that extraction

---

## References

- Ideation: `specs/fix-relay-cwd-passthrough/01-ideation.md`
- Self-test evidence: `test-results/chat-self-test/20260310-065059.md`
- Related spec (different bug, same method): `specs/fix-relay-agent-routing-cwd/02-specification.md`
- Pulse pattern reference: `packages/relay/src/adapters/claude-code-adapter.ts:595–596`
