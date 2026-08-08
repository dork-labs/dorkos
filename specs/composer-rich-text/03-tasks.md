# Composer rich text (Lexical) — task breakdown

**Spec:** [02-specification.md](./02-specification.md) · **Work item:** DOR-948 · **Generated:** 2026-08-08 · **Mode:** full

29 tasks across 5 phases. Dependencies are hard ordering; `parallelWith` marks tasks that may run concurrently.

Every phase ends with a verification-gate task. Phase 1 and phase 2 change no behaviour on any surface; the flag ships **off** and only chat reads it.

## Phase 1 — The seam, with no editor behind it

### Task 1.1: Define the EditingSurface port and move the textarea's five reach-ins behind it

- **Size:** medium · **Priority:** high
- **Depends on:** — · **Parallel with:** —

Create two files in `apps/client/src/layers/features/composer/ui/`.

**`editing-surface.ts`** — the port, with exactly these seven methods and no eighth:

```ts
/**
 * The seven things the keyboard ladder needs from whatever it is editing.
 * Deliberately tiny: everything else the ladder decides from props alone.
 */
export interface EditingSurface {
  /** Text before a COLLAPSED caret, or `null` when the selection is a range. */
  textBeforeCaret(): string | null;
  /** Caret at offset 0 of the whole document (ArrowUp into the queue). */
  isCaretAtStart(): boolean;
  /** Caret at the very end of the whole document (ArrowDown out of an edit). */
  isCaretAtEnd(): boolean;
  /** Insert a hard line break at the caret, pushing one undo entry (Alt+Enter). */
  insertLineBreak(): void;
  /** Replace the escaping backslash before the caret with a newline. */
  consumeEscapeIntoNewline(): void;
  /** Empty the field as ONE undo entry, so Cmd+Z brings the draft back. */
  clearThroughUndoStack(): void;
  /** Whether an IME composition is in progress on this surface. */
  isComposing(): boolean;
}
```

DRIFT NOTE, resolve it in the code rather than repeating it: the spec's own code block heads this interface with the words "The five things the keyboard ladder needs" and then lists seven methods. The count is SEVEN. ADR `260808-180003` says so too ("seven small methods covering exactly those reach-ins plus `isComposing()`"). Write seven, say seven.

The port's TSDoc carries the seam's argument, because a reviewer meeting an interface with two implementations deserves to know why it exists: React 19 delegates synthetic listeners to the root container while Lexical registers native listeners on the editable element, so without a port the ladder either reaches into a `<textarea>` that is not there or gets consulted after Lexical has already inserted a paragraph. Every method added to this port is a new way for two surfaces to diverge — keep it at seven.

**`textarea-surface.ts`** — today's code, moved behind the interface character for character. Export a factory:

```ts
export function createTextareaSurface(ref: RefObject<HTMLTextAreaElement | null>): EditingSurface;
```

The four module-private helpers currently at the top of `apps/client/src/layers/features/composer/ui/use-input-keyboard.ts` MOVE here verbatim, with their existing TSDoc intact — `isEscapedNewline` (lines 35-39), `insertTextAtCaret` (49-52), `consumeEscapeIntoNewline` (58-62), `clearThroughUndoStack` (74-78), plus `countTrailingBackslashes` (21-25) which `isEscapedNewline` calls. `document.execCommand('insertText', …)` STAYS, for exactly the reason its existing TSDoc gives: it is the only edit that pushes a real undo entry and fires a native `input` event, and rewriting the controlled value with `setState` instead silently destroys the field's undo stack. Do not "modernize" it.

Method bodies, each `return`ing a stable no-op answer when `ref.current` is null (the ladder already tolerates a null textarea at every reach-in today — see lines 288 and 297, where `!textarea` short-circuits to "at start"/"at end"):

- `textBeforeCaret()` — `null` when `selectionStart !== selectionEnd`, else `value.slice(0, selectionStart)`. This is the shape `isEscapedNewline` needs; the odd/even backslash arithmetic itself stays in the ladder so BOTH surfaces get one rule rather than two copies.
- `isCaretAtStart()` — `selectionStart === 0`, and `true` when there is no element.
- `isCaretAtEnd()` — `selectionStart === value.length`, and `true` when there is no element.
- `insertLineBreak()` — `insertTextAtCaret(el, '\n')`.
- `consumeEscapeIntoNewline()` — the existing `setSelectionRange(caret - 1, caret)` then `insertTextAtCaret(el, '\n')`.
- `clearThroughUndoStack()` — focus, select all, `execCommand('insertText', false, '')`.
- `isComposing()` — `false`. A textarea has no editor-level composition state to ask; the ladder's existing event-level guard (`e.nativeEvent.isComposing || e.keyCode === 229`, line 218) is the whole IME story on this surface, and it stays. Say that in the method's TSDoc so nobody "fixes" it later.

Both files are INTERNAL to the slice. Do not add either to `apps/client/src/layers/features/composer/index.ts` — that barrel exports components and types only (its module TSDoc says so at lines 45-49), and a port with two adapters is exactly the kind of hook-shaped export that keeps the FSD cross-feature rule satisfiable.

TSDoc on every export (`eslint-plugin-jsdoc` is error-level).

Acceptance: `pnpm --filter @dorkos/client typecheck` and `pnpm --filter @dorkos/client lint` green. No behaviour changed yet — `use-input-keyboard.ts` still holds copies of the helpers until task 1.2 deletes them, so this task alone leaves duplicated private functions, which 1.2 removes. 1.1, 1.2 and 1.3 land as ONE commit; the tree is not meant to be reviewed between them.

### Task 1.2: Repoint useInputKeyboard from textareaRef to surface at all five reach-ins

- **Size:** medium · **Priority:** high
- **Depends on:** 1.1 · **Parallel with:** —

Edit `apps/client/src/layers/features/composer/ui/use-input-keyboard.ts` (406 lines). The decision logic does NOT change — every branch, every ordering, every `preventDefault`, every comment stays. What changes is what the branches ask.

Swap the option: `textareaRef: RefObject<HTMLTextAreaElement | null>` (line 81) becomes `surface: EditingSurface`; the destructure at line 155 and the `useCallback` dependency at line 398 follow.

The five reach-ins, by their current line numbers:

1. **266-267** (double-Escape wipe): `const textarea = textareaRef.current; if (textarea) clearThroughUndoStack(textarea);` becomes `surface.clearThroughUndoStack();`. The comment above it (lines 262-265, "Wipe through the field's own editing pipeline first, so the draft is one Cmd+Z away") stays verbatim.
2. **287-288** (ArrowUp queue navigation): `const isAtStart = !textarea || textarea.selectionStart === 0;` becomes `const isAtStart = surface.isCaretAtStart();`. The null-tolerance moves into the adapter, which is why the adapter answers `true` with no element.
3. **296-297** (ArrowDown out of a queue edit): `const isAtEnd = !textarea || textarea.selectionStart === textarea.value.length;` becomes `const isAtEnd = surface.isCaretAtEnd();`.
4. **311-312** (Alt+Enter): `const textarea = textareaRef.current; if (textarea) insertTextAtCaret(textarea, '\n');` becomes `surface.insertLineBreak();`.
5. **344-347** (backslash line continuation): `if (textarea && isEscapedNewline(textarea)) { e.preventDefault(); consumeEscapeIntoNewline(textarea); return; }` becomes

```ts
const before = surface.textBeforeCaret();
if (before !== null && countTrailingBackslashes(before) % 2 === 1) {
  e.preventDefault();
  surface.consumeEscapeIntoNewline();
  return;
}
```

`countTrailingBackslashes` stays in THIS file (it is the rule, not the reach-in) and keeps its TSDoc; `isEscapedNewline`, `insertTextAtCaret`, `consumeEscapeIntoNewline` and `clearThroughUndoStack` are DELETED here because task 1.1 moved them into `textarea-surface.ts`. Leaving copies behind is dead code and `pnpm knip` will say so.

**One deliberate, non-mechanical addition, and it is the only one.** The IME guard at line 218 currently reads `if (e.nativeEvent.isComposing || e.keyCode === IME_PROCESS_KEY_CODE) return;`. It gains a third disjunct: `|| surface.isComposing()`. This is a real logic change and the spec's "the diff is mechanical substitution" is not quite true here — record it as such in the commit body. It is needed because Lexical tracks its own composition state and can report a composition in progress on a keydown whose event flags are clear; the textarea adapter answers `false`, so the textarea path is provably unchanged by it. Add one test to `apps/client/src/layers/features/composer/__tests__/ComposerInput.test.tsx`'s existing IME area asserting Enter is not handled when the surface reports composing, on the textarea path with a stubbed surface.

`ComposerInput.tsx` (line 250-277) now builds a surface instead of passing the ref: `const surface = useMemo(() => createTextareaSurface(textareaRef), []);` — the factory closes over the ref object, which is stable, so the memo has an empty dependency list and the ladder's `useCallback` identity does not churn on every render. Do not inline `createTextareaSurface(textareaRef)` into the hook call; that allocates a new object per render and re-creates `handleKeyDown` every time, which is a real regression on the most latency-sensitive surface in the product.

Acceptance: `pnpm vitest run apps/client/src/layers/features/composer/__tests__/ComposerInput.test.tsx` passes with NO assertion changed (only the one added IME test). That file is 1876 lines and 145 `it()` blocks and it IS the ladder's regression net — see the drift note in task 1.4. If an existing assertion needs editing, stop: behaviour moved.

### Task 1.3: Extract TextareaField out of ComposerInput behind one ComposerFieldProps interface

- **Size:** medium · **Priority:** high
- **Depends on:** 1.2 · **Parallel with:** —

Create `apps/client/src/layers/features/composer/ui/field/` and put two files in it.

**`ComposerFieldProps.ts`** — the one interface both fields satisfy. It is the _field's_ surface, not the composer's: `ComposerInput.tsx` keeps its entire 30-prop public surface (lines 38-154) and its `ComposerInputHandle` (lines 10-29) exactly as they are, and passes a narrowed subset down. The field needs, and gets, nothing more than:

- `value: string`, `onChange: (value: string) => void`, `onCursorChange?: (pos: number) => void`
- `onKeyDown: (e: React.KeyboardEvent) => void` — the ladder's `handleKeyDown`, already built by `ComposerInput`
- `onFocus: () => void`, `onBlur: () => void` — today's `handleFocus`/`handleBlur` (lines 284-288)
- `placeholder: string`, `hasPlaceholderOverlay: boolean`
- the palette a11y quartet the textarea reads today at lines 379-388: `isPaletteOpen?: boolean`, `paletteListboxId?: string`, `activeDescendantId?: string`
- `onSurfaceChange: (surface: EditingSurface) => void` — how the field hands its adapter back up, so `ComposerInput` can give it to `useInputKeyboard` without knowing which field rendered. A callback rather than a ref-out param because the Lexical field cannot produce its surface until its editor exists, which is after first paint.

**`TextareaField.tsx`** — the `<textarea>` currently at `ComposerInput.tsx` lines 371-391, moved verbatim, together with its wrapper `<div className="relative min-h-[24px] flex-1">` (line 369) and the `{!hasText && placeholderOverlay}` slot (line 370). It owns its own `textareaRef`, calls `useTextareaResize(ref, value)` (today at `ComposerInput.tsx` line 282), builds `createTextareaSurface(ref)` and reports it through `onSurfaceChange` in a mount effect. It keeps, character for character:

- `role="combobox"`, `aria-autocomplete="list"`, `aria-controls`, `aria-expanded`, `aria-activedescendant`, `aria-label={placeholder}`, `placeholder={placeholderOverlay ? '' : placeholder}`
- `className="block max-h-[200px] min-h-[24px] w-full resize-none bg-transparent py-0.5 text-sm focus:outline-none"`, `rows={1}`
- the comment at lines 384-386 explaining why `aria-label` exists alongside `placeholder`

`ComposerInput.tsx` keeps everything else and loses only the textarea: the busy line (318-322), the `canSubmitReason` live region (326-330), the editing-queue line (331-337), the bordered row (338-345), the paperclip + hidden file input (346-368), the clear X (396-412), and `InputActionButton` (413-431) all stay exactly where they are. It renders `<TextareaField {...fieldProps} />` in the textarea's place. `focusAt`/`focus`/`focusUnlessTouch` in the `useImperativeHandle` (lines 226-238) still need the element, so the field also exposes those three through a small imperative handle of its own that `ComposerInput` forwards to — same method names, same meanings, same units, because `ComposerInputHandle` is a published contract that `RoomComposer` (`inputRef.current?.focusAt(pendingCaret.pos)`) and `ChatInputContainer` (`chatInputRef.current?.focusAt(next.length)`, line 190) both call.

Because `ComposerInput`'s wrapper markup does not move, the rendered DOM is expected to be IDENTICAL. That is the phase gate in task 1.5, and it is the reason this extraction is worth doing before any editor exists.

`field/` is internal to the slice. Nothing here goes in the barrel.

Acceptance: `pnpm --filter @dorkos/client typecheck` green; `pnpm vitest run apps/client/src/layers/features/composer/__tests__/ComposerInput.test.tsx` green with no assertion changed. This lands in ONE commit with 1.1 and 1.2 — the tree does not compile between them.

### Task 1.4: Build the one keyboard scenario table and run it against the textarea adapter

- **Size:** large · **Priority:** high
- **Depends on:** 1.3 · **Parallel with:** —

Author `apps/client/src/layers/features/composer/__tests__/editing-surface-conformance.ts` — a single exported scenario table plus a runner that any adapter can be handed, in the shape `runtimeConformance` and `communityConformance` already use for the runtime and community ports.

```ts
/** One keyboard scenario, expressed so it can run on any EditingSurface. */
export interface LadderScenario {
  readonly name: string;
  /** Text and caret to start from, as a markdown string and an offset into it. */
  readonly given: { text: string; caret: number };
  readonly key: { key: string; shiftKey?: boolean; altKey?: boolean };
  readonly props: Partial<UseInputKeyboardOptions>;
  readonly expect: {
    calls?: readonly (keyof UseInputKeyboardOptions)[];
    notCalls?: readonly (keyof UseInputKeyboardOptions)[];
    /** Text after the key, when the scenario edits the document. */
    text?: string;
    defaultPrevented: boolean;
  };
}
export const LADDER_SCENARIOS: readonly LadderScenario[];
export function runLadderConformance(name: string, mount: () => Promise<MountedSurface>): void;
```

**DRIFT, and it changes where the scenarios come from.** The spec's Testing Strategy says "`use-input-keyboard.test.ts` is today's regression net. Its scenarios are lifted into a shared table." THAT FILE DOES NOT EXIST. Verified against this worktree: there is no test file anywhere in `apps/client` for the keyboard hook. The ladder's real net is `apps/client/src/layers/features/composer/__tests__/ComposerInput.test.tsx` — 1876 lines, 145 `it()` blocks, component-level, driving a real `<textarea>` through React Testing Library, with 85 sites that type the element as a textarea and 9 that assert on `document.execCommand`. So the scenarios are LIFTED from a component test, and the table is new code, not a re-export.

Lift at minimum these rungs, each named after the behaviour and not the key (line numbers are `ComposerInput.test.tsx`'s):

- Enter submits with text, does not with empty text, does not while streaming (239, 253, 260)
- Shift+Enter never submits (246)
- Alt+Enter inserts a newline and never submits or picks a palette row
- backslash continuation: `foo\` + Enter inserts a newline and never sends; `foo\\` + Enter DOES send (the even-run rule)
- Escape ladder in priority order: palette dismiss (385), cancel queue edit, stop streaming, cancel upload, then the double-tap (626, 643, 693, 717, 734)
- the double-Escape wipe empties through the undo pipeline and selects the whole draft first (665, 679)
- the 500 ms window closes (693) and a `contextKey` change disarms
- palette open: ArrowUp/ArrowDown/Tab/Enter intercepted (345, 352, 359, 376); Shift+Enter not (392)
- palette open with ZERO results: Enter falls through and sends, and queues mid-stream (406, 424); Escape dismisses without arming the wipe (440)
- queue navigation: ArrowUp at caret 0 with items, ArrowDown at end while editing
- `commandPending` swallows Enter (the trigger latch); `isUploading` swallows Enter (the second half of the latch)
- touch-only: Enter inserts a newline instead of sending
- IME: `isComposing()` true means Enter is not handled

Register ONE adapter in this task: `runLadderConformance('textarea', mountTextareaSurface)` from a new `apps/client/src/layers/features/composer/__tests__/editing-surface.textarea.test.tsx`. Task 3.3 adds the Lexical registration and nothing else; that is the whole point of building it now.

**The bar has to be able to fail, and here is how you prove it can.** Before the port existed this suite could not even be written — `surface.insertLineBreak()` has no meaning on a ref. Record the discriminating evidence in the commit body: with `createTextareaSurface`'s `consumeEscapeIntoNewline` stubbed to a no-op, the backslash-continuation scenarios go RED; restore it and they go green. A table that passes against a deliberately broken adapter is not a table, it is decoration.

Do NOT delete or thin `ComposerInput.test.tsx`. It stays as the component-level net; the table is the surface-level one, and they overlap on purpose.

Acceptance: `pnpm vitest run apps/client/src/layers/features/composer/__tests__/editing-surface.textarea.test.tsx` green, and the recorded red-then-green mutation run in the commit body.

### Task 1.5: Phase 1 gate — ten DOM baselines diff empty and the ladder's net passes unedited

- **Size:** small · **Priority:** high
- **Depends on:** 1.4 · **Parallel with:** —

The phase-1 verification gate. Phases 1 and 2 change no behaviour on any surface, so the proof is that nothing moved.

**DOM parity — and the count is TEN, not eleven.** The spec says "all eleven DOM-parity baselines diff empty". Verified against this worktree: there are 10 committed baseline files, and the DOR-947 branch adds none.

| Baseline dir                                                        | Files                                                                                                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `apps/client/src/layers/features/chat/__tests__/__baselines__/`     | `chat-input-container.idle.json`, `.streaming-queue.json`, `.failed-attachment.json`, `.clear-armed.json`, `.interactive.json` |
| `apps/client/src/layers/widgets/room-view/__tests__/__baselines__/` | `room-composer.idle.json`, `.mention-open.json`, `.clear-armed.json`, `.archived.json`                                         |
| `apps/client/src/layers/widgets/dashboard/__tests__/__baselines__/` | `dashboard-composer-section.json`                                                                                              |

Every one of the ten must diff EMPTY, and none of them may be re-recorded. `DORKOS_RECORD_DOM_BASELINE=1` must not appear anywhere in this phase's work. A baseline re-recorded after a change proves nothing — `apps/client/src/test-helpers/dom-parity.ts` says so in its own module docblock (lines 27-31) and `matchDomBaseline` throws rather than inventing a missing file.

**DOR-947 COLLISION — read this before believing a green.** `origin/room-attachments` (PR #871) lands before this work builds, and it stamps `data-composer-card=""` on `Composer.Root`'s card (`ComposerRoot.tsx`, the `COMPOSER_CARD_ATTR` constant). On that branch, `ChatInputContainer-dom-parity.test.tsx` no longer asserts `formatDomDiff(diff) === ''`; it asserts `beyondTheComposerCardAttr(diff) === ''`, filtering exactly one entry:

```
div > div: [attr-added] attribute data-composer-card="" added
```

and `DashboardComposerSection-dom-parity.test.tsx` asserts `wrapper.attrs` equals `{ 'data-composer-card': '' }` rather than `{}`. So "diffs empty" post-947 means "empty beyond that one reviewed attribute". Assert against the 947 shape of those two files; do not restore the unfiltered assertion, and do not widen the filter to hide anything else.

Run, from the worktree root:

1. `pnpm --filter @dorkos/client typecheck`
2. `pnpm --filter @dorkos/client lint` — including `no-restricted-imports` (FSD) and `jsdoc` on the new `field/` directory and the two surface files
3. `pnpm vitest run apps/client/src/layers/features/composer/` — `ComposerInput.test.tsx` (1876 lines) passes with only the one added IME test from task 1.2, and the new conformance file passes
4. `pnpm vitest run apps/client/src/layers/features/chat/__tests__/ChatInputContainer-dom-parity.test.tsx` and `pnpm vitest run apps/client/src/layers/widgets/dashboard/__tests__/DashboardComposerSection-dom-parity.test.tsx`
5. **RoomComposer false-red gotcha:** a bare `pnpm vitest run` from the repo root has falsely failed `apps/client/src/layers/widgets/room-view/__tests__/RoomComposer.test.tsx`. Re-run from the package before believing a red: `cd apps/client && pnpm vitest run src/layers/widgets/room-view/__tests__/`
6. `pnpm test -- --run` once for the whole repo. NEVER a bare `pnpm vitest run` for a full run — it skips the per-package env turbo sets up and has falsely failed tests in dev
7. `pnpm knip` after building dists — the four helpers deleted from `use-input-keyboard.ts` must not survive anywhere, and nothing in `field/` may leak into the barrel

Dead-path greps, all empty: `grep -n "textareaRef" apps/client/src/layers/features/composer/ui/use-input-keyboard.ts`; `grep -rn "execCommand" apps/client/src/layers/features/composer/ui/` returns hits only in `textarea-surface.ts`.

Acceptance: every command green, both grep sets empty, and the commit body records the ten baselines by name with their empty (or attr-only) diffs.

## Phase 2 — The markdown boundary, headless

### Task 2.1: Add the six Lexical packages pinned to one minor line and record the pre-Lexical bundle

- **Size:** small · **Priority:** high
- **Depends on:** 1.5 · **Parallel with:** —

Add to `apps/client/package.json` `dependencies`, pinned to ONE minor line (`~0.x.y`, not `^`), and nothing else: `lexical`, `@lexical/react`, `@lexical/markdown`, `@lexical/rich-text`, `@lexical/list`, `@lexical/utils`. All first-party Meta packages, MIT.

DELIBERATELY NOT TAKEN, and the reasons belong in the commit body because a future reader will wonder: `@lexical/react/LexicalTypeaheadMenuPlugin` (the palettes are host-owned, driven by `(value, cursorPos)`, rendered in `Composer.OverlayLane`, and pinned by DOM baselines and browser tests — adopting it would mean rewriting `use-input-autocomplete` and `use-mention-autocomplete`, moving the palettes out of the lane, and re-deciding the zero-result Enter fall-through that DOR-946 fixed), `@lexical/link` (no links in the node set), `@lexical/code` (a fenced code block that swallows Enter would be a THIRD Enter meaning and the locked decision authorized exactly one exception), `@lexical/table`, `@lexical/yjs` (collaborative editing is a non-goal).

**Measure the BEFORE, because the flag-off byte claim is checked against it, not against an estimate.** Run `pnpm --filter @dorkos/client build` on the commit BEFORE this one and record, in the commit body: the total `dist/assets/*.js` gzipped size, and the size of the entry chunk. The spec's Performance section is explicit that the ideation's "~54 kB" figure "is an expectation, not a measurement, and this spec does not accept it on faith". Task 3.6 measures the after and diffs against these numbers; without a before, that task has nothing to compare to.

No source file imports any of these packages yet. That is deliberate: this commit is a dependency change a reviewer can read in isolation, and `pnpm --filter @dorkos/client build` on THIS commit must produce byte-identical output to the before-run above, because nothing references them. Record that identity as the first half of the zero-bytes proof.

Also check `pnpm knip` does not flag the six as unused-yet — if it does, note it and let task 2.2 (the first importer) clear it rather than adding an ignore entry.

Acceptance: `pnpm install` clean, lockfile committed, `pnpm --filter @dorkos/client typecheck` green, and the two recorded bundle numbers (before-deps and after-deps) identical.

### Task 2.2: Write MentionNode as a token text node that draws the real identity pill

- **Size:** medium · **Priority:** high
- **Depends on:** 2.1 · **Parallel with:** 2.3

Create `apps/client/src/layers/features/composer/ui/field/lexical-nodes.ts`.

`MentionNode extends TextNode`, with `isToken()` returning `true`. Token mode is what makes it atomic: backspace deletes the whole pill in one press, the caret never lands inside it, and typing against it does not extend it. Its text **is** `@handle`, so it serializes through the ordinary text path with no transformer at all — which is exactly why round-trip stability (task 2.5) holds for a document containing mentions.

Required overrides: `getType()`/`clone()`/`importJSON()`/`exportJSON()` (Lexical refuses to register a node without them), `createDOM()`, and `updateDOM()` returning `false` unless the handle or the identity colour changed.

**`createDOM()` must emit what `MentionPill` emits, and that is more than a class string.** Read `apps/client/src/layers/shared/ui/mention-pill.tsx` before writing it; `mentionPillVariants` IS exported from the shared barrel (`apps/client/src/layers/shared/ui/index.ts` line 269), so import it from `@/layers/shared/ui` and never re-derive the classes. The agent branch of that component renders four things this node must reproduce by hand, because `createDOM` returns a DOM element and cannot render React:

1. `class = mentionPillVariants({ tone: 'agent', interactive: false })`
2. `data-slot="mention-pill"` and `data-kind="agent"` and `title="@handle"`
3. inline `--identity-color` custom property — PUBLISHED, not painted; the background lives in the class that reads it, so an inline `background-color` would break the hover rule
4. inline `color: color-mix(in oklch, <color> 65%, hsl(var(--foreground)))` — the `hsl()` wrapper is load-bearing: this app's theme tokens store a bare `H S% L%` triple, and `color-mix()` with an unwrapped triple is invalid CSS that the browser silently drops whole
5. the leading `Bot` glyph, `class="mr-0.5 inline-block size-[0.85em] align-[-0.15em]"`, `aria-hidden` — inlined as an SVG string, since lucide's React component is not available here

The human branch is simpler: `tone: 'neutral'`, `data-kind="human"`, the text `@label`, no glyph, no inline style.

If reproducing the agent glyph by hand proves brittle, the acceptable alternative is a `DecoratorNode`, but it costs the round-trip guarantee its simplicity (a decorator's text is not text) — take it only with a recorded reason, not by default.

Also export the registered node list the editor config takes:

```ts
/** Every node class the composer's editor may create. A closed set. */
export const COMPOSER_NODES = [HeadingNode, ListNode, ListItemNode, MentionNode];
```

`HeadingNode` comes from `@lexical/rich-text` (the `#` transformers need it registered or they silently do nothing); `ListNode`/`ListItemNode` from `@lexical/list`.

Tests — `apps/client/src/layers/features/composer/ui/field/__tests__/lexical-nodes.test.ts`, headless (`createEditor()`, no React):

- a `MentionNode` for an agent renders a span whose class set equals `mentionPillVariants({ tone: 'agent', interactive: false })`'s, carries `data-slot="mention-pill"`, `data-kind="agent"`, `title="@ana"`, and a `--identity-color` custom property
- a `MentionNode` for a human renders the neutral variant with no inline colour
- `getTextContent()` is exactly `@handle` for both
- `isToken()` is `true`, and the node's text survives `exportJSON` → `importJSON` unchanged

Acceptance: `pnpm vitest run apps/client/src/layers/features/composer/ui/field/__tests__/lexical-nodes.test.ts` green; `pnpm --filter @dorkos/client lint` green (TSDoc on every export).

### Task 2.3: Write the closed markdown transformer set and prove the exclusions stay literal

- **Size:** medium · **Priority:** high
- **Depends on:** 2.1 · **Parallel with:** 2.2

Create `apps/client/src/layers/features/composer/ui/field/lexical-transformers.ts`, exporting one closed array the editor and the serializer both use:

```ts
/** The only markdown the composer's editor recognizes. Closed on purpose. */
export const COMPOSER_TRANSFORMERS: readonly Transformer[];
```

Recognized, and nothing else:

| Syntax                  | Result                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `**bold**` · `__bold__` | text format `bold` (also `⌘B`)                                                                                 |
| `*italic*` · `_italic_` | text format `italic` (also `⌘I`)                                                                               |
| `` `code` ``            | text format `code`                                                                                             |
| `# ` `## ` `### `       | `HeadingNode` h1-h3                                                                                            |
| `- ` `* ` `+ `          | `ListNode` unordered                                                                                           |
| `1. `                   | `ListNode` ordered                                                                                             |
| `@handle`               | `MentionNode` — NO transformer; it is a `TextNode` whose text is `@handle` and it rides the ordinary text path |

Build it by naming the specific transformers you want out of `@lexical/markdown`'s registries rather than spreading `TRANSFORMERS` and subtracting. Spreading and subtracting is how a link transformer arrives silently in a minor version bump; an explicit list makes an addition a diff someone has to approve.

**Deliberately not recognized:** links (`[x](y)`), blockquotes (`> `), fenced code blocks (` ``` `), strikethrough (`~~x~~`), horizontal rules, tables, images. Excluding a node from the editor does NOT remove the capability from the message — unrecognized syntax stays as literal characters in the box, rides the wire as the markdown it already is, and renders exactly as it does today through `streamdown`. Someone who types a fenced code block gets a fenced code block in the sent message; they just do not watch it become one while typing. Fenced code has the strongest argument of the seven: recognizing it would create a THIRD meaning for Enter, and the locked decision authorized exactly one exception ("Enter continues a list").

Also export the two keyboard formats, and only these two: `⌘B` and `⌘I`. No `⌘K`, because there are no links.

The module TSDoc must state the constraint the round-trip test enforces (task 2.5): a transformer that does not round-trip cleanly is unusable however nice it looks, because the controlled loop oscillates when `parse(md) → serialize()` is not a fixed point.

Tests — `apps/client/src/layers/features/composer/ui/field/__tests__/lexical-transformers.test.ts`, headless:

- each recognized row: feeding the syntax through `$convertFromMarkdownString(md, COMPOSER_TRANSFORMERS)` produces the expected node type
- each of the seven exclusions: the source characters survive in `getTextContent()` and NO node of the excluded type exists in the tree — a table-driven test over all seven, so adding a transformer without updating this list is red
- the array's length is asserted against a named constant, so an accidental spread is caught by count as well as by behaviour

Acceptance: `pnpm vitest run apps/client/src/layers/features/composer/ui/field/__tests__/lexical-transformers.test.ts` green.

### Task 2.4: Write markdown-offsets.ts — serialize and build the position map in one walk

- **Size:** large · **Priority:** high
- **Depends on:** 2.2, 2.3 · **Parallel with:** —

Create `apps/client/src/layers/features/composer/ui/field/markdown-offsets.ts`. This is the load-bearing module of the whole spec: every one of the four directions the host contract needs goes through it.

Exports, with these signatures verbatim:

```ts
/** A markdown string and the map from its offsets back to the document. */
export interface SerializedComposerDoc {
  readonly markdown: string;
  /** Each entry: a Lexical node key, and the [start, end) run of `markdown` it produced. */
  readonly spans: readonly { key: NodeKey; start: number; end: number; textOffset: number }[];
}
export function $serializeWithOffsets(): SerializedComposerDoc;
export function $markdownOffsetOfSelection(doc: SerializedComposerDoc): number | null;
export function $selectMarkdownOffset(doc: SerializedComposerDoc, pos: number): void;
```

The `$` prefix is Lexical's convention for a function that must run inside `editor.read()`/`editor.update()`; keep it.

**Serialize and build the map in a SINGLE walk.** The map is required because serialization is not identity: `**bold**` adds four characters that belong to no text node, and a mention node contributes `@handle` from a node whose own text is `@handle` but whose DOM is a pill. Deriving the caret from `textContent` alone would put the `@`-trigger regex a few characters off exactly when a person is mid-formatting — which is to say, exactly when the palette matters. Two walks would be two chances to disagree.

`$markdownOffsetOfSelection` returns `null` when there is no range selection, which the field treats as "do not emit a cursor change" rather than as offset 0.

**The fixed-point invariant, stated in the module TSDoc so it cannot be lost:** for every value a host can write back, `parse(md) → serialize()` must equal `md` exactly. If it does not, the controlled loop oscillates — the host writes `V`, the editor emits `V'`, the host writes `V'`, and the caret is destroyed on every keystroke. Task 2.5 is the property test that gates it.

The hosts this contract serves, named in the TSDoc so a future reader knows what breaks:

- `apps/client/src/layers/features/chat/model/use-input-autocomplete.ts` runs `detectFileTrigger(value, cursor)` / `detectCommandTrigger`
- `apps/client/src/layers/features/mentions/model/use-mention-autocomplete.ts` matches `MENTION_TRIGGER` (line 28, `/(^|\s)@([A-Za-z0-9_.-]*)$/`) against `text.slice(0, cursorPos)` and writes back through `insertMention` (`apps/client/src/layers/features/mentions/lib/mention-rows.ts:210`), which slices by the same offsets and returns a new `{ value, cursorPos }`
- `RoomComposer` then calls `focusAt(cursorPos)` (`apps/client/src/layers/widgets/room-view/ui/RoomComposer.tsx`, the `pendingCaret` `useLayoutEffect`)
- `ChatInputContainer`'s `insertIntoComposer` (lines 184-190) calls `focusAt(next.length)` after a file-tree path drop

Neither autocomplete hook is modified by this spec. That is the whole point of preserving the units.

TSDoc on every export; `NodeKey` imported as a type from `lexical`.

Acceptance: `pnpm --filter @dorkos/client typecheck` and `lint` green. Behaviour is proven in task 2.5, not here.

### Task 2.5: Commit the round-trip corpus and the offset-map table, both mutation-checked

- **Size:** medium · **Priority:** high
- **Depends on:** 2.4 · **Parallel with:** —

Two test files, both headless — no React, no field, nothing rendered.

**`apps/client/src/layers/features/composer/ui/field/__tests__/round-trip.test.ts`** — the property test. For every entry in a committed corpus, `$convertFromMarkdownString(md, COMPOSER_TRANSFORMERS)` then `$serializeWithOffsets().markdown` must equal `md` EXACTLY. Put the corpus in `__tests__/round-trip-corpus.ts` as an exported array of strings with a one-line comment per class, so adding a case is a data change.

The corpus includes, at minimum, and this list is the floor not the ceiling:

- every supported syntax alone: `**bold**`, `__bold__`, `*italic*`, `_italic_`, `` `code` ``, `# h1`, `## h2`, `### h3`, `- a`, `* a`, `+ a`, `1. a`
- nested: bold inside a list item, italic inside a heading, inline code inside bold
- every UNSUPPORTED syntax, which must survive untransformed: `> quote`, a fenced code block, `[text](url)`, `~~strike~~`, a pipe table, `---`, `![alt](src)`
- mentions at start of document, mid-sentence, immediately before a comma, immediately after an open paren, and two adjacent (`@ana @kai`)
- a trailing backslash (`foo\`) — the backslash-continuation rung depends on it surviving
- Windows line endings (`\r\n`)
- the empty document, and a document of only whitespace
- literal `**` that is not a formatting pair (`2 ** 3`), and a lone `*`
- a line that starts with `1.` but is not a list (`1.5x faster`)

**`apps/client/src/layers/features/composer/ui/field/__tests__/markdown-offsets.test.ts`** — the offset-map table. For a table of (document, caret position) pairs assert `$markdownOffsetOfSelection` returns the index the mention and command regexes need, and that `$selectMarkdownOffset` is its inverse (`$selectMarkdownOffset(doc, n)` then `$markdownOffsetOfSelection(doc)` returns `n`). Three cases are pinned by name because they are where a naive `textContent` walk goes wrong:

1. a caret immediately after a mention pill — the offset must be past the whole `@handle`, not inside it
2. a caret between the two asterisks of an unclosed `**` — the four syntax characters belong to no text node
3. a caret at the end of a list item — the `- ` marker is serialized but is not typed text

Plus: `$markdownOffsetOfSelection` returns `null` for a range selection, and for no selection at all.

**Mutation checks, required before this gate is called green** (`.claude/rules/testing.md`, `verification-before-completion`). Record the red-before/green-after in the commit body, with the command and the failing test names:

- remove ONE transformer from `COMPOSER_TRANSFORMERS` — the round-trip corpus must go RED on that syntax's entries specifically, not on everything
- make `$markdownOffsetOfSelection` return the raw `textContent` offset — the three pinned offset cases must go RED while the round-trip corpus stays green, proving the two tests are testing different things

A check that cannot fail is worse than none. If either mutation leaves the suite green, the test is decoration and must be rewritten before the phase closes.

Acceptance: `pnpm vitest run apps/client/src/layers/features/composer/ui/field/__tests__/` green, and both mutation runs recorded.

### Task 2.6: Phase 2 gate — the markdown boundary holds and nothing user-facing moved

- **Size:** small · **Priority:** high
- **Depends on:** 2.5 · **Parallel with:** —

The phase-2 verification gate. Nothing rendered changed in this phase, so the proof is one half "the new boundary is provably correct" and one half "the old path is provably untouched".

Run and record:

1. `pnpm --filter @dorkos/client typecheck`
2. `pnpm --filter @dorkos/client lint` — jsdoc on all four new `field/` modules
3. `pnpm vitest run apps/client/src/layers/features/composer/` — nodes, transformers, round-trip, offsets, plus the phase-1 conformance table and the unmodified `ComposerInput.test.tsx`
4. All ten DOM baselines still diff empty (beyond DOR-947's reviewed `data-composer-card` attribute — see task 1.5): `pnpm vitest run apps/client/src/layers/features/chat/__tests__/ChatInputContainer-dom-parity.test.tsx` and `.../widgets/dashboard/__tests__/DashboardComposerSection-dom-parity.test.tsx`, then `cd apps/client && pnpm vitest run src/layers/widgets/room-view/__tests__/` for the four room baselines (the RoomComposer false-red gotcha applies — never believe a red from a bare root-level run)
5. `pnpm test -- --run` for the whole repo
6. `pnpm --filter @dorkos/client build` — record the gzipped total again. It must still equal the number recorded in task 2.1, because no shipped module imports Lexical yet. If it moved, something imported a Lexical package outside a dynamic `import()` and the flag-off zero-bytes claim is already broken.

Grep proofs, all empty:

- `grep -rn "from 'lexical'\|from '@lexical" apps/client/src --include=*.ts --include=*.tsx | grep -v "/field/"` — every Lexical import lives under `features/composer/ui/field/`
- `grep -rn "lexical" apps/client/src/layers/features/composer/index.ts` — the barrel names nothing from the editor

Both mutation runs from task 2.5 are attached to the work item as the discriminating evidence for this phase. A phase whose gate is "the tests pass" and whose tests were never shown to be able to fail has not been gated.

Acceptance: every command green, both greps empty, the bundle number unchanged from 2.1.

## Phase 3 — The field

### Task 3.1: Build LexicalField with the a11y attributes the page objects and the feed nav depend on

- **Size:** medium · **Priority:** high
- **Depends on:** 2.6 · **Parallel with:** —

Create `apps/client/src/layers/features/composer/ui/field/LexicalField.tsx` — the chunk root. It satisfies `ComposerFieldProps` (task 1.3) exactly, so `ComposerInput` can render either field without knowing which.

Composition: `LexicalComposer` with `initialConfig = { namespace: 'composer', nodes: COMPOSER_NODES, theme, onError }`, wrapping `RichTextPlugin` (with a `ContentEditable`), `HistoryPlugin`, `ListPlugin`, and the field's own plugins added in tasks 3.2-3.5. `onError` must rethrow in development and report-and-continue in production — a Lexical error swallowed silently leaves a composer that looks fine and drops keystrokes.

**The a11y attributes are a hard constraint on the implementation, not a preference.** Three separate systems already in the tree read them, and all three break silently if they move:

1. `apps/e2e/pages/ChatPage.ts` line 20 locates the field with `getByRole('combobox', { name: /^(message |send a message)/i })`.
2. `apps/e2e/pages/RoomsPage.ts` line 299 uses `getByRole('combobox', { name: 'Message ${spokenName}…' })` and line 483 uses `getByRole('combobox', { name: 'Reply in this thread…' })`. DOR-947 adds 110 lines to this page object; those two locators are unchanged by it and must stay working.
3. `apps/client/src/layers/shared/model/feed/use-feed-keyboard-nav.ts` — on the DOR-947 branch its tab-stop selector already includes `'[contenteditable="true"]:not([tabindex="-1"])'` (line 49) and its composer-card resolver is `card?.querySelector<HTMLElement>('textarea, [contenteditable="true"]')` (line 66). This is GOOD NEWS: Ctrl+End into a composer already works for a contenteditable — but only if the element carries `contenteditable="true"` literally. Do not use `contenteditable=""`, and do not use `plaintext-only`.

So the `ContentEditable` renders with, at minimum: `role="combobox"`, `aria-autocomplete="list"`, `aria-label={placeholder}`, `aria-multiline="true"`, `aria-expanded={isPaletteOpen ?? false}`, `aria-controls={isPaletteOpen ? paletteListboxId : undefined}`, `aria-activedescendant={isPaletteOpen ? activeDescendantId : undefined}`. Every `aria-*` attribute the textarea carries must appear here with the same value — task 3.7's baseline review treats a difference there as a real a11y regression, not a swap.

The placeholder moves from a native attribute to an element (Lexical's `placeholder` slot), which is a recorded, intended delta. The `{!hasText && placeholderOverlay}` slot from `TextareaField` is reproduced so `AnimatedPlaceholder` still works on chat.

**Sizing.** `use-textarea-resize.ts` does NOT run on this path — a contenteditable grows naturally. Reproduce the 200 px cap in CSS on the editable: `max-h-[200px] overflow-y-auto`, alongside the textarea's other field classes (`block min-h-[24px] w-full bg-transparent py-0.5 text-sm focus:outline-none`). The 200 ms ease-down on empty is a textarea-only artifact of imperative height setting; it is NOT reproduced, and that is a recorded, intended delta in the flag-on baseline. Never hand-sort the Tailwind class strings — Prettier's class sorter owns them.

No new timers, intervals, subscriptions, or context providers outside the editor's own.

Acceptance: `pnpm --filter @dorkos/client typecheck` green; a smoke test renders the field and asserts the element is found by `getByRole('combobox', { name: 'Send a message...' })` and carries `contenteditable="true"`.

### Task 3.2: Write use-lexical-value.ts — the emitted-value latch and the two-call emission order

- **Size:** medium · **Priority:** high
- **Depends on:** 3.1 · **Parallel with:** —

Create `apps/client/src/layers/features/composer/ui/field/use-lexical-value.ts`. This hook is the controlled-value boundary, and dropping any part of it breaks typing while every other test stays green.

**The emitted-value latch.** Re-hydrate the document from the `value` prop ONLY when `value` differs from the last string this field emitted:

```ts
// Emitted-value latch, in words: we own the document while the person types; the
// host owns it when the host changes the text out from under us.
if (value !== lastEmittedRef.current) hydrate(value);
```

Without it, every keystroke round-trips its own output through the parser, which resets selection, empties the undo stack, and makes the editor feel broken. This is the single most common way a controlled Lexical integration fails, and it is written down here so it cannot be discovered in review. The hook's TSDoc carries the latch AND why dropping it breaks typing — that TSDoc is a deliverable, not decoration.

**The update listener, and the selection-only fast path.** Register through `registerUpdateListener`. When `dirtyElements.size === 0 && dirtyLeaves.size === 0` the update was selection-only: skip serialization entirely and emit ONLY `onCursorChange`. The trigger detectors need the caret, and the text has not moved. Serialization runs on every document change on the most latency-sensitive surface in the product; this fast path is why the p95 budget in task 5.3 is reachable.

**The emission ORDER is fixed by an existing contract and is not yours to choose.** `apps/client/src/layers/features/mentions/model/use-mention-autocomplete.ts` documents it in its own TSDoc (see `noteTextChange` at line 76 and `handleCursorChange` at line 78): text first, then cursor. So a document change emits `onChange(markdown)` and THEN `onCursorChange(offset)`, in that order, synchronously, in one listener call. Emitting them in the other order, or in two separate effects, makes the room picker match a trigger against a stale string.

`focusAt(pos)` on the field's imperative handle maps the markdown offset back to a Lexical selection via `$selectMarkdownOffset` and focuses the editable. `RoomComposer`'s `pendingCaret` `useLayoutEffect` and `ChatInputContainer`'s `insertIntoComposer` (line 190, `focusAt(next.length)`) both depend on this landing after the value write, not before.

Hydration parses with `$convertFromMarkdownString(value, COMPOSER_TRANSFORMERS)` inside one `editor.update()`, and sets `lastEmittedRef.current = value` in the same update so the very next listener call does not re-hydrate what it just parsed.

Tests — `apps/client/src/layers/features/composer/ui/field/__tests__/use-lexical-value.test.tsx`:

- **the latch test, and it must be able to fail loudly:** type N characters into the field with a host that echoes `onChange` straight back into `value`, and assert the document was hydrated ZERO times after mount. Instrument hydration with a counter, not a spy on a private function. Mutation check to record: remove the `value !== lastEmittedRef.current` guard and this test goes RED while every other test in the suite stays green — that asymmetry IS the reason the test exists.
- a genuinely external write (a value the field never emitted) DOES hydrate, exactly once
- a selection-only update emits `onCursorChange` and NOT `onChange`
- a document change emits `onChange` before `onCursorChange`, asserted on call order across the two mocks

Acceptance: `pnpm vitest run apps/client/src/layers/features/composer/ui/field/__tests__/use-lexical-value.test.tsx` green, and the latch mutation run recorded red-then-green.

### Task 3.3: Write lexical-surface.ts and register the second adapter in the scenario table

- **Size:** large · **Priority:** high
- **Depends on:** 3.1 · **Parallel with:** —

Create `apps/client/src/layers/features/composer/ui/field/lexical-surface.ts`, exporting `createLexicalSurface(editor: LexicalEditor): EditingSurface` — the second implementation of the port from task 1.1, with all seven methods.

Every method runs inside `editor.read()` or `editor.update()` and uses `$getSelection` / `$isRangeSelection`:

- `textBeforeCaret()` — `null` unless the selection is a collapsed range; otherwise the markdown text before the caret, taken from `$serializeWithOffsets()` and `$markdownOffsetOfSelection` so the backslash-continuation rule sees the SAME string a textarea would. Deriving it from `getTextContent()` would miss the four characters `**bold**` contributes, and `foo**\` would stop continuing the line.
- `isCaretAtStart()` — collapsed selection at offset 0 of the whole document, not of the current block. ArrowUp into the message queue depends on "the whole document", and a caret at the start of the second paragraph is not at the start of the document.
- `isCaretAtEnd()` — the mirror.
- `insertLineBreak()` — one `editor.update()` inserting a line break, which `HistoryPlugin` records as one undo entry.
- `consumeEscapeIntoNewline()` — one `editor.update()` that deletes the escaping backslash before the caret and inserts a line break. One update, so Cmd+Z takes both back together.
- `clearThroughUndoStack()` — a single `editor.update()` that selects the root and clears it. `HistoryPlugin` records it as ONE entry, which is the whole requirement: this clear sits two taps behind a key someone is already hammering to stop a turn that will not stop, and Cmd+Z has to bring the draft back.
- `isComposing()` — `editor.isComposing()`.

**Then register the second adapter, and that is the central proof of this spec.** Add `apps/client/src/layers/features/composer/ui/field/__tests__/editing-surface.lexical.test.tsx` calling `runLadderConformance('lexical', mountLexicalSurface)` against a real headless Lexical editor. It imports `LADDER_SCENARIOS` from the table task 1.4 built; the table itself is NOT edited. One scenario table, two adapters — a ladder rung that behaves differently on the two surfaces fails, and that is the bar for "the keyboard survived".

FSD note for the test file: the conformance module lives in `features/composer/__tests__/` and this test in `features/composer/ui/field/__tests__/`, both inside the same slice, so a relative import is correct and no barrel widens. If a test needs to reach a genuinely internal module across a barrel, `vi.importActual` is the sanctioned escape hatch — do not add an export to `index.ts` to make a test convenient.

Expect this to be red before it is green, and record which rungs were red first: the seam exists precisely because the textarea methods have no meaning on a contenteditable, so a Lexical adapter that has not yet implemented `consumeEscapeIntoNewline` fails the backslash scenarios while everything else passes. That per-rung failure pattern is the evidence the table discriminates.

Acceptance: `pnpm vitest run apps/client/src/layers/features/composer/ui/field/__tests__/editing-surface.lexical.test.tsx` and `pnpm vitest run apps/client/src/layers/features/composer/__tests__/editing-surface.textarea.test.tsx` both green against the same `LADDER_SCENARIOS` array.

### Task 3.4: Register the ladder at COMMAND_PRIORITY_CRITICAL and implement the thirteen-row Enter table

- **Size:** large · **Priority:** high
- **Depends on:** 3.3 · **Parallel with:** —

Add the command registrations to `LexicalField.tsx` (or a `use-ladder-commands.ts` beside it), wired through `mergeRegister` from `@lexical/utils` so one cleanup unregisters all five.

React 19 attaches synthetic listeners at the root container; Lexical registers native listeners on the contenteditable itself. So a native Lexical handler runs in the target phase, before React's delegated `onKeyDown` fires at the root. Left alone, Lexical inserts a paragraph on Enter before `use-input-keyboard` ever runs, and the message never sends. The fix is priority, not ordering luck: register at `COMMAND_PRIORITY_CRITICAL`, the highest, so the ladder is consulted before Lexical's own rich-text handlers.

| Lexical command          | What the ladder does                                                     |
| ------------------------ | ------------------------------------------------------------------------ |
| `KEY_ESCAPE_COMMAND`     | Runs the whole Escape ladder. Returns `true` on every rung that acts.    |
| `KEY_ENTER_COMMAND`      | Runs the Enter ladder. See the table below.                              |
| `KEY_ARROW_UP_COMMAND`   | Queue navigation when the queue has items and the caret is at the start. |
| `KEY_ARROW_DOWN_COMMAND` | Queue navigation when editing a queue item and the caret is at the end.  |
| `KEY_TAB_COMMAND`        | Palette pick when a palette is open with results.                        |

The handler returns Lexical's `true`/`false` — `true` means "consumed, stop", `false` means "I did not act, carry on". **The `false` return is the whole of locked decision 2:** it is how Enter continues a list.

**The Enter table, flag-on**, top to bottom, first match wins. All thirteen rows, in this order:

| Condition                               | Result                                       | Lexical return |
| --------------------------------------- | -------------------------------------------- | -------------- |
| IME composing                           | do nothing                                   | `false`        |
| `Alt+Enter`                             | `surface.insertLineBreak()`                  | `true`         |
| `Shift+Enter`                           | line break (Lexical's own)                   | `false`        |
| backslash continuation (`foo\` + Enter) | `surface.consumeEscapeIntoNewline()`         | `true`         |
| palette open **and** has results        | `onCommandSelect()`                          | `true`         |
| **caret inside a non-empty list item**  | continue the list (Lexical's own)            | `false`        |
| **caret inside an empty list item**     | exit the list (`$handleListInsertParagraph`) | `false`        |
| touch-only device                       | newline (Lexical's own)                      | `false`        |
| `commandPending`                        | do nothing (the trigger latch)               | `true`         |
| editing a queue item, text non-empty    | `onSaveEdit()`                               | `true`         |
| streaming, text non-empty               | `onQueue()`                                  | `true`         |
| idle, sendable, text non-empty          | `onSubmit()`                                 | `true`         |
| otherwise                               | do nothing                                   | `true`         |

The two bold rows are the entirety of locked decision 2. They sit BELOW the palette rung on purpose: a `/` palette open inside a list item is still a palette, and Enter still picks the row. They sit ABOVE the send rungs, which is what "Enter never sends from inside a list" means. Sending a message that ends in a list is done by pressing Enter on the empty item (which exits the list) and then Enter again, or by the Send button — the same two ways every chat app with lists works.

Flag-off, the table is today's exactly, and the two list rows are unreachable because no list node exists.

**`preventDefault` semantics survive exactly.** The existing ladder marks a consumed Escape with `preventDefault()` and deliberately does NOT `stopPropagation` — an enclosing thread panel reads `defaultPrevented` to decide whether the key was already spoken for (see the 15-line comment at `use-input-keyboard.ts` lines 220-235, which must survive this work verbatim). Lexical hands the original `KeyboardEvent` to the command handler, so the ladder calls `preventDefault()` on the same event object it does today and the bubbling behaviour is unchanged. Assert this: a consumed Escape leaves `event.defaultPrevented === true` and the event still reaches a listener on an ancestor.

Tests — extend the Lexical conformance run from task 3.3 with the two list rows (they have no textarea equivalent, so they are Lexical-only cases marked as such in the table, not silent omissions), and add a direct test that Enter inside a non-empty list item returns `false` and produces a second list item, while Enter on an empty list item exits to a paragraph.

Acceptance: both conformance runs green; `pnpm --filter @dorkos/client typecheck` green.

### Task 3.5: Implement paste precedence so DOR-947 attach and DOR-1032 path drops keep working

- **Size:** medium · **Priority:** high
- **Depends on:** 3.4 · **Parallel with:** —

The composer card already owns two drop-shaped behaviours that predate this work, and the editor must decline both rather than compete with them.

**File paste — the rule the spec states, and it is load-bearing.** `Composer.Root` owns an `onPaste` handler for file attachments (`apps/client/src/layers/features/composer/ui/use-drag-and-paste.ts`, `handlePaste` at lines 24-33, which filters `item.kind === 'file'`), and DOR-947 depends on it — on `origin/room-attachments`, `RoomComposer` passes `onFilesDropped={attachments.addFiles}`, which is the entire attach declaration. So the Lexical field's `PASTE_COMMAND` handler must **decline any paste whose `clipboardData.items` contain a file** — returning `false` lets the event bubble to Root, which attaches it. A paste carrying BOTH files and HTML is treated as a file paste, matching today's behaviour. Only a file-free paste is converted.

**Path drop — a second claimant the spec does not mention, found in the tree.** DOR-1032 landed at `4df274842` and added `usePathDrop` to the same module (lines 58-82). `Composer.Root` wires `onDragOver`/`onDrop` from it on BOTH card variants (`ComposerRoot.tsx` lines 114-115 and 153-159), and `ChatInputContainer` line 237 turns a dropped file-tree path into text via `insertIntoComposer(composerFileReference(path))`. This is a drag of a REFERENCE, not of bytes: it becomes text in the box, not an upload. Lexical registers its own `DROP_COMMAND` and `DRAGOVER_COMMAND` on the editable, so a path dropped directly ON the field would be handled by Lexical before React's delegated `onDrop` at Root ever fires. Handle it the same way as paste: the field's `DROP_COMMAND` handler returns `false` for any drag whose `dataTransfer.types` satisfy `hasFilePathDrag`, and for any drag carrying files, so both bubble to Root. Note this explicitly in the commit body as an addition beyond the spec's Security section.

**Conversion is allowlist-shaped, not sanitizer-shaped.** A file-free paste carrying HTML is parsed with `DOMParser` into an inert document — never inserted into the live DOM — walked, and mapped to the supported node set from `COMPOSER_TRANSFORMERS`; anything outside that set contributes its `textContent` and nothing else. No `dangerouslySetInnerHTML`, no `innerHTML` assignment, no `document.write`. A pasted `<script>` / `<img onerror>` / `<iframe>` therefore cannot execute and cannot survive as markup — it becomes text or nothing.

**Plain-text paste** (`⌘⇧V`, `Ctrl+Shift+V`) bypasses conversion entirely and inserts the clipboard's `text/plain`.

No HTML is ever persisted, posted, or stored. What leaves the component is a markdown string, the same string it is today. The editor gains no network access, no storage access, and no new permissions.

Tests — `apps/client/src/layers/features/composer/ui/field/__tests__/lexical-paste.test.tsx`:

- a paste whose `clipboardData.items` contain one `kind: 'file'` item and one `kind: 'string'` item: the field's handler returns `false` and the document is unchanged; assert the event reaches a Root-level `onPaste` spy
- a file-free HTML paste of `<b>bold</b><p>para</p>` produces bold text and a paragraph
- a file-free HTML paste of `<script>alert(1)</script><img onerror="x">` produces no `script` or `img` node anywhere in the document and no `<script>` element in any document — assert on the document tree, not on a serialized string
- `<a href="x">link</a>` contributes the text `link` and no link node (links are not in the supported set)
- a plain-text paste inserts `text/plain` verbatim with no conversion
- a drop carrying a file-tree path type returns `false` and reaches Root's `onDrop`

Acceptance: `pnpm vitest run apps/client/src/layers/features/composer/ui/field/__tests__/lexical-paste.test.tsx` green, and `cd apps/client && pnpm vitest run src/layers/features/composer/__tests__/ComposerRoot.test.tsx` still green (298 lines, it owns the drop/paste-reaches-Root assertions).

### Task 3.6: Lazy-load the editor and measure the flag-off zero-bytes claim

- **Size:** medium · **Priority:** high
- **Depends on:** 3.5 · **Parallel with:** —

Wire the field choice in `apps/client/src/layers/features/composer/ui/ComposerInput.tsx`. The wrapper is identical either way; only the field swaps.

```tsx
const richText = useComposerRichText(props.richText);
// … the wrapper is identical either way …
{
  richText ? (
    <Suspense fallback={<TextareaField {...fieldProps} />}>
      <LexicalField {...fieldProps} />
    </Suspense>
  ) : (
    <TextareaField {...fieldProps} />
  );
}
```

`LexicalField` is reached through `React.lazy(() => import('./field/LexicalField'))`. The Suspense fallback is the TEXTAREA, not a spinner: a composer that is briefly un-typeable is worse than a composer that is briefly plain, and the two share `value`/`onChange` so nothing is lost when the chunk arrives. When the flag is on, prefetch the chunk on idle so the first focus does not show the fallback at all.

`richText` arrives as one ADDITIVE OPTIONAL prop on `ComposerInputProps` (task 4.4 makes `ChatInputContainer` pass it; every other call site compiles untouched and never reads it). Until task 4.2 exists, read it straight from the prop with a `false` default — do not stub a hook.

**Measure the claim, do not assert it.** The spec's Performance section is explicit that the ideation's ~54 kB figure "is an expectation, not a measurement". Run `pnpm --filter @dorkos/client build` and record in the commit body, against the numbers task 2.1 captured:

1. the entry chunk's gzipped size — it must be UNCHANGED from the pre-Lexical measurement, to the byte if the bundler is deterministic. That is the zero-Lexical-bytes-flag-off proof.
2. the name and gzipped size of the separate Lexical chunk. This number is what the graduation criteria accept or reject; the estimate is not accepted as a result.
3. a grep of the built entry chunk for a Lexical marker string (e.g. `createEditor`) returning nothing.

If any Lexical module lands in the entry chunk, a static import slipped in somewhere — find it before moving on rather than adding a manual chunk rule to paper over it.

Tests: a render test asserting that with `richText` absent or `false` the tree contains a `<textarea>` and no `[contenteditable]`, and with `richText` true it eventually contains `[contenteditable="true"]` and no `<textarea>`.

Acceptance: `pnpm --filter @dorkos/client typecheck` green, the three recorded measurements in the commit body, and the entry-chunk grep empty.

### Task 3.7: Record the flag-on DOM baselines and prove the palettes and mentions still work

- **Size:** large · **Priority:** high
- **Depends on:** 3.6 · **Parallel with:** —

Three proofs that the field swapped without the surfaces noticing.

**Flag-on DOM baselines.** New baselines under the existing harness (`apps/client/src/test-helpers/dom-parity.ts`), recorded DELIBERATELY with `DORKOS_RECORD_DOM_BASELINE=1` and reviewed as the rich-text reference — this is the one place in the whole spec where recording is legitimate, because there is no pre-existing tree to compare against. Name them `chat-input-container.rich-text.<state>.json` beside the existing five, so the flag-off ten stay untouched and un-re-recorded.

The intended deltas are enumerable and small; enumerate them in the test file's docblock and assert them positively rather than accepting whatever renders:

- `<textarea>` becomes `<div contenteditable="true" role="combobox" aria-multiline="true">`
- the placeholder moves from a native attribute to an element
- inside the field only, the nodes the document currently holds
- no `use-textarea-resize` inline `height` style, and no 200 ms ease-down (task 3.1's recorded delta)

**Every `aria-*` attribute on the field must appear in BOTH baselines with the same value.** A diff there is a real a11y regression, not a swap. Write that as its own assertion comparing the field element's `aria-*` map across the flag-off and flag-on serializations, so it fails loudly rather than being lost in a large diff.

**Palette integration, unchanged code under a changed field.** `use-input-autocomplete` (chat) and `use-mention-autocomplete` (rooms) are NOT edited by this spec, so their own tests are untouched. Add new tests that drive the Lexical field and assert the palettes still open, filter, and insert:

- `/comp` opens the command palette with results
- `@zzz` opens the zero-result panel and Enter falls THROUGH to send — the rung DOR-946 pinned (`ComposerInput.test.tsx` lines 406 and 424 are the textarea-path versions)
- `insertMention`'s returned `cursorPos` lands the caret past the separating space, verified through `focusAt` and read back through `$markdownOffsetOfSelection`

**Mention node behaviour.** Backspace at the right edge of a pill deletes the whole pill in one press; the caret cannot be placed inside it; a hand-typed handle that is in the roster becomes a pill; a handle absent from the roster stays plain text; `mentionSubjects` omitted means no pills anywhere.

The roster arrives as one additive optional prop on `ComposerInputProps`, forwarded through `ComposerFieldProps`:

```ts
/**
 * Handles this composer may draw as identity pills, and the colours to draw
 * them in. Purely presentational: the SERVER still resolves who a mention
 * addresses at write time. A handle absent from this list stays plain text.
 * Omitted by surfaces with no roster (chat, dashboard, onboarding).
 */
mentionSubjects?: readonly { handle: string; identityColor: string | null; kind: 'human' | 'agent' }[];
```

Additive and optional, so every existing call site compiles untouched and the flag-off path never reads it. Rooms will pass it (derived from `room.members`, which `RoomComposer` already holds for `useMentionAutocomplete` — see its `members: room.members` argument) when rooms graduate; nobody passes it at ship time.

A `MentionNode` comes into existence two ways and both go through the SAME node transform, so a hand-typed `@ana` and a picked `@ana` are the same node and look the same: the picker writes back a new `value` containing `@handle`, and a node transform scans plain text for `/(^|\s)@([A-Za-z0-9_.-]+)/` and promotes a match when the handle is in the roster. DRIFT NOTE: the spec calls that "the same shape as `MENTION_TRIGGER`", and it is not — `MENTION_TRIGGER` (`use-mention-autocomplete.ts` line 28) is `/(^|\s)@([A-Za-z0-9_.-]*)$/`, with `*` and a `$` anchor, because it matches a PARTIALLY TYPED handle at the caret. The promotion transform wants `+` and no anchor. Use `+`, and say why in a comment.

**The editor never becomes the resolver.** It draws what the host already told it. Nothing in `apps/server/src/services/rooms/mentions.ts` changes and the span doctrine (`.claude/rules/room-conduct.md`) is untouched. If a change here seems to need a server edit, stop.

Acceptance: `pnpm vitest run apps/client/src/layers/features/composer/` green; the new baselines committed with a review note naming each intended delta; the flag-off ten unmodified (`git diff --stat` over the three `__baselines__` directories shows only added files).

### Task 3.8: Phase 3 gate — both surfaces pass one table, and the mutations prove it discriminates

- **Size:** small · **Priority:** high
- **Depends on:** 3.7 · **Parallel with:** —

The phase-3 verification gate, and the most important one in the spec: this is where "the keyboard survived" becomes a claim that can fail.

Run and record:

1. `pnpm --filter @dorkos/client typecheck` and `lint`
2. `pnpm vitest run apps/client/src/layers/features/composer/` — one `LADDER_SCENARIOS` array, two adapters, both green
3. `pnpm vitest run apps/client/src/layers/features/chat/__tests__/ChatInputContainer-dom-parity.test.tsx` and the dashboard one — flag-off baselines still empty beyond DOR-947's reviewed `data-composer-card` attribute
4. `cd apps/client && pnpm vitest run src/layers/widgets/room-view/__tests__/` — the four room baselines and `RoomComposer.test.tsx`. A bare root-level `pnpm vitest run` has falsely failed that file; re-run from the package before believing any red
5. `pnpm test -- --run` for the whole repo
6. `pnpm knip` after building dists — nothing in `field/` may have leaked into `apps/client/src/layers/features/composer/index.ts`

**The three mutation checks, all required before this gate is called green** (`.claude/rules/testing.md`, `verification-before-completion`). Record each as a red-before/green-after pair with the failing test names, not as a sentence saying it was done:

- **Drop the `COMMAND_PRIORITY_CRITICAL` registration** (drop to `COMMAND_PRIORITY_LOW`, or unregister `KEY_ENTER_COMMAND`): the ladder table must go RED. Specifically it should go red on the Lexical run and stay green on the textarea run, which proves the two runs are genuinely independent rather than sharing a mock.
- **Remove the emitted-value latch**: the typing test from task 3.2 must go RED while the rest of the suite stays green. That asymmetry is the point — the latch's failure mode is invisible to every other test.
- **Remove one transformer from `COMPOSER_TRANSFORMERS`**: the round-trip corpus must go RED on that syntax's entries and nowhere else.

Grep proof, empty: `grep -rn "from 'lexical'\|from '@lexical" apps/client/src --include=*.ts --include=*.tsx | grep -v "features/composer/ui/field/"`.

Acceptance: every command green, all three mutation pairs recorded and attached to the work item. A gate whose tests were never shown to be able to fail has not gated anything.

## Phase 4 — The flag and chat

### Task 4.1: Add ui.composer.richText with its three classifications and a conf migration

- **Size:** medium · **Priority:** high
- **Depends on:** 3.8 · **Parallel with:** —

Add the feature flag to persistent user config, following the `adding-config-fields` skill lifecycle end to end and `.claude/rules/safe-defaults.md`. Skipping any step turns the build red — each classification file has its own drift guard.

**1. The schema.** `packages/shared/src/config-schema.ts`. The `ui` object starts at line 734; `statusBar: StatusBarPrefsSchema.default(() => ({ pins: [] }))` at line 762 is the model to copy, including its own `ComposerPrefsSchema` declared above the `UserConfigSchema` beside `StatusBarPrefsSchema` (line 559). Add:

```ts
ui.composer.richText: z.boolean().default(false)
```

and add the matching entry to the `ui` block's explicit `.default(() => ({ … }))` literal (lines 794-817, where `statusBar: { pins: [] }` sits at line 816). Missing that literal is the classic half-done config change: the field validates but a fresh install has no `ui.composer` key at all.

The field's TSDoc says what it is for a person, not for the system: whether the message box shows formatting as you type. It also records that it ships `false` and that flipping it to default-`true` is gated on the graduation criteria, so nobody flips it as a "cleanup".

**2. The three classifications**, all mandatory:

- `apps/server/src/services/core/safe-defaults/default-verdicts.ts` — `'ui.composer.richText'` as **`no-risk`** (`ui.theme` at line 87 is the precedent). It sends nothing off the machine, grants no agent capability, and enforces no bound. It is a preference.
- `apps/server/src/services/core/operator/config-disclosure.ts` — `'ui.composer.richText': 'expose'` (`'ui.theme': 'expose'` at line 113).
- `apps/server/src/services/core/operator/config-write-policy.ts` — `'ui.composer.richText': 'agent-writable'` (`'ui.theme': 'agent-writable'` at line 138). Nothing is at stake; an agent may change it on the user's word.

NO `PROTECTIVE_CARRYOVERS` rule. That list exists for a permissive default a person could move to a protective value; this default is `false`, which is the conservative end, so a config wipe cannot reverse a protection.

**3. The migration.** `CONFIG_MIGRATIONS` in `apps/server/src/services/core/config-manager.ts` (line 1946). A migration goes under a NEW key STRICTLY GREATER than the newest `v*` tag, and never onto a key that has already shipped — `conf` runs a key only in `(storedVersion, projectVersion]`, so a body added to a released key never runs for anybody already past it. Verified in this worktree: the newest key present is `'0.57.0'` (line 2097, whose own comment says "THIS KEY HAS SHIPPED. Do not append a body to it"), the newest tag is `v0.58.0`, and `package.json` reads `0.58.0`. So the new key is **`'0.59.0'`** — above the newest tag, and not the current version. The body backfills `ui.composer = { richText: false }` on an existing `ui` block, idempotently, exactly as `migrateStatusBarToPins` does for its section. The retired placeholder convention (a "next ascending release" key expecting `/system:release` to rename it) is documented above `CONFIG_MIGRATIONS` as retired — do not resurrect it.

**4. The test, and it must use a REAL `ConfigManager`.** `.claude/rules/safe-defaults.md` is explicit: mock stores never cross the `conf`/Ajv seam, and `UserConfigSchema.parse` cannot substitute because Zod strips unknown keys where Ajv rejects them. Follow `apps/server/src/services/core/safe-defaults/__tests__/protected-state.test.ts`: write a real config file with no `ui.composer`, boot a real manager, assert the key is present and `false` afterwards. Also assert the guard in `apps/server/src/services/core/__tests__/migration-safety.ts` still passes.

Acceptance: `pnpm --filter @dorkos/shared build` then `pnpm --filter @dorkos/server typecheck`; `pnpm vitest run apps/server/src/services/core/safe-defaults/__tests__/` and `apps/server/src/services/core/operator/__tests__/` green (the drift guards); the real-manager migration test green.

### Task 4.2: Add use-composer-prefs to entities/config, following the status-bar pins pattern exactly

- **Size:** small · **Priority:** high
- **Depends on:** 4.1 · **Parallel with:** 4.3

Create `apps/client/src/layers/entities/config/model/use-composer-prefs.ts`, modelled line for line on `apps/client/src/layers/entities/config/model/use-status-bar-prefs.ts` — same file, same shape, same reasoning, different key. Read that file first; the pattern is not obvious and re-deriving it produces subtly different cache behaviour.

Two exports:

- `useComposerRichText(): boolean` — selects from the shared `useConfig()` query with a `selectComposer(config)` helper returning a stable default while config is still loading. Returning `false` while loading is the right default: a composer that renders plain and then becomes rich is fine; one that renders rich and collapses to a textarea is a flash of the wrong field.
- `useUpdateComposerPrefs(): { setRichText(on: boolean): void; isPending: boolean }` — a `useMutation` that PATCHes `{ ui: { composer: { richText } } }` through `transport.updateConfig`, with an optimistic cache write, rollback on error, and `invalidateQueries({ queryKey: configKeys.current() })` on settle. The route deep-merges plain objects, so no other `ui` key is touched — which is the same reason `setPins` sends only its own subtree.

Copy the optimistic-write guard verbatim in spirit: when `ui` is absent from the cache there is nothing to patch optimistically (the settle-time invalidate refetches it), so leave it undefined rather than fabricating a partial `ui`.

Export both from `apps/client/src/layers/entities/config/index.ts` beside the status-bar hooks. Module-level TSDoc (`@module entities/config/model/use-composer-prefs`) per the FSD barrel convention.

Then have `ComposerInput` read it: `const richText = useComposerRichText(props.richText)` — the PROP wins when given, the config answers when it is not. That precedence is what lets the dev playground and tests force a value without touching a person's config, and it is why task 3.6 wired the prop first.

FSD check: `entities/config` may import `shared/` only. `features/composer` importing `entities/config` is legal (features may import entities). Import from the barrel, never an internal path.

Tests — `apps/client/src/layers/entities/config/__tests__/use-composer-prefs.test.tsx`: reads `false` while loading; reads the stored value once config resolves; `setRichText(true)` sends exactly `{ ui: { composer: { richText: true } } }` and nothing else; an error rolls the cache back.

Acceptance: `pnpm vitest run apps/client/src/layers/entities/config/__tests__/use-composer-prefs.test.tsx` green; `pnpm --filter @dorkos/client lint` green.

### Task 4.3: Add the Settings toggle in plain words under Advanced

- **Size:** small · **Priority:** high
- **Depends on:** 4.1 · **Parallel with:** 4.2

Add one switch to `apps/client/src/layers/features/settings/ui/AdvancedTab.tsx`, using the `SwitchSettingRow` primitive that tab already imports from `@/layers/shared/ui` (line 16, first used at line 61) — not a hand-rolled row. The Advanced tab is registered in `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx` line 80 (`{ id: 'advanced', label: 'Advanced', icon: Cog, component: AdvancedTab, group: 'System' }`); no registration change is needed.

Copy, in the plain-words register the `writing-for-humans` skill requires — a smart 9th grader who does not code has to understand what turning it on does:

- Label: **Format text as you type**
- Description: **See bold, headings, and lists take shape in the message box while you write.**

No "Lexical", no "WYSIWYG", no "rich text editor", no "experimental" scare word in the label itself. Do not promise what it does not do: it is on chat only at ship time, so if the description would read as "everywhere", say where instead.

Wire it to `useComposerRichText` / `useUpdateComposerPrefs` from `@/layers/entities/config`. The switch reflects the stored value and writes optimistically, so it responds instantly and self-corrects if the write fails.

**Why the switch is visible at all**, and it belongs in a comment because a reviewer will ask: a person whose composer misbehaves can fix it without reading a file, and an opt-in feature nobody can find gets no signal. The counter-argument — that a rollout mechanism in Settings is a promise to keep both paths forever — is answered by the exit plan: the switch is removed when the flag graduates to default-on and the textarea path is deleted, which is the "no tolerated legacy patterns" ending this repo asks for. Write that exit plan into the comment so the removal is someone's obvious next move rather than a discovery.

**The exit path must actually work**, and it is testable: switch off and the box is a textarea again on the next render, with nothing lost — a draft is markdown text either way, so a half-written formatted message reappears as its markdown source. Assert that: render with the flag on, type formatted text, flip the flag off, and the textarea's value is the same markdown string.

Dev playground: per the `maintaining-dev-playground` skill, add the flag-on variant to the existing `composer-input` showcase (`apps/client/src/dev/showcases/InputShowcases.tsx`; registered in `apps/client/src/dev/sections/chat-sections.ts` at line 252 with `id: 'composer-input'`). Keep the `id` stable so deep links survive, and add `rich text`, `markdown`, `lexical`, `formatting` to that entry's `keywords` array.

Tests — `apps/client/src/layers/features/settings/__tests__/`: the row renders with the exact label and description above; toggling calls the mutation with `true`; the row reflects the stored value.

Acceptance: `pnpm vitest run apps/client/src/layers/features/settings/__tests__/` green; the playground showcase renders at `/dev` under Chat → Input.

### Task 4.4: Turn it on for chat only, by composition, and leave the other three surfaces alone

- **Size:** small · **Priority:** high
- **Depends on:** 4.2, 4.3 · **Parallel with:** —

Which surface has rich text is visible in the JSX, not in a table that can disagree with it — that is `features/composer`'s own doctrine (its barrel's module TSDoc states composition IS the capability declaration).

**Chat, and only chat**, at ship time (locked 2026-08-07): `apps/client/src/layers/features/chat/ui/input/ChatInputContainer.tsx` reads the preference and passes `richText` to `<Composer.Input>`. Its existing props are untouched — including `onCursorChange={autocomplete.handleCursorChange}` (line 360), which is the whole reason Decision 1 preserved the units.

**Pass nothing** from: `apps/client/src/layers/widgets/room-view/ui/RoomComposer.tsx`, `apps/client/src/layers/widgets/dashboard/ui/DashboardComposerSection.tsx`, `apps/client/src/layers/features/onboarding/ui/OnboardingConversation.tsx`. Not `richText={false}` — nothing. An explicit `false` reads as a decision that was made about that surface, when the truth is the surface has not graduated yet.

**DOR-947 COLLISION on `RoomComposer.tsx`.** `origin/room-attachments` rewrites this file (+114 lines): it adds `useRoomAttachments(room.id)`, passes `onFilesDropped={attachments.addFiles}` to `Composer.Root`, renders `Composer.Attachments` above the input, and threads `attachmentIds`/`attachmentNames` through `deliver`. Write this task against the 947 shape. The good news, and the file's own comment says it: "`Composer.Input`, which holds no attachment state at all, so DOR-948's swap of that component's internals for Lexical stays a swap." The only edit this task makes to that file is: none. Confirm it needs none rather than assuming it.

Rooms, the dashboard, and onboarding graduate in a FOLLOW-UP work item, gated on every one of these holding — capture that item when this one closes:

1. The whole ladder scenario table passes against the Lexical surface (task 3.8).
2. Round-trip stability holds over the corpus, including every mention shape (task 2.5).
3. Typing latency at p95 is within budget on a 4 000-character document (task 5.3).
4. An IME (Japanese, and one of Korean/Chinese) composes and commits a candidate with no send and no dropped characters, verified in a real browser.
5. VoiceOver or NVDA announces the field, its name, and the open palette's active row equivalently to the textarea, verified by a person.
6. The measured gzipped chunk is recorded and accepted (task 3.6).

Tests: `ChatInputContainer.test.tsx` asserts the container passes `richText` from the pref; a test per other surface asserts the prop is absent from the props the mocked `Composer.Input` received.

Acceptance: `pnpm vitest run apps/client/src/layers/features/chat/__tests__/ChatInputContainer.test.tsx` green; `cd apps/client && pnpm vitest run src/layers/widgets/room-view/__tests__/RoomComposer.test.tsx` green (false-red gotcha applies); `grep -rn "richText" apps/client/src/layers/widgets apps/client/src/layers/features/onboarding` returns nothing.

### Task 4.5: Phase 4 gate — flag-off is still byte-identical, and both states work in a real browser

- **Size:** small · **Priority:** high
- **Depends on:** 4.4 · **Parallel with:** —

The phase-4 verification gate. The flag now exists, so for the first time the two paths are both reachable by a person and both must be checked.

Automated:

1. `pnpm --filter @dorkos/client typecheck` and `lint`; `pnpm --filter @dorkos/server typecheck` and `lint`
2. All ten flag-off DOM baselines still diff empty (beyond DOR-947's reviewed `data-composer-card` attribute), UN-RE-RECORDED. `git diff --stat origin/main -- 'apps/client/src/**/__baselines__/*.json'` must show only the flag-on files task 3.7 ADDED, and zero modifications to the original ten. This is the strongest available proof that the fallback path did not move, and re-recording one destroys it.
3. `pnpm test -- --run` for the whole repo
4. The config drift guards: `pnpm vitest run apps/server/src/services/core/safe-defaults/__tests__/` and `apps/server/src/services/core/operator/__tests__/`

**Real browser, both states.** Per the `browser-testing` skill, boot the cockpit and check by hand what jsdom cannot answer:

- flag OFF: chat composer is a textarea; type, send, Shift+Enter, Escape-Escape, `/` palette, paperclip, drag a file in, paste a file — all as today
- flag ON: type `**important**` and watch the asterisks disappear as the closing pair lands; `⌘B` on a selection; `- ` becomes a bullet and Enter makes the next one; Enter on an empty bullet ends the list; `# ` becomes a heading; `` `npm run dev` `` becomes inline code; type `> ` and ` ``` ` and confirm NOTHING visible happens and the characters stay
- flag ON, the things that must not have moved: Shift+Enter is a newline; `foo\` + Enter is a newline; Escape stops a turn; Escape-Escape clears with the same 500 ms window and the same hint, and `⌘Z` brings the draft back; `/` opens the command palette; `@` opens the file palette; ArrowUp walks into the queue; the paperclip, drag-and-drop, and paste-a-file behave as DOR-947 left them
- flip the switch off with a formatted draft in the box and confirm the markdown source reappears in the textarea, unchanged

**What must never happen, stated so it can be checked:** a keystroke that used to send does not stop sending; a keystroke that used to insert a newline does not start sending; a palette that used to open does not stop opening; and text a person typed is never silently rewritten by the serializer.

Attach a screenshot or short capture of the flag-on composer showing bold, a heading, and a two-item list to the work item.

Acceptance: every command green, the baseline `git diff --stat` showing additions only, and the browser checklist walked with its result recorded.

## Phase 5 — Close the loop

### Task 5.1: Replace the eleven textarea-only e2e assertions with probes that work on both fields

- **Size:** medium · **Priority:** high
- **Depends on:** 4.5 · **Parallel with:** 5.2

`apps/e2e` runs unmodified with the flag OFF — that is the fallback gate and it must stay true. With the flag ON, some assertions read the field as an `HTMLTextAreaElement`, and a contenteditable is not one. Fix them so ONE spec works on both fields; do not fork the specs.

**The four `selectionStart` sites the spec names, verified in this worktree** — `apps/e2e/tests/rooms/mention-picker.spec.ts` lines **182, 222, 232, 241**, each of the form:

```ts
expect(await composer.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(…)
```

A contenteditable has no `selectionStart`. Replace with a caret probe helper (put it beside the page objects, e.g. `apps/e2e/pages/composer-probe.ts`) that answers the same question on either field: for a textarea, `el.selectionStart`; for a contenteditable, the caret's offset into the element's text computed from `window.getSelection()` and a `Range` from the element start to the caret. Same number, same meaning, one call site shape.

**SEVEN MORE the spec's "exhaustive" list missed, and they break the same way.** Playwright's `toHaveValue` requires an `<input>`, `<textarea>`, or `<select>` and throws on anything else, so every one of these fails flag-on:

| File                                             | Lines                        |
| ------------------------------------------------ | ---------------------------- |
| `apps/e2e/tests/rooms/mention-picker.spec.ts`    | 130, 177, 187, 231, 240, 273 |
| `apps/e2e/tests/rooms/room-conversation.spec.ts` | 85                           |

Give the probe a `valueOf(locator)` companion — `el.value` for a textarea, `el.textContent`/`innerText` for a contenteditable — and replace `await expect(composer).toHaveValue(x)` with an `expect.poll` over it so the retry semantics survive. Eleven sites total, not four; record the corrected count.

**What keeps working unchanged, and is a hard constraint on task 3.1 rather than a hope:**

- `apps/e2e/pages/RoomsPage.ts` line 299 `getByRole('combobox', { name: 'Message ${spokenName}…' })` and line 483 `getByRole('combobox', { name: 'Reply in this thread…' })`
- `apps/e2e/pages/ChatPage.ts` line 20 `getByRole('combobox', { name: /^(message |send a message)/i })`
- `.fill()` and `.pressSequentially()` both work on a contenteditable, so no page-object change is needed for typing

**DOR-947 COLLISION on `apps/e2e/pages/RoomsPage.ts`:** the 947 branch adds ~110 lines of attachment helpers to this file and adds `apps/e2e/tests/rooms/room-attachments.spec.ts`. Rebase onto that shape before editing; the two composer locators above are untouched by 947, but the file's line numbers move.

Acceptance: `grep -rn "HTMLTextAreaElement" apps/e2e/tests` returns nothing; `grep -rn "toHaveValue" apps/e2e/tests/rooms` returns nothing; the rooms specs pass flag-off unchanged in behaviour.

### Task 5.2: Add the flag-on chat e2e spec and register it in the manifest

- **Size:** medium · **Priority:** high
- **Depends on:** 4.5 · **Parallel with:** 5.1

Add `apps/e2e/tests/chat/composer-rich-text.spec.ts`, a mock-mode spec for the flag-on chat path.

Turn the flag on for the spec by PATCHing `/api/config` with `{ ui: { composer: { richText: true } } }` through Playwright's API request context — the pattern `apps/e2e/global-setup.ts` already uses (`context.get('/api/config')` at line 49, `context.patch('/api/config', …)` at line 60). Restore the previous value in teardown, so a spec that fails does not leave every later spec running against a different composer.

The scenario the spec locks: type `- a`, Enter, `b`, Enter, Enter, then a sentence and Enter. Assert two list items, a paragraph, and **exactly one message sent**. The "exactly one" is the assertion that matters — it is what proves Enter did not send from inside the list, which is the entirety of locked decision 2 and the one rung with no textarea equivalent to fall back on.

Add at least these alongside it, each one a rung a person would notice:

- `**bold**` renders as a `<strong>` inside the field and the SENT message body is the markdown string `**bold**` — the wire format did not change
- ` ```  ` typed at the start of a line leaves the three backticks as literal characters in the field (the exclusion set stays literal)
- Shift+Enter inserts a line break and sends nothing
- `/` opens the command palette over the contenteditable and Enter picks a row

Use the caret/value probe from task 5.1 rather than `toHaveValue`.

**Register it in `apps/e2e/manifest.json`.** That file is `version: 1` with a `tests` map keyed by test id; each entry carries `specFile`, `feature`, `description`, `relatedCode`, and the run counters. Add an entry keyed `composer-rich-text` with `specFile: "tests/chat/composer-rich-text.spec.ts"`, `feature: "chat"`, a one-line description, and `relatedCode` naming `apps/client/src/layers/features/composer/ui/field/LexicalField.tsx` and `.../ui/ComposerInput.tsx`. DOR-947 rewrites 114 lines of this manifest (it registers `room-attachments`), so rebase onto its shape before adding — a hand-merged manifest is how two specs end up sharing one id.

**Every existing spec runs unmodified with the flag off.** Run the full suite flag-off and confirm; a spec that needs editing means behaviour moved, not that the spec is stale.

Acceptance: the new spec passes against a mock-mode server; the full `apps/e2e` suite passes flag-off; `apps/e2e/manifest.json` parses and contains exactly one `composer-rich-text` entry.

### Task 5.3: Measure typing latency and the shipped chunk, and record both as numbers

- **Size:** medium · **Priority:** medium
- **Depends on:** 5.2 · **Parallel with:** 5.4

The graduation criteria depend on two measured numbers, and the spec is explicit that an estimate is not accepted as a result. Produce both with a repeatable script and write them into `specs/composer-rich-text/04-implementation.md`.

**Latency.** The composer is the most latency-sensitive surface in the product — a person feels 16 ms here that they would not feel anywhere else. Budget: median keystroke-to-paint no worse than the textarea path, and **p95 under 16 ms on a 4 000-character document containing 20 mentions**. Measure both paths on the same machine in the same session so the comparison means something:

- build the 4 000-character / 20-mention fixture once and commit it beside the script, so the number is reproducible next quarter
- drive real key events (not `fill`) and sample with `performance.measure` around the update-listener-to-paint window
- report median, p95, and sample count for BOTH the textarea path and the Lexical path

If p95 misses the budget, the selection-only fast path from task 3.2 is the first suspect: confirm `dirtyElements.size === 0 && dirtyLeaves.size === 0` actually skips serialization on arrow-key movement before optimizing anything else.

**Bundle.** Re-run `pnpm --filter @dorkos/client build` and record: the entry chunk's gzipped size (must equal the pre-Lexical number from task 2.1 — the zero-Lexical-bytes-flag-off proof), and the Lexical chunk's gzipped size. The ideation records ~54 kB for the core; that figure is an expectation, and this task replaces it with a measurement. Whatever the number is, record it as measured and state whether it is accepted — a chunk twice the estimate is a decision to make, not a number to bury.

Write the numbers into `04-implementation.md` under a "Measured" heading with the date, the machine, and the command used. A number with no provenance cannot be re-checked when it drifts.

Acceptance: `specs/composer-rich-text/04-implementation.md` exists and carries both measurements with their commands; the entry-chunk number matches task 2.1's.

### Task 5.4: Write the docs and the changelog fragment, saying only what actually ships

- **Size:** medium · **Priority:** medium
- **Depends on:** 5.2 · **Parallel with:** 5.3

Everything a reader outside this branch will meet.

**Internal guides:**

- `contributing/keyboard-shortcuts.md` — the Enter table gains its two list rows and the flag-on/flag-off distinction. This file already names `Composer.Input` (DOR-946 task 3.3), so extend rather than duplicate. Say plainly what Enter does in each of the four states: not in a list, in a non-empty list item, in an empty list item, and with a palette open.
- `contributing/project-structure.md` — the `apps/client/src/layers/features/composer/ui/field/` directory and what each of its modules owns.
- `contributing/configuration.md` — the new `ui.composer.richText` field, per the `adding-config-fields` skill: what it does, its default, its three classifications, and the migration key.

**User-facing docs** (`docs/`, Fumadocs). A short section on formatting as you type, in the plain-words register the `writing-for-humans` skill requires. `docs/guides/keyboard-shortcuts.mdx` already exists and is the natural home for the Enter behaviour; the switch itself and what it does belong wherever settings are described. It must state three things and no more: what the setting is, where the switch is (Settings → Advanced → "Format text as you type"), and that syntax the box does not preview — quotes, code blocks, links, strikethrough, tables — **still works and still renders in the sent message**. That last one is the sentence that stops a support question.

**Nothing may claim more than ships.** The flag defaults OFF and only chat reads it. So: no "DorkOS now has a rich text composer", no "rich text everywhere", no claim about rooms or the dashboard, and nothing about the Obsidian plugin or the Windows alpha. Rooms/dashboard/onboarding are a gated follow-up.

**One changelog fragment** in `changelog/unreleased/`, named `<id>-composer-rich-text.md` with an id from `.claude/scripts/id.ts`. Written LAST, user-facing, `writing-for-humans` bar — plain enough for a smart 9th grader who does not code. Because the flag ships off, the fragment must say it is **a setting you can turn on**, not a thing that happened to your composer. Say what a person sees when they turn it on: `**bold**` becomes bold as you type, `- ` starts a bullet list, `# ` makes a heading, and Enter still sends. Never edit `CHANGELOG.md` directly.

**TSDoc, as a deliverable rather than a side effect** — each of these carries an argument a reviewer needs, and the spec names them: `editing-surface.ts` carries why a port and why these seven methods; `markdown-offsets.ts` carries the round-trip fixed-point invariant; `use-lexical-value.ts` carries the latch and why dropping it breaks typing.

Acceptance: `pnpm --filter @dorkos/site build` green if the docs change touches MDX; the changelog fragment passes the `fragment-present` and fragment-validity checks; a read-through confirms no sentence claims a surface that does not ship.

### Task 5.5: Final gate — full repo, e2e, dead-path sweep, and adversarial review before the PR

- **Size:** medium · **Priority:** high
- **Depends on:** 5.3, 5.4 · **Parallel with:** —

The closing gate for the whole spec. Run in this order, and record each result rather than the fact that it was run.

1. `pnpm --filter @dorkos/client typecheck` · `pnpm --filter @dorkos/client lint`
2. `pnpm --filter @dorkos/server typecheck` · `pnpm --filter @dorkos/server lint`
3. `pnpm --filter @dorkos/shared build` first if any import resolves stale — a stale `@dorkos/shared` dist causes false-red type errors, and the config field touched that package
4. `pnpm test -- --run` for the whole monorepo. NEVER a bare `pnpm vitest run` for a full run
5. `cd apps/client && pnpm vitest run src/layers/widgets/room-view/__tests__/` separately — the RoomComposer false-red gotcha means a root-level red there is not evidence
6. `pnpm knip` after building dists — no orphaned export from `field/`, no unused Lexical package
7. `pnpm verify`
8. `apps/e2e` full suite flag-off (unmodified specs), then the flag-on spec from task 5.2

Dead-path sweep, all of which must return nothing:

- `grep -rn "from 'lexical'\|from '@lexical" apps/client/src --include=*.ts --include=*.tsx | grep -v "features/composer/ui/field/"` — every Lexical import is confined to the field directory
- `grep -rn "textareaRef" apps/client/src/layers/features/composer/ui/use-input-keyboard.ts` — the ladder no longer knows what a textarea is
- `grep -rn "HTMLTextAreaElement\|toHaveValue" apps/e2e/tests/rooms` — the dual-field probes replaced them
- `grep -rn "lexical" apps/client/src/layers/features/composer/index.ts` — the barrel names nothing from the editor
- no `TODO`, no commented-out old field, no `richText={false}` on any surface

Baseline integrity: `git diff --stat origin/main -- 'apps/client/src/**/__baselines__/*.json'` shows ONLY added flag-on files. Zero of the original ten modified. If one shows as modified, find out why before doing anything else — a re-recorded baseline is the single easiest way to make this whole spec's central proof meaningless.

**Before any PR opens, put the branch through an independent adversarial review against `REVIEW.md`.** Point the reviewer at the four claims most likely to be wrong, because a reviewer told what to doubt finds more than one told to look around: (a) the flag-off path is byte-identical — check the baselines were not re-recorded; (b) one scenario table really runs against two adapters and is not sharing a mock between them; (c) the emitted-value latch is present and its test fails without it; (d) the paste and drop handlers decline files and file-tree paths so DOR-947 attach and DOR-1032 path drops still work. Also ask the reviewer to check the ORCHESTRATOR's claims, not only the code — the drift notes in these tasks (ten baselines not eleven, no `use-input-keyboard.test.ts`, seven ladder methods not five, eleven e2e sites not four) are exactly the class of thing a brief gets wrong.

Acceptance: every command green, every grep empty, the baseline diff showing additions only, and the adversarial review complete with its findings addressed before the PR opens.
