# Agent Permission Mode for Adapter Bindings

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-03-15
**Spec #:** 135
**Ideation:** `specs/agent-permission-mode/01-ideation.md`

---

## Overview

Add a `permissionMode` field to `AdapterBindingSchema` and wire it through the relay message pipeline so that adapter-triggered agent sessions use the binding's configured permission mode. This prevents headless agent sessions from silently skipping tools (the current behavior when `default` mode encounters tool approval requests in non-TTY contexts).

## Background / Problem Statement

When a user sends a message via Slack or Telegram, the relay pipeline creates an agent session without specifying a permission mode. Claude Code's `default` mode prompts for tool approval, but in headless (non-TTY) contexts, unapproved tools are **auto-denied** — the agent silently skips tools rather than completing work. Users have no way to configure this behavior.

The existing binding schema has `canReply`, `canInitiate`, and `canReceive` (binary permission flags), but no field for the runtime's permission mode (`default`, `plan`, `acceptEdits`, `bypassPermissions`).

Additionally, `adapter-manager.ts` passes `permissionMode: 'auto'` to `ensureSession()`, but `'auto'` is not a valid value in `PermissionModeSchema`.

Almost all the plumbing exists:

- `PermissionModeSchema` defines the enum
- `RuntimeCapabilities.supportedPermissionModes` declares what each runtime supports
- `SessionOpts.permissionMode` is required at session creation
- `MessageOpts.permissionMode` provides per-message override capability
- `message-sender.ts` correctly maps permission modes to SDK options

The only gap: `AdapterBindingSchema` has no `permissionMode` field, so the binding router can't pass it through.

## Goals

- Allow users to configure the permission mode per adapter-agent binding
- Ensure adapter-triggered sessions use the binding's configured permission mode
- Default to `acceptEdits` for new bindings (matching Pulse scheduler precedent)
- Show only runtime-supported permission modes in the UI
- Warn users when selecting `bypassPermissions` on external-facing adapters
- Fix the `permissionMode: 'auto'` bug in `adapter-manager.ts`

## Non-Goals

- Per-tool granular permissions (e.g., "allow Bash but not file writes")
- OpenCode-specific permission mode mapping (deferred until OpenCode runtime exists)
- Changes to `PermissionModeSchema` enum values
- Changes to `message-sender.ts` permission mode handling (already correct)
- Adapter-level or runtime-level permission mode (binding-level was chosen)

## Technical Dependencies

- `zod` — schema validation (already in use)
- `@dorkos/shared` — `PermissionModeSchema`, `RuntimeCapabilities`, `AgentRuntime` interface
- Shadcn `Select`, `AlertDialog` — UI components (already available)
- No new external dependencies required

## Detailed Design

### 1. Schema Change — `AdapterBindingSchema`

**File:** `packages/shared/src/relay-adapter-schemas.ts`

Add `permissionMode` to `AdapterBindingSchema`:

```typescript
import { PermissionModeSchema } from './schemas.js';

export const AdapterBindingSchema = z
  .object({
    id: z.string().uuid(),
    adapterId: z.string(),
    agentId: z.string(),
    chatId: z.string().optional(),
    channelType: ChannelTypeSchema.optional(),
    sessionStrategy: SessionStrategySchema.default('per-chat'),
    label: z.string().default(''),
    permissionMode: PermissionModeSchema.optional().default('acceptEdits'),
    canInitiate: z.boolean().default(false),
    canReply: z.boolean().default(true),
    canReceive: z.boolean().default(true),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('AdapterBinding');
```

The field is optional with a default of `'acceptEdits'`. Existing bindings without this field will default to `acceptEdits` when parsed through the schema.

`CreateBindingRequestSchema` (which uses `.omit({ id, createdAt, updatedAt })`) will automatically include the new field — no change needed.

### 2. Binding Store Update

**File:** `apps/server/src/services/relay/binding-store.ts`

Add `permissionMode` to the `update()` method's `Partial<Pick<...>>` type:

```typescript
async update(
  id: string,
  updates: Partial<
    Pick<
      AdapterBinding,
      'sessionStrategy' | 'label' | 'chatId' | 'channelType' | 'canInitiate' | 'canReply' | 'canReceive' | 'permissionMode'
    >
  >,
): Promise<AdapterBinding | undefined> {
```

No other changes needed — the spread `...updates` already handles the merge.

### 3. Binding Router — Permission Mode Injection

**File:** `apps/server/src/services/relay/binding-router.ts`

Two changes in `handleInbound()`:

**a) Include `permissionMode` in enriched payload:**

```typescript
const enrichedPayload =
  envelope.payload && typeof envelope.payload === 'object'
    ? {
        ...(envelope.payload as Record<string, unknown>),
        cwd: projectPath,
        __bindingPermissions: {
          canReply: binding.canReply,
          canInitiate: binding.canInitiate,
          permissionMode: binding.permissionMode ?? 'acceptEdits',
        },
      }
    : envelope.payload;
```

**b) Pass `permissionMode` through the `AgentSessionCreator`:**

The `AgentSessionCreator` interface (defined in `binding-router.ts`) needs to accept a permission mode:

```typescript
export interface AgentSessionCreator {
  createSession(cwd: string, permissionMode?: PermissionMode): Promise<{ id: string }>;
}
```

Update `createNewSession` and `getOrCreateSession` to pass `binding.permissionMode`:

```typescript
private async createNewSession(binding: AdapterBinding): Promise<string> {
  const projectPath = this.deps.meshCore.getProjectPath(binding.agentId);
  const result = await this.deps.sessionCreator.createSession(
    projectPath ?? process.cwd(),
    binding.permissionMode,
  );
  return result.id;
}
```

### 4. Adapter Manager — Fix `'auto'` Bug + Accept Permission Mode

**File:** `apps/server/src/services/relay/adapter-manager.ts`

Fix the session creator to accept and pass through the permission mode:

```typescript
const sessionCreator: AgentSessionCreator = {
  async createSession(cwd: string, permissionMode?: PermissionMode) {
    const id = crypto.randomUUID();
    agentManager.ensureSession(id, {
      permissionMode: permissionMode ?? 'acceptEdits',
      cwd,
    });
    return { id };
  },
};
```

This fixes the `permissionMode: 'auto'` bug — the invalid value is replaced with either the binding's configured mode or `'acceptEdits'` as fallback.

### 5. API Route — Binding CRUD

**File:** `apps/server/src/routes/relay.ts`

The binding update endpoint already passes through `req.body` fields to `bindingStore.update()`. Since we added `permissionMode` to the `update()` Pick type, it will flow through automatically if present in the request body. Verify that the Zod validation on the update endpoint allows `permissionMode`.

### 6. Client UI — BindingDialog Permission Mode Selector

**File:** `apps/client/src/layers/features/mesh/ui/BindingDialog.tsx`

#### 6a. Permission Mode Labels

Define a constant mapping permission mode values to user-friendly labels:

```typescript
const PERMISSION_MODE_OPTIONS: Array<{
  value: PermissionMode;
  label: string;
  description: string;
}> = [
  {
    value: 'default',
    label: 'Default',
    description: 'Agent asks for approval before using any tools',
  },
  {
    value: 'plan',
    label: 'Plan Only',
    description: 'Agent can read files but asks before making changes',
  },
  {
    value: 'acceptEdits',
    label: 'Accept Edits',
    description: 'Agent can read and write files; asks before running shell commands',
  },
  {
    value: 'bypassPermissions',
    label: 'Full Access',
    description: 'Agent can use all tools without asking for approval',
  },
];
```

#### 6b. State

Add state for permission mode alongside existing permission states:

```typescript
const [permissionMode, setPermissionMode] = useState<PermissionMode>(
  initialValues?.permissionMode ?? 'acceptEdits'
);
const [bypassWarningOpen, setBypassWarningOpen] = useState(false);
const [pendingPermissionMode, setPendingPermissionMode] = useState<PermissionMode | null>(null);
```

Update the `useEffect` sync block to include `permissionMode`:

```typescript
setPermissionMode(initialValues.permissionMode ?? 'acceptEdits');
```

Update `advancedOpen` auto-detection to include non-default permission mode:

```typescript
const [advancedOpen, setAdvancedOpen] = useState(
  !!(
    initialValues?.canInitiate ||
    initialValues?.canReply === false ||
    initialValues?.canReceive === false ||
    (initialValues?.sessionStrategy && initialValues.sessionStrategy !== 'per-chat') ||
    (initialValues?.permissionMode && initialValues.permissionMode !== 'acceptEdits')
  )
);
```

#### 6c. Runtime Capability Filtering

The BindingDialog needs access to the selected agent's runtime capabilities to filter permission modes. Use the existing agent data (from `useRegisteredAgents` or similar) to get `RuntimeCapabilities.supportedPermissionModes`.

Filter the options:

```typescript
const availablePermissionModes = PERMISSION_MODE_OPTIONS.filter((opt) =>
  supportedModes ? supportedModes.includes(opt.value) : true
);
```

If `supportedPermissionModes` is not available for the selected agent (runtime doesn't report capabilities), show all modes.

#### 6d. UI Placement

Add the permission mode selector **inside the Advanced collapsible section**, between the Session Strategy selector and the Permissions toggles:

```tsx
{
  /* Permission mode selector */
}
<div className="space-y-1.5">
  <Label htmlFor="binding-permission-mode">Permission Mode</Label>
  <Select
    value={permissionMode}
    onValueChange={(v) => handlePermissionModeChange(v as PermissionMode)}
  >
    <SelectTrigger id="binding-permission-mode" className="w-full">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {availablePermissionModes.map((mode) => (
        <SelectItem key={mode.value} value={mode.value}>
          {mode.label}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
  {selectedPermissionMode && (
    <p className="text-muted-foreground text-xs">{selectedPermissionMode.description}</p>
  )}
</div>;
```

#### 6e. Security Warning for `bypassPermissions`

When the user selects `bypassPermissions` ("Full Access"), intercept the change and show an AlertDialog:

```typescript
function handlePermissionModeChange(mode: PermissionMode) {
  if (mode === 'bypassPermissions') {
    setPendingPermissionMode(mode);
    setBypassWarningOpen(true);
  } else {
    setPermissionMode(mode);
  }
}
```

AlertDialog:

```tsx
<AlertDialog open={bypassWarningOpen} onOpenChange={setBypassWarningOpen}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Enable Full Access?</AlertDialogTitle>
      <AlertDialogDescription>
        Any user who can send messages through this adapter (e.g., members of your Slack workspace)
        will be able to trigger unrestricted agent actions, including file system access and command
        execution.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel onClick={() => setPendingPermissionMode(null)}>Cancel</AlertDialogCancel>
      <AlertDialogAction
        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
        onClick={() => {
          if (pendingPermissionMode) setPermissionMode(pendingPermissionMode);
          setPendingPermissionMode(null);
        }}
      >
        Enable Full Access
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

#### 6f. Include in Submit

Update the `handleSubmit` / `onConfirm` call to include `permissionMode`:

```typescript
onConfirm({
  adapterId,
  agentId,
  sessionStrategy: strategy,
  label: label || undefined,
  chatId: chatId === SELECT_ANY ? undefined : chatId,
  channelType: channelType === SELECT_ANY ? undefined : channelType,
  permissionMode,
  canInitiate,
  canReply,
  canReceive,
});
```

## User Experience

### Creating a Binding

1. User opens BindingDialog (from AdapterCard "Add Binding" or ConversationRow route popover)
2. Selects adapter and agent
3. Optionally expands "Advanced" section
4. Permission Mode selector shows modes supported by the selected agent's runtime
5. Default is "Accept Edits" — most users won't need to change this
6. If user selects "Full Access", an AlertDialog warns about security implications
7. User confirms or cancels the selection

### Editing a Binding

1. User clicks an existing binding row in AdapterCard
2. BindingDialog opens in edit mode with current values
3. Permission mode selector shows the current value
4. User can change the permission mode — same security warning applies for `bypassPermissions`

### Runtime Behavior

After a binding is saved with a permission mode:

1. Adapter receives a message (e.g., Slack message)
2. BindingRouter resolves the binding for this adapter+chat
3. BindingRouter creates/reuses a session, passing `binding.permissionMode` to `ensureSession()`
4. The session uses the configured mode — e.g., `acceptEdits` allows file edits without blocking
5. Agent completes work and responds through the adapter

## Testing Strategy

### Unit Tests

**Schema tests** (`packages/shared/src/__tests__/relay-binding-schemas.test.ts`):

```typescript
/** Validates that permissionMode defaults to 'acceptEdits' when omitted */
it('defaults permissionMode to acceptEdits', () => {
  const result = AdapterBindingSchema.parse(bindingWithoutPermissionMode);
  expect(result.permissionMode).toBe('acceptEdits');
});

/** Validates that all valid PermissionMode values are accepted */
it('accepts all valid permission modes', () => {
  for (const mode of ['default', 'plan', 'acceptEdits', 'bypassPermissions']) {
    const result = AdapterBindingSchema.parse({ ...validBinding, permissionMode: mode });
    expect(result.permissionMode).toBe(mode);
  }
});

/** Validates that invalid permission mode values are rejected */
it('rejects invalid permission mode', () => {
  expect(() => AdapterBindingSchema.parse({ ...validBinding, permissionMode: 'auto' })).toThrow();
});
```

**Binding store tests** (`apps/server/src/services/relay/__tests__/binding-store.test.ts`):

```typescript
/** Verifies that update() persists permissionMode changes */
it('updates permissionMode on a binding', async () => {
  const binding = await store.create(validBinding);
  const updated = await store.update(binding.id, { permissionMode: 'bypassPermissions' });
  expect(updated?.permissionMode).toBe('bypassPermissions');
});
```

**Binding router tests** (`apps/server/src/services/relay/__tests__/binding-router.test.ts`):

```typescript
/** Verifies that binding.permissionMode is passed through to session creation */
it('passes binding permissionMode to session creator', async () => {
  const binding = createBinding({ permissionMode: 'bypassPermissions' });
  mockBindingStore.resolve.mockReturnValue(binding);

  await router.handleInbound(inboundEnvelope);

  expect(mockSessionCreator.createSession).toHaveBeenCalledWith(
    expect.any(String),
    'bypassPermissions'
  );
});

/** Verifies that missing permissionMode defaults to acceptEdits */
it('defaults to acceptEdits when binding has no permissionMode', async () => {
  const binding = createBinding({ permissionMode: undefined });
  mockBindingStore.resolve.mockReturnValue(binding);

  await router.handleInbound(inboundEnvelope);

  expect(mockSessionCreator.createSession).toHaveBeenCalledWith(expect.any(String), 'acceptEdits');
});

/** Verifies that permissionMode is included in __bindingPermissions payload */
it('includes permissionMode in enriched payload', async () => {
  const binding = createBinding({ permissionMode: 'plan' });
  mockBindingStore.resolve.mockReturnValue(binding);

  await router.handleInbound(inboundEnvelope);

  expect(mockRelayCore.publish).toHaveBeenCalledWith(
    expect.stringMatching(/^relay\.agent\./),
    expect.objectContaining({
      __bindingPermissions: expect.objectContaining({
        permissionMode: 'plan',
      }),
    }),
    expect.any(Object)
  );
});
```

**BindingDialog tests** (`apps/client/src/layers/features/mesh/ui/__tests__/BindingDialog.test.tsx`):

```typescript
/** Verifies permission mode selector renders with default value */
it('renders permission mode selector defaulting to Accept Edits', () => {
  render(<BindingDialog {...defaultProps} />);
  // Open advanced section
  fireEvent.click(screen.getByText('Advanced'));
  expect(screen.getByText('Accept Edits')).toBeInTheDocument();
});

/** Verifies security warning appears when selecting Full Access */
it('shows security warning when selecting Full Access', async () => {
  const user = userEvent.setup();
  render(<BindingDialog {...defaultProps} />);
  // Open advanced, change permission mode to Full Access
  // Verify AlertDialog appears with warning text
  expect(screen.getByText('Enable Full Access?')).toBeInTheDocument();
});

/** Verifies that canceling the warning reverts the selection */
it('reverts to previous mode when warning is canceled', async () => {
  // Select Full Access, cancel the dialog
  // Verify permissionMode is still acceptEdits
});
```

### Integration Tests

- Verify end-to-end: create binding with `acceptEdits` → send message via adapter → session is created with `acceptEdits` mode
- Verify backward compatibility: existing bindings without `permissionMode` field still work (default to `acceptEdits`)

## Performance Considerations

- **No performance impact.** The `permissionMode` field adds one string field to the binding schema. No additional queries, network calls, or computational work.
- The binding is already resolved once per inbound message — reading one additional field is negligible.

## Security Considerations

- **`bypassPermissions` on external adapters is a significant risk.** Any user in the Slack workspace or Telegram chat who can message the bot gains full agent filesystem and command execution access.
- **Mitigation:** AlertDialog warning with explicit confirmation required. The warning text clearly states the implications.
- **Future consideration:** A server-side validation could prevent `bypassPermissions` on external-facing adapters entirely, but for now the UI warning + user confirmation is the right balance of safety and flexibility.
- **`acceptEdits` is the safe default.** In headless mode, tools that aren't auto-approved (like Bash, network) are auto-denied rather than stalling. This means the agent can edit files but cannot execute arbitrary commands.

## Documentation

- Update `contributing/relay-adapters.md` to document the `permissionMode` field on bindings
- No user-facing docs changes needed (the UI is self-explanatory with the description text)

## Implementation Phases

### Phase 1: Core Pipeline (Schema + Server)

1. Add `permissionMode` field to `AdapterBindingSchema` in `relay-adapter-schemas.ts`
2. Add `permissionMode` to `BindingStore.update()` Pick type
3. Update `AgentSessionCreator` interface to accept `permissionMode`
4. Update `BindingRouter` to pass `binding.permissionMode` through session creation and enriched payload
5. Fix `adapter-manager.ts` `permissionMode: 'auto'` bug
6. Add schema and binding-store unit tests

### Phase 2: Client UI

7. Add `permissionMode` state and `useEffect` sync to `BindingDialog.tsx`
8. Add `PERMISSION_MODE_OPTIONS` constant with labels and descriptions
9. Add `Select` component in the Advanced section
10. Add runtime capability filtering for the permission mode options
11. Add `bypassPermissions` security warning AlertDialog
12. Include `permissionMode` in the submit payload
13. Add BindingDialog component tests

### Phase 3: Integration + Polish

14. Verify binding CRUD API passes `permissionMode` through
15. Update `advancedOpen` auto-detection for non-default `permissionMode`
16. Update `hasAdvancedChanges` badge logic
17. Update `contributing/relay-adapters.md`

## Open Questions

None — all design decisions were resolved during ideation:

1. ~~**Placement**~~ → Binding level
2. ~~**Default**~~ → `acceptEdits`
3. ~~**Security UX**~~ → Warning with acknowledgment
4. ~~**Runtime filtering**~~ → Yes, filter by capabilities

## Related ADRs

- **ADR-0085:** Agent Runtime Interface as Universal Abstraction — established `RuntimeCapabilities` with `supportedPermissionModes`
- **ADR-0047:** Most-Specific-First Binding Resolution — binding resolution scoring algorithm

## References

- Ideation document: `specs/agent-permission-mode/01-ideation.md`
- Research: `research/20260315_agent_runtime_permission_modes.md`
- Claude Agent SDK permissions: https://platform.claude.com/docs/en/agent-sdk/permissions
- Existing binding schema: `packages/shared/src/relay-adapter-schemas.ts:272-289`
- Existing permission mode handling: `apps/server/src/services/runtimes/claude-code/message-sender.ts:154-179`

## Changelog

_(Empty — spec is new)_
