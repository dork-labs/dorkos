---
slug: composer-rich-text
number: 260806-215029
created: 2026-08-08
status: specified
---

# Rich text via markdown in the composer (Lexical)

**Status:** Draft
**Author:** flow agent (SPECIFY stage, DOR-948)
**Date:** 2026-08-08
**Design record:** [design-decisions.md](./design-decisions.md) (locked 2026-08-06 with Dorian) · programme answers locked 2026-08-07 at the `composer-parity` spec review

## Overview

Replace the internals of `Composer.Input` — today a controlled `<textarea>` — with a Lexical
WYSIWYG editor, behind a feature flag, without changing what the component looks like to the
surfaces that render it. The person sees `**bold**` become **bold** as they type, `- ` become a
bullet, `# ` become a heading, and an `@mention` they pick from the roster become the same
identity pill the sent message shows. What leaves the component is unchanged: a **markdown
string** and a **caret offset into that string**. Nothing on the server, the wire, or the message
renderer changes.

DOR-946 made this a one-place swap (`Composer.Input` is the single text field on chat, rooms, the
dashboard hero, and onboarding). DOR-947 wired attachments around it without touching it. This
spec swaps its inside.

## Background / Problem Statement

The composer is where every DorkOS interaction starts, and it is the only surface in the product
where markdown is a language you must know rather than a thing you can see. You type `**bold**`
and stare at asterisks until you press Enter. You type `- one`, press Enter, and get a bare
newline — the list you started does not continue. You type `@ana`, and the picker resolves a
person, but the box shows six grey characters where the message will show a coloured pill. Every
one of those is a place where the composer knows something it refuses to show you.

Three things make this the right moment and not before:

1. **There is exactly one text field left.** Before DOR-946 (landed `20260807`, ADR
   `260807-173219`) this swap was four swaps: `ChatInput` for chat and the dashboard,
   a hand-rolled variant for rooms, another for onboarding. It is now `Composer.Input`, rendered
   by five call sites, with one prop surface and one keyboard ladder.
2. **The keyboard ladder is written down and pinned.** `use-input-keyboard.ts` (406 lines) is the
   most carefully argued file in the client — Escape priority, the 500 ms double-Escape arm and its
   context key, palette fall-through on a zero-result panel, backslash line continuation, the
   `isUploading` trigger latch, IME guards, queue navigation. Its tests are the regression net the
   spec leans on, and they only work as a net if the ladder's decisions stay in one place.
3. **The wire format is already markdown.** Messages are stored, posted, and rendered as markdown
   (`streamdown` on the read side, `mentionSpans` resolved server-side at write time). A WYSIWYG
   editor that serializes to markdown adds a view, not a format.

Verified against the worktree base `4df274842` (2026-08-08). `Composer.Input` is untouched by the
DOR-947 branch (`origin/room-attachments`), which changes only `ComposerRoot` (a
`data-composer-card` attribute) and `RoomComposer` (attach wiring) — its own source says so:
"`Composer.Input`, which holds no attachment state at all, so DOR-948's swap of that component's
internals for Lexical stays a swap."

## Goals

- Live markdown formatting as you type, with **no toolbar and no chrome** (design decision 1).
- `@mentions` render as the real `MentionPill`, atomic on delete (design decision 2).
- **The host contract does not move.** `value`, `onChange(string)`, `onCursorChange(number)`,
  `focusAt(number)`, `ComposerInputHandle` — same names, same meanings, same units.
  `use-input-autocomplete` (chat's `/` and `@file` palettes) and `use-mention-autocomplete`
  (rooms' `@` picker) are **not modified by this spec**.
- The whole keyboard ladder survives observably unchanged, proven by running the **same scenario
  table** against both the textarea and the Lexical editing surface.
- The flag-off path stays **byte-identical** — proven by the committed DOM-parity baselines
  diffing empty, and by shipping **zero Lexical bytes** to a flag-off install.
- Nothing regresses DOR-946's DOM-parity proofs or DOR-947's attach flow.

## Non-Goals

- **Collaborative editing.** No Yjs, no `@lexical/yjs`, no awareness.
- **Persisting editor state.** Nothing but markdown text ever leaves the component or reaches the
  server. `EditorState` is never serialized to storage.
- **Rich text in rendered messages.** Already markdown via `streamdown`; untouched.
- **Changing the wire format.** `POST /api/sessions/:id/messages`, `usePostToRoom`,
  `useReplyInThread`, and the `first-message` seam all keep taking a string.
- **Becoming the mention resolver.** The editor decorates handles the host already told it about;
  `apps/server/src/services/rooms/mentions.ts` and the span doctrine stay untouchable
  (`.claude/rules/room-conduct.md`).
- **Merging or moving the palettes.** Chat's command/file palettes and rooms' mention picker keep
  their current owners, DOM, and keyboard contract.
- **A toolbar, a formatting menu, or a markdown-source toggle.** Design decision 1 is a wall.
- **Rich text on rooms, the dashboard, or onboarding at ship time.** Chat gets the flag first
  (locked 2026-08-07); the other surfaces graduate in a follow-up.

## Technical Dependencies

New, all first-party Lexical packages (Meta, MIT), pinned to one minor line:

| Package              | Why                                                                             |
| -------------------- | ------------------------------------------------------------------------------- |
| `lexical`            | Core editor: `EditorState`, nodes, commands, selection, history                 |
| `@lexical/react`     | `LexicalComposer`, `RichTextPlugin`, `ContentEditable`, `HistoryPlugin`, hooks  |
| `@lexical/markdown`  | `$convertToMarkdownString` / `$convertFromMarkdownString`, transformer registry |
| `@lexical/rich-text` | `HeadingNode` (the `#` transformers need it registered)                         |
| `@lexical/list`      | `ListNode` / `ListItemNode`, `ListPlugin`, `$handleListInsertParagraph`         |
| `@lexical/utils`     | `mergeRegister`, node traversal helpers used by the offset map                  |

**Not taken:** `@lexical/react/LexicalTypeaheadMenuPlugin` (see Open Question 1),
`@lexical/link`, `@lexical/code`, `@lexical/table`, `@lexical/yjs`. Tiptap remains the named
fallback if Lexical proves wrong in practice (locked 2026-08-03); the kill-switch criteria below
are what "proves wrong" means.

**Bundle:** the ideation records ~54 kB for the core. That figure is an expectation, not a
measurement, and this spec does not accept it on faith — see Performance Considerations. Every
Lexical package is behind a dynamic `import()`, so the flag-off bundle is unchanged and the
measurement is of a separate chunk.

## Detailed Design

### The shape of the change

`ComposerInput.tsx` keeps its entire prop surface, its `forwardRef` handle, its wrapper markup
(the busy line, the `canSubmitReason` live region, the editing-queue line, the card row, the
paperclip, the clear X, the `InputActionButton`). Only **the field itself** — the `<textarea>`
inside `<div className="relative min-h-[24px] flex-1">` — is swapped, and only when the flag says
so.

```
features/composer/
├── ui/
│   ├── ComposerInput.tsx          # unchanged props/handle; picks a field
│   ├── field/
│   │   ├── TextareaField.tsx      # today's <textarea>, extracted verbatim
│   │   ├── LexicalField.tsx       # the new field (lazy chunk root)
│   │   ├── ComposerFieldProps.ts  # the one interface both fields satisfy
│   │   ├── lexical-nodes.ts       # MentionNode + the registered node list
│   │   ├── lexical-transformers.ts# the closed markdown transformer set
│   │   ├── markdown-offsets.ts    # markdown string <-> Lexical selection map
│   │   ├── lexical-surface.ts     # EditingSurface adapter for Lexical
│   │   └── use-lexical-value.ts   # the controlled-value latch
│   ├── textarea-surface.ts        # EditingSurface adapter for the textarea
│   ├── editing-surface.ts         # the EditingSurface port
│   ├── use-input-keyboard.ts      # the ladder, now surface-agnostic
│   └── use-textarea-resize.ts     # unchanged; textarea path only
```

`ComposerInput` renders one of two fields:

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

The Suspense fallback is the textarea, not a spinner: a composer that is briefly un-typeable is
worse than a composer that is briefly plain, and the two share `value`/`onChange` so nothing is
lost when the chunk arrives.

### Decision 1 — the host contract is markdown text plus a markdown offset

**This is the load-bearing decision of the whole spec.** Every host of `Composer.Input` drives its
palettes off two things and nothing else:

- `onChange(value: string)` — the text
- `onCursorChange(pos: number)` — an index into that text

`use-input-autocomplete` (chat) runs `detectFileTrigger(value, cursor)` / `detectCommandTrigger`;
`use-mention-autocomplete` (rooms) runs `MENTION_TRIGGER` against `text.slice(0, cursorPos)` and
writes back through `insertMention(text, triggerPos, query, handle)`, which slices by the same
offsets and returns a new `{ value, cursorPos }` the host feeds back in. `RoomComposer` then calls
`focusAt(cursorPos)`.

So the Lexical field must, on every change:

1. Serialize the document to a markdown string and hand it to `onChange`.
2. Compute the caret's offset **into that same string** and hand it to `onCursorChange`.
3. Accept an externally-set `value` (a queue item opened for edit, a restored draft, a `?prompt=`
   seed, a mention insert) by parsing it back into the document.
4. Map a markdown offset back to a Lexical selection for `focusAt(pos)`.

Every one of the four goes through **one module**, `markdown-offsets.ts`, which serializes and
builds the position map in a single walk:

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

The map is required because serialization is not identity: `**bold**` adds four characters that
belong to no text node, and a mention node contributes `@handle` from a node whose own text is
`@handle` but whose DOM is a pill. Deriving the caret from `textContent` alone would put the
`@`-trigger regex a few characters off exactly when a person is mid-formatting.

**Round-trip stability is a hard requirement, not a hope.** For every value a host can write back,
`parse(md) → serialize()` must equal `md` exactly. If it does not, the controlled loop oscillates:
the host writes `V`, the editor emits `V'`, the host writes `V'`, and the caret is destroyed on
every keystroke. A property test over a corpus (below) is the gate.

**The controlled-value latch.** `use-lexical-value.ts` re-hydrates the document from the `value`
prop **only when `value` differs from the last string this field emitted**. Without the latch,
every keystroke round-trips its own output through the parser, which resets selection, empties the
undo stack, and makes the editor feel broken. This is the single most common way a controlled
Lexical integration fails, and it is specified here so it cannot be discovered in review.

```ts
// Emitted-value latch, in words: we own the document while the person types; the
// host owns it when the host changes the text out from under us.
if (value !== lastEmittedRef.current) hydrate(value);
```

Consequence: chat and rooms **need no changes at all** for their palettes to keep working, and
their palette DOM is unchanged, which is what lets the DOM-parity harness stay meaningful.

### Decision 2 — the keyboard ladder becomes surface-agnostic (THE hard seam)

Two problems have to be solved together.

**Problem A: who sees the key first.** React 19 attaches synthetic listeners at the root
container. Lexical registers native listeners on the contenteditable element itself. So a native
Lexical handler runs in the target phase, before React's delegated `onKeyDown` fires at the root.
Left alone, Lexical would insert a paragraph on Enter before `use-input-keyboard` ever ran, and the
message would never send.

**Problem B: the ladder reaches into the textarea.** Five places in `use-input-keyboard.ts` touch
`textareaRef.current` directly: `isEscapedNewline` (text before a collapsed caret),
`consumeEscapeIntoNewline`, `insertTextAtCaret` (Alt+Enter), `clearThroughUndoStack` (the
double-Escape wipe, which must land as ONE undo entry), and the ArrowUp/ArrowDown
caret-at-start/caret-at-end checks.

**The seam:** an `EditingSurface` port, with two adapters.

```ts
/**
 * The five things the keyboard ladder needs from whatever it is editing.
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

`textarea-surface.ts` is today's code, moved behind the interface, character for character —
including `document.execCommand('insertText', …)`, which stays for the reason its existing TSDoc
gives (it is the only edit that pushes a real undo entry and fires a native `input` event).

`lexical-surface.ts` is the new one. Its methods run inside `editor.update()` and use
`$getSelection` / `$isRangeSelection`; `clearThroughUndoStack` is a single `editor.update()` that
selects the root and removes it, which the `HistoryPlugin` records as one entry. `isComposing()`
returns `editor.isComposing()`.

`useInputKeyboard` takes `surface: EditingSurface` in place of `textareaRef`. **Its decision logic
does not change** — the diff is mechanical substitution — which is what keeps its existing test
file the regression net.

**Wiring the ladder into Lexical.** The Lexical field registers the ladder at
`COMMAND_PRIORITY_CRITICAL`, the highest priority, so it is consulted before Lexical's own
rich-text handlers:

| Lexical command          | What the ladder does                                                     |
| ------------------------ | ------------------------------------------------------------------------ |
| `KEY_ESCAPE_COMMAND`     | Runs the whole Escape ladder. Returns `true` on every rung that acts.    |
| `KEY_ENTER_COMMAND`      | Runs the Enter ladder. See the fall-through table below.                 |
| `KEY_ARROW_UP_COMMAND`   | Queue navigation when the queue has items and the caret is at the start. |
| `KEY_ARROW_DOWN_COMMAND` | Queue navigation when editing a queue item and the caret is at the end.  |
| `KEY_TAB_COMMAND`        | Palette pick when a palette is open with results.                        |

The registration returns Lexical's `true`/`false` — `true` means "consumed, stop", `false` means
"I did not act, carry on". **The `false` return is the whole of decision 2 in the locked set:** it
is how Enter continues a list.

`preventDefault` semantics survive exactly. The existing ladder marks a consumed Escape with
`preventDefault()` and deliberately does **not** `stopPropagation` — an enclosing thread panel
reads `defaultPrevented` to decide whether the key was already spoken for. Lexical hands the
original `KeyboardEvent` to the command handler, so the ladder calls `preventDefault()` on the same
event object it does today, and the bubbling behaviour is unchanged.

**The Enter table, flag-on** (top to bottom; first match wins):

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

The two bold rows are the entirety of locked decision 2. They sit **below** the palette rung on
purpose: a `/` palette open inside a list item is still a palette, and Enter still picks the row.
They sit **above** the send rungs, which is what "Enter never sends from inside a list" means.
Sending a message that ends in a list is done by pressing Enter on the empty item (which exits the
list) and then Enter again, or by the Send button — the same two ways every chat app with lists
works.

Flag-off, the table is today's exactly, and the two list rows are unreachable because no list node
exists.

### Decision 3 — supported nodes, and what happens to everything else

The editor recognizes a **closed** transformer set:

| Syntax                  | Node                             |
| ----------------------- | -------------------------------- |
| `**bold**` · `__bold__` | text format `bold` (also `⌘B`)   |
| `*italic*` · `_italic_` | text format `italic` (also `⌘I`) |
| `` `code` ``            | text format `code`               |
| `# ` `## ` `### `       | `HeadingNode` h1–h3              |
| `- ` `* ` `+ `          | `ListNode` unordered             |
| `1. `                   | `ListNode` ordered               |
| `@handle`               | `MentionNode` (see Decision 4)   |

**Deliberately not recognized:** links (`[x](y)`), blockquotes (`> `), fenced code blocks
(` ``` `), strikethrough (`~~x~~`), horizontal rules, tables, images.

**Excluding a node from the editor does not remove the capability from the message.** This is the
point, and it is why the exclusion list is safe: unrecognized syntax stays as literal characters
in the editor, rides the wire as the markdown it already is, and renders exactly as it does today
in the message. Someone who types a fenced code block gets a fenced code block in the sent
message; they just do not watch it become one while typing. Fenced code in particular is excluded
because a code block that swallows Enter would be a _third_ Enter meaning, and the locked decision
authorized exactly one exception ("Enter continues a list").

`⌘B` / `⌘I` are the only keyboard combos (design decision 1: "keyboard combos"). No `⌘K`, because
there are no links.

### Decision 4 — mentions are token-mode text nodes, decorated from a host-supplied roster

`MentionNode extends TextNode`, with `isToken()` returning `true`. Token mode is what makes it
atomic: backspace deletes the whole pill, the caret never lands inside it, and typing against it
does not extend it. Its text **is** `@handle`, so it serializes through the ordinary text path
with no transformer — which is why round-trip stability holds for a document containing mentions.

Its `createDOM` emits the same `<span>` `MentionPill` emits: the `mentionPillVariants` class
string and the inline `--identity-color` custom property. The pill is imported from
`@/layers/shared/ui`, so a change to how a mention looks in a message changes how it looks in the
composer, once.

A `MentionNode` comes into existence two ways, and both need the host to have said who the handle
belongs to:

1. **The picker inserted it.** `RoomComposer` writes back a new `value` containing `@handle`.
2. **The person typed it, or a draft was restored.** A node transform scans plain text for
   `/(^|\s)@([A-Za-z0-9_.-]+)/` — the same shape as `MENTION_TRIGGER` — and promotes a match to a
   `MentionNode` when the handle is in the roster.

Both paths go through the same transform, so a hand-typed `@ana` and a picked `@ana` are the same
node and look the same. That convergence is the reason to do it this way: the server resolves both
identically at write time, so showing them differently in the box would be a lie about what is
about to happen.

The roster arrives as **one additive optional prop**:

```ts
/**
 * Handles this composer may draw as identity pills, and the colours to draw
 * them in. Purely presentational: the SERVER still resolves who a mention
 * addresses at write time. A handle absent from this list stays plain text.
 * Omitted by surfaces with no roster (chat, dashboard, onboarding).
 */
mentionSubjects?: readonly { handle: string; identityColor: string | null; kind: 'human' | 'agent' }[];
```

Additive and optional, so every existing call site compiles untouched and the flag-off path never
reads it. Rooms pass it (derived from `room.members`, which `RoomComposer` already holds for
`useMentionAutocomplete`); nobody else does.

**The editor never becomes the resolver.** It draws what the host already knows. Nothing in
`apps/server/src/services/rooms/mentions.ts` changes; the span doctrine is untouched.

### Decision 5 — the feature flag

> **The default below was superseded by an owner decision on 2026-08-12: it is `true` for chat.**
> The graduation ladder at the end of this decision still governs which SURFACES pass `richText`
> (rooms and onboarding stay plain), and the Settings switch stays as the escape hatch. The
> decision and its reasoning are recorded in `04-implementation.md`. The rest of this section is
> left as written.

**Where it lives:** `UserConfigSchema.ui.composer.richText: z.boolean().default(false)` in
`packages/shared/src/config-schema.ts`.

Chosen over the alternatives because it is the repo's only durable, migration-guarded preference
mechanism, and because a kill-switch has to be reachable when the UI it gates is the thing that
broke — editing `~/.dork/config.json` and restarting is that reach. `localStorage` was rejected:
this codebase uses it for per-device view state (unread cursors, frecency, hint counters), never
for capability. The server's `createFeatureFlag` (`apps/server/src/lib/feature-flag.ts`) was
rejected: it reports whether a **subsystem** initialized, which is a different question and has no
user-settable side.

**The work the field requires** (Hard Rule: `.claude/rules/safe-defaults.md`, the
`adding-config-fields` skill):

- `default-verdicts.ts`: classify as **`no-risk`**. It sends nothing off the machine, grants no
  agent capability, and enforces no bound — a preference, in the same class as `ui.theme`.
- `config-disclosure.ts`: `expose`.
- `config-write-policy.ts`: `agent-writable` (matching `ui.theme`; nothing is at stake).
- No `PROTECTIVE_CARRYOVERS` rule — the default is not permissive, so a wipe cannot reverse a
  protection.
- A `conf` migration under a **new** key strictly greater than the newest shipped `v*` tag.

**How the client reads it:** exactly the `ui.statusBar.pins` pattern
(`entities/config/model/use-status-bar-prefs.ts`) — a new
`entities/config/model/use-composer-prefs.ts` selecting from the shared `useConfig()` query, and a
mutation that PATCHes `{ ui: { composer: { richText } } }` (the route deep-merges plain objects, so
no other `ui` key is touched).

**Which surfaces read it:** chat only, at ship time (locked 2026-08-07). `ChatInputContainer`
reads the pref and passes `richText`; `RoomComposer`, `DashboardComposerSection`, and
`OnboardingConversation` pass nothing. Surface enablement is composition, exactly as
`features/composer`'s own doctrine says — which surface has rich text is visible in the JSX, not in
a table that can disagree with it.

**The toggle:** Settings → Advanced, one switch, labelled in plain words ("Format text as you
type" / "See bold, headings, and lists take shape in the message box while you write").

**Graduation, and what "it earned its keep" means.** The flag ships `false`. It flips to `true` by
default, and rooms/dashboard/onboarding start passing `richText`, only when every one of these
holds — these are also the kill-switch criteria the ideation asked for:

1. The whole `use-input-keyboard` scenario table passes against the Lexical surface (§Testing).
2. Round-trip stability holds over the corpus, including every mention shape.
3. Typing latency at the 95th percentile is within budget on a 4 000-character document
   (§Performance).
4. An IME (Japanese, and one of Korean/Chinese) composes and commits a candidate with no send and
   no dropped characters, verified in a real browser.
5. VoiceOver or NVDA announces the field, its name, and the open palette's active row equivalently
   to the textarea, verified by a person.
6. The measured gzipped chunk is recorded and accepted.

### API / data model changes

One additive optional prop (`mentionSubjects`), one additive optional prop (`richText`), and one
config field. **No server, transport, route, wire, or database change of any kind.**

## User Experience

**With the flag off** — literally nothing changes anywhere, on any surface. The box is the same
textarea, with the same DOM.

**With the flag on, in session chat:**

- Type `**important**` and the asterisks disappear as the closing pair lands; the word is bold.
  `⌘B` on a selection does the same.
- Type `- ` at the start of a line and it becomes a bullet. Enter makes the next bullet. Enter on
  an empty bullet ends the list and puts you back in a paragraph. Enter anywhere else still sends.
- Type `# ` and the line becomes a heading.
- Type `` `npm run dev` `` and it becomes inline code.
- Type `> ` or ` ``` ` and nothing visible happens — the characters stay, and the sent message
  renders as the quote or code block it always did.
- Everything else is unchanged: Shift+Enter is a newline, `foo\` + Enter is a newline, Escape stops
  a turn, Escape-Escape clears the draft with the same 500 ms window and the same hint, `/` opens
  the command palette, `@` opens the file palette, ArrowUp walks into the queue, the paperclip and
  drag-and-drop and paste-a-file all behave as DOR-947 left them.
- Undo (`⌘Z`) walks back through formatting and text alike, including the Escape-Escape wipe.

**In rooms, once they graduate:** `@ana` picked from the picker becomes Ana's coloured pill in the
box, one backspace deletes the whole thing, and the message that arrives is the one that always
arrived.

**Exit path.** Settings → Advanced, switch off, and the box is a textarea again on the next render.
Nothing is lost: a draft is markdown text either way, so a half-written formatted message reappears
as its markdown source.

**What must never happen, stated so it can be tested:** a keystroke that used to send does not stop
sending; a keystroke that used to insert a newline does not start sending; a palette that used to
open does not stop opening; and text a person typed is never silently rewritten by the serializer.

## Testing Strategy

**The scenario table, run twice (the central proof).** `use-input-keyboard.test.ts` is today's
regression net. Its scenarios are lifted into a shared table and executed against **both**
adapters — `textareaSurface` over a real `<textarea>`, and `lexicalSurface` over a real headless
Lexical editor. A ladder rung that behaves differently on the two surfaces fails. This is the
discriminating bar for "the ladder survived", and it can fail: it was RED before the surface port
existed, because the textarea methods do not exist on a contenteditable.

**Round-trip property test.** `parse(md) → serialize()` equals `md`, over a committed corpus that
includes, at minimum: every supported syntax alone and nested; every _unsupported_ syntax
(blockquote, fenced code, link, strikethrough, table, horizontal rule) which must survive
untransformed; mentions at start, mid-sentence, adjacent to punctuation, and two in a row; a
trailing backslash; Windows line endings; an empty document; a document of only whitespace; text
containing literal `**` that is not a formatting pair.

**Offset-map unit tests.** For a table of (document, caret position) pairs, assert
`$markdownOffsetOfSelection` returns the index the mention/command regexes need, and that
`$selectMarkdownOffset` is its inverse. Specifically pinned: a caret immediately after a mention
pill, a caret between the two asterisks of an unclosed `**`, and a caret at the end of a list item.

**The controlled-value latch.** A test that types N characters and asserts the document was
hydrated **zero** times after mount. It fails loudly if the latch is dropped, which is the failure
mode that makes the editor feel broken while every other test stays green.

**DOM parity, both directions.**

- **Flag off:** all five `chat-input-container.*.json` baselines, all four
  `room-composer.*.json`, and `dashboard-composer-section.json` diff **empty**, unchanged and
  un-re-recorded. This is the strongest available proof that the fallback path did not move.
- **Flag on:** new baselines under the same harness, recorded deliberately with
  `DORKOS_RECORD_DOM_BASELINE=1` and reviewed as the rich-text reference. The intended deltas are
  enumerable and small: `<textarea>` → `<div contenteditable role="combobox" aria-multiline>`, the
  placeholder moving from a native attribute to an element, and (inside the field only) the nodes
  the document currently holds. Every `aria-*` attribute on the field must appear in **both**
  baselines with the same values — a diff there is a real a11y regression, not a swap.

**Palette integration, unchanged code under a changed field.** `use-input-autocomplete` and
`use-mention-autocomplete` are not edited, so their own tests are untouched. New tests drive the
Lexical field and assert the palettes still open, filter, and insert: `/comp` opens the command
palette with results; `@zzz` opens the zero-result panel and Enter falls through to send (the rung
DOR-946 pinned); `insertMention`'s returned `cursorPos` lands the caret past the separating space.

**Mention node tests.** Backspace at the right edge of a pill deletes the whole pill in one press;
the caret cannot be placed inside it; a hand-typed handle in the roster becomes a pill and one
absent from the roster stays plain text; `mentionSubjects` omitted means no pills anywhere.

**IME.** jsdom cannot produce a real composition, so the unit level asserts only that the guard is
consulted (`isComposing()` true ⇒ Enter is not handled, on both surfaces). The real proof is the
browser check in the graduation criteria.

**E2E.** Every existing spec runs unmodified with the flag off — that is the fallback gate. With
the flag on, `apps/e2e` needs the following, and this list is exhaustive because it was enumerated
against the current source:

- `RoomsPage.composer()` and `ChatPage.input` locate the field by
  `getByRole('combobox', { name })`. The contenteditable keeps `role="combobox"` and the same
  `aria-label`, so **both locators keep working unchanged**. This is a hard constraint on the
  implementation, not a hope.
- `.fill()` and `.pressSequentially()` both work on a contenteditable; no page-object change.
- **`apps/e2e/tests/rooms/mention-picker.spec.ts` has four assertions that read
  `el.selectionStart` off an `HTMLTextAreaElement`** (lines 182, 222, 232, 241). A contenteditable
  has no `selectionStart`. These need a caret probe that works on both fields; they are the only
  four e2e sites that touch the field's internals.
- A new mock-mode spec for the flag-on chat path: type `- a`, Enter, `b`, Enter, Enter, then a
  sentence and Enter — assert two list items, a paragraph, and exactly one message sent.

**Mutation checks required before any gate is called green** (`.claude/rules/testing.md`,
`verification-before-completion`): drop the `COMMAND_PRIORITY_CRITICAL` registration and the ladder
table must go red on both surfaces; remove the latch and the typing test must go red; remove one
transformer from the closed set and the round-trip corpus must go red.

## Performance Considerations

The composer is the most latency-sensitive surface in the product — a person feels 16 ms here that
they would not feel anywhere else.

- **Serialization runs on every document change**, inside `registerUpdateListener`. Selection-only
  updates (`dirtyElements.size === 0 && dirtyLeaves.size === 0`) skip serialization entirely and
  emit only `onCursorChange` — the trigger detectors need the caret, and the text has not moved.
- **Budget:** median keystroke-to-paint no worse than the textarea path, and p95 under 16 ms on a
  4 000-character document containing 20 mentions. Measured with a repeatable script and the number
  recorded in `04-implementation.md`; the graduation criteria depend on it.
- **Bundle:** the entire Lexical path is a dynamic `import()`. A flag-off install downloads and
  parses zero Lexical bytes, so the ideation's ~54 kB estimate is a cost only people who opted in
  pay. When the flag is on, the chunk is prefetched on idle so the first focus does not show the
  Suspense fallback. The real gzipped size is measured and recorded — the estimate is not accepted
  as a result.
- **Auto-resize:** the contenteditable grows naturally, so `use-textarea-resize` does not run on
  the Lexical path. The 200 px cap is reproduced in CSS (`max-h-[200px] overflow-y-auto`). The
  200 ms ease-down on empty is a textarea-only artifact of imperative height setting; it is not
  reproduced, and that is a recorded, intended delta in the flag-on baseline.
- No new timers, intervals, subscriptions, or context providers outside the editor's own.

## Security Considerations

- **No HTML is persisted, posted, or stored — ever.** Pasted rich text is converted to markdown at
  the paste boundary and the HTML is discarded. The value that leaves the component is a string,
  the same string it is today.
- **The paste pipeline, precisely.** `Composer.Root` already owns an `onPaste` handler for file
  attachments (`use-drag-and-paste.ts`), and DOR-947 depends on it. The Lexical field's
  `PASTE_COMMAND` handler must therefore **decline any paste whose `clipboardData.items` contain a
  file** — returning `false` lets the event bubble to Root, which attaches it. A paste carrying
  both files and HTML is treated as a file paste, matching today's behaviour. Only a file-free
  paste is converted.
- **Conversion is allowlist-shaped, not sanitizer-shaped.** Pasted HTML is parsed with
  `DOMParser` into an inert document (never inserted into the live DOM), walked, and mapped to the
  supported node set; anything outside that set contributes its text content and nothing else. No
  `dangerouslySetInnerHTML`, no `innerHTML` assignment, no `document.write`. A pasted
  `<script>`/`<img onerror>`/`<iframe>` therefore cannot execute and cannot survive as markup — it
  becomes text or nothing.
- **Plain-text paste** (`⌘⇧V`, `Ctrl+Shift+V`) bypasses conversion entirely and inserts the
  clipboard's `text/plain`, as the design record recommends.
- The editor gains no network access, no storage access, and no new permissions.

## Documentation

- `contributing/keyboard-shortcuts.md` — the Enter table gains its two list rows and the
  flag-on/flag-off distinction. This file already names `Composer.Input` (DOR-946 task 3.3).
- `contributing/project-structure.md` — the `features/composer/ui/field/` directory.
- `contributing/configuration.md` — the new `ui.composer.richText` field, per the
  `adding-config-fields` skill.
- `docs/` (Fumadocs, user-facing) — a short section on formatting as you type, in the plain-words
  register the `writing-for-humans` skill requires. It states what the flag is, where the switch
  is, and what the unsupported syntax does (still works, just does not preview).
- TSDoc: `EditingSurface` carries the seam's argument (why a port, why these seven methods);
  `markdown-offsets.ts` carries the round-trip invariant; `use-lexical-value.ts` carries the latch
  and why dropping it breaks typing.
- Dev playground: the existing `composer-input` showcase gains a flag-on variant
  (`maintaining-dev-playground`).
- One changelog fragment in `changelog/unreleased/`, user-facing, written last.

## Implementation Phases

Each phase is a separately reviewable commit with its proof attached; adversarial REVIEW.md review
before any PR opens. Phases 1 and 2 change no behaviour on any surface.

1. **The seam, with no editor behind it.** Extract `EditingSurface` and `textarea-surface.ts`;
   repoint `useInputKeyboard` from `textareaRef` to `surface`; extract `TextareaField.tsx` out of
   `ComposerInput`. **Proof:** all eleven DOM-parity baselines diff empty; the full existing
   keyboard suite passes unedited; the client suite is green.
2. **The markdown boundary, headless.** `lexical-transformers.ts`, `markdown-offsets.ts`,
   `lexical-nodes.ts`, and the round-trip corpus — no React, no field, nothing rendered.
   **Proof:** the round-trip property test and the offset-map table, both mutation-checked.
3. **The field.** `LexicalField.tsx`, `lexical-surface.ts`, `use-lexical-value.ts`, the command
   registrations, the paste handler, the a11y attributes, the lazy chunk. **Proof:** the scenario
   table green on both surfaces; the flag-on DOM baselines recorded and reviewed; palette
   integration tests green.
4. **The flag and chat.** The config field with its three classifications and migration, the
   `use-composer-prefs` hook, the Settings toggle, and `ChatInputContainer` passing `richText`.
   **Proof:** flag-off baselines still empty; a real browser check of both states.
5. **Close the loop.** The four `mention-picker.spec.ts` caret assertions, the new flag-on e2e
   spec, docs, playground, changelog fragment, bundle and latency measurements recorded.

Rooms, the dashboard, and onboarding are **not** in this spec's phases. They graduate in a
follow-up work item, gated on the criteria in Decision 5, and that item is captured when this one
closes.

## Open Questions

### For spec review — genuinely new calls

1. **The 2026-08-03 architecture lock names `LexicalTypeaheadMenuPlugin` for both `@` and `/`.
   This spec does not use it, and that needs confirming.** The lock predates DOR-946 by four days.
   What shipped since is a composer whose palettes are **owned by the hosts**, driven by
   `(value, cursorPos)`, rendered in `Composer.OverlayLane`, keyboard-navigated by the ladder, and
   pinned by DOM baselines and e2e specs. `LexicalTypeaheadMenuPlugin` owns three things —
   trigger detection, menu rendering in its own portal, and arrow/Enter navigation — and the second
   and third are already owned, deliberately and with tests. Adopting it would mean rewriting
   `use-input-autocomplete` and `use-mention-autocomplete`, moving the palettes out of the overlay
   lane, re-recording every composer baseline, and re-deciding the zero-result Enter fall-through
   that DOR-946 fixed. **Recommendation: drop the plugin, keep the host-owned palettes, and let
   Decision 1's markdown-offset contract be the mechanism.** The lock's _intent_ — one typeahead
   mechanism serving both sigils rather than two — is satisfied: `use-input-autocomplete` already
   routes `@` and `/` through one detector. This is the only place the spec knowingly departs from
   a locked line, and it is flagged rather than assumed.

2. **Confirm the excluded node set.** The spec recognizes bold, italic, inline code, h1–h3, and
   both list kinds, and deliberately does not recognize links, blockquotes, fenced code blocks,
   strikethrough, rules, tables, or images. The brief named "bold, italic, headings, bullets"; the
   rest is a judgement. The exclusion is cheap to reverse and cheap to live with because
   **unrecognized syntax still works** — it stays literal in the box and renders normally in the
   sent message. Fenced code is the one with a real argument behind it: recognizing it would create
   a third meaning for Enter, and the locked decision authorized exactly one exception.
   **Recommendation: ship the closed set above; add links only if someone asks.**

3. **Should the toggle be visible in Settings, or operator-only?** The spec puts a switch in
   Settings → Advanced. The argument for it: a person whose composer misbehaves can fix it without
   reading a file, and an opt-in feature nobody can find gets no signal. The argument against: it
   is a rollout mechanism, not a preference, and a switch in Settings is a promise to keep both
   paths forever. **Recommendation: ship the switch for the flag-off era, and remove it when the
   flag graduates to default-on and the textarea path is deleted** — which is the "no tolerated
   legacy patterns" ending this repo asks for.

### Resolved during SPECIFY

4. ~~**Does pasted rich text become markdown?**~~ **(RESOLVED — locked 2026-08-07, Dorian at the
   `composer-parity` spec review.)** **Answer:** yes; the stored and posted payload stays markdown
   text and no HTML persists. **Rationale:** the wire format is markdown and the server never
   learns editor state; converting at the paste boundary is the only place the conversion can
   happen exactly once. Specified in Security Considerations, including the file-paste precedence
   that keeps DOR-947 working and the plain-text-paste bypass.

5. ~~**Enter semantics in block contexts.**~~ **(RESOLVED — locked 2026-08-07.)** **Answer:**
   Enter continues a list; Enter on an empty list item exits the list; Enter-to-send everywhere
   else; Shift+Enter stays a newline. **Rationale:** preserves send muscle memory while making
   lists usable. Specified as the two bold rows of the Enter table, sitting below the palette rung
   and above the send rungs.

6. ~~**Which surface gets the flag first?**~~ **(RESOLVED — locked 2026-08-07.)** **Answer:**
   chat. **Rationale:** the swap itself lands on every surface at once because there is one
   `Composer.Input`; the flag is what gates the rich behaviour, and enablement is expressed by
   which host passes `richText`. Rooms, dashboard, and onboarding follow in a gated follow-up.

7. ~~**Where does the flag live?**~~ **(RESOLVED from existing code.)** **Answer:**
   `UserConfigSchema.ui.composer.richText`, read through `useConfig()` and written with a
   `{ ui: { composer: { richText } } }` PATCH, following `ui.statusBar.pins` exactly.
   **Rationale:** it is the repo's only durable, migration-guarded preference mechanism, it is
   reachable by editing `config.json` when the UI it gates is what broke, and `localStorage` is
   reserved here for per-device view state. Classified `no-risk` / `expose` / `agent-writable`.

8. ~~**How does the keyboard ladder survive a contenteditable?**~~ **(RESOLVED from existing
   code.)** **Answer:** an `EditingSurface` port with a textarea adapter and a Lexical adapter; the
   ladder's decision logic is untouched; Lexical is wired at `COMMAND_PRIORITY_CRITICAL` so the
   ladder is consulted first, and a `false` return is what lets Lexical continue a list.
   **Rationale:** the five textarea reach-ins are the only coupling, the ladder's existing tests
   stay valid as the net, and running one scenario table against two adapters is a bar that can
   actually fail.

9. ~~**Do the palettes have to move?**~~ **(RESOLVED from existing code.)** **Answer:** no.
   `use-input-autocomplete` and `use-mention-autocomplete` are not modified by this spec.
   **Rationale:** both are driven entirely by `(value, cursorPos)`, and Decision 1 preserves both
   in the same units. `use-mention-autocomplete`'s own TSDoc already specifies the two-call
   `noteTextChange` → `handleCursorChange` order the Lexical field must keep emitting.

10. ~~**What happens to a formatted draft when the flag is switched off?**~~ **(RESOLVED.)**
    **Answer:** nothing is lost — the draft is markdown text either way, and the textarea shows its
    source. **Rationale:** the document is never the storage format; the markdown string is, and
    draft stores hold that string on both paths.

11. ~~**Does anything about attachments change?**~~ **(RESOLVED from `origin/room-attachments`.)**
    **Answer:** no. `Composer.Root` owns the dropzone, the hidden input, the overlay, the
    `data-composer-card` attribute, and the chip bar; `Composer.Input` holds no attachment state.
    The one interaction is paste precedence, specified above: a file-bearing paste is declined by
    the editor and bubbles to Root.

## Related ADRs

- **Seeded by this spec (draft):**
  - `260808-180001` — The composer's host contract is markdown text and a markdown offset.
  - `260808-180003` — The composer keyboard ladder is surface-agnostic behind an editing-surface port.
  - `260808-180004` — Composer mentions are token text nodes decorated from a host-supplied roster.
- `260807-173219` — One compound composer family shared by chat, rooms, and dashboard (DOR-946).
  This spec is the swap that family exists to make cheap.
- `260807-233815` — Room attachments are room-scoped, upload-then-reference (DOR-947). Constrains
  the paste pipeline.
- `260722-111316` — the `first-message` seam (dashboard submit path), unchanged here.

## References

- DOR-948 · project "Rooms, Channels & Threads" · umbrella DOR-951
- `specs/composer-rich-text/01-ideation.md`, `specs/composer-rich-text/design-decisions.md`
- `specs/composer-parity/02-specification.md` §Open Questions (the 2026-08-07 programme answers),
  `specs/composer-parity/04-implementation.md` (the DOM-parity harness as built)
- `specs/room-attachments/` (DOR-947), branch `origin/room-attachments`, PR #871
- Design session mockups: `.dork/visual-companion/81863-1786054606/content/`
- Source read while specifying: `apps/client/src/layers/features/composer/` (all of it),
  `features/chat/model/use-input-autocomplete.ts`, `features/mentions/` (`use-mention-autocomplete.ts`,
  `lib/mention-rows.ts`), `widgets/room-view/ui/RoomComposer.tsx`, `shared/ui/mention-pill.tsx`,
  `apps/client/src/test-helpers/dom-parity.ts`, `entities/config/model/use-status-bar-prefs.ts`,
  `apps/e2e/pages/RoomsPage.ts`, `apps/e2e/pages/ChatPage.ts`,
  `apps/e2e/tests/rooms/mention-picker.spec.ts`
- `.claude/rules/safe-defaults.md`, `.claude/rules/fsd-layers.md`, `.claude/rules/components.md`,
  `.claude/rules/room-conduct.md`, `.claude/rules/testing.md`
- Lexical: <https://lexical.dev/docs/intro> · `@lexical/markdown` transformers ·
  `@lexical/list` `$handleListInsertParagraph` · command priorities
