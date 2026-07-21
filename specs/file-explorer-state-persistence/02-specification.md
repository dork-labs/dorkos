# File explorer state persistence + UX polish — Specification

**Issue:** DOR-404 · **Spec id:** 260721-140257 · **Status:** specified
**Feature dir:** `apps/client/src/layers/features/file-explorer/`
**Companion research:** `01-ideation.md` (decisions D1–D8, assumptions A1–A3)

## Goal

The Files tab behaves like a place, not a popup: expanded directories, the selected
row, the scroll position, and the hidden-files toggle all survive (a) opening a file
and coming back, (b) switching right-panel tabs, (c) a full page refresh. Directory
data is cached so returning to the tree is instant within a page session. Refresh
refetches everything that is visible, not just the root.

Non-goals (deferred, see D8): tree search/filter, multi-select, copy/duplicate,
reveal-from-canvas for agent-opened files, committed Playwright e2e.

## §1 Persisted explorer UI state

Extend the existing feature store `model/file-explorer-store.ts` (do **not** create a
second store; one store per feature):

```ts
interface FileExplorerEntry {
  expanded: Record<string, boolean>; // dir path (ROOT_KEY-relative, same keys as today) → true
  selectedPath: string | null;
  scrollTop: number;
  accessedAt: number; // LRU stamp
}
```

- **Storage:** one localStorage blob, key `dorkos-file-explorer-state`, holding
  `Record<cwd, FileExplorerEntry>`. Hand-written co-located helpers
  (`readExplorerEntry(cwd)` / `writeExplorerEntry(cwd, entry)`), `try/catch`-wrapped,
  LRU-evicting beyond `MAX_FILE_EXPLORER_ENTRIES = 50` by `accessedAt` on write —
  mirror `app-store-helpers.ts` (`readCanvasSession`/`writeCanvasSession`) exactly.
  Helpers live in the feature (`model/`), not in shared — this store is feature-owned.
- **Store state/actions** (added to `useFileExplorerStore`):
  - `scopeKey: string | null` — the active cwd.
  - `expanded`, `selectedPath`, `scrollTop` — the live copy of the active entry.
  - `loadExplorerForCwd(cwd: string | null)` — explicit hydration: stamps `accessedAt`,
    loads (or defaults) the entry, `set()`s it. Called when the explorer's cwd changes.
    Mirrors `loadCanvasForSession`.
  - `setDirExpanded(path, isExpanded)`, `setSelectedPath(path)`, `setScrollTop(n)` —
    each `set()`s then writes through to localStorage inline (`persist()` helper
    pattern from `app-store-canvas.ts`). `setScrollTop` is the only high-frequency
    writer: callers must debounce (§4); the store itself stays dumb.
  - `pruneMissing(parentPath, existingChildNames)` — drops `expanded`/`selectedPath`
    entries pointing at children of `parentPath` that no longer exist (A3). Called from
    the hook when a directory listing arrives.
- **`showHidden`** (already in this store): persist globally under
  `dorkos-file-explorer-show-hidden` with a co-located bool read/write pair following
  the `readBool`/`writeBool` convention (D5). Initial value reads storage.
- `commands`, `renamingPath`, `draft` are unchanged (D7 — ephemeral stays ephemeral).

## §2 Directory data moves to TanStack Query

Replace the `useReducer` data plumbing in `model/use-file-explorer.ts`:

- **Query shape:** one query per visible directory.
  `queryKey: ['file-explorer', 'tree', cwd, dirPath, showHidden]`,
  `queryFn: () => transport.readFileTree(cwd, { path: dirPath, showHidden })`,
  `staleTime: QUERY_TIMING.FILE_TREE_STALE_TIME_MS` (add, 30*000),
  `gcTime: QUERY_TIMING.FILE_TREE_GC_TIME_MS` (add, 30 \* 60_000) — new constants in
  the existing `QUERY_TIMING` block beside `FILES*\*`.
- **Enumeration:** root (`ROOT_KEY`) plus every `expanded` dir, via `useQueries` (the
  list of visible dirs is derived state, not per-row hooks — virtualization must not
  affect fetching). A dir's query mounts when it becomes expanded; cached data renders
  instantly on remount within a page session (this is the cache-across-tab-switch win).
- **Derivation:** `flattenTree` becomes a pure function of
  `(expanded, queryDataByPath, showHidden)` → `FlatRow[]`. Keep the pure helpers
  (`sortEntries`, `parentOf`, `joinPath`, `baseName`) — move them (and `flattenTree`)
  to a pure module; **delete** the reducer and its now-dead actions entirely (no
  half-migrations). Update `tree-reducer.test.ts` accordingly (rename to match).
- **Loading/error UX:** an expanded-but-loading dir renders its existing skeleton/spinner
  row; a failed dir listing renders the existing error affordance with retry
  (`refetch`). Behavior parity with today, sourced from query state.
- **Refresh (D4):** `explorer.reload` becomes
  `queryClient.invalidateQueries({ queryKey: ['file-explorer', 'tree', cwd] })` —
  root and every expanded dir refetch. The toolbar Refresh button gets this for free
  via the `commands` bridge.
- **CRUD (`model/use-file-crud.ts`):** keep optimistic semantics, retarget from reducer
  dispatches to query-cache writes:
  - create → `setQueryData` on the parent dir's key (insert, `sortEntries`-ordered);
  - rename/move → remove from source parent key, insert into dest parent key;
  - delete → remove from parent key;
  - on error → restore snapshotted previous data (rollback), keep the coded-error
    toasts; on settle → invalidate the touched dir keys.
  - Also update `expanded`/`selectedPath` in the store on rename/move/delete of an
    expanded/selected path (path-prefix rewrite on rename of an ancestor; drop on delete).
- **Transport is unchanged.** No server changes in this spec.

## §3 Hydration & lifecycle

In `use-file-explorer.ts` (or a successor hook composed by it):

1. On `cwd` change: `loadExplorerForCwd(cwd)`. No imperative root fetch — the root
   query mounts declaratively once `cwd` is set; persisted `expanded` dirs mount their
   queries in the same render. After a refresh this cascades fetches for exactly the
   dirs the user had open (A3's prune keeps this bounded).
2. When a dir listing arrives: call `pruneMissing(dirPath, names)`.
3. `selectedPath` renders as today (row highlight + keyboard-nav anchor). If the
   selected path is inside a collapsed subtree it is retained but invisible — no
   auto-expansion of ancestors (predictability over magic).
4. Selection changes (click, keyboard, post-create/rename) go through
   `setSelectedPath` — lift the `useState` out of `FileExplorer.tsx` (D1).

## §4 Scroll persistence (D6)

- The scroll container (`FileTree`, both plain and virtualized paths) writes
  `setScrollTop` on scroll **debounced ≥250 ms trailing** and once more in the effect
  cleanup on unmount (latest value wins). Never per-event/per-frame localStorage writes.
- Restore: after the first render in which the flattened rows are non-empty, set the
  container's `scrollTop` (virtualized path: `scrollToOffset`) exactly once per
  hydration. Guard so later data arrivals don't re-scroll. If content is shorter than
  the saved offset, the browser clamps — acceptable.

## §5 Acceptance criteria

1. Expand `src/` → `src/layers/` → open a file → close it / return to Files: the tree
   is exactly as left — same expansion, same selection, same scroll. (The reported bug.)
2. Switch Files → Pulse → Files: same guarantee.
3. Full page refresh: expansion + selection + scroll + hidden-toggle restore; expanded
   dirs refetch and repopulate.
4. Refresh button refetches every expanded directory (create a file externally two
   levels deep, hit Refresh, see it appear).
5. Switching cwd/agent swaps to that cwd's own remembered state; returning swaps back.
6. Create/rename/delete/move still update instantly and roll back on server rejection.
7. Keyboard nav, context menus, DnD move, inline create/rename behave exactly as today.
8. Works identically in embedded (Obsidian) mode — localStorage only, no config writes.

## §6 Testing

- **Store tests** (`__tests__/file-explorer-store.test.ts`): hydration for known/unknown
  cwd, write-through on each setter, LRU eviction at 50, `pruneMissing`, `showHidden`
  persistence round-trip, corrupted-JSON resilience (falls back to defaults).
- **Component regression test — the headline:** render `FileExplorer`, expand a dir,
  select a file, **unmount, remount** → expansion + selection intact, and the dir's
  children render from cache without a new transport call (assert call counts).
- Update `FileExplorer.test.tsx` CRUD/refresh tests for the query-cache data layer
  (refresh asserts subtree invalidation, not root-only).
- Keep/port pure-function tests for `flattenTree`/`sortEntries`/path helpers.
- All client tests green: `pnpm --filter @dorkos/client test -- --run` equivalent via
  targeted `pnpm vitest run` on touched files, then `pnpm verify` before PR.

## §7 File-touch map (expected)

| File                                                           | Change                                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `model/file-explorer-store.ts`                                 | extend store: persisted per-cwd entry + helpers + showHidden persistence         |
| `model/use-file-explorer.ts`                                   | queries via `useQueries`, hydration, prune, selection lift, reload-as-invalidate |
| `model/use-file-crud.ts`                                       | optimistic writes retargeted to query cache + store path fixups                  |
| `model/tree-reducer.ts` → pure module                          | reducer deleted; pure helpers + `flattenTree` kept                               |
| `model/types.ts`                                               | `FlatRow` unchanged; entry types added                                           |
| `ui/FileExplorer.tsx`                                          | selection state removed (store), wiring                                          |
| `ui/FileTree.tsx`                                              | scroll save/restore; loading/error rows from query state                         |
| `ui/FileTreeRow.tsx`                                           | minor prop plumbing only                                                         |
| `shared config `QUERY_TIMING``                                 | `FILE_TREE_STALE_TIME_MS`, `FILE_TREE_GC_TIME_MS`                                |
| `__tests__/*`                                                  | per §6                                                                           |
| `changelog/unreleased/<id>-file-explorer-state-persistence.md` | user-facing fragment (writing-for-humans voice)                                  |
