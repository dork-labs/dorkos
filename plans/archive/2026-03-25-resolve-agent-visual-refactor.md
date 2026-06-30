# resolveAgentVisual Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract agent visual identity resolution into a single pure function `resolveAgentVisual` so that every consumer uses the same logic and the hash-fallback behavior can never drift.

**Architecture:** Place the pure `resolveAgentVisual` function in `shared/lib/` (alongside the hash utilities it depends on) so it is importable from any FSD layer. Define a minimal `AgentVisualSource` interface (just `id`, `color?`, `icon?`) that both `AgentManifest` and `AgentPathEntry` already satisfy. The existing `useAgentVisual` hook in `entities/agent/` becomes a thin memoized wrapper. All 5 inline-resolution sites (including `DirectoryPicker` in `shared/ui/`), plus the topology builder, switch to calling `resolveAgentVisual`. The `entities/agent/` barrel re-exports the function for convenience.

**Tech Stack:** TypeScript, React (hooks), Vitest

---

### File Map

| File                                                                       | Action | Responsibility                                                                             |
| -------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| `apps/client/src/layers/shared/lib/resolve-agent-visual.ts`                | Create | `AgentVisualSource` interface and `resolveAgentVisual` pure function                       |
| `apps/client/src/layers/shared/lib/index.ts`                               | Modify | Re-export `resolveAgentVisual` and `AgentVisualSource`                                     |
| `apps/client/src/layers/shared/lib/__tests__/resolve-agent-visual.test.ts` | Create | Tests for `resolveAgentVisual` pure function                                               |
| `apps/client/src/layers/entities/agent/model/use-agent-visual.ts`          | Modify | Slim down to import and call `resolveAgentVisual` from shared                              |
| `apps/client/src/layers/entities/agent/index.ts`                           | Modify | Re-export `resolveAgentVisual` and `AgentVisualSource` from shared                         |
| `apps/client/src/layers/features/command-palette/ui/AgentCommandItem.tsx`  | Modify | Replace inline resolution with `resolveAgentVisual`                                        |
| `apps/client/src/layers/features/command-palette/ui/AgentPreviewPanel.tsx` | Modify | Replace inline resolution with `resolveAgentVisual`                                        |
| `apps/client/src/layers/features/pulse/ui/ScheduleRow.tsx`                 | Modify | Replace inline resolution with `resolveAgentVisual`                                        |
| `apps/client/src/layers/features/pulse/ui/AgentPicker.tsx`                 | Modify | Replace inline resolution with `resolveAgentVisual`                                        |
| `apps/client/src/layers/shared/ui/DirectoryPicker.tsx`                     | Modify | Replace inline resolution with `resolveAgentVisual`                                        |
| `apps/client/src/layers/features/mesh/lib/build-topology-elements.ts`      | Modify | Use `resolveAgentVisual` for emoji; preserve `color ?? null` for namespace border fallback |
| `apps/client/src/layers/features/mesh/ui/AgentNode.tsx`                    | Modify | Make `emoji` non-nullable in `AgentNodeData`                                               |

---

### Task 1: Create `resolveAgentVisual` in shared/lib and add tests

**Files:**

- Create: `apps/client/src/layers/shared/lib/resolve-agent-visual.ts`
- Create: `apps/client/src/layers/shared/lib/__tests__/resolve-agent-visual.test.ts`
- Modify: `apps/client/src/layers/shared/lib/index.ts`

- [ ] **Step 1: Write tests for the pure function**

Create `apps/client/src/layers/shared/lib/__tests__/resolve-agent-visual.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveAgentVisual } from '../resolve-agent-visual';
import { hashToHslColor, hashToEmoji } from '../favicon-utils';

describe('resolveAgentVisual', () => {
  it('uses color and icon overrides when present', () => {
    const result = resolveAgentVisual({ id: 'test-id', color: '#6366f1', icon: '🤖' });
    expect(result.color).toBe('#6366f1');
    expect(result.emoji).toBe('🤖');
  });

  it('hashes from id when no overrides are set', () => {
    const result = resolveAgentVisual({ id: 'test-id' });
    expect(result.color).toBe(hashToHslColor('test-id'));
    expect(result.emoji).toBe(hashToEmoji('test-id'));
  });

  it('handles partial overrides — color set, icon not', () => {
    const result = resolveAgentVisual({ id: 'test-id', color: '#ff0000' });
    expect(result.color).toBe('#ff0000');
    expect(result.emoji).toBe(hashToEmoji('test-id'));
  });

  it('handles partial overrides — icon set, color not', () => {
    const result = resolveAgentVisual({ id: 'test-id', icon: '🎯' });
    expect(result.color).toBe(hashToHslColor('test-id'));
    expect(result.emoji).toBe('🎯');
  });

  it('treats null overrides same as undefined (defensive against runtime data)', () => {
    const result = resolveAgentVisual({ id: 'test-id', color: null, icon: null });
    expect(result.color).toBe(hashToHslColor('test-id'));
    expect(result.emoji).toBe(hashToEmoji('test-id'));
  });

  it('produces same output for same id', () => {
    const a = resolveAgentVisual({ id: 'stable-id' });
    const b = resolveAgentVisual({ id: 'stable-id' });
    expect(a).toEqual(b);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/client/src/layers/shared/lib/__tests__/resolve-agent-visual.test.ts`
Expected: FAIL — module does not exist yet.

- [ ] **Step 3: Implement `resolveAgentVisual`**

Create `apps/client/src/layers/shared/lib/resolve-agent-visual.ts`:

```typescript
import { hashToHslColor, hashToEmoji } from './favicon-utils';

/** Minimal shape needed to resolve agent visual identity. */
export interface AgentVisualSource {
  id: string;
  color?: string | null;
  icon?: string | null;
}

/** Resolved visual identity for an agent. */
export interface AgentVisual {
  /** CSS color string (HSL or user override) */
  color: string;
  /** Single emoji character */
  emoji: string;
}

/**
 * Resolve agent visual identity from overrides or deterministic hash fallback.
 *
 * Priority: agent.color/icon override -> hash from agent.id.
 * Pure function — no React dependency. Use directly in non-hook contexts
 * (topology builders, command palette items, pickers, etc.).
 */
export function resolveAgentVisual(agent: AgentVisualSource): AgentVisual {
  return {
    color: agent.color ?? hashToHslColor(agent.id),
    emoji: agent.icon ?? hashToEmoji(agent.id),
  };
}
```

- [ ] **Step 4: Export from shared/lib barrel**

In `apps/client/src/layers/shared/lib/index.ts`, add:

```typescript
export { resolveAgentVisual } from './resolve-agent-visual';
export type { AgentVisual, AgentVisualSource } from './resolve-agent-visual';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run apps/client/src/layers/shared/lib/__tests__/resolve-agent-visual.test.ts`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/client/src/layers/shared/lib/resolve-agent-visual.ts \
       apps/client/src/layers/shared/lib/__tests__/resolve-agent-visual.test.ts \
       apps/client/src/layers/shared/lib/index.ts
git commit -m "refactor(client): add resolveAgentVisual pure function to shared/lib"
```

---

### Task 2: Slim down `useAgentVisual` hook to use `resolveAgentVisual`

**Files:**

- Modify: `apps/client/src/layers/entities/agent/model/use-agent-visual.ts`
- Modify: `apps/client/src/layers/entities/agent/index.ts`

- [ ] **Step 1: Rewrite use-agent-visual.ts**

Replace the contents of `apps/client/src/layers/entities/agent/model/use-agent-visual.ts` with:

```typescript
import { useMemo } from 'react';
import { hashToHslColor, hashToEmoji } from '@/layers/shared/lib/favicon-utils';
import {
  resolveAgentVisual,
  type AgentVisualSource,
  type AgentVisual,
} from '@/layers/shared/lib/resolve-agent-visual';

// Re-export so consumers can import types from this module or the entity barrel.
export { resolveAgentVisual, type AgentVisual, type AgentVisualSource };

/**
 * React hook wrapper for {@link resolveAgentVisual} with memoization.
 *
 * When an agent is present, resolves from agent overrides/id.
 * When no agent is registered (null/undefined), falls back to hashing from cwd.
 *
 * @param agent - Agent data, or null/undefined if unregistered directory
 * @param cwd - Current working directory (fallback hash source when no agent)
 */
export function useAgentVisual(
  agent: AgentVisualSource | null | undefined,
  cwd: string
): AgentVisual {
  return useMemo(() => {
    if (agent) {
      return resolveAgentVisual(agent);
    }
    return {
      color: hashToHslColor(cwd),
      emoji: hashToEmoji(cwd),
    };
  }, [agent, cwd]);
}
```

- [ ] **Step 2: Update entity barrel exports**

In `apps/client/src/layers/entities/agent/index.ts`, change lines 13-14 to:

```typescript
export { useAgentVisual, resolveAgentVisual } from './model/use-agent-visual';
export type { AgentVisual, AgentVisualSource } from './model/use-agent-visual';
```

- [ ] **Step 3: Run existing useAgentVisual tests to verify no regression**

Run: `pnpm vitest run apps/client/src/layers/entities/agent/__tests__/agent-hooks.test.tsx`
Expected: ALL PASS — existing tests pass unchanged since `AgentManifest` satisfies `AgentVisualSource`.

- [ ] **Step 4: Commit**

```bash
git add apps/client/src/layers/entities/agent/model/use-agent-visual.ts \
       apps/client/src/layers/entities/agent/index.ts
git commit -m "refactor(client): slim useAgentVisual to delegate to resolveAgentVisual"
```

---

### Task 3: Migrate command palette to `resolveAgentVisual`

**Files:**

- Modify: `apps/client/src/layers/features/command-palette/ui/AgentCommandItem.tsx`
- Modify: `apps/client/src/layers/features/command-palette/ui/AgentPreviewPanel.tsx`

- [ ] **Step 1: Update AgentCommandItem**

In `AgentCommandItem.tsx`:

1. Replace import:

   ```typescript
   // BEFORE
   import { hashToHslColor, hashToEmoji, shortenHomePath } from '@/layers/shared/lib';
   // AFTER
   import { shortenHomePath, resolveAgentVisual } from '@/layers/shared/lib';
   ```

2. Replace lines 49-50:
   ```typescript
   // BEFORE
   const color = agent.color ?? hashToHslColor(agent.id);
   const emoji = agent.icon ?? hashToEmoji(agent.id);
   // AFTER
   const { color, emoji } = resolveAgentVisual(agent);
   ```

- [ ] **Step 2: Update AgentPreviewPanel**

In `AgentPreviewPanel.tsx`:

1. Replace import:

   ```typescript
   // BEFORE
   import { hashToHslColor, hashToEmoji, shortenHomePath } from '@/layers/shared/lib';
   // AFTER
   import { shortenHomePath, resolveAgentVisual } from '@/layers/shared/lib';
   ```

2. Replace lines 23-24:
   ```typescript
   // BEFORE
   const color = agent.color ?? hashToHslColor(agent.id);
   const emoji = agent.icon ?? hashToEmoji(agent.id);
   // AFTER
   const { color, emoji } = resolveAgentVisual(agent);
   ```

- [ ] **Step 3: Run existing command palette tests**

Run: `pnpm vitest run apps/client/src/layers/features/command-palette/`
Expected: ALL PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/client/src/layers/features/command-palette/ui/AgentCommandItem.tsx \
       apps/client/src/layers/features/command-palette/ui/AgentPreviewPanel.tsx
git commit -m "refactor(client): use resolveAgentVisual in command palette components"
```

---

### Task 4: Migrate pulse components to `resolveAgentVisual`

**Files:**

- Modify: `apps/client/src/layers/features/pulse/ui/ScheduleRow.tsx`
- Modify: `apps/client/src/layers/features/pulse/ui/AgentPicker.tsx`

- [ ] **Step 1: Update ScheduleRow**

In `ScheduleRow.tsx`:

1. Remove the direct favicon-utils import:

   ```typescript
   // DELETE this line
   import { hashToHslColor, hashToEmoji } from '@/layers/shared/lib/favicon-utils';
   ```

2. Add to the existing `@/layers/shared/lib` import:

   ```typescript
   import { cn, shortenHomePath, resolveAgentVisual } from '@/layers/shared/lib';
   ```

3. Compute visual at the top of the component body:

   ```typescript
   const agentVisual = agent ? resolveAgentVisual(agent) : null;
   ```

4. Replace inline resolution in the JSX (lines 122-128):
   ```tsx
   {agent ? (
     <>
       <span
         className="inline-block size-2 shrink-0 rounded-full"
         style={{ backgroundColor: agentVisual!.color }}
       />
       <span className="text-xs leading-none">{agentVisual!.emoji}</span>
       <span className="text-sm font-medium">{agent.name}</span>
       <span className="text-muted-foreground text-xs">&middot;</span>
     </>
   ```

- [ ] **Step 2: Update AgentPicker**

In `AgentPicker.tsx`:

1. Remove the direct favicon-utils import:

   ```typescript
   // DELETE this line
   import { hashToHslColor, hashToEmoji } from '@/layers/shared/lib/favicon-utils';
   ```

2. Add to existing imports:

   ```typescript
   import { cn, shortenHomePath, resolveAgentVisual } from '@/layers/shared/lib';
   ```

3. Compute selected visual above JSX:

   ```typescript
   const selectedVisual = selectedAgent ? resolveAgentVisual(selectedAgent) : null;
   ```

4. Replace inline resolution in selected display (lines 72-78):

   ```tsx
   <span
     className="inline-block size-2 shrink-0 rounded-full"
     style={{ backgroundColor: selectedVisual!.color }}
   />
   <span className="text-xs leading-none">{selectedVisual!.emoji}</span>
   ```

5. Replace inline resolution in dropdown list (lines 94-113):
   ```tsx
   {
     agents.map((agent) => {
       const visual = resolveAgentVisual(agent);
       return (
         <CommandItem
           key={agent.id}
           value={`${agent.name} ${agent.projectPath}`}
           onSelect={() => handleSelect(agent.id)}
         >
           <span
             className="inline-block size-2 shrink-0 rounded-full"
             style={{ backgroundColor: visual.color }}
           />
           <span className="text-xs leading-none">{visual.emoji}</span>
           <span className="truncate font-medium">{agent.name}</span>
           <span className="text-muted-foreground truncate text-xs">
             {shortenHomePath(agent.projectPath)}
           </span>
           {agent.id === value && <Check className="ml-auto size-4 shrink-0" />}
         </CommandItem>
       );
     });
   }
   ```

- [ ] **Step 3: Run pulse tests and typecheck**

Run: `pnpm vitest run apps/client/src/layers/features/pulse/ 2>/dev/null; pnpm typecheck`
Expected: ALL PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/client/src/layers/features/pulse/ui/ScheduleRow.tsx \
       apps/client/src/layers/features/pulse/ui/AgentPicker.tsx
git commit -m "refactor(client): use resolveAgentVisual in pulse ScheduleRow and AgentPicker"
```

---

### Task 5: Migrate DirectoryPicker to `resolveAgentVisual`

**Files:**

- Modify: `apps/client/src/layers/shared/ui/DirectoryPicker.tsx`

This site was the reason `resolveAgentVisual` lives in `shared/lib/` — `shared/ui/` cannot import from `entities/`.

- [ ] **Step 1: Update DirectoryPicker**

In `DirectoryPicker.tsx`:

1. Replace `hashToHslColor` and `hashToEmoji` in the import from `@/layers/shared/lib`:

   ```typescript
   // BEFORE (in the shared/lib import)
   hashToHslColor,
   hashToEmoji,
   // AFTER (replace with)
   resolveAgentVisual,
   ```

2. Replace the inline resolution (lines 330-331):

   ```typescript
   // BEFORE
   const color = agent?.color ?? hashToHslColor(agent?.id ?? recent.path);
   const emoji = agent?.icon ?? hashToEmoji(agent?.id ?? recent.path);
   // AFTER
   const { color, emoji } = resolveAgentVisual({
     id: agent?.id ?? recent.path,
     color: agent?.color,
     icon: agent?.icon,
   });
   ```

   Note: When no agent exists, we pass `recent.path` as `id` so the hash source matches the old behavior (hash from directory path).

- [ ] **Step 2: Run DirectoryPicker tests**

Run: `pnpm vitest run apps/client/src/layers/shared/ui/__tests__/DirectoryPicker.test.tsx`
Expected: ALL PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/client/src/layers/shared/ui/DirectoryPicker.tsx
git commit -m "refactor(client): use resolveAgentVisual in DirectoryPicker"
```

---

### Task 6: Migrate topology builder — fix missing emoji, preserve border color

**Files:**

- Modify: `apps/client/src/layers/features/mesh/lib/build-topology-elements.ts`
- Modify: `apps/client/src/layers/features/mesh/ui/AgentNode.tsx`

**Important design decision:** The topology graph uses `namespaceColor` as the agent card's left border when the agent has no color override. This is an intentional UX affordance for visual namespace grouping. We must NOT replace it with a hash-derived color. Instead:

- **emoji**: Resolve via `resolveAgentVisual` — this fixes the gap where agents without icon overrides had no emoji.
- **color**: Keep `typedAgent.color ?? null` — the existing `resolveBorderColor` fallback chain (`agent color → namespace color`) is preserved.

- [ ] **Step 1: Update build-topology-elements.ts**

1. Add import:

   ```typescript
   import { resolveAgentVisual } from '@/layers/shared/lib';
   ```

2. Replace lines 174-175:
   ```typescript
   // BEFORE
   color: typedAgent.color ?? null,
   emoji: typedAgent.icon ?? null,
   // AFTER
   color: typedAgent.color ?? null,
   emoji: resolveAgentVisual(typedAgent).emoji,
   ```

- [ ] **Step 2: Update `AgentNodeData.emoji` to non-nullable**

In `AgentNode.tsx`, change line 32:

```typescript
// BEFORE
emoji?: string | null;
// AFTER
emoji: string;
```

Leave `color?: string | null` unchanged — it remains nullable so `resolveBorderColor` can fall back to `namespaceColor`.

- [ ] **Step 3: Simplify emoji rendering in AgentNode**

The conditionals `{d.emoji ? `${d.emoji} ` : ''}` on lines 92 and 143 can be simplified to `{`${d.emoji} `}` since emoji is now always a non-empty string. However, this is cosmetic — leave as-is to minimize the diff.

- [ ] **Step 4: Run mesh tests and typecheck**

Run: `pnpm vitest run apps/client/src/layers/features/mesh/ 2>/dev/null; pnpm typecheck`
Expected: ALL PASS. If any mesh test constructs `AgentNodeData` without an `emoji` field, add a value like `emoji: '🤖'`.

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/layers/features/mesh/lib/build-topology-elements.ts \
       apps/client/src/layers/features/mesh/ui/AgentNode.tsx
git commit -m "refactor(client): resolve agent emoji in topology builder, preserve border color"
```

---

### Task 7: Verify no remaining inline resolution and run full suite

- [ ] **Step 1: Grep for stale inline resolution patterns**

Run: `grep -rn 'hashToHslColor\|hashToEmoji' apps/client/src/layers/`

Expected matches (all legitimate):

- `shared/lib/favicon-utils.ts` — definitions
- `shared/lib/index.ts` — re-exports
- `shared/lib/resolve-agent-visual.ts` — centralized caller
- `shared/lib/__tests__/resolve-agent-visual.test.ts` — tests import for assertions
- `shared/lib/__tests__/favicon-utils.test.ts` — tests for the hash functions
- `shared/model/use-document-title.ts` — document title uses CWD-based hashing (no agent)
- `shared/model/use-favicon.ts` — favicon uses CWD-based hashing (no agent)
- `entities/agent/model/use-agent-visual.ts` — CWD fallback in hook

No matches should appear in `features/` or `widgets/` layers.

- [ ] **Step 2: Run full test suite**

Run: `pnpm test -- --run`
Expected: ALL PASS.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 4: Run lint**

Run: `pnpm lint`
Expected: No new errors.
