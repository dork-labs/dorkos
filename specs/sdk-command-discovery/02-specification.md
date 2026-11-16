---
slug: sdk-command-discovery
number: 133
status: approved
created: 2026-03-15
authors: [Claude Code]
---

# SDK-Based Command Discovery

## Status

Approved

## Overview

Switch slash command discovery from our filesystem scanner (`CommandRegistryService`) to the Claude Agent SDK's `supportedCommands()` API as the primary source, supplemented by filesystem metadata enrichment. This delivers a complete command list (built-ins, skills, user-level commands) to the command palette while preserving existing metadata for project-level custom commands.

## Background / Problem Statement

Today, `CommandRegistryService` scans `.claude/commands/` on disk to discover slash commands. This works for project-level custom commands but has three gaps:

1. **No built-in commands** — `/compact`, `/help`, `/clear`, etc. are invisible to the palette
2. **No user-level commands** — `~/.claude/commands/` is never scanned
3. **No skills** — `.claude/skills/` (the new Claude Code extensibility format) is unrecognized

The Claude Agent SDK's `Query.supportedCommands()` returns the authoritative, complete list of all command types. The existing codebase already calls `supportedModels()` and `mcpServerStatus()` from the same SDK query object using the same non-blocking pattern we need.

## Goals

- Surface built-in, user-level, and skills commands in the command palette
- Use the SDK as the authoritative command source, following the established `supportedModels()` pattern
- Retain filesystem scanner as a supplementary metadata source (`allowedTools`, `filePath`)
- Provide immediate command availability via filesystem fallback before any SDK session
- Zero client-side changes — server merges sources internally

## Non-Goals

- Implementing command discovery for non-Claude-Code runtimes (OpenCode, Cursor, Codex)
- Changing the command palette UI, autocomplete, fuzzy matching, or keyboard navigation
- Adding new frontmatter fields or command formats
- Exposing command source (`sdk` vs `filesystem`) to the client
- Changing how Claude Code interprets/expands slash commands at execution time

## Technical Dependencies

- `@anthropic-ai/claude-agent-sdk` — `Query.supportedCommands()` method (already available)
- No new external dependencies

## Related ADRs

- **ADR-0085: Agent Runtime Interface** — `AgentRuntime` is the universal abstraction; all SDK interactions are encapsulated inside `ClaudeCodeRuntime`
- **ADR-0089: SDK Import Confinement** — `@anthropic-ai/claude-agent-sdk` imports banned outside `services/runtimes/claude-code/` (error-level lint)

## Detailed Design

### Architecture Overview

```
Before first SDK query:
  GET /api/commands → ClaudeCodeRuntime.getCommands()
                    → CommandRegistryService.getCommands()  (filesystem only)
                    → CommandRegistry { commands: [...custom], lastScanned }

After first SDK query:
  executeSdkQuery() → query.supportedCommands() → cache on runtime
  GET /api/commands → ClaudeCodeRuntime.getCommands()
                    → merge(cachedSdkCommands, filesystemEnrichment)
                    → CommandRegistry { commands: [...all], lastScanned }
```

### 1. Schema Changes (`packages/shared/src/schemas.ts`)

Make `namespace`, `command`, and `filePath` optional to accommodate SDK-only commands (built-ins, skills) that lack these fields:

```typescript
export const CommandEntrySchema = z
  .object({
    namespace: z.string().optional(), // was required
    command: z.string().optional(), // was required
    fullCommand: z.string(), // stays required
    description: z.string(), // stays required
    argumentHint: z.string().optional(), // already optional
    allowedTools: z.array(z.string()).optional(), // already optional
    filePath: z.string().optional(), // was required
  })
  .openapi('CommandEntry');
```

`CommandRegistrySchema` is unchanged. The `CommandRegistry` type flows through the Transport interface to the client unchanged.

### 2. SDK Command Fetching (`message-sender.ts`)

Add a `supportedCommands()` call following the exact pattern of `supportedModels()` (lines 195-210):

```typescript
// In MessageSenderOpts interface:
onCommandsReceived?: (commands: Array<{ name: string; description: string; argumentHint: string }>) => void;

// In executeSdkQuery(), after the existing mcpServerStatus block:
if (opts.onCommandsReceived) {
  agentQuery
    .supportedCommands()
    .then((commands) => {
      opts.onCommandsReceived!(
        commands.map((c) => ({
          name: c.name,
          description: c.description,
          argumentHint: c.argumentHint,
        }))
      );
    })
    .catch((err) => {
      logger.debug('[sendMessage] failed to fetch supported commands', { err });
    });
}
```

### 3. SDK Command Caching (`claude-code-runtime.ts`)

Add a cache property and populate it from the callback:

```typescript
// New property alongside existing cachedModels:
private cachedSdkCommands: Array<{ name: string; description: string; argumentHint: string }> | null = null;

// In sendMessage opts (alongside existing onModelsReceived):
onCommandsReceived: !this.cachedSdkCommands
  ? (commands) => {
      this.cachedSdkCommands = commands;
      logger.debug('[sendMessage] cached supported commands', {
        count: commands.length,
      });
    }
  : undefined,
```

### 4. Merge Logic (`claude-code-runtime.ts`)

Replace the current `getCommands()` implementation with a merge strategy:

```typescript
async getCommands(forceRefresh?: boolean, cwd?: string): Promise<CommandRegistry> {
  const root = cwd || this.cwd;

  // If SDK commands are cached, use them as primary source
  if (this.cachedSdkCommands) {
    // Convert SDK commands to CommandEntry format
    const sdkEntries: CommandEntry[] = this.cachedSdkCommands.map((c) => ({
      fullCommand: c.name.startsWith('/') ? c.name : `/${c.name}`,
      description: c.description,
      argumentHint: c.argumentHint || undefined,
    }));

    // Enrich with filesystem metadata where available
    const registry = this.getOrCreateRegistry(root);
    const fsCommands = await registry.getCommands(forceRefresh);
    const fsLookup = new Map(fsCommands.commands.map((c) => [c.fullCommand, c]));

    const merged = sdkEntries.map((entry) => {
      const fsMatch = fsLookup.get(entry.fullCommand);
      if (fsMatch) {
        return {
          ...entry,
          namespace: fsMatch.namespace,
          command: fsMatch.command,
          allowedTools: fsMatch.allowedTools,
          filePath: fsMatch.filePath,
        };
      }
      return entry;
    });

    merged.sort((a, b) => a.fullCommand.localeCompare(b.fullCommand));

    return {
      commands: merged,
      lastScanned: new Date().toISOString(),
    };
  }

  // Fallback: no SDK data yet, use filesystem scanner
  const registry = this.getOrCreateRegistry(root);
  return registry.getCommands(forceRefresh);
}

/** Get or create a CommandRegistryService for the given root, with LRU eviction. */
private getOrCreateRegistry(root: string): CommandRegistryService {
  let registry = this.commandRegistries.get(root);
  if (!registry) {
    if (this.commandRegistries.size >= ClaudeCodeRuntime.MAX_COMMAND_REGISTRIES) {
      const oldest = this.commandRegistries.keys().next().value!;
      this.commandRegistries.delete(oldest);
    }
    registry = new CommandRegistryService(root);
    this.commandRegistries.set(root, registry);
  }
  return registry;
}
```

### 5. Cache Invalidation

The SDK command cache refreshes when:

- `forceRefresh=true` is passed (clears `cachedSdkCommands = null`; next `sendMessage` repopulates)
- Server restarts (in-memory cache is lost)

The filesystem scanner's existing 5-minute TTL continues to operate independently for enrichment data.

### Files Changed

| File                                                                                  | Change                                                                                            |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/shared/src/schemas.ts`                                                      | Make `namespace`, `command`, `filePath` optional in `CommandEntrySchema`                          |
| `apps/server/src/services/runtimes/claude-code/message-sender.ts`                     | Add `onCommandsReceived` callback + `supportedCommands()` call                                    |
| `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts`                | Add `cachedSdkCommands` property, merge logic in `getCommands()`, extract `getOrCreateRegistry()` |
| `apps/server/src/services/runtimes/claude-code/__tests__/sdk-scenarios.ts`            | Populate `slash_commands` in mock init messages                                                   |
| `apps/server/src/services/runtimes/claude-code/__tests__/claude-code-runtime.test.ts` | Add tests for SDK+filesystem merge, fallback behavior                                             |
| `apps/server/src/routes/__tests__/commands.test.ts`                                   | Update assertions for optional fields                                                             |

### Files NOT Changed

| File                                                               | Reason                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------- |
| `apps/server/src/routes/commands.ts`                               | Already delegates to `runtime.getCommands()`                |
| `packages/shared/src/transport.ts`                                 | Interface unchanged                                         |
| `packages/shared/src/agent-runtime.ts`                             | Interface unchanged                                         |
| All client code                                                    | Transparent — `CommandEntry[]` shape is backward compatible |
| `apps/server/src/services/runtimes/test-mode/test-mode-runtime.ts` | Continues returning empty commands                          |

## User Experience

### Before This Change

The command palette shows only project-level custom commands from `.claude/commands/`. Users who define commands at `~/.claude/commands/` or use skills don't see them. Built-in Claude Code commands (`/compact`, `/help`, `/clear`) are invisible.

### After This Change

1. **Page load (before any message):** Command palette shows project-level custom commands (filesystem fallback) — identical to current behavior
2. **After first message sent:** Command palette silently upgrades to include built-ins, user-level commands, and skills alongside custom commands
3. **Custom commands retain metadata:** `allowedTools` and `filePath` appear for project-level commands that exist on disk
4. **Built-in/skill commands:** Appear as flat entries without namespace or file metadata

No UI changes, no new affordances, no visual distinction between command sources.

## Testing Strategy

### Unit Tests

**1. SDK command caching (`claude-code-runtime.test.ts`)**

```typescript
describe('SDK command caching', () => {
  it('caches SDK commands on first sendMessage callback', async () => {
    // Arrange: sendMessage triggers onCommandsReceived callback
    // Act: call getCommands()
    // Assert: returns SDK commands, not just filesystem commands
  });

  it('does not re-fetch SDK commands on subsequent sendMessage calls', async () => {
    // Purpose: verify onCommandsReceived is only passed when cache is empty
    // Arrange: populate cache via first sendMessage
    // Act: send second message
    // Assert: onCommandsReceived is undefined in second call opts
  });

  it('clears SDK command cache on forceRefresh', async () => {
    // Purpose: verify forceRefresh invalidates the SDK cache
    // Arrange: populate cache
    // Act: call getCommands(true)
    // Assert: falls back to filesystem scanner
  });
});
```

**2. Merge logic (`claude-code-runtime.test.ts`)**

```typescript
describe('command source merging', () => {
  it('enriches SDK commands with filesystem metadata where available', async () => {
    // Purpose: validate that allowedTools and filePath from filesystem are merged
    // Arrange: SDK returns [/ns:cmd, /compact], filesystem has /ns:cmd with allowedTools
    // Act: getCommands()
    // Assert: /ns:cmd has allowedTools+filePath, /compact does not
  });

  it('includes SDK-only commands without filesystem metadata', async () => {
    // Purpose: built-in commands appear even without filesystem entry
    // Arrange: SDK returns /compact, filesystem has no matching entry
    // Act: getCommands()
    // Assert: /compact appears with description but no namespace/filePath
  });

  it('falls back to filesystem when SDK cache is empty', async () => {
    // Purpose: pre-session commands work via filesystem fallback
    // Arrange: no sendMessage has been called yet
    // Act: getCommands()
    // Assert: returns filesystem-only commands (existing behavior)
  });

  it('sorts merged commands alphabetically by fullCommand', async () => {
    // Purpose: consistent ordering regardless of source
    // Arrange: SDK returns [/zebra, /alpha], filesystem has [/middle]
    // Act: getCommands()
    // Assert: order is [/alpha, /middle, /zebra]
  });
});
```

**3. Schema changes (`commands.test.ts`)**

```typescript
it('accepts commands with optional namespace and filePath', () => {
  // Purpose: verify schema allows SDK-only command shape
  const sdkOnlyCommand = {
    fullCommand: '/compact',
    description: 'Compact conversation history',
  };
  expect(() => CommandEntrySchema.parse(sdkOnlyCommand)).not.toThrow();
});
```

**4. Message sender callback (`message-sender.test.ts` or equivalent)**

```typescript
it('calls supportedCommands() on SDK query when callback provided', async () => {
  // Purpose: verify the non-blocking supportedCommands() call is wired up
  // Arrange: mock SDK query with supportedCommands spy
  // Act: executeSdkQuery with onCommandsReceived callback
  // Assert: supportedCommands() was called, callback received mapped results
});
```

### Integration Tests

No new integration tests needed — the existing route tests in `commands.test.ts` validate the HTTP contract. The route delegates to `runtime.getCommands()` which is mocked in tests.

### E2E Tests

Not required for this change. The command palette UI is unchanged. Existing E2E tests (if any) for the command palette continue to pass.

## Performance Considerations

- **No additional latency:** `supportedCommands()` is non-blocking (fire-and-forget), same as `supportedModels()`
- **Merge cost:** O(n) map lookup per SDK command for filesystem enrichment — negligible for ~50-200 commands
- **Cache efficiency:** SDK commands cached once per runtime lifetime; filesystem scanner retains its 5-minute TTL for enrichment data
- **Memory:** One additional array (~50-200 entries) cached on the runtime instance

## Security Considerations

- No new external API calls — `supportedCommands()` is a local IPC call to the Claude Code process
- All SDK interaction remains confined to `services/runtimes/claude-code/` (ADR-0089, lint-enforced)
- No new user inputs processed — the merge logic only combines two trusted internal sources
- Boundary validation for `cwd` parameter is unchanged (existing route-level check)

## Documentation

No documentation changes needed. The command palette behavior is transparent — users see more commands without any configuration. The internal architecture change is covered by this spec.

## Implementation Phases

### Phase 1: Schema + SDK Fetch + Merge (Single Phase)

This is a small, tightly coupled change (~5 files). A single implementation phase:

1. Update `CommandEntrySchema` to make `namespace`, `command`, `filePath` optional
2. Add `onCommandsReceived` callback to `MessageSenderOpts` and wire up `supportedCommands()` call
3. Add `cachedSdkCommands` property to `ClaudeCodeRuntime`
4. Implement merge logic in `getCommands()`, extract `getOrCreateRegistry()` helper
5. Update test scenarios to populate `slash_commands` and add new test cases
6. Verify existing route tests pass with optional fields

## Open Questions

None — all decisions resolved during ideation.

## References

- `specs/sdk-command-discovery/01-ideation.md` — Ideation document with research
- `specs/improve-slash-commands/` — Complementary spec #19 (UI/UX fixes, fully implemented)
- `research/20260315_agent_sdk_slash_command_discovery_api.md` — SDK API details (3 discovery mechanisms)
- `research/20260315_slash_command_storage_formats_competitive.md` — Competitive analysis of 6 tools
- ADR-0085: Agent Runtime Interface
- ADR-0089: SDK Import Confinement
