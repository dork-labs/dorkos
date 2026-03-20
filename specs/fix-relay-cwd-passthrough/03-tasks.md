# Task Breakdown: fix-relay-cwd-passthrough

**Spec**: specs/fix-relay-cwd-passthrough/02-specification.md
**Generated**: 2026-03-10
**Mode**: full

---

## Summary

Two tasks, two phases. Phase 1 is the surgical code fix in one file. Phase 2 is three test cases that
verify the fix and guard the Mesh-context fallback path.

| ID  | Phase | Size  | Priority | Description                                                |
| --- | ----- | ----- | -------- | ---------------------------------------------------------- |
| 1.1 | 1     | small | high     | Extract payload cwd and replace agentCwd with effectiveCwd |
| 2.1 | 2     | small | high     | Add three cwd-from-payload unit tests                      |

---

## Phase 1 — Core Fix

### Task 1.1 — Extract payload cwd and replace agentCwd with effectiveCwd in handleAgentMessage

**File**: `packages/relay/src/adapters/claude-code-adapter.ts`

**Root cause recap**: `handleAgentMessage()` resolves the working directory exclusively from
`context?.agent?.directory`. This is undefined for web client sessions that have no Mesh
registration, even though `cwd` is present in the relay envelope payload (put there by the server
route from the `?dir=` URL parameter). The fix mirrors the pattern already used in
`handlePulseMessage()` in the same file.

**Four targeted edits:**

#### Edit 1 — Replace comment block and `agentCwd` declaration (lines 368–372)

Before:

```typescript
// Resolve agent working directory from authoritative context only.
// When context is undefined (no Mesh agent), do NOT override with
// process.cwd() — let the session's stored CWD (set by BindingRouter
// from binding.projectPath) take precedence via AgentManager fallback.
const agentCwd = context?.agent?.directory;
```

After:

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
```

#### Edit 2 — Update debug log (lines 374–378)

Before:

```typescript
log.debug?.(
  `[CCA] handleAgentMessage agentId=${agentId} ccaSessionKey=${ccaSessionKey}, ` +
    `context.agent.directory=${context?.agent?.directory ?? '(none)'}, ` +
    `resolvedCwd=${agentCwd ?? '(deferred to session)'}`
);
```

After:

```typescript
log.debug?.(
  `[CCA] handleAgentMessage agentId=${agentId} ccaSessionKey=${ccaSessionKey}, ` +
    `payloadCwd=${payloadCwd ?? '(none)'}, ` +
    `context.agent.directory=${context?.agent?.directory ?? '(none)'}, ` +
    `resolvedCwd=${effectiveCwd ?? '(deferred to session)'}`
);
```

#### Edit 3 — Replace `agentCwd` with `effectiveCwd` in `ensureSession` (lines 380–384)

Before:

```typescript
this.deps.agentManager.ensureSession(ccaSessionKey, {
  permissionMode: 'default',
  hasStarted: true,
  ...(agentCwd ? { cwd: agentCwd } : {}),
});
```

After:

```typescript
this.deps.agentManager.ensureSession(ccaSessionKey, {
  permissionMode: 'default',
  hasStarted: true,
  ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
});
```

#### Edit 4 — Replace `agentCwd` with `effectiveCwd` in `sendMessage` (line 440)

Before:

```typescript
const eventStream = this.deps.agentManager.sendMessage(ccaSessionKey, prompt, {
  ...(agentCwd ? { cwd: agentCwd } : {}),
});
```

After:

```typescript
const eventStream = this.deps.agentManager.sendMessage(ccaSessionKey, prompt, {
  ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
});
```

**Acceptance criteria:**

- `payloadCwd` is extracted inline before `ensureSession` is called
- `effectiveCwd = payloadCwd ?? agentCwd` encodes the precedence: payload wins over Mesh context
- All four usages of `agentCwd` in `handleAgentMessage` after its declaration are replaced with `effectiveCwd`
- The debug log includes `payloadCwd=` as a field
- `pnpm typecheck` passes with no new errors

---

## Phase 2 — Test Coverage

### Task 2.1 — Add three cwd-from-payload unit tests to claude-code-adapter.test.ts

**File**: `packages/relay/src/adapters/__tests__/claude-code-adapter.test.ts`
**Depends on**: Task 1.1

**Insertion point**: After the existing test `'uses context.agent.directory when Mesh context is
provided'` (line 281) and before the `// === Pulse message delivery ===` comment (line 296). No new
imports are required — `AdapterContext` is already imported from `'../../types.js'`.

#### Test 1 — payload cwd passes through with no agent context (primary bug fix validation)

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
```

#### Test 2 — payload cwd wins over Mesh agent context (precedence validation)

```typescript
it('prefers payload cwd over agent context directory', async () => {
  // Purpose: Validates fallback precedence — payload cwd wins over Mesh agent context.
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
```

#### Test 3 — falls back to agent context when payload has no cwd (non-regression guard)

```typescript
it('falls back to agent context directory when payload has no cwd', async () => {
  // Purpose: Ensures Mesh agent routing is not regressed — when payload cwd is absent,
  // context.agent.directory still wins.
  await adapter.start(relay);
  const envelope = createTestEnvelope(); // payload: { content: 'Run the budget report' } — no cwd
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

**Note on test 3**: This test passes before task 1.1 is applied, making it a true non-regression
guard. It uses `createTestEnvelope()` without a `cwd` in the payload, so `payloadCwd` will be
`undefined` and the fallback to `context.agent.directory` is exercised.

**Note on existing test compatibility**: The test `'does not pass cwd when no context is provided
(lets session.cwd take precedence)'` (line 262) uses `createTestEnvelope()` with no `cwd` in the
payload and no context. After task 1.1, `payloadCwd` will be `undefined`, `agentCwd` will be
`undefined`, and `effectiveCwd` will be `undefined` — so the existing assertion
`expect(ensureCall[1]).not.toHaveProperty('cwd')` continues to hold. No changes to that test.

**Acceptance criteria:**

- All three new tests pass: `pnpm vitest run packages/relay/src/adapters/__tests__/claude-code-adapter.test.ts`
- All existing tests continue to pass (full suite green)
- No new imports added to the test file

---

## Verification

After both tasks are complete, run the full test command to confirm no regressions:

```bash
pnpm vitest run packages/relay/src/adapters/__tests__/claude-code-adapter.test.ts
```

For manual end-to-end verification:

1. Start DorkOS with `DORKOS_RELAY_ENABLED=true`
2. Open `http://localhost:4241/?dir=/tmp/test-relay-cwd`
3. Click "+ New session" and send "Run pwd in bash"
4. Confirm the agent reports `/tmp/test-relay-cwd`
5. Confirm JSONL created under `~/.claude/projects/-tmp-test-relay-cwd/`
