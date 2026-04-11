# Permission Mode Management

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-04-10
**Spec #:** 230
**Ideation:** `specs/permission-mode-management/01-ideation.md`
**Supersedes:** Spec #135 (agent-permission-mode) for the chat client UI surface

---

## Overview

Expand permission mode management to support all 6 Claude Agent SDK modes and fix the `message-sender.ts` allowlist that silently drops unrecognized modes. The 2 missing modes (`dontAsk`, `auto`) are added to the Zod schema, runtime capabilities, and status bar UI. The `PermissionModeItem` dropdown renders dynamically from runtime capabilities. `auto` mode failures (strict SDK prerequisites) are handled gracefully with an inline error and optimistic revert.

## Background / Problem Statement

The Claude Agent SDK supports 6 permission modes, but DorkOS only surfaces 4 in its schema, capabilities, and UI:

| Mode                | In DorkOS? | In SDK? |
| ------------------- | ---------- | ------- |
| `default`           | Yes        | Yes     |
| `plan`              | Yes        | Yes     |
| `acceptEdits`       | Yes        | Yes     |
| `dontAsk`           | **No**     | Yes     |
| `bypassPermissions` | Yes        | Yes     |
| `auto`              | **No**     | Yes     |

Additionally, `message-sender.ts` has a hardcoded 3-value allowlist (lines 223-228) that silently falls back to `default` for any mode not in `['bypassPermissions', 'plan', 'acceptEdits']`. Even after expanding the schema, new modes would be silently dropped at query time.

The mid-stream `setPermissionMode()` infrastructure **already exists** in `session-store.ts:183-187` — this spec does not need to add it. The work is purely about schema expansion, removing the allowlist bottleneck, and updating the UI.

## Goals

- Support all 6 Claude Agent SDK permission modes in schema, server, and client
- Remove the `message-sender.ts` allowlist so all valid `PermissionMode` values pass through to the SDK
- Add `dontAsk` and `auto` modes to the status bar `PermissionModeItem` dropdown
- Render permission modes dynamically from `RuntimeCapabilities.supportedPermissionModes`
- Handle `auto` mode's strict prerequisites gracefully (try, fail, inform, revert)
- Show informational descriptions for `dontAsk` mode's "allowlist-only" behavior
- Maintain runtime-agnostic architecture — future runtimes declare their own supported modes

## Non-Goals

- Per-tool `allowedTools` configuration UI (separate feature)
- OpenCode-specific permission mode mapping (deferred until that runtime exists)
- Adapter binding permission modes (spec #135 scope — follow-up using the same expanded schema)
- Claude Code admin settings detection for `auto` mode gating
- Adding a toast/notification library (use existing error handling patterns)

## Technical Dependencies

- `zod` — schema validation (already in use)
- `@dorkos/shared` — `PermissionModeSchema`, `RuntimeCapabilities`, `AgentRuntime` interface
- `@anthropic-ai/claude-agent-sdk` — `query()`, `Query.setPermissionMode()`, `PermissionMode` type
- `lucide-react` — icons for new modes (already in use)
- Shadcn `ResponsiveDropdownMenu` — status bar dropdown (already available)
- No new external dependencies required

## Detailed Design

### 1. Schema Expansion — `PermissionModeSchema`

**File:** `packages/shared/src/schemas.ts` (lines 17-19)

```typescript
export const PermissionModeSchema = z
  .enum(['default', 'plan', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'auto'])
  .openapi('PermissionMode');
```

The `PermissionMode` type automatically expands via `z.infer`. All downstream consumers (session store, route validators, client types) pick up the new values without additional changes.

**Ordering rationale:** Modes are listed in ascending order of autonomy — `default` (most restrictive) to `auto` (most autonomous). `dontAsk` goes after `acceptEdits` because it's a lockdown mode (medium restrictiveness), not an escalation. `bypassPermissions` and `auto` are the most permissive.

### 2. Runtime Capabilities Expansion

**File:** `apps/server/src/services/runtimes/claude-code/runtime-constants.ts`

```typescript
export const CLAUDE_CODE_CAPABILITIES: RuntimeCapabilities = {
  type: 'claude-code',
  supportsPermissionModes: true,
  supportedPermissionModes: [
    'default',
    'plan',
    'acceptEdits',
    'dontAsk',
    'bypassPermissions',
    'auto',
  ],
  supportsToolApproval: true,
  supportsCostTracking: true,
  supportsResume: true,
  supportsMcp: true,
  supportsQuestionPrompt: true,
};
```

**File:** `apps/server/src/services/runtimes/test-mode/test-mode-runtime.ts`

Update the `getCapabilities()` return to include `supportedPermissionModes` matching the same 6 values.

**File:** `packages/test-utils/src/fake-agent-runtime.ts`

Add `supportedPermissionModes` to the capabilities returned by `getCapabilities()`.

### 3. Message Sender Fix — Remove Allowlist

**File:** `apps/server/src/services/runtimes/claude-code/message-sender.ts` (lines 223-231)

**Before (current — broken for new modes):**

```typescript
sdkOptions.permissionMode =
  session.permissionMode === 'bypassPermissions' ||
  session.permissionMode === 'plan' ||
  session.permissionMode === 'acceptEdits'
    ? session.permissionMode
    : 'default';
if (session.permissionMode === 'bypassPermissions') {
  sdkOptions.allowDangerouslySkipPermissions = true;
}
```

**After (passthrough all valid modes):**

```typescript
// Pass the session's permission mode directly to the SDK.
// The schema validates valid values upstream; no allowlist needed here.
sdkOptions.permissionMode = session.permissionMode;
if (session.permissionMode === 'bypassPermissions') {
  sdkOptions.allowDangerouslySkipPermissions = true;
}
```

This is the critical fix. The old code silently converted any unrecognized mode to `default`, including the newly added `dontAsk` and `auto`. Since `PermissionModeSchema` validates all values at the API boundary (route handlers), there's no need for a redundant allowlist in the message sender.

### 4. Permission Mode UI Expansion

**File:** `apps/client/src/layers/features/status/ui/PermissionModeItem.tsx`

#### 4a. Mode Metadata

Expand the `PERMISSION_MODES` array with the 2 new entries:

```typescript
import { Shield, ShieldCheck, ShieldOff, ClipboardList, Lock, Sparkles } from 'lucide-react';

const PERMISSION_MODES: {
  value: PermissionMode;
  label: string;
  icon: LucideIcon;
  description: string;
  warn?: boolean;
}[] = [
  { value: 'default', label: 'Default', icon: Shield, description: 'Prompt for each tool call' },
  {
    value: 'acceptEdits',
    label: 'Accept Edits',
    icon: ShieldCheck,
    description: 'Auto-approve file edits',
  },
  {
    value: 'plan',
    label: 'Plan Mode',
    icon: ClipboardList,
    description: 'Research only, no edits',
  },
  {
    value: 'dontAsk',
    label: "Don't Ask",
    icon: Lock,
    description: 'Only pre-approved tools run; everything else denied',
  },
  {
    value: 'bypassPermissions',
    label: 'Bypass All',
    icon: ShieldOff,
    description: 'Auto-approve everything',
    warn: true,
  },
  {
    value: 'auto',
    label: 'Auto',
    icon: Sparkles,
    description: 'AI classifier auto-approves actions',
    warn: true,
  },
];
```

**Icon choices:**

- `Lock` for `dontAsk` — conveys lockdown/restrictive behavior
- `Sparkles` for `auto` — conveys AI/magic/automatic decision-making

#### 4b. Capability-Based Filtering

Accept optional `supportedModes` prop to filter modes by what the runtime supports:

```typescript
interface PermissionModeItemProps {
  mode: PermissionMode;
  onChangeMode: (mode: PermissionMode) => void;
  disabled?: boolean;
  /** When provided, only modes in this array are shown. */
  supportedModes?: PermissionMode[];
}

export function PermissionModeItem({
  mode, onChangeMode, disabled, supportedModes,
}: PermissionModeItemProps) {
  const availableModes = supportedModes
    ? PERMISSION_MODES.filter((m) => supportedModes.includes(m.value))
    : PERMISSION_MODES;

  const current = availableModes.find((m) => m.value === mode)
    ?? PERMISSION_MODES.find((m) => m.value === mode)
    ?? PERMISSION_MODES[0];
  // ...rest of component uses availableModes instead of PERMISSION_MODES
```

The fallback chain ensures the current mode always renders even if it's not in `supportedModes` (defensive).

#### 4c. Warning Styling

Use the existing `warn` field to apply danger styling to both `bypassPermissions` and `auto`:

```typescript
{availableModes.map((m) => (
  <ResponsiveDropdownMenuRadioItem
    key={m.value}
    value={m.value}
    icon={m.icon}
    description={m.description}
    className={m.warn ? 'text-red-500' : ''}
  >
    {m.label}
  </ResponsiveDropdownMenuRadioItem>
))}
```

### 5. ChatStatusSection Wiring

**File:** `apps/client/src/layers/features/chat/ui/status/ChatStatusSection.tsx`

Pass `supportedModes` from capabilities to `PermissionModeItem`:

```typescript
import { useDefaultCapabilities } from '@/layers/entities/runtime';

// Inside component:
const capabilities = useDefaultCapabilities();

<PermissionModeItem
  mode={status.permissionMode}
  onChangeMode={(mode) => status.updateSession({ permissionMode: mode })}
  disabled={!sessionId}
  supportedModes={capabilities?.supportedPermissionModes}
/>
```

The `useDefaultCapabilities()` hook already exists with `staleTime: Infinity` — perfect for this use case since capabilities rarely change.

### 6. Auto Mode Error Handling

When the user selects `auto` mode and the SDK rejects it (prerequisites unmet), the error must surface in the UI. The current architecture has a gap: `session-store.ts` catches `setPermissionMode()` errors silently.

#### 6a. Server — Propagate `setPermissionMode()` Errors

**File:** `apps/server/src/services/runtimes/claude-code/session-store.ts` (lines 176-187)

The current code:

```typescript
if (opts.permissionMode) {
  session.permissionMode = opts.permissionMode;
  if (session.activeQuery) {
    session.activeQuery.setPermissionMode(opts.permissionMode).catch((err) => {
      logger.error('[updateSession] setPermissionMode failed', { sessionId, err });
    });
  }
}
```

The fix: make the permission mode update **await** the SDK call when an active query exists, and throw on failure so the route handler can return an error:

```typescript
if (opts.permissionMode) {
  const prevMode = session.permissionMode;
  session.permissionMode = opts.permissionMode;
  if (session.activeQuery) {
    try {
      await session.activeQuery.setPermissionMode(opts.permissionMode);
    } catch (err) {
      // Revert in-memory state on SDK rejection
      session.permissionMode = prevMode;
      logger.error('[updateSession] setPermissionMode failed', { sessionId, err });
      throw err;
    }
  }
}
```

**Impact:** `updateSession()` signature changes from synchronous (`boolean`) to asynchronous (`Promise<boolean>`). This requires updating the `AgentRuntime` interface and all callers.

**AgentRuntime interface change** (`packages/shared/src/agent-runtime.ts`):

```typescript
updateSession(
  sessionId: string,
  opts: {
    permissionMode?: PermissionMode;
    model?: string;
    effort?: EffortLevel;
    fastMode?: boolean;
    autoMode?: boolean;
  }
): boolean | Promise<boolean>;
```

The return type becomes `boolean | Promise<boolean>` so existing synchronous implementations (test-mode, fake) continue to work without changes.

**Route handler change** (`apps/server/src/routes/sessions.ts`):

```typescript
try {
  const updated = await runtime.updateSession(sessionId, opts);
  if (!updated) return res.status(404).json({ error: 'Session not found' });
  // ... return success
} catch (err) {
  return res.status(422).json({
    error: 'Permission mode rejected by runtime',
    message: err instanceof Error ? err.message : 'Unknown error',
  });
}
```

#### 6b. Client — Revert on Error

**File:** `apps/client/src/layers/entities/session/model/use-session-status.ts`

The existing `catch` block already reverts optimistic state:

```typescript
} catch (err) {
  console.error('[useSessionStatus] updateSession failed for session', sessionId, err);
  if (opts.model) setLocalModel(null);
  if (opts.permissionMode) setLocalPermissionMode(null);
  // ...
}
```

When `auto` mode fails (422 response), `setLocalPermissionMode(null)` reverts to the server-confirmed mode. The UI automatically shows the previous mode via the priority chain: `localPermissionMode ?? session?.permissionMode ?? 'default'`.

**No toast needed.** The revert itself is the feedback. The user sees the mode snap back to the previous value. This is consistent with how model changes that fail also revert silently. A console error is logged for debugging.

## User Experience

### Selecting a Permission Mode

1. User clicks the permission mode item in the status bar
2. Dropdown shows all modes supported by the current runtime (typically all 6 for Claude Code)
3. Each mode has an icon, label, and description
4. `bypassPermissions` and `auto` show in red (elevated risk)
5. User selects a mode → UI updates immediately (optimistic)
6. Server persists the change; if streaming, `setPermissionMode()` applies it mid-stream

### `auto` Mode Failure

1. User selects "Auto" from the dropdown
2. UI shows "Auto" immediately (optimistic)
3. Server calls `setPermissionMode('auto')` on the SDK
4. SDK rejects (account/model/plan requirements not met)
5. Server returns 422 to the client
6. Client reverts `localPermissionMode` to null
7. UI snaps back to the previous mode
8. Console logs the specific SDK error for debugging

### `dontAsk` Mode

1. User selects "Don't Ask" from the dropdown
2. Description reads: "Only pre-approved tools run; everything else denied"
3. Mode applies immediately — the SDK's `dontAsk` behavior takes over
4. Only tools in the agent's `allowedTools` list will execute
5. No additional configuration needed — `buildAllowedTools(toolConfig)` in `message-sender.ts` already populates the SDK's `allowedTools` option

### Future Runtime Support

1. A new runtime (e.g., OpenCode) is added with `supportedPermissionModes: ['default', 'custom_mode']`
2. `GET /api/capabilities` returns the runtime's supported modes
3. `useDefaultCapabilities()` returns the data
4. `PermissionModeItem` filters `PERMISSION_MODES` by `supportedModes`
5. Only "Default" and any matching modes appear in the dropdown
6. No code changes needed — fully data-driven

## Testing Strategy

### Unit Tests — Schema

**File:** `packages/shared/src/__tests__/schemas.test.ts`

```typescript
/** Validates all 6 permission modes are accepted by the schema */
it('accepts all 6 permission modes', () => {
  for (const mode of ['default', 'plan', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'auto']) {
    expect(PermissionModeSchema.parse(mode)).toBe(mode);
  }
});

/** Validates invalid permission modes are still rejected */
it('rejects invalid permission modes', () => {
  expect(() => PermissionModeSchema.parse('yolo')).toThrow();
  expect(() => PermissionModeSchema.parse('')).toThrow();
});
```

### Unit Tests — Message Sender

**File:** `apps/server/src/services/runtimes/claude-code/__tests__/claude-code-runtime.test.ts`

```typescript
/** Validates that dontAsk mode passes through to SDK options without fallback */
it('passes dontAsk mode directly to SDK query options', async () => {
  // Set session permissionMode to 'dontAsk'
  // Verify sdkOptions.permissionMode === 'dontAsk'
  // Verify allowDangerouslySkipPermissions is NOT set
});

/** Validates that auto mode passes through to SDK options without fallback */
it('passes auto mode directly to SDK query options', async () => {
  // Set session permissionMode to 'auto'
  // Verify sdkOptions.permissionMode === 'auto'
  // Verify allowDangerouslySkipPermissions is NOT set
});

/** Validates that bypassPermissions still sets allowDangerouslySkipPermissions */
it('preserves allowDangerouslySkipPermissions for bypassPermissions', async () => {
  // Verify existing behavior is not broken
});
```

### Unit Tests — Session Store (Async `updateSession`)

```typescript
/** Validates that setPermissionMode failure reverts in-memory state */
it('reverts permissionMode when setPermissionMode rejects', async () => {
  const session = store.ensureSession('s1', { permissionMode: 'default' });
  session.activeQuery = {
    setPermissionMode: vi.fn().mockRejectedValue(new Error('auto unavailable')),
  };

  await expect(store.updateSession('s1', { permissionMode: 'auto' })).rejects.toThrow();
  expect(session.permissionMode).toBe('default'); // reverted
});
```

### Component Tests — PermissionModeItem

**File:** `apps/client/src/layers/features/status/__tests__/PermissionModeItem.test.tsx`

```typescript
/** Validates all 6 modes render in the dropdown */
it('renders all 6 permission modes', async () => {
  const user = userEvent.setup();
  render(<PermissionModeItem mode="default" onChangeMode={vi.fn()} />);
  await user.click(screen.getByText('Default'));
  expect(screen.getByText('Default')).toBeInTheDocument();
  expect(screen.getByText('Accept Edits')).toBeInTheDocument();
  expect(screen.getByText('Plan Mode')).toBeInTheDocument();
  expect(screen.getByText("Don't Ask")).toBeInTheDocument();
  expect(screen.getByText('Bypass All')).toBeInTheDocument();
  expect(screen.getByText('Auto')).toBeInTheDocument();
});

/** Validates supportedModes prop filters the dropdown */
it('filters modes by supportedModes prop', async () => {
  const user = userEvent.setup();
  render(
    <PermissionModeItem
      mode="default"
      onChangeMode={vi.fn()}
      supportedModes={['default', 'plan']}
    />,
  );
  await user.click(screen.getByText('Default'));
  expect(screen.getByText('Default')).toBeInTheDocument();
  expect(screen.getByText('Plan Mode')).toBeInTheDocument();
  expect(screen.queryByText('Bypass All')).not.toBeInTheDocument();
});

/** Validates warning styling for dangerous modes */
it('applies warning styling to bypassPermissions and auto', async () => {
  const user = userEvent.setup();
  render(<PermissionModeItem mode="default" onChangeMode={vi.fn()} />);
  await user.click(screen.getByText('Default'));
  // Both Bypass All and Auto should have text-red-500 class
});
```

### Component Tests — ChatStatusSection

```typescript
/** Validates permission mode dropdown receives supportedModes from capabilities */
it('passes supported modes from capabilities to PermissionModeItem', () => {
  // Mock useDefaultCapabilities to return { supportedPermissionModes: ['default', 'plan'] }
  // Verify PermissionModeItem receives supportedModes prop
});
```

### Existing Tests — Update Required

- `packages/shared/src/__tests__/relay-binding-schemas.test.ts` (line 65): Currently rejects `'auto'` — update to accept it
- `apps/server/src/services/runtimes/claude-code/__tests__/sdk-scenarios.ts`: `setPermissionMode` mock already exists — no change needed
- `packages/test-utils/src/fake-agent-runtime.ts`: Add `supportedPermissionModes` to capabilities

## Performance Considerations

- **No performance impact.** Schema expansion adds 2 enum values — zero runtime cost.
- `useDefaultCapabilities()` already caches with `staleTime: Infinity` — no new API calls.
- Mode filtering in `PermissionModeItem` is a trivial array filter (6 items).

## Security Considerations

- **`bypassPermissions` risk is unchanged.** Existing red styling and `allowDangerouslySkipPermissions` handling are preserved.
- **`auto` mode** uses an AI classifier — not a security guarantee. The SDK documentation calls it a "research preview." The `warn: true` flag ensures red styling in the UI.
- **`dontAsk` mode** is the _most_ restrictive mode — it denies everything not in `allowedTools`. No security concern.
- **Subagent inheritance:** `bypassPermissions` propagates to all subagents and cannot be overridden. This is SDK behavior, not something DorkOS can mitigate. The UI description should mention this in a future iteration.

## Documentation

- No user-facing docs changes needed — the UI is self-documenting with descriptions.
- Update `contributing/agent-runtimes.md` (if it exists) to note the 6 supported modes.

## Implementation Phases

### Phase 1: Schema + Server (Foundation)

1. Expand `PermissionModeSchema` from 4 to 6 values in `schemas.ts`
2. Add `dontAsk` and `auto` to `CLAUDE_CODE_CAPABILITIES.supportedPermissionModes`
3. Replace `message-sender.ts` allowlist with passthrough
4. Update `FakeAgentRuntime` and `TestModeRuntime` capabilities
5. Update schema tests (`relay-binding-schemas.test.ts` to accept `auto`)
6. Add message-sender tests for `dontAsk` and `auto` passthrough
7. `pnpm typecheck` + `pnpm test -- --run`

### Phase 2: Error Propagation

8. Make `session-store.updateSession()` async with `setPermissionMode()` error handling
9. Update `AgentRuntime.updateSession` return type to `boolean | Promise<boolean>`
10. Update PATCH route handler to catch and return 422 on permission mode rejection
11. Add session-store test for `setPermissionMode()` revert on failure
12. `pnpm typecheck` + `pnpm test -- --run`

### Phase 3: Client UI

13. Add `dontAsk` and `auto` entries to `PERMISSION_MODES` in `PermissionModeItem.tsx`
14. Add `supportedModes` prop with capability-based filtering
15. Wire `useDefaultCapabilities()` → `supportedModes` in `ChatStatusSection.tsx`
16. Add PermissionModeItem component tests (all 6 modes, filtering, warning styles)
17. `pnpm typecheck` + `pnpm test -- --run`

## Open Questions

None — all decisions resolved during ideation (see Section 6 of `01-ideation.md`).

## Related ADRs

- **ADR-0085:** Agent Runtime Interface as Universal Abstraction — established `RuntimeCapabilities` with `supportedPermissionModes`
- **ADR-0106:** Convergence Effect for Optimistic TanStack Query State — the pattern used in `use-session-status.ts` for optimistic permission mode updates
- **ADR-0135:** Binding-Level Permission Mode for Adapter Sessions — adapter binding permission modes (separate scope, uses the same expanded schema)

## References

- Ideation document: `specs/permission-mode-management/01-ideation.md`
- Existing spec #135: `specs/agent-permission-mode/02-specification.md`
- Claude Agent SDK permissions: https://platform.claude.com/docs/en/agent-sdk/permissions
- Claude Code permission modes: https://code.claude.com/docs/en/permission-modes
- Claude Code auto mode: https://www.anthropic.com/engineering/claude-code-auto-mode
- `allowedTools` doesn't constrain `bypassPermissions`: https://github.com/anthropics/claude-agent-sdk-typescript/issues/115

## Changelog

_(Empty — spec is new)_
