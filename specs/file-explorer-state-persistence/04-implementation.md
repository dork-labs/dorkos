# Implementation Summary: File explorer state persistence + UX polish

**Created:** 2026-07-21
**Last Updated:** 2026-07-21 (post-review: three review nits fixed)
**Spec:** specs/file-explorer-state-persistence/02-specification.md
**Issue:** DOR-404
**Worktree:** `/Users/doriancollier/.dork/workspaces/dorkos/feat-dor-404-file-explorer-state`
**Branch:** `feat-dor-404-file-explorer-state`

## Progress

**Status:** Complete — all four tasks (1.1 → 1.2 → 2.1 → 2.2) landed as one commit each.

## What shipped vs the spec

### §1 Persisted explorer UI state — done

- `FileExplorerEntry` (`{ expanded, selectedPath, scrollTop, accessedAt }`) persisted as one
  localStorage blob `Record<cwd, entry>` under `dorkos-file-explorer-state`, LRU-capped at
  `MAX_FILE_EXPLORER_ENTRIES = 50` by `accessedAt`.
- Feature-owned, hand-written `try/catch` helpers in `model/file-explorer-persistence.ts`
  (`readExplorerEntry`/`writeExplorerEntry`/`readShowHidden`/`writeShowHidden`), mirroring
  `app-store-helpers.ts` exactly. No Zustand `persist` middleware.
- Store gained `scopeKey`/`expanded`/`selectedPath`/`scrollTop` plus `loadExplorerForCwd`
  (explicit hydration, stamps `accessedAt`), `setDirExpanded`/`setSelectedPath`/`setScrollTop`
  (inline write-through after `set()`), and `pruneMissing`.
- `showHidden` persisted globally under `dorkos-file-explorer-show-hidden`; initial value reads
  storage. `commands`/`renamingPath`/`draft` stay ephemeral (D7).

### §2 Directory data → TanStack Query — done

- One query per visible directory, key `['file-explorer','tree',cwd,dirPath,showHidden]`,
  `staleTime`/`gcTime` from new `QUERY_TIMING.FILE_TREE_STALE_TIME_MS` (30 s) /
  `FILE_TREE_GC_TIME_MS` (30 min), enumerated via `useQueries`.
- `flattenTree` is now pure over `(expanded, dirData)`; `sortEntries`/`parentOf`/`joinPath`/
  `baseName` moved with it into `model/tree.ts`. The reducer and its dead actions were
  **deleted** (no comment-outs); `tree-reducer.ts` → `tree.ts`, `tree-reducer.test.ts` →
  `tree.test.ts`.
- Refresh = `invalidateQueries({ queryKey: ['file-explorer','tree',cwd] })` (whole subtree, D4).
- CRUD retargeted to `setQueryData` on the affected parent key, snapshot rollback on error,
  invalidate on settle; conflict-safety semantics preserved (the existing conflict tests pass
  unchanged). Rename/move/delete fix up store paths (see deviations).

### §3–§4 Hydration, selection lift, scroll — done

- `loadExplorerForCwd(cwd)` on cwd change; `pruneMissing` on each listing arrival (gated by the
  entries reference so a stable listing never re-triggers a write).
- Selection lifted out of `FileExplorer.tsx` `useState` into the store (D1). No ancestor
  auto-expansion for an off-screen selection (§3.3).
- Scroll: trailing-debounced write (`SCROLL_PERSIST_MS = 250`) + unmount flush; one-shot restore
  after the first non-empty render, gated on `scopeKey`, for both plain and virtualized paths
  (virtualizer uses `scrollToOffset`).

### §5 Acceptance / §6 tests — done

- Headline regression test (expand + select → unmount → remount → expansion + selection intact,
  child served from cache, `readFileTree` call count asserted unchanged) — green.
- Store tests (hydration known/unknown cwd, per-setter write-through, LRU at 50, `pruneMissing`,
  `remap`/`drop`, show-hidden round-trip, corrupted-JSON fallback), pure-module tests
  (path helpers, `sortEntries`, `visibleExpandedDirs`, `flattenTree`), and a subtree-refresh test.
- `pnpm verify` passes (typecheck + lint + affected tests).

## Deviations from spec (with justification)

1. **`flattenTree(expanded, dirData)` — `showHidden` dropped as a parameter.** The spec listed
   `flattenTree(expanded, queryDataByPath, showHidden)`. `showHidden` is baked into each
   directory's query key, so `dirData` already reflects it; a `showHidden` argument would be
   dead. Loading status is folded into the `DirState` map (`{ entries, loading, error }`) the
   flattener reads. Function stays pure and testable.
2. **`FlatRow` kept unchanged (§7), so error state rides props, not synthetic rows.** A failed
   _expanded subdirectory_ renders an inline Retry on its own row (via `errorPaths` +
   `onRetryDir` threaded to `FileTreeRow` — "minor prop plumbing", §7); a failed _root_ renders a
   centered Retry in `FileExplorer`. Today's code swallowed listing errors, so there was no
   "existing error affordance" to reuse; this is the minimal calm version. Keeping `FlatRow`
   entry-only left keyboard nav untouched.
3. **Two store actions added beyond §1's list: `remapExpandedPaths` / `dropExpandedPaths`.**
   §2 requires updating `expanded`/`selectedPath` on rename/move/delete; these are the dedicated,
   unit-tested actions that do it (prefix-rewrite on rename/move, drop on delete). Applied on
   transport **success** (not optimistically) to avoid store-state rollback bookkeeping — the
   query cache still updates optimistically with rollback, so the only cost is a sub-tick lag in
   selection following a moved row on a slow transport (negligible; imperceptible on the
   in-process transport).
4. **Post-create/rename selection.** §3.4 lists create/rename as selection sources, so a
   successfully created or renamed entry becomes the selection.
5. **Enumeration gates on the full ancestor chain (`visibleExpandedDirs`).** Rather than "root +
   every expanded dir" literally, only expanded dirs whose ancestors are all expanded mount a
   query — matching exactly what `flattenTree` renders. Collapsing an ancestor stops fetching its
   whole subtree, and re-expanding restores nested expansion as it was (today's UX). Strictly a
   tightening of the spec's intent, no behavior loss.

## Notable implementation notes for review

- **Zustand no-op discipline:** `pruneMissing`/`remapExpandedPaths`/`dropExpandedPaths` return the
  same state reference when nothing changes, so the prune effect (which runs whenever the
  `useQueries` result array re-identifies) never churns the store or loops.
- **Scroll persistence scope races:** the unmount flush writes to the store's _current_
  `scopeKey`. For the primary bug scenario (open file / tab switch, same cwd) this is always
  correct; a cwd change while a scroll debounce is still pending is the only edge that could
  misattribute a stale offset, and is not worth extra coupling. **Reviewer confirmed this note
  accurate and negligible-by-design (DOR-404 review, nit 4):** after nit 2 the debounce only ever
  holds a _user_ scroll (programmatic restore scrolls are ignored), so the edge is even narrower —
  only a user scroll landing microseconds before a cwd switch — and still not worth the coupling.
- **No server/transport changes.** Only `apps/client/src/layers/features/file-explorer/`, the two
  `QUERY_TIMING` constants, and tests were touched.

## Review follow-ups (APPROVE-WITH-NITS, DOR-404)

Independent review returned APPROVE-WITH-NITS (0 important, 4 nits). Nits 1–3 fixed in one commit;
nit 4 needs no code change.

1. **Nit 1 — failed optimistic delete no longer loses selection/expansion.** A shared in-flight
   counter (`inFlightRef`, threaded from `use-file-explorer.ts` into `use-file-crud.ts`) is raised
   around every optimistic op via a `guard` wrapper; the prune effect stands down while it is
   raised, so a transient optimistic cache edit (a removed/renamed row) can never be misread as the
   entry vanishing and pruned from the store — a prune a rollback couldn't undo. On settle the op
   invalidates and the refetch re-runs the prune against real data. Regression tests (file delete +
   directory recursive delete) use a test-controlled deferred rejection so the optimistic render
   commits before the reject; both fail without the gate.
2. **Nit 2 — scroll no longer under-restores after a cold refresh with a deep offset.** The one-shot
   restore in `FileTree.tsx` became a re-applying restore: it re-applies the saved offset every time
   content grows (rows stream in) and latches permanently only once the container can hold the full
   offset unclamped, or the user scrolls (a user scroll always wins — `handleScroll` distinguishes
   its own programmatic scrolls from real ones and latches immediately on a real one). Latch is per
   `scopeKey`. Also fixes a latent bug: clamped programmatic restore scrolls are no longer persisted
   (they would have corrupted the saved offset). New `FileTree.test.tsx` covers grow-then-latch and
   user-scroll-cancels-restore.
3. **Nit 3 — first show-hidden toggle no longer blanks the tree to a root spinner.** Tree queries got
   a `placeholderData` that holds the previous rows across the toggle. **Deviation from the review's
   suggested mechanism:** the literal `placeholderData: keepPreviousData` does _not_ work here —
   `useQueries` matches observers by `queryHash`, so a show-hidden toggle (part of the key) spins up
   a _fresh_ observer with no previous data (verified against `@tanstack/query-core` 5.99
   `queriesObserver` source; `keepPreviousData` works only for single `useQuery`). The working
   equivalent reads the sibling (opposite show-hidden) listing straight from the cache as the
   placeholder. A first-ever expand has neither key cached, so its skeleton still shows. New
   regression test asserts the previous rows hold across the toggle.
4. **Nit 4 — no code change.** The scroll-flush misattribution note above was reviewed and confirmed
   negligible-by-design.
5. **Live-verification fix — selection reveal no longer fights scroll restore on remount.** A live-browser
   probe found the "keep selected row in view" effect fired on mount, not just on selection change:
   on remount it dragged the restored offset back to the (out-of-view) selection and, because the reveal
   scroll wasn't marked programmatic, `handleScroll` persisted it over the user's saved offset. Fixed by
   making the reveal change-driven (a previous-selection ref; the first run per mount only records, and an
   unchanged selection never re-reveals — this also stops late query loads from fighting the restore) and
   marking the reveal scroll programmatic (`programmaticTopRef` from the post-reveal `scrollTop`). New
   `FileTree.test.tsx` cases: no reveal on mount + saved offset preserved; reveal still fires on
   keyboard/click selection change.

## Deferred follow-ups (D8)

Each deserves its own design; intentionally out of scope to keep this PR reviewable:

- Tree search / filter.
- Multi-select.
- Copy / duplicate.
- Reveal-from-canvas for agent-opened files (jump the tree to a file the agent opened).
- Committed Playwright e2e for the persistence flows (covered here by unit + component tests).
