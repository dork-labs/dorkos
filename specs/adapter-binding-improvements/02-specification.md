# Relay Binding Robustness & Multi-Instance Routing

**Status:** Draft
**Authors:** Claude, 2026-03-22
**Spec ID:** adapter-binding-improvements

## Overview

Fix four interrelated issues in the relay binding and adapter routing system that cause silent message loss, prevent multi-instance adapter routing, and allow invalid configuration state. These range from a critical data-loss bug (empty `agentId` bindings silently drop all messages) to architectural gaps exposed by enabling multi-instance adapters.

## Background / Problem Statement

The binding system was introduced in spec #71 (adapter-agent-routing) and has been refined through specs #90, #120, and #131. Along the way, several gaps have accumulated:

1. **Empty `agentId` bindings silently drop messages** — The `AdapterBindingSchema` defines `agentId: z.string()` with no minimum length. An empty string passes validation, gets persisted to `bindings.json`, and at routing time `meshCore.getProjectPath("")` returns `undefined`, causing `BindingRouter.handleInbound()` to silently skip the message with only a warn log. When two bindings exist for the same adapter (one with empty `agentId`, one valid), the empty one can shadow the valid one due to equal specificity scores, causing **all** messages to that adapter to be dropped.

2. **Schema allows empty `agentId` and `adapterId`** — Both fields are `z.string()` with no `.min(1)` constraint. The client UI has a soft guard (disabled submit button) but it's bypassed by edit mode, `QuickBindingPopover`, MCP tools, and direct API calls.

3. **`resolveAdapterInstanceId` returns only the first match** — The resolver closure uses `configs.find()` which returns the first enabled adapter of a given type. With `multiInstance: true` (enabled for Telegram in spec #120), a second adapter instance's messages are misrouted to the first instance's bindings. The root cause is that the inbound subject (`relay.human.telegram.<chatId>`) encodes only the adapter **type**, not the instance ID, making disambiguation impossible at parse time.

4. **`builtin` flag incorrectly set on user-created adapters** — `addAdapter()` stamps `builtin: manifest.builtin` from the adapter type's manifest. Built-in manifests (telegram, slack, etc.) declare `builtin: true`, so every user-created instance of these types gets `builtin: true` in the persisted config. While the deletion guard is scoped to `claude-code` specifically, the flag is semantically wrong and the `adapter-plugin-loader.ts` uses it to determine factory routing.

## Goals

- Prevent creation of bindings with empty `agentId` or `adapterId` at the schema level
- Surface binding routing failures visibly rather than silently dropping messages
- Enable correct routing when multiple instances of the same adapter type exist
- Ensure the `builtin` flag accurately reflects whether an adapter instance is built-in or user-created
- Clean up existing invalid data (the empty-`agentId` binding in dev config)
- Add server-side agent existence validation at binding creation time

## Non-Goals

- Redesigning the binding resolution scoring algorithm (ADR-0047)
- Removing `projectPath` from bindings (covered by spec #131 / ADR-0130)
- Adding a binding health dashboard or monitoring UI
- Changing the `ThreadIdCodec` interface contract
- Supporting cross-type adapter routing (e.g., routing a telegram message to a slack adapter)

## Technical Dependencies

- `zod` — Schema validation (already in use)
- `@dorkos/shared/relay-schemas` — Binding and adapter schemas
- `@dorkos/relay` — Adapter registry, base adapter, thread-id codecs
- No new external dependencies required

## Detailed Design

### Fix 1: Schema-Level Enforcement of Non-Empty IDs

**File:** `packages/shared/src/relay-adapter-schemas.ts`

Add `.min(1)` constraints to `agentId` and `adapterId` in `AdapterBindingSchema`:

```typescript
export const AdapterBindingSchema = z.object({
  id: z.string().uuid(),
  adapterId: z.string().min(1), // was: z.string()
  agentId: z.string().min(1), // was: z.string()
  chatId: z.string().optional(),
  channelType: ChannelTypeSchema.optional(),
  // ... rest unchanged
});
```

This is the single most impactful fix — it prevents invalid bindings at every entry point (UI, API, MCP tools) in one place.

**Migration consideration:** Existing `bindings.json` files with empty `agentId` will fail `BindingsFileSchema.parse()` on load. The `BindingStore.load()` method already handles parse failures gracefully (clears bindings, logs error). However, this is destructive — all bindings would be lost if any one has an empty ID. Instead, add a migration step that filters out invalid entries:

**File:** `apps/server/src/services/relay/binding-store.ts`

In the `load()` method, validate entries individually and discard invalid ones rather than rejecting the entire file:

```typescript
private async load(): Promise<void> {
  try {
    const raw = await readFile(this.filePath, 'utf-8');
    const json = JSON.parse(raw) as unknown;

    // Validate file structure but parse entries individually
    if (!json || typeof json !== 'object' || !Array.isArray((json as any).bindings)) {
      throw new Error('Invalid bindings file structure');
    }

    this.bindings.clear();
    let discarded = 0;
    for (const entry of (json as { bindings: unknown[] }).bindings) {
      const result = AdapterBindingSchema.safeParse(entry);
      if (result.success) {
        this.bindings.set(result.data.id, result.data);
      } else {
        discarded++;
        logger.warn('Discarded invalid binding entry:', result.error.flatten());
      }
    }

    if (discarded > 0) {
      logger.info(`Discarded ${discarded} invalid binding(s), saving cleaned file`);
      await this.save();
    }

    logger.info(`Loaded ${this.bindings.size} binding(s) from ${this.filePath}`);
  } catch (err) {
    // ... existing error handling
  }
}
```

### Fix 2: Server-Side Agent Existence Validation

**File:** `apps/server/src/routes/relay-adapters.ts`

Add an agent existence check in the `POST /bindings` handler. The route already has access to `adapterManager` which exposes the mesh core:

```typescript
router.post('/bindings', async (req, res) => {
  const bindingStore = adapterManager.getBindingStore();
  if (!bindingStore) return res.status(503).json({ error: 'Binding subsystem not available' });

  const result = CreateBindingRequestSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
  }

  // Validate adapter exists
  const adapterExists = adapterManager.getAdapter(result.data.adapterId);
  if (!adapterExists) {
    return res.status(400).json({
      error: `Adapter '${result.data.adapterId}' not found`,
    });
  }

  // Validate agent exists in mesh registry
  const meshCore = adapterManager.getMeshCore();
  if (meshCore && result.data.agentId) {
    const projectPath = meshCore.getProjectPath(result.data.agentId);
    if (!projectPath) {
      return res.status(400).json({
        error: `Agent '${result.data.agentId}' not found in mesh registry`,
      });
    }
  }

  // ... existing create logic
});
```

This requires exposing `meshCore` from `AdapterManager`. Add a simple getter:

```typescript
// adapter-manager.ts
getMeshCore(): AdapterMeshCoreLike | undefined {
  return this.deps.meshCore;
}
```

### Fix 3: Instance-Aware Subject Encoding for Multi-Instance Adapters

This is the most architecturally significant change. The current subject format `relay.human.<platformType>.<chatId>` cannot distinguish which adapter instance received a message when multiple instances of the same type exist.

**Approach: Embed the adapter instance ID in the subject prefix.**

Change the subject format from:

```
relay.human.telegram.<chatId>          → relay.human.telegram.<instanceId>.<chatId>
relay.human.telegram.group.<chatId>    → relay.human.telegram.<instanceId>.group.<chatId>
```

This requires changes at three layers:

#### 3a. ThreadIdCodec becomes instance-aware

**File:** `packages/relay/src/lib/thread-id.ts`

The codec already has a `prefix` property. Make it accept an optional instance ID:

```typescript
export class TelegramThreadIdCodec implements ThreadIdCodec {
  readonly prefix: string;

  constructor(instanceId?: string) {
    this.prefix = instanceId ? `relay.human.telegram.${instanceId}` : 'relay.human.telegram';
  }

  // encode() and decode() unchanged — they already use this.prefix
}
```

The same pattern applies to `SlackThreadIdCodec` and `ChatSdkTelegramThreadIdCodec`.

#### 3b. Adapters pass instance ID to codec

**File:** `packages/relay/src/adapters/telegram/inbound.ts`

Currently uses a module-level singleton codec:

```typescript
const codec = new TelegramThreadIdCodec();
```

Change `handleInboundMessage` to accept the adapter's instance ID and construct the codec accordingly. The adapter itself knows its ID (it's passed to the constructor):

**File:** `packages/relay/src/adapters/telegram/telegram-adapter.ts`

```typescript
constructor(id: string, config: TelegramAdapterConfig, displayName = 'Telegram') {
  const codec = new TelegramThreadIdCodec(id);
  super(id, codec.prefix, displayName);
  this.codec = codec;
  // ... rest unchanged
}
```

Pass `this.codec` (or `this.id`) into `handleInboundMessage()` and `deliverMessage()`.

#### 3c. Remove `resolveAdapterInstanceId` — instance ID is now in the subject

**File:** `apps/server/src/services/relay/binding-router.ts`

With instance IDs embedded in subjects, `parseSubject()` no longer needs the resolver:

```typescript
private parseSubject(subject: string): {
  adapterId?: string;
  chatId?: string;
  channelType?: string;
} {
  const parts = subject.split('.');
  if (parts[0] !== 'relay' || parts[1] !== 'human') return {};

  const platformType = parts[2];
  if (!platformType) return {};

  const remaining = parts.slice(3);

  // First remaining token is the instance ID
  const instanceId = remaining[0];
  if (!instanceId) return {};

  const adapterId = instanceId;
  const afterInstance = remaining.slice(1);

  let chatId: string | undefined;
  let channelType: string | undefined;

  if (afterInstance.length >= 2 && afterInstance[0] === 'group') {
    channelType = 'group';
    chatId = afterInstance.slice(1).join('.');
  } else if (afterInstance.length >= 1) {
    chatId = afterInstance.join('.');
  }

  return { adapterId, chatId, channelType };
}
```

The `resolveAdapterInstanceId` dep becomes unnecessary and can be removed from `BindingRouterDeps` and `BindingSubsystemDeps`.

#### 3d. Outbound delivery also becomes instance-aware

**File:** `packages/relay/src/adapter-registry.ts`

`getBySubject()` currently does a prefix match. With instance-specific prefixes (`relay.human.telegram.tg-bot-1`), each adapter has a unique prefix and the first-match problem is resolved automatically.

#### 3e. Backward compatibility

Existing `sessions.json` entries use old-format subjects as keys. On load, entries with old-format keys (no instance ID segment) should be discarded — they'll be recreated on next message. The `BindingRouter.loadSessionMap()` already handles malformed entries gracefully.

Existing `bindings.json` entries don't reference subjects (they use `adapterId` which is already the instance ID), so no migration is needed there.

### Fix 4: Correct `builtin` Flag on User-Created Adapters

**File:** `apps/server/src/services/relay/adapter-manager.ts`

In `addAdapter()`, the `builtin` flag should always be `false` for user-created instances. The built-in `claude-code` adapter is created via `ensureDefaultAdapterConfig()`, not `addAdapter()`:

```typescript
async addAdapter(
  type: string,
  id: string,
  config: Record<string, unknown>,
  enabled = true,
  label?: string
): Promise<void> {
  // ...existing validation...

  const adapterConfig = {
    id,
    type,
    enabled,
    builtin: false,  // was: manifest.builtin — user-created instances are never builtin
    ...(label ? { label } : {}),
    config,
  } as AdapterConfig;
  // ...
}
```

Similarly in `testConnection()`:

```typescript
const tempConfig = {
  id: `__test_${type}_${Date.now()}`,
  type,
  enabled: true,
  builtin: false, // was: manifest.builtin
  config,
} as AdapterConfig;
```

**Migration:** Existing `adapters.json` entries with incorrect `builtin: true` should be corrected. Add a migration step in `loadAdapterConfig()` or `initialize()`:

```typescript
// In initialize(), after loading configs:
let needsSave = false;
for (const config of this.configs) {
  if (config.builtin && config.type !== 'claude-code') {
    config.builtin = false;
    needsSave = true;
  }
}
if (needsSave) {
  await saveAdapterConfig(this.configPath, this.configs);
  logger.info('[AdapterManager] Corrected builtin flag on user-created adapter(s)');
}
```

### Fix 5: Explicit Routing Failure Visibility

**File:** `apps/server/src/services/relay/binding-router.ts`

Currently, when a binding's agent is not found, the message is silently dropped with only a warn log. Make this more visible by tracking it as a binding health issue:

```typescript
if (!projectPath) {
  logger.warn(
    `BindingRouter: agent '${binding.agentId}' not found in mesh registry, ` +
      `dropping message for binding ${binding.id} (adapter=${binding.adapterId})`
  );
  // Record as adapter event so it appears in the UI event log
  this.deps.eventRecorder?.insertAdapterEvent(
    binding.adapterId,
    'binding.routing_failed',
    `Agent '${binding.agentId}' not found in mesh registry`
  );
  return;
}
```

This requires adding an optional `eventRecorder` to `BindingRouterDeps`:

```typescript
export interface BindingRouterDeps {
  // ... existing deps
  eventRecorder?: {
    insertAdapterEvent(adapterId: string, eventType: string, message: string): void;
  };
}
```

## User Experience

**Before:** Users create a binding via the UI or API. If the agent ID is empty or invalid, the binding is created successfully but all messages routed through it are silently dropped. No indication of failure appears in the UI. With multi-instance adapters, messages may route to the wrong bot's bindings.

**After:**

- Creating a binding with an empty `agentId` returns a 400 validation error with a clear message
- Creating a binding with a non-existent agent returns a 400 error: "Agent 'xxx' not found in mesh registry"
- Routing failures appear in the adapter event log visible in the Relay panel
- Multiple instances of the same adapter type each have their own subject namespace and route correctly
- The adapter catalog correctly shows user-created adapters as non-builtin

## Testing Strategy

### Unit Tests

**`packages/shared/src/__tests__/relay-adapter-schemas.test.ts`** (new or extend existing):

```typescript
describe('AdapterBindingSchema', () => {
  it('rejects empty agentId', () => {
    /** Validates that the schema prevents creation of bindings that would silently drop messages */
    const result = AdapterBindingSchema.safeParse({
      id: '00000000-0000-0000-0000-000000000000',
      adapterId: 'test-adapter',
      agentId: '', // empty
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty adapterId', () => {
    /** Validates that the schema prevents orphan bindings with no target adapter */
    const result = AdapterBindingSchema.safeParse({
      id: '00000000-0000-0000-0000-000000000000',
      adapterId: '', // empty
      agentId: 'valid-agent',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid non-empty IDs', () => {
    /** Ensures the constraint does not reject legitimate binding data */
    const result = AdapterBindingSchema.safeParse({
      id: '00000000-0000-0000-0000-000000000000',
      adapterId: 'telegram-bot-1',
      agentId: '01ABC123',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });
});
```

**`packages/relay/src/lib/__tests__/thread-id.test.ts`** (extend existing):

```typescript
describe('TelegramThreadIdCodec with instance ID', () => {
  it('encodes DM subject with instance ID', () => {
    /** Verifies instance-aware subjects include the adapter ID for disambiguation */
    const codec = new TelegramThreadIdCodec('my-bot');
    expect(codec.encode('123', 'dm')).toBe('relay.human.telegram.my-bot.123');
  });

  it('encodes group subject with instance ID', () => {
    const codec = new TelegramThreadIdCodec('my-bot');
    expect(codec.encode('-456', 'group')).toBe('relay.human.telegram.my-bot.group.-456');
  });

  it('round-trips with instance ID', () => {
    /** Ensures encode→decode is lossless for instance-aware subjects */
    const codec = new TelegramThreadIdCodec('my-bot');
    const subject = codec.encode('789', 'dm');
    const decoded = codec.decode(subject);
    expect(decoded).toEqual({ platformId: '789', channelType: 'dm' });
  });

  it('does not decode subjects from different instances', () => {
    /** Two instances must not accidentally decode each other's subjects */
    const codec1 = new TelegramThreadIdCodec('bot-1');
    const codec2 = new TelegramThreadIdCodec('bot-2');
    const subject = codec1.encode('123', 'dm');
    expect(codec2.decode(subject)).toBeNull();
  });

  it('backward compat: no instance ID produces legacy format', () => {
    /** Ensures single-instance deployments are unaffected */
    const codec = new TelegramThreadIdCodec();
    expect(codec.encode('123', 'dm')).toBe('relay.human.telegram.123');
  });
});
```

**`apps/server/src/services/relay/__tests__/binding-store.test.ts`** (extend existing):

```typescript
describe('BindingStore.load() migration', () => {
  it('discards entries with empty agentId and saves cleaned file', async () => {
    /** Validates that corrupted bindings are cleaned up on load rather than crashing */
    // Write a bindings file with one valid and one invalid entry
    await writeFile(
      bindingsPath,
      JSON.stringify({
        bindings: [
          { id: uuid(), adapterId: 'tg', agentId: '' /* ... */ },
          { id: uuid(), adapterId: 'tg', agentId: 'valid-agent' /* ... */ },
        ],
      })
    );

    const store = new BindingStore(relayDir);
    await store.init();

    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].agentId).toBe('valid-agent');
  });
});
```

**`apps/server/src/services/relay/__tests__/binding-router.test.ts`** (extend existing):

```typescript
describe('parseSubject with instance-aware format', () => {
  it('extracts adapterId from instance ID segment', () => {
    /** Validates the new subject format correctly identifies the adapter instance */
    const result = router['parseSubject']('relay.human.telegram.my-bot.123456');
    expect(result.adapterId).toBe('my-bot');
    expect(result.chatId).toBe('123456');
  });

  it('extracts group channel type with instance ID', () => {
    const result = router['parseSubject']('relay.human.telegram.my-bot.group.-789');
    expect(result.adapterId).toBe('my-bot');
    expect(result.chatId).toBe('-789');
    expect(result.channelType).toBe('group');
  });
});
```

**`apps/server/src/services/relay/__tests__/adapter-manager.test.ts`** (extend existing):

```typescript
describe('addAdapter builtin flag', () => {
  it('sets builtin to false for user-created adapters', async () => {
    /** Ensures user-created adapters are never marked as builtin */
    await manager.addAdapter('telegram', 'my-tg', { token: 'test' });
    const adapter = manager.getAdapter('my-tg');
    expect(adapter?.config.builtin).toBe(false);
  });
});

describe('initialize builtin migration', () => {
  it('corrects builtin: true on non-claude-code adapters', async () => {
    /** Validates existing misconfigured adapters are fixed on startup */
    // Pre-seed config with builtin: true on a telegram adapter
    await writeFile(
      configPath,
      JSON.stringify({
        adapters: [{ id: 'tg-1', type: 'telegram', enabled: false, builtin: true, config: {} }],
      })
    );

    await manager.initialize();
    const adapter = manager.getAdapter('tg-1');
    expect(adapter?.config.builtin).toBe(false);
  });
});
```

### Integration Tests

**`POST /api/relay/bindings` validation** — Verify that the route returns 400 for empty `agentId`, empty `adapterId`, and non-existent agent IDs.

**Multi-instance routing** — Create two telegram adapter instances, send a message through each, and verify the correct binding is resolved for each.

### E2E Tests

No new E2E tests required — the fixes are internal to the relay subsystem and testable at the unit/integration level.

## Performance Considerations

- **Schema validation:** Adding `.min(1)` has negligible cost.
- **Agent existence check at binding creation:** One extra hash map lookup per binding creation (rare operation).
- **Instance-aware subjects:** Slightly longer subject strings (additional instance ID segment). No measurable impact on relay publish/subscribe performance.
- **Migration on load:** One-time cost per server startup. Only triggers if invalid entries exist.

## Security Considerations

- **`builtin` flag fix:** Prevents plugin adapters from claiming `builtin: true` and potentially bypassing future builtin-only guards.
- **Agent existence validation:** Prevents creating bindings that reference non-existent agents, which could be used to probe the mesh registry.
- No new attack surface introduced.

## Documentation

- Update `contributing/relay-adapters.md` with the new instance-aware subject format
- Update `contributing/adapter-catalog.md` to clarify `builtin` semantics
- No user-facing documentation changes (the fixes are transparent to users)

## Implementation Phases

### Phase 1: Critical Fixes (Schema + Validation + Data Cleanup)

1. Add `.min(1)` to `agentId` and `adapterId` in `AdapterBindingSchema`
2. Add per-entry validation in `BindingStore.load()` to handle existing invalid data
3. Add agent existence check in `POST /bindings` route
4. Add `getMeshCore()` getter to `AdapterManager`
5. Fix `builtin` flag in `addAdapter()` and `testConnection()`
6. Add startup migration to correct existing `builtin: true` on user-created adapters
7. Add routing failure event recording in `BindingRouter.handleInbound()`
8. Clean up the empty-agentId binding in dev config (`apps/server/.temp/.dork/relay/bindings.json`)
9. Tests for all Phase 1 changes

### Phase 2: Multi-Instance Routing

1. Make `ThreadIdCodec` constructors accept optional instance ID
2. Update `TelegramAdapter`, `ChatSdkTelegramAdapter`, and `SlackAdapter` to pass instance ID to codec
3. Update `BaseRelayAdapter` to accept the instance-aware prefix from the codec
4. Update `BindingRouter.parseSubject()` to extract instance ID from subject
5. Remove `resolveAdapterInstanceId` from `BindingRouterDeps` and `BindingSubsystemDeps`
6. Remove the resolver closure from `AdapterManager.initBindingSubsystem()`
7. Handle backward-compatible session map entries in `BindingRouter.loadSessionMap()`
8. Tests for all Phase 2 changes

## Open Questions

1. **Should `POST /bindings` also validate that the `adapterId` references an enabled adapter, or just that it exists?** Currently the spec validates existence only. An enabled-only check would prevent creating bindings for disabled adapters, but users may want to pre-configure bindings before enabling an adapter.

2. **Should the multi-instance subject format use the instance ID or the adapter type + instance ID?** The current proposal uses `relay.human.<platformType>.<instanceId>.<chatId>`. An alternative is `relay.human.<instanceId>.<chatId>` (dropping the platform type). The platform-type-first approach preserves human readability and allows platform-level wildcard subscriptions (`relay.human.telegram.>`).

3. **Should existing single-instance deployments get the instance-ID segment automatically?** The current proposal makes it optional (no instance ID = legacy format). This means single-instance adapters continue working without changes but won't benefit from the disambiguation. The alternative is to always include the instance ID, which requires all existing adapters to be restarted.

## Related ADRs

- **ADR-0046** (Accepted) — Central BindingRouter pattern. This spec modifies BindingRouter but maintains its central role.
- **ADR-0047** (Proposed) — Most-specific-first binding resolution scoring. Unchanged by this spec.
- **ADR-0130** (Proposed) — Remove `projectPath` from binding schema. Complementary — this spec adds schema constraints while ADR-0130 removes a field. No conflict.

## References

- Spec #71 (adapter-agent-routing) — Original binding system implementation
- Spec #90 (fix-relay-agent-routing-cwd) — Fixed CWD resolution, introduced `AgentSessionStore`
- Spec #120 (adapter-binding-ux-overhaul) — Enabled multi-instance Telegram, expanded binding UX
- Spec #131 (remove-binding-projectpath) — Proposed removal of `projectPath` (not yet implemented)
- `packages/relay/src/lib/thread-id.ts` — ThreadIdCodec interface and implementations
- `apps/server/src/services/relay/binding-router.ts` — Central routing service
- `apps/server/src/services/relay/binding-store.ts` — Binding persistence
- `packages/shared/src/relay-adapter-schemas.ts` — Zod schemas
