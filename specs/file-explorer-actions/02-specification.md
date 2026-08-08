# File explorer: context menu actions, copy/paste, and drag-and-drop

- **Spec id**: 260808-144053
- **Linear**: DOR-1032
- **Status**: specified (slices A and B implemented)

The workbench file tree can create, rename, delete, and drag-to-move. Everything
else a person expects from a file tree — show it in the OS file manager, copy
its path, hand it to the agent, copy and paste it — is missing, so the tree is
where you look at files rather than where you work with them. This spec closes
that gap.

## Decisions (locked)

1. **Reveal in the OS file manager.** The menu label follows the **server's** OS,
   because the server is the machine whose file manager opens: `darwin` →
   "Reveal in Finder", `win32` → "Reveal in File Explorer", anything else →
   "Show in File Manager". The server platform is already published at
   `GET /api/config` (`platform: "${process.platform}-${process.arch}"`), read
   through the existing `useConfig()` query.
2. **Copy path, the VS Code way.** Two flat items: "Copy Path" (absolute — the
   working directory joined with the entry's stored path, spelled with the
   server OS's separator) and "Copy Relative Path" (the stored path as-is).
   Written with `navigator.clipboard.writeText`; success is silent (the menu
   closing is the acknowledgement) and only a refused clipboard toasts.
3. **Add to Chat stays.** One click replaces copy → focus → type `@` → paste. It
   inserts `@<relativePath> ` (trailing space) into the chat composer and
   focuses it — the plain-text file reference the composer's own `@` palette
   already produces, so the chat needs no new rendering.
4. **Copy and paste files** (slice B). Context-menu Copy + Paste plus
   Cmd/Ctrl+C/V. Copy puts the entry on an internal explorer clipboard
   (`{ path, isDir }` in the file-explorer store) **and** writes the relative
   path as text to the system clipboard, so pasting into the chat or any
   external app pastes the path. Paste targets the selected directory, the
   parent of the selected file, or the root. Collisions get Finder-style names
   (`name copy.ext`, `name copy 2.ext`), computed client-side from the target
   directory's loaded listing. **Duplicate** copies in place with the same
   suffix. No Cut — drag already moves.
5. **Drag and drop** (slice B). Keep the existing native HTML5 DnD (no dnd-kit).
   Holding Alt/Option during a drop copies instead of moving (`dropEffect` set
   during `dragover`, `altKey` read at drop). The empty area below the tree
   becomes a drop target for the root. `dragstart` additionally sets
   `application/x-dorkos-file-path`; the composer's drop layer checks for that
   type first and inserts `@<relativePath> ` instead of treating the drop as a
   file upload.
6. **Menu order** (editor-conventional, existing items kept):

   ```
   New File
   New Folder
   ─────────
   Reveal in Finder          (label per server OS; files and folders)
   Add to Chat
   ─────────
   Copy            ⌘C        (slice B)
   Paste           ⌘V        (slice B; disabled when the clipboard is empty)
   Duplicate                 (slice B)
   ─────────
   Copy Path
   Copy Relative Path
   ─────────
   Rename
   Delete                    (destructive, last)
   ```

   The shared responsive context menu has no shortcut slot, so no keyboard hints
   are shown rather than faking them. On mobile every item works from the
   long-press drawer; drag-and-drop stays desktop-only.

## Slice A — shipped

### Server

Two endpoints in `apps/server/src/routes/files.ts`, following the existing file
routes exactly (Zod request schema in `@dorkos/shared/schemas`, both paths
resolved through `resolveWithinCwd`, the same coded error envelope):

- **`POST /api/files/copy`** `{ cwd, from, to }` — mirrors `POST /rename`:
  boundary-validate both paths, refuse the `cwd` root (400 `REFUSE_ROOT`), 404
  `NOT_FOUND` when `from` is missing, 409 `CONFLICT` when `to` exists, 400
  `COPY_INTO_SELF` when a directory would be copied into its own subtree.
  Directories copy recursively (`fs.cp` with `recursive: true`,
  `errorOnExist: true`, `force: false`); a failed copy removes the partial
  destination so no half-written tree is left behind.
- **`POST /api/files/reveal`** `{ cwd, path }` — boundary-validate, 404 when the
  entry is gone, otherwise dispatch the platform's file manager and answer 204.
  The launcher lives in `apps/server/src/lib/reveal-in-file-manager.ts`: `open -R`
  on macOS, `explorer.exe /select,"…"` (with `windowsVerbatimArguments`, and a
  non-zero exit ignored — Explorer always reports one) on Windows, `xdg-open` on
  the containing folder elsewhere. Always `execFile` with an argument array,
  never a shell, so a file name containing shell metacharacters is data.

### Transport seam

`copyEntry(cwd, from, to)`, `revealEntry(cwd, path)`, and the capability flag
`supportsReveal` join the `Transport` interface. `HttpTransport` implements all
three. `DirectTransport` (Obsidian, in-process) implements `copyEntry` against
the filesystem like its sibling mutations, and reports `supportsReveal: false`:
the in-process host cannot drive the desktop shell, so the menu item is not
offered there at all — the same posture as `supportsTerminal`. A menu item that
throws is never shipped.

### Client

- `model/use-file-actions.ts` — the non-mutating row actions (reveal, copy path,
  add to chat), kept out of `use-file-crud.ts`, which owns the optimistic cache
  dance.
- `lib/paths.ts` — the reveal label per server platform, and the absolute-path
  join that respects the server OS's separator.
- `shared/lib/composer-insert.ts` — a module singleton the chat's input
  container registers with on mount, so the file explorer (a feature) can put
  text in the composer (another feature) without importing it. Deliberately
  **not** part of the agent-facing `UiCommand` schema: this is a client-internal
  seam between two pieces of the cockpit, not something an agent asks for.

## Slice B — shipped

- **Explorer clipboard** — `clipboard: { path, isDir } | null` in
  `file-explorer-store.ts`. Not persisted, and cleared when the working
  directory changes (the path means nothing in another one); a remount of the
  same directory keeps it.
- **Copy / Paste / Duplicate** — menu items in the order above, plus
  Cmd/Ctrl+C and Cmd/Ctrl+V in `FileTree.tsx`'s key ladder, which already
  stands down while the rename input is open. Modifier detection is
  `metaKey || ctrlKey`, the spelling every other shortcut in the client uses;
  `isMac` stays for display only. Paste is `disabled` wherever it could not
  land — nothing copied, or a folder being pasted inside itself — which
  required teaching the shared `ResponsiveContextMenuItem` to honour `disabled`
  in its mobile drawer branch, where it had been dropped.
- **Refusals speak.** A folder cannot be copied into itself. The explorer
  refuses the cases it can see (dimmed item, and a toast for the keyboard,
  which dimming cannot stop); the server refuses the rest — including a
  case-insensitive filesystem where `SRC` and `src` are one folder — as 400
  `COPY_INTO_SELF`, mapped in `crud-errors.ts` to the same sentence, so one
  mistake never produces two explanations. Silence was the original bug: paste
  right after copying a folder did nothing at all and said nothing.
- **Collision-free naming** — `lib/copy-name.ts`, pure and unit-tested. The
  destination's names are read straight from the transport with
  `showHidden: true`, NOT through the tree's cache: the tree's listing is
  filtered by the show-hidden toggle, and a name you cannot see still owns
  itself, so naming a copy from the visible listing lands `.env` on an existing
  `.env` and the server answers 409. `copyEntry` in `use-file-crud.ts` is
  optimistic with rollback like its siblings — it shows the copy only where the
  destination is already on screen, as a move does — and needs no collision
  branch: the name is free by construction. It takes an `EntryRef`
  (`{ path, isDir }`) rather than a path, because the clipboard outlives the row
  that filled it and the source's listing may have been evicted by then.
- **Drag and drop** — `dragstart` sets `text/plain` and
  `application/x-dorkos-file-path` and `effectAllowed = 'copyMove'` (without
  which the browser refuses an Alt-held copy). Every drop target reads the
  custom type, never bare `text/plain`, so a sentence dragged out of another
  app cannot move whatever file it happens to name. Rows stop their own drag
  events from bubbling, so the tree container's handler fires only for drops
  that landed on nothing — that is the root drop target, and it works
  identically in the plain and virtualized lists because it rides on the scroll
  container.
- **Drag into chat** — `ComposerRoot` gained an optional `onPathDropped`
  alongside `onFilesDropped`; `usePathDrop` in the composer-internal
  `use-drag-and-paste.ts` implements it. The drop handler is composed with
  react-dropzone's by hand rather than passed through `getRootProps`, so the
  ordering is explicit: ours first, then react-dropzone's, **always** — its drop
  handler is the only thing that clears the drag targets it counted on the way
  in, and consuming the event instead of passing it on left the "Drop files to
  attach" overlay stuck on forever after the first drag from the tree.
  `shared/lib/file-drag.ts` owns the drag type and its two readers (types are
  compared case-insensitively, since browsers lowercase custom types), and
  `composerFileReference()` in `shared/lib/composer-insert.ts` is the one place
  that spells `@path `.

## Quality bar

- Copy/paste/duplicate mutate optimistically with rollback, mirroring
  `use-file-crud.ts`.
- Server route tests cover copy (file, directory, missing parents, 404, 409,
  400 into-itself, root refusal, boundary escape) and reveal (dispatch, 404,
  403, launcher failure); the launcher's platform branching is tested on its
  own with `execFile` mocked.
- Client tests cover the path helpers, the copy-name ladder, the drag-type
  readers, the composer-insert bridge, and the menu end-to-end through a mock
  transport (label per platform, hidden item when unsupported, clipboard
  contents, composer insertion, paste target and collision naming, rollback).
- Drag tests dispatch a `MouseEvent` rather than `fireEvent.drop`: jsdom
  implements no `DragEvent`, so Testing Library falls back to a plain `Event`
  and silently drops `altKey` — which would make every Alt-to-copy assertion
  read as a move and pass for the wrong reason.
- Every drop target is also tested on `dragover`, asserting `defaultPrevented`
  and `dropEffect`. Tests that only dispatch `drop` cannot see a missing
  `preventDefault`, and a target without one is not a target at all: a real
  browser refuses the drop and the handler under test never runs.
- All user-facing strings are plain language.
