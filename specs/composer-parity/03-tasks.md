# Composer parity — task breakdown

**Spec:** [02-specification.md](./02-specification.md) · **Work item:** DOR-946 · **Generated:** 2026-08-07 · **Mode:** full

12 tasks across 3 phases. Dependencies are hard ordering; `parallelWith` marks tasks that may run concurrently.

## Phase 1 — Extract the features/composer slice

### Task 1.1: Move the composer core files into a new features/composer slice

- **Size:** large · **Priority:** high
- **Depends on:** — · **Parallel with:** —

Create the FSD feature slice `apps/client/src/layers/features/composer/` and MOVE (git mv, no copies, no re-export shims) these files out of `apps/client/src/layers/features/chat/ui/input/`:

| From                                              | To                                    |
| ------------------------------------------------- | ------------------------------------- |
| `chat/ui/input/ChatInput.tsx` (407 lines)         | `composer/ui/ComposerInput.tsx`       |
| `chat/ui/input/FileChipBar.tsx` (144 lines)       | `composer/ui/ComposerAttachments.tsx` |
| `chat/ui/input/ClearArmedHint.tsx` (49 lines)     | `composer/ui/ClearArmedHint.tsx`      |
| `chat/ui/input/InputActionButton.tsx` (308 lines) | `composer/ui/InputActionButton.tsx`   |
| `chat/ui/input/use-input-keyboard.ts` (406 lines) | `composer/ui/use-input-keyboard.ts`   |
| `chat/ui/input/use-textarea-resize.ts` (69 lines) | `composer/ui/use-textarea-resize.ts`  |

`chat/ui/input/use-drag-and-paste.ts` (35 lines) deliberately does NOT move in phase 1. Its only consumer today is `ChatInputContainer` (line 37), which is still chat-owned until phase 2; moving it now would force either a barrel export of an internal hook or a cross-feature internal-path import, both of which the FSD rule forbids. It moves in task 2.1 alongside `ComposerRoot`, which becomes its only consumer.

And MOVE these test files out of `apps/client/src/layers/features/chat/__tests__/`:

| From                                                          | To                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------ |
| `chat/__tests__/ChatInput.test.tsx` (1835 lines)              | `composer/__tests__/ComposerInput.test.tsx`            |
| `chat/__tests__/FileChipBar.test.tsx` (247 lines)             | `composer/__tests__/ComposerAttachments.test.tsx`      |
| `chat/__tests__/InputActionButton-dimmed.test.tsx` (99 lines) | `composer/__tests__/InputActionButton-dimmed.test.tsx` |

Renames inside the moved files, and NOTHING else:

- `ChatInput.tsx`: the exported component `ChatInput` becomes `ComposerInput`; the exported interface `ChatInputHandle` becomes `ComposerInputHandle`; the local props interface `ChatInputProps` becomes `ComposerInputProps`; the `forwardRef(function ChatInput(...))` inner function name becomes `ComposerInput`. Its three relative imports (`./use-input-keyboard`, `./use-textarea-resize`, `./InputActionButton`) still resolve because those files move alongside it. Its `@/layers/shared/lib` (`cn`) and `@/layers/shared/model` (`useIsTouchOnly`) imports are unchanged and remain FSD-legal (features may import shared).
- `FileChipBar.tsx`: the exported component `FileChipBar` becomes `ComposerAttachments`. Its props (`files`, `onRemove`, `onRetry`, `onCancel`) and its rendered markup are unchanged.
- `use-input-keyboard.ts` MOVES WITHOUT A SINGLE EDIT. It is the keyboard ladder (Enter/Shift+Enter/Escape/Escape-Escape arming, palette Enter fall-through, queue navigation, upload cancel) and its existing tests are the only regression net for it. If a diff of this file is anything other than 0 changed lines, stop and revisit.
- `use-textarea-resize.ts`, `use-drag-and-paste.ts`, `InputActionButton.tsx`, `ClearArmedHint.tsx` move with no edits beyond nothing (no renames).
- In the three moved test files, update only the import specifier and the identifier names (`ChatInput` -> `ComposerInput`, `ChatInputHandle` -> `ComposerInputHandle`, `FileChipBar` -> `ComposerAttachments`). Assertions, queries, and test titles must NOT change. A moved test that needs a real assertion changed is proof of a behavior change and must be escalated rather than edited.

What stays in `features/chat/ui/input/` (do not touch): `ChatInputContainer.tsx`, `QueuePanel.tsx`, `InteractiveInputPanel.tsx`, `PromptSuggestionChips.tsx`, `AnimatedPlaceholder.tsx`, `chat-input-container-types.ts`, `__tests__/InteractiveInputPanel.test.tsx`.

Acceptance: the seven source files and three test files exist at their new paths and nowhere else; `use-input-keyboard.ts` has a zero-line diff; `git log --follow` still resolves each moved file's history. The build is expected to be RED at the end of this task alone — task 1.2 migrates the consumers and the two land as one commit.

### Task 1.2: Write the features/composer barrel with the Composer namespace and capability-matrix module TSDoc

- **Size:** small · **Priority:** high
- **Depends on:** 1.1 · **Parallel with:** —

Create `apps/client/src/layers/features/composer/index.ts` as the slice's ONLY public surface.

Exports exactly:

```ts
export const Composer = {
  Input: ComposerInput,
  OverlayLane: ComposerOverlayLane,
  Attachments: ComposerAttachments,
  ClearArmedHint,
};
export type { ComposerInputHandle } from './ui/ComposerInput';
```

`Root` is deliberately absent in phase 1 and is added to the same object in task 2.1 — do not stub it.

Deliberately NOT exported (they stay internal to the slice, which is what keeps the cross-feature model-import rule in `.claude/rules/fsd-layers.md` satisfied — consumers may only ever import components and types from this barrel): `InputActionButton`, `useInputKeyboard`, `useTextareaResize`, `useDragAndPaste`. If any consumer needs one of these, that is a design error, not a reason to widen the barrel.

The file carries a module-level TSDoc (`@module features/composer`) as required for FSD barrels by `.claude/rules/conventions.md`, and that TSDoc carries the capability matrix verbatim as the reviewable declaration of which surface composes what:

```
 * | Capability                     | Chat | Room             | Dashboard    |
 * | ------------------------------ | ---- | ---------------- | ------------ |
 * | Attach (chip bar, drag, paste) | yes  | reserved         | follows chat |
 * | Slash commands                 | yes  | reserved         | follows chat |
 * | `@` mentions                   | no   | yes              | no           |
 * | Queue-while-busy               | yes  | no (session)     | yes          |
 * | Prompt suggestions             | yes  | no (session)     | yes          |
 * | Interactive input panel        | yes  | no (session)     | yes          |
```

The prose around it must state the doctrine: composition IS the capability declaration — a surface has attach because it renders `Composer.Attachments` and passes `onAttach`/`onFilesDropped`, never because a config object says so. "reserved" means the slot exists and is intentionally unwired: room attach lands in DOR-947, room slash commands are deferred to a follow-up ticket (a room has no single cwd, session, or runtime, so `transport.getCommands` has nothing to key on).

Every export in the slice needs TSDoc (`eslint-plugin-jsdoc` is an error-level gate): `ComposerInput`, `ComposerInputHandle`, `ComposerAttachments`, `ClearArmedHint` already carry theirs from the move — verify the renamed identifiers are still described accurately (e.g. `ChatInputHandle`'s TSDoc references `{@link ChatInputHandle.focus}`, which must become `{@link ComposerInputHandle.focus}`).

Acceptance: `pnpm --filter @dorkos/client lint` reports no jsdoc errors for the new slice; the barrel exports exactly the five names above and nothing else.

### Task 1.3: Migrate every ChatInput consumer and test mock to @/layers/features/composer

- **Size:** medium · **Priority:** high
- **Depends on:** 1.1, 1.2 · **Parallel with:** —

Repoint every import of the moved symbols. `features/chat` keeps NO re-export shim and NO transitional alias — after this task `grep -rn "ChatInput\b" apps/client/src` must return zero hits outside `ChatInputContainer` (the container itself keeps its name).

Delete from `apps/client/src/layers/features/chat/index.ts` (lines 21 and 22-28 today): `export { ChatInput, type ChatInputHandle } from './ui/input/ChatInput';` and `export { ClearArmedHint } from './ui/input/ClearArmedHint';` together with the block comment above `ClearArmedHint`. Everything else in that barrel stays.

Source consumers (all paths under `apps/client/src/`):

1. `layers/features/chat/ui/input/ChatInputContainer.tsx` — lines 5-6 (`./ChatInput`, `type ChatInputHandle`), line 18 (`./FileChipBar`), line 20 (`./ClearArmedHint`). Replace those three with `import { Composer, type ComposerInputHandle } from '@/layers/features/composer';` and use `<Composer.Input>`, `<Composer.Attachments>`, `<Composer.ClearArmedHint />` at the JSX sites. Line 37's `import { useDragAndPaste } from './use-drag-and-paste'` is UNCHANGED in phase 1 — that hook stays in `features/chat/ui/input/` until task 2.1 moves it into `ComposerRoot`, so nothing here needs a temporary barrel export.
2. `layers/features/chat/ui/ChatPanel.tsx` line 27 — `import type { ChatInputHandle } from './input/ChatInput'` becomes `import type { ComposerInputHandle } from '@/layers/features/composer'`; the `useRef<ChatInputHandle>(null)` at line 71 becomes `useRef<ComposerInputHandle>(null)`.
3. `layers/features/chat/model/use-chat-queue.ts` line 12 — `import type { ChatInputHandle } from '../ui/input/ChatInput'` becomes the barrel type import. This is a model file importing a TYPE from a sibling feature's barrel; a type-only import carries no runtime coupling and is legal, but if lint objects, hoist the ref type to a local `interface { focus(): void }` rather than widening any barrel.
4. `layers/features/onboarding/ui/OnboardingConversation.tsx` — remove `ChatInput` from the `@/layers/features/chat` import block at lines 22-29 and add `import { Composer } from '@/layers/features/composer';`; the JSX at line 394 becomes `<Composer.Input ... />` with its four props (`value`, `onChange`, `onSubmit`, `isStreaming={false}`, `placeholder`) unchanged.
5. `layers/widgets/dashboard/ui/DashboardComposerSection.tsx` line 17 — same swap; JSX at line 57 becomes `<Composer.Input>` keeping `value`, `onChange`, `onSubmit`, `isStreaming`, `canSubmit`, `canSubmitReason`, `placeholder`.
6. `layers/widgets/room-view/ui/RoomComposer.tsx` line 3 — `import { ChatInput, ClearArmedHint, type ChatInputHandle } from '@/layers/features/chat'` becomes `import { Composer, type ComposerInputHandle } from '@/layers/features/composer'`; `useRef<ChatInputHandle>(null)` at line 88 and the `<ChatInput>`/`<ClearArmedHint />` JSX at lines 248 and 250 follow. The prose TSDoc on `RoomComposer` names "the shared `ChatInput`" twice (lines ~61 and the header) — update those references to `Composer.Input`. No other room behavior changes here.
7. `src/dev/showcases/InputShowcases.tsx` lines 2-3 — these reach INTO internal paths (`@/layers/features/chat/ui/input/ChatInput`, `.../FileChipBar`), which was already a barrel violation. Replace both with the single barrel import and rename the local `ChatInputDemo` helper to `ComposerInputDemo`, the section title at line 149 from `"ChatInput"` to `"Composer.Input"`, and the FileChipBar section title to `"Composer.Attachments"`.
8. `src/dev/sections/chat-sections.ts` — the registry entries at ~line 246 (`id: 'chatinput'`, `title: 'ChatInput'`) and the `filechipbar` entry below it: retitle to `Composer.Input` / `Composer.Attachments`, keep the `id` values stable so deep links survive, and add `composer` to both entries' `keywords` arrays.

Test mocks that name the moved symbols (each `vi.mock` factory must move to the composer barrel and export `Composer` as an object, not a bare `ChatInput`):

- `layers/features/chat/__tests__/ChatInputContainer.test.tsx` — imports `ChatInput` from `../ui/input/ChatInput` at line 91 and reads `vi.mocked(ChatInput).mock.calls.at(-1)![0]` in `lastChatInputProps()`. Repoint to a `vi.mock('@/layers/features/composer', ...)` factory whose `Composer.Input` is the mocked component, and read the recorded props off that same mock fn.
- `layers/features/chat/__tests__/upload-wedge-recovery.test.tsx` (line 77 imports the container; check its mock factory for `ChatInput`).
- `layers/features/chat/__tests__/use-chat-queue.test.ts` line 21 — type-only import, repoint to the barrel type.
- `layers/features/onboarding/__tests__/OnboardingConversation.test.tsx` line ~101 — its `vi.mock('@/layers/features/chat', ...)` factory returns a `ChatInput` stand-in; that key moves to a second `vi.mock('@/layers/features/composer', () => ({ Composer: { Input: ... } }))`, keeping the stand-in's rendered `<input>` + submit button exactly as-is.
- `layers/features/onboarding/__tests__/onboarding-skip.test.tsx` line ~106 — same split; `ChatInput: () => <div data-testid="composer" />` becomes `Composer: { Input: () => <div data-testid="composer" /> }` under the composer-barrel mock.
- `layers/widgets/dashboard/__tests__/DashboardComposerSection.test.tsx` line ~33 — same split; the stand-in must keep rendering `canSubmitReason` so the "Getting your agent ready…" assertion still passes.
- `layers/widgets/room-view/__tests__/RoomComposer.test.tsx` — check for a `@/layers/features/chat` mock and repoint; the comment at line 331 referencing `ChatInput` becomes `Composer.Input`.
- `src/dev/__tests__/PlaygroundSearch.test.tsx` line 95 asserts `screen.getByText('ChatInput')` — update to `'Composer.Input'` to match the retitled registry entry.

Acceptance: `grep -rn "ChatInputHandle\|FileChipBar\|from '.*features/chat'" apps/client/src` shows no reference to a moved symbol; `pnpm --filter @dorkos/client typecheck` is green; this task and 1.1/1.2 land as ONE commit because the tree does not compile between them.

### Task 1.4: Prove the extraction changed no behavior and left no dead path

- **Size:** small · **Priority:** high
- **Depends on:** 1.3 · **Parallel with:** —

The phase-1 gate. Run and record, from the worktree root:

1. `pnpm --filter @dorkos/client typecheck` — green.
2. `pnpm --filter @dorkos/client lint` — green, including `no-restricted-imports` (FSD) and `jsdoc` on the new slice.
3. `pnpm vitest run apps/client/src/layers/features/composer` — the three moved test files pass. Then the surfaces that mock them: `pnpm vitest run apps/client/src/layers/features/chat/__tests__/ChatInputContainer.test.tsx`, `.../chat/__tests__/upload-wedge-recovery.test.tsx`, `.../onboarding/__tests__/OnboardingConversation.test.tsx`, `.../onboarding/__tests__/onboarding-skip.test.tsx`, `.../widgets/dashboard/__tests__/DashboardComposerSection.test.tsx`, `apps/client/src/dev/__tests__/PlaygroundSearch.test.tsx`.
4. `apps/client/src/layers/widgets/room-view/__tests__/RoomComposer.test.tsx` — KNOWN FALSE RED: a bare `pnpm vitest run` from the repo root falsely fails this file. Run it from `apps/client` (`cd apps/client && pnpm vitest run src/layers/widgets/room-view/__tests__/RoomComposer.test.tsx`) before believing any red there.
5. Full client suite once: `pnpm test -- --run --filter @dorkos/client`. Never use a bare `pnpm vitest run` for a full run — it skips the per-package env turbo sets up and has falsely failed tests in dev.

Dead-path proofs, all of which must return nothing:

- `grep -rn "ui/input/ChatInput\|ui/input/FileChipBar\|ui/input/ClearArmedHint\|ui/input/InputActionButton\|ui/input/use-input-keyboard\|ui/input/use-textarea-resize" apps/client/src` (note `use-drag-and-paste` is deliberately absent from this list — it is still chat-owned until task 2.1)
- `grep -n "ChatInput\|ClearArmedHint" apps/client/src/layers/features/chat/index.ts` (the barrel must no longer name either).
- `git diff --stat <base> -- apps/client/src/layers/features/composer/ui/use-input-keyboard.ts` shows 0 changed lines (the keyboard ladder moved untouched).

DOM proof: no diff harness is needed for phase 1 because nothing was rewrapped — the evidence is that the 1835-line `ComposerInput.test.tsx` and the 247-line `ComposerAttachments.test.tsx` pass with only import/identifier lines changed. Record the diff of those two test files in the phase-1 commit message so a reviewer can confirm no assertion moved.

Acceptance: every command above green, every grep empty, and `pnpm knip` reports no new unused export from the composer barrel.

## Phase 2 — Introduce Composer.Root and Composer.OverlayLane

### Task 2.1: Build Composer.Root — shared card chrome, dropzone, and drop overlay

- **Size:** medium · **Priority:** high
- **Depends on:** 1.4 · **Parallel with:** 2.2

Create `apps/client/src/layers/features/composer/ui/ComposerRoot.tsx` and move `use-drag-and-paste.ts` from `apps/client/src/layers/features/chat/ui/input/` into `apps/client/src/layers/features/composer/ui/` (ComposerRoot is its only consumer; it stays internal to the slice and is NOT exported from the barrel).

Props:

```ts
interface ComposerRootProps {
  children: React.ReactNode;
  /**
   * Accept dropped and pasted files. Given => the card mounts the dropzone,
   * renders the hidden file input, and shows the "Drop files to attach"
   * overlay. Omitted => no dropzone is mounted at all.
   */
  onFilesDropped?: (files: File[]) => void;
  className?: string;
}
```

The card chrome is chat's current one, verbatim: `bg-surface relative m-2 rounded-xl border p-2`, merged with the caller's `className` via `cn()` from `@/layers/shared/lib` (caller class last so it can override). `relative` is load-bearing — `Composer.OverlayLane` anchors to it with `bottom-full`.

Structure Root renders, in this exact order:

1. `<input {...getInputProps()} />` — only when `onFilesDropped` is given.
2. `<AnimatePresence>` drop overlay — only when `onFilesDropped` is given. Copied verbatim from `ChatInputContainer.tsx` lines 222-234: `motion.div` with `initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} transition={{duration:0.15}}`, `className="bg-primary/10 border-primary absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed"`, containing `<p className="text-primary text-sm font-medium">Drop files to attach</p>`.
3. `{children}`.

Hooks-rules constraint: `useDragAndPaste` calls `useDropzone`, which attaches document-level drag listeners. Mounting it on every room and thread composer that has no attach wiring would be a real behavior change, and a conditional hook call is illegal. Resolve with two internal components inside `ComposerRoot.tsx`: a plain `ComposerCard` (the styled `div` + children) and a `DropCapableCard` that calls `useDragAndPaste({ onFilesSelected: onFilesDropped })`, spreads `getRootProps()`, sets `onPaste={handlePaste}`, and renders the hidden input and overlay around the same card. `ComposerRoot` picks one by whether `onFilesDropped` is defined. Do not "solve" this by passing a no-op to the hook.

Add `Root: ComposerRoot` as the FIRST key of the `Composer` object in `apps/client/src/layers/features/composer/index.ts`, and extend the barrel's module TSDoc to name Root as the owner of the card chrome and the attach plumbing. TSDoc on `ComposerRoot` itself must state what the spec locked: chat's `ScanLine` streaming edge is chat-only and arrives as a CHILD, never baked in.

Never hand-sort the Tailwind class strings — Prettier's class sorter owns them.

Tests: add `apps/client/src/layers/features/composer/__tests__/ComposerRoot.test.tsx` asserting (a) with no `onFilesDropped`, the rendered tree contains no `input[type=file]` and no dropzone `onDrop` handler; (b) with `onFilesDropped`, a `drop` event carrying two `File`s calls it once with both files; (c) a `paste` event whose `clipboardData.items` contain one file kind and one string kind calls it with exactly the one file; (d) the root element's class list contains `relative`, `rounded-xl`, `border`, `p-2`, `m-2`, and `bg-surface`, plus any caller `className`.

### Task 2.2: Build Composer.OverlayLane — the one lane above the box

- **Size:** small · **Priority:** high
- **Depends on:** 1.4 · **Parallel with:** 2.1

Create `apps/client/src/layers/features/composer/ui/ComposerOverlayLane.tsx`, the lane chat and rooms currently hand-roll in two places with two different offsets.

```tsx
interface ComposerOverlayLaneProps {
  children: React.ReactNode;
  className?: string;
}
```

It renders a single `div` with `cn('absolute right-0 bottom-full left-0 mb-2', className)` and nothing else — no `AnimatePresence` of its own, no stacking logic. Stacking order IS child order, and the TSDoc must say so, because both hosts rely on it: palettes first, `Composer.ClearArmedHint` last, so the armed-clear pill sits below an open palette rather than over it.

The TSDoc must also record why the lane exists at all rather than anchoring the hint inside the text field: measured in a browser, an in-field anchor lands the hint squarely across the bottom queue row's Send-now and Remove buttons — the one way out of a queue the flush pump cannot drain. The lane costs the resting composer no pixels and moves nothing when it appears.

Existing call sites this replaces (do not migrate them here — 2.3 and 3.1 do):

- `apps/client/src/layers/features/chat/ui/input/ChatInputContainer.tsx` line 270: `<div className="absolute right-0 bottom-full left-0 mb-2">` — identical, so chat's DOM is unchanged by adopting it.
- `apps/client/src/layers/widgets/room-view/ui/RoomComposer.tsx` line 235: `<div className="absolute right-3 bottom-full left-3 mb-2">` — the `right-3 left-3` inset existed because the room's own wrapper was `p-3`; once the room sits inside `Composer.Root`'s `p-2`, `right-0 left-0` is the correct alignment and the inset difference disappears. That is an intended phase-3 delta, recorded there.

Add `OverlayLane: ComposerOverlayLane` to the `Composer` object in the barrel with TSDoc.

Tests: add `apps/client/src/layers/features/composer/__tests__/ComposerOverlayLane.test.tsx` asserting the rendered element carries exactly the classes `absolute`, `right-0`, `bottom-full`, `left-0`, `mb-2` plus any caller class, and that two children render in source order (first child precedes second in `compareDocumentPosition`).

### Task 2.3: Migrate ChatInputContainer onto Composer.Root and Composer.OverlayLane

- **Size:** medium · **Priority:** high
- **Depends on:** 2.1, 2.2 · **Parallel with:** —

Rewrite the shell of `apps/client/src/layers/features/chat/ui/input/ChatInputContainer.tsx` (currently 408 lines) so the chrome, dropzone, and lane markup leave it and it becomes pure chat orchestration.

Remove from the container:

- the `useDragAndPaste` call (lines 182-184) and its import (line 37) — the hook now lives inside `Composer.Root`.
- the outer `<div {...getRootProps()} onPaste={handlePaste} className="chat-input-container bg-surface relative m-2 rounded-xl border p-2">` (lines 209-213) and its closing tag.
- the `<input {...getInputProps()} />` at line 214.
- the entire drag-overlay `AnimatePresence` block (lines 222-234).
- the hand-rolled lane `<div className="absolute right-0 bottom-full left-0 mb-2">` at line 270 and its closing tag.

Replace with `<Composer.Root className="chat-input-container" onFilesDropped={onFilesSelected}>` as the outer element, and `<Composer.OverlayLane>` around the palette block. `onFilesSelected` comes from the existing `fileUpload` prop destructure at line 124 — it is the same callback the paperclip button already receives via `onAttach`, so drag, paste, and click all still land in one place.

Everything else stays put and in the same order inside Root's children:

1. the `ScanLine` `AnimatePresence` (lines 216-220) — now passed as Root's first child, exactly as the spec requires. It keeps `color={agentVisual.color} isTextStreaming={isTextStreaming} edge="top"`.
2. the `AnimatePresence mode="wait"` interactive-panel swap (line 236) with both branches untouched.
3. inside the `key="normal"` branch: `<Composer.OverlayLane>` containing the `AnimatePresence` with `CommandPalette` and `FilePalette` then `{clearArmed && <Composer.ClearArmedHint />}`; then `Composer.Attachments` (guarded by `pendingFiles.length > 0`); then the `QueuePanel` `AnimatePresence`; then `BackgroundTaskBar`; then `Composer.Input` with ALL 30 of its current props unchanged; then `ChatStatusSection`.

One ordering delta is created and must be recorded rather than hidden: today the drop overlay renders BETWEEN the ScanLine and the content (`ChatInputContainer.tsx` line 222); after the move, `Composer.Root` renders it before `children`, so it precedes the ScanLine instead of following it. Both are absolutely positioned and the overlay keeps `z-10` while ScanLine sets no z-index, so paint order is unchanged; the two nodes are only ever siblings at all when a drag is active during a streaming turn. Note this in the phase-2 proof as the single reviewed exception.

Do NOT touch: `useChatQueue`, `useBackgroundTasks`, `useRotatingPlaceholder`, `getPlaceholder`, `submitAndDismiss`, `queueAndDismiss`, `handleStopTask`, or the `sessionContextKey` wiring. The submit path is not merged with anything (chat still submits via the session trigger POST).

Acceptance: the container drops below ~360 lines; `pnpm vitest run apps/client/src/layers/features/chat/__tests__/ChatInputContainer.test.tsx` and `.../upload-wedge-recovery.test.tsx` pass with import-path changes only; `pnpm --filter @dorkos/client typecheck` green.

### Task 2.4: Prove chat's composer DOM is unchanged with a serialized-DOM diff

- **Size:** medium · **Priority:** high
- **Depends on:** 2.3 · **Parallel with:** 2.5

Add `apps/client/src/layers/features/chat/__tests__/ChatInputContainer-dom-parity.test.tsx` implementing the DOR-956 DOM-diff technique against `ChatInputContainer`.

Method: render the container under a fixed prop fixture, serialize `container.innerHTML` (or a normalized walk of the subtree), and compare against a checked-in snapshot captured from the pre-migration component. Capture the baseline BEFORE task 2.3 lands (run the harness on the parent commit and commit the snapshot file), so the snapshot is real evidence and not a post-hoc recording of whatever the new code happens to emit. A snapshot written after the change proves nothing.

Normalization the comparison MUST apply, and nothing beyond it:

- `class` attributes compare as token SETS, not strings. `cn()` composition legitimately reorders tokens (Root emits its base classes then the caller's `chat-input-container`, where the old markup led with it) without changing a single rendered pixel. Any token added or removed is a real failure.
- `framer-motion`/`motion` generated `style` transform values and any `id`/`aria-*` values derived from `useId` are placeholder-substituted.
  Everything else — element names, nesting, order, `data-testid`, `role`, `aria-label`, `placeholder`, `disabled` — compares literally.

States to diff, each its own case:

1. Idle: no pending files, empty queue, no interaction, not streaming, not dragging.
2. Streaming with a 2-item queue (exercises ScanLine, QueuePanel, and the queue-aware placeholder).
3. Two pending files, one in `failed` state (exercises `Composer.Attachments` and the `canSubmit={!hasFailedUpload}` gate).
4. `clearArmed` raised (exercises the overlay lane).
5. An active interaction (exercises the `InteractiveInputPanel` branch, which must be byte-identical since it never moved).

Expected result: EMPTY diff in all five. The one permitted exception is the drop-overlay sibling position described in task 2.3, which is unreachable in these five states because no drag is active — if it shows up, the fixture is wrong.

Also assert the keyboard ladder end-to-end at this level rather than trusting the unit tests alone: type text, press Enter -> `handleSubmit` called once; Shift+Enter -> newline, no submit; Escape with a palette open -> `dismissPalettes`, no clear; Escape twice within the arming window with text present -> `setInput('')`.

Run with `pnpm vitest run apps/client/src/layers/features/chat/__tests__/ChatInputContainer-dom-parity.test.tsx`.

### Task 2.5: Wrap the dashboard hero composer in Composer.Root and prove the diff is the wrapper only

- **Size:** small · **Priority:** high
- **Depends on:** 2.3 · **Parallel with:** 2.4

In `apps/client/src/layers/widgets/dashboard/ui/DashboardComposerSection.tsx`, wrap the `<Composer.Input>` at line 57 in `<Composer.Root>` so the hero composer carries the same card chrome as chat's. `onFilesDropped` is NOT passed — the dashboard has no upload path today (`Composer.Input` there receives no `onAttach`), so no dropzone mounts. Per the capability matrix the dashboard "follows chat" on attach, which means it inherits the capability when chat's upload seam reaches it, not that it wires one now.

Everything else in the file is unchanged: the `<section data-testid={TOUR_ANCHORS.dashboardComposer}>` wrapper, the `<h2>` "What are we building today?", the `first-message` seam submit handler (`crypto.randomUUID()` -> `useAgentBirthStore.getState().register(sessionId, record)` -> `navigate({ to: '/session', ... })`), and the `canSubmit`/`canSubmitReason` props stay exactly as they are. Submit paths are never merged (ADR 260722-111316 owns this one).

One consequence to check by eye and in the test: `Composer.Root`'s chrome includes `m-2`, which adds an 8px margin the dashboard hero did not have. Confirm this reads correctly under the `<h2 className="... mb-3">` above it. If the margin visibly double-spaces the hero, pass `className="m-0"` (Tailwind-merged by `cn()`, caller-last) rather than weakening Root's default — chat is the reference chrome and Root must not drift toward the dashboard.

Proof: add `apps/client/src/layers/widgets/dashboard/__tests__/DashboardComposerSection-dom-parity.test.tsx` using the same serialized-DOM diff harness as task 2.4, with the baseline captured before the wrap lands. Expected diff: EXACTLY one added element — the Root `div` with the card classes — wrapping the previously top-level composer subtree, and nothing else added, removed, reordered, or reattributed. Assert that explicitly (the added node's tag is `div`, its class set is Root's, and its `innerHTML` equals the old subtree's).

The existing `DashboardComposerSection.test.tsx` mocks the composer barrel; its `Composer` mock object must gain a `Root` key that renders `<div>{children}</div>` or the wrap will silently render nothing. Its assertions (the "Getting your agent ready…" line, the navigate call, the birth-record shape) must pass unmodified.

Run `pnpm vitest run apps/client/src/layers/widgets/dashboard/__tests__/` and `pnpm --filter @dorkos/client typecheck`.

## Phase 3 — Migrate rooms onto the shared composer

### Task 3.1: Migrate RoomComposer onto Composer.Root and Composer.OverlayLane

- **Size:** medium · **Priority:** high
- **Depends on:** 2.4, 2.5 · **Parallel with:** —

Rewrite the shell of `apps/client/src/layers/widgets/room-view/ui/RoomComposer.tsx` (304 lines) so rooms sit in the same card chat does. This is the one deliberate visual change in the whole spec.

Replace `<div className="relative border-t p-3">` (line 219) with `<Composer.Root>`. Root already supplies `relative` and the card chrome (`bg-surface m-2 rounded-xl border p-2`); the room's `border-t` and `p-3` are DELETED, not merged. Do not pass `onFilesDropped` — room attach stays unwired until DOR-947, and Root mounts no dropzone without it.

Replace the hand-rolled lane `<div className="absolute right-3 bottom-full left-3 mb-2">` (line 235) with `<Composer.OverlayLane>`, whose `right-0 left-0` is the correct alignment now that the room composer sits inside Root's `p-2` rather than its own `p-3`. Its children keep their order: the `MentionPalette` `AnimatePresence` first, then `{clearArmed && <Composer.ClearArmedHint />}` — the hint must stay last so an open picker is never covered.

Stays exactly where it is, as a direct child of `Composer.Root` before the lane: the `<span role="status" aria-live="polite" aria-atomic="true" className="sr-only">` announcer at lines 232-234 that speaks "No one by that name." only when the picker is open with zero rows. It is not lane content — it is an announcer, and the long comment above it explaining why the picker cannot carry it must survive the move verbatim.

Untouched, all of it: `draftKey` derivation (`room.id` vs `threadDraftKey(room.id, threadRootId)`), `useRoomDraft`/`useRoomDraftStore`, `useMentionAutocomplete`, the `focusRequest` counter effect, the mount-only `focusOnMount` effect, the `pendingCaret` state + `useLayoutEffect` caret restoration, `takeInsert`/`takeRow`/`takeHighlighted`, and `handleSubmit` with its read-and-clear-from-the-store guard and `newPendingId()` minting. The room submit path (`usePostToRoom` / `useReplyInThread`, 202 + pending rows) is NOT merged with chat's — that is an explicit non-goal.

Also untouched: everything under `apps/server/src`. Mention rendering and addressing (`apps/server/src/services/rooms/mentions.ts`, the span doctrine in `.claude/rules/room-conduct.md`) are out of bounds for this spec — if a change here seems to need a server edit, stop.

Slash commands stay UNWIRED (decision 2026-08-07): chat's palette is fed by `transport.getCommands(cwd, { sessionId, runtime })` and a room has no single cwd, session, or runtime. The slot exists via `Composer.OverlayLane` + `Composer.Input`'s palette props; a follow-up ticket decides the semantics. Do not pass `isPaletteOpen`/`onCommandSelect` for commands here — the room already uses those props for the MENTION picker, and double-booking them is exactly the bug the deferral avoids.

Acceptance: `pnpm --filter @dorkos/client typecheck` green; the file loses ~6 lines of chrome and gains no state.

### Task 3.2: Update RoomComposer tests and record the intended chrome delta as reviewed evidence

- **Size:** medium · **Priority:** high
- **Depends on:** 3.1 · **Parallel with:** —

Rooms are the one surface whose DOM legitimately changes, so the proof is a diff that is reviewed, not a diff that is empty.

Update `apps/client/src/layers/widgets/room-view/__tests__/RoomComposer.test.tsx`: every behavioral assertion (draft persistence across remount, thread vs room draft keys never sharing text, the mention picker opening on `@` and inserting the handle with the caret landing after it, the empty-picker `role="status"` announcement, Escape dismissing the picker, double-Escape clearing with the `clear-armed-hint` testid appearing, `canSubmit={false}` and the archived-room reason line, Enter posting via `usePostToRoom` / `useReplyInThread` with a minted `clientId`, the second-Enter-in-one-tick guard) must pass with NO change to what it asserts. Only chrome-level DOM assertions change — anything that asserted `border-t`, `p-3`, or the `right-3 left-3` lane offsets.

Add a chrome-delta assertion block that states the intended change positively rather than deleting the old one:

- the composer's root element carries `bg-surface`, `rounded-xl`, `border`, `p-2`, `m-2`, `relative`;
- it carries neither `border-t` nor `p-3`;
- the overlay lane carries `absolute right-0 bottom-full left-0 mb-2`;
- no `input[type="file"]` is rendered and no drop handler is attached (attach is reserved for DOR-947, not shipped);
- the mention picker still precedes the clear-armed hint in document order inside the lane.

Add `apps/client/src/layers/widgets/room-view/__tests__/RoomComposer-chrome-delta.test.tsx` running the same serialized-DOM diff harness as tasks 2.4/2.5, with a baseline captured before 3.1 landed, and assert the diff consists of EXACTLY: the root element's class set swap (`relative border-t p-3` -> Root's card classes) and the lane's `right-3 left-3` -> `right-0 left-0`. Any other node added, removed, or reordered fails. Attach the printed diff to the work item as the reviewed evidence for the intended visual change.

VERIFICATION GOTCHA — a bare `pnpm vitest run` from the repo root falsely fails `RoomComposer.test.tsx`. Re-run from `apps/client` before believing a red: `cd apps/client && pnpm vitest run src/layers/widgets/room-view/__tests__/`. Single files elsewhere run fine as `pnpm vitest run <path>` from the root.

Also run the room-view widget's other suites (`cd apps/client && pnpm vitest run src/layers/widgets/room-view/__tests__/`) — the thread panel mounts a second `RoomComposer` and its focus-on-mount path goes through the same tree.

### Task 3.3: Close the loop — docs, playground, e2e, and the full-repo gate

- **Size:** medium · **Priority:** medium
- **Depends on:** 3.2 · **Parallel with:** —

Final pass across everything the move touches outside the three composers.

Docs:

- `contributing/design-system.md` — find the composer section and update it to name ONE family living at `apps/client/src/layers/features/composer/`, listing `Composer.Root` / `.Input` / `.OverlayLane` / `.Attachments` / `.ClearArmedHint` and stating that a surface declares its capabilities by which parts it composes. Replace any reference to `features/chat/ui/input/ChatInput` or `FileChipBar`. If the section does not name the old paths, leave it alone rather than padding it.
- Dev playground: per the `maintaining-dev-playground` skill, `apps/client/src/dev/showcases/InputShowcases.tsx` already renders the composer. Add a `Composer.Root` showcase demonstrating the card chrome with and without attach wiring, and register it in `apps/client/src/dev/sections/chat-sections.ts` with `page: 'chat'`, `category: 'Input'`, and keywords including `composer`, `card`, `dropzone`.
- Changelog fragment: create `changelog/unreleased/<id>-composer-parity.md` with an id from `.claude/scripts/id.ts`. It is user-facing prose, so it follows the `writing-for-humans` bar — plain enough for a smart 9th grader who does not code. Say what a person sees: the message box in rooms now looks and feels like the one in chat. Do NOT claim room file attachments or slash commands work — neither ships here.

E2E (the behavior-preservation gate at browser level): run the existing Playwright specs in `apps/e2e` that type into a composer — chat send, room post, mention flow, queue flow. They run UNMODIFIED. A spec that needs editing means behavior moved, not that the spec is stale.

Full-repo gate, in order:

1. `pnpm --filter @dorkos/client typecheck`
2. `pnpm --filter @dorkos/client lint`
3. `pnpm test -- --run` (never a bare `pnpm vitest run` for a full run — it skips the per-package env turbo sets up and has falsely failed tests in dev)
4. `pnpm knip` after building dists — no orphaned export left behind by the move
5. `pnpm verify`

Final dead-path sweep, all empty: `grep -rn "ChatInput\b" apps/client/src` returns only `ChatInputContainer` (chat's orchestrator, which keeps its name); `apps/client/src/layers/features/chat/index.ts` names neither `ChatInput` nor `ClearArmedHint`; no file under `apps/client/src/layers/features/chat/ui/input/` is named `ChatInput.tsx`, `FileChipBar.tsx`, `ClearArmedHint.tsx`, `InputActionButton.tsx`, `use-input-keyboard.ts`, `use-textarea-resize.ts`, or `use-drag-and-paste.ts`.

Before any PR opens, put the branch through an independent adversarial review against `REVIEW.md`.
