---
slug: composer-parity
number: 260806-215027
created: 2026-08-07
status: specified
---

# Composer parity: one compound composer family for chat, rooms, and dashboard

**Status:** Draft
**Author:** flow agent (SPECIFY stage, DOR-946)
**Date:** 2026-08-07
**Design record:** [design-decisions.md](./design-decisions.md) (locked 2026-08-06 with Dorian)

## Overview

Extract the composer into a **compound component family** — `Composer.Root` / `Composer.Input` / `Composer.OverlayLane` / `Composer.Attachments` / `Composer.ClearArmedHint` — in a new FSD slice `features/composer`, and migrate all three surfaces (session chat, rooms, dashboard) onto it. Chat and rooms then **literally share the same components**; per-surface divergence is expressed by which parts a surface composes and which props it passes, never by forked chrome. Rooms gain chat's exact card chrome and the reserved attach + slash-command affordances; queue, prompt suggestions, and the interactive panel remain chat/dashboard-only session concepts.

This is the enabler for DOR-947 (files-in-rooms wires the already-present attach slot) and DOR-948 (the Lexical swap replaces one `Composer.Input`, landing on every surface at once).

## Background / Problem Statement

All three composers already share one core, `ChatInput.tsx` (~408 lines: textarea, focus rules, auto-resize, the full keyboard ladder, palette wiring, clear/attach/queue affordances, submit gating). What diverges is everything wrapped around it, and the divergence is drift, not design:

- **Chat** (`features/chat/ui/input/ChatInputContainer.tsx`, 408 lines) wraps the core in a floating card (`bg-surface m-2 rounded-xl border p-2`), an overlay lane above the box (CommandPalette / FilePalette / ClearArmedHint), FileChipBar, QueuePanel, drag-and-paste, ScanLine, InteractiveInputPanel swap, status section.
- **Rooms** (`widgets/room-view/ui/RoomComposer.tsx`, 304 lines) wrap the same core in different chrome (`border-t p-3`), re-implement the overlay lane by hand for MentionPalette + ClearArmedHint, and have no attach, no slash commands, no drag/paste.
- **Dashboard** (`widgets/dashboard/ui/DashboardComposerSection.tsx`, 71 lines) renders the bare core with no card at all.

Every future composer feature (attachments, rich text) currently pays this divergence tax per surface. Parity collapses the shell so DOR-947/948 each land once.

Verified against `main` @ `20ff16a8c` (2026-08-07); line counts unchanged since the 2026-08-06 design session, and the identity-programme PRs that shipped in between (#819–#827, #841–#846) did not touch these three files.

## Goals

- One compound composer family both `features/chat` and `widgets/room-view` (and `widgets/dashboard`) import — no fork of the input core, chip bar, overlay lane, or send affordance.
- Chrome identical by construction across chat, rooms, and dashboard (the chat card treatment is the reference).
- The capability matrix from the design record is expressed in code as composition, reviewable per surface:

  | Capability                     | Chat | Room                 | Dashboard    |
  | ------------------------------ | ---- | -------------------- | ------------ |
  | Attach (chip bar, drag, paste) | yes  | **yes (new)**        | follows chat |
  | Slash commands                 | yes  | **yes (new)**        | follows chat |
  | `@` mentions                   | no   | yes                  | no           |
  | Queue-while-busy               | yes  | no (session concept) | yes          |
  | Prompt suggestions             | yes  | no (session concept) | yes          |
  | Interactive input panel        | yes  | no (session concept) | yes          |

- Behavior preservation on chat and dashboard: identical DOM and identical keyboard ladder before/after (DOR-956's DOM-diff technique is the evidence bar).
- Rooms visually change exactly once, deliberately: they adopt the chat card chrome.

## Non-Goals

- **Merging submit paths.** Chat submits via session trigger POST; rooms via `usePostToRoom`/`useReplyInThread` (202 + pending rows); dashboard via the `first-message` seam (ADR 260722-111316). Each surface keeps its own submit handler — parity is the shell only.
- **Room file attachments themselves** (DOR-947). Parity reserves the slot (`Composer.Attachments`, `onAttach`, drag/paste plumbing); rooms leave it unwired until 947.
- **Rich text / Lexical** (DOR-948).
- **Mentions in chat.** Stays room-only (a single-agent session has nobody to disambiguate); can flip later inside the same composition model.
- **Mention rendering/addressing** — `apps/server/src/services/rooms/mentions.ts` and the span doctrine are untouchable (`.claude/rules/room-conduct.md`).
- Moving chat's session machinery (queue model, background tasks, status section, autocomplete model) out of `features/chat`.

## Technical Dependencies

No new dependencies. Existing: React 19, `motion`, Tailwind 4, lucide-react. Everything moved is first-party.

## Detailed Design

### The new slice: `apps/client/src/layers/features/composer/`

Compound Components pattern (Dorian's explicit architecture direction): a `Composer` namespace whose parts compose under a shared root. **Composition is the capability declaration** — a surface exposes attach by rendering `Composer.Attachments` and passing `onAttach`; there is no separate capability config object, because the props already are the declaration and a parallel config could disagree with what is actually rendered.

```
features/composer/
├── ui/
│   ├── ComposerRoot.tsx        # card chrome + drag/drop/paste + drop overlay
│   ├── ComposerInput.tsx       # ChatInput, moved verbatim (props unchanged)
│   ├── ComposerOverlayLane.tsx # the absolute bottom-full lane above the box
│   ├── ComposerAttachments.tsx # FileChipBar, moved
│   ├── ClearArmedHint.tsx      # moved
│   ├── InputActionButton.tsx   # moved (internal, not exported)
│   ├── use-input-keyboard.ts   # moved (internal)
│   ├── use-textarea-resize.ts  # moved (internal)
│   └── use-drag-and-paste.ts   # moved (consumed by ComposerRoot)
├── __tests__/                  # moved alongside
└── index.ts                    # exports the `Composer` namespace + types
```

Public API (barrel):

```tsx
export const Composer = {
  Root: ComposerRoot,
  Input: ComposerInput,
  OverlayLane: ComposerOverlayLane,
  Attachments: ComposerAttachments,
  ClearArmedHint,
};
export type { ComposerInputHandle } from './ui/ComposerInput'; // = today's ChatInputHandle
```

- **`Composer.Root`** owns the shared chrome — today's chat card: `bg-surface relative m-2 rounded-xl border p-2` — and, when the surface passes `onFilesDropped`, the dropzone root props, hidden file input, paste handler, and the "Drop files to attach" overlay (all moved from `ChatInputContainer`). Children render inside. It stays `relative` so the overlay lane can anchor to it. Chat's `ScanLine` streaming edge is chat-only and passed as a child, not baked in.
- **`Composer.Input`** is today's `ChatInput` moved verbatim — same props, same `ChatInputHandle` (exported as `ComposerInputHandle`), same keyboard ladder, same optional-prop capability surface (`onAttach`, `onQueue`, palette props, `canSubmit`/`canSubmitReason`, `contextKey`, `onClearArmedChange`). No behavior change in this spec. DOR-948 later swaps its internals behind the same props.
- **`Composer.OverlayLane`** is the `absolute right-0 bottom-full left-0 mb-2` lane both chat and rooms currently hand-roll (chat at `ChatInputContainer.tsx:270`, rooms at `RoomComposer.tsx:235` with `right-3 left-3` — the offset difference disappears once rooms sit inside `Root`'s padding). Hosts put palettes and `Composer.ClearArmedHint` in it; stacking order is the child order.
- **`Composer.Attachments`** is `FileChipBar` moved verbatim (files, onRemove, onRetry, onCancel).

**What deliberately stays in `features/chat`:** `QueuePanel`, `PromptSuggestionChips`, `InteractiveInputPanel`, `BackgroundTaskBar`, `ChatStatusSection`, `AnimatedPlaceholder` + rotating-hints model, `use-chat-queue`, `use-input-autocomplete`, `use-background-tasks`, native commands. These are session concepts per the locked matrix. `ChatInputContainer` remains chat's orchestrator, now composing `Composer.*`.

### FSD placement and legality

`features/composer` is a new feature slice. Widgets (`room-view`, `dashboard`) importing it is the normal `widgets ← features` edge. `features/chat` and `features/mentions` rendering its components is cross-feature **UI composition, which is allowed**; the forbidden edge (cross-feature model/hook imports) is avoided by keeping every hook internal to the slice — consumers only ever import components and types from the barrel. The alternative of leaving the family in `features/chat` was rejected: the room widget importing a "chat" feature for its own composer is exactly the naming lie that let the chrome drift; `shared/ui` was rejected because the composer is a feature (stateful keyboard contract, upload affordances), not a primitive.

`features/chat` keeps **no re-export shim**: all `ChatInput` imports repo-wide (chat, rooms, dashboard, onboarding surfaces — enumerate with `grep -rn "ChatInput" apps/client/src` at build time) migrate to `@/layers/features/composer` in the same phase the file moves. No dead paths, no transitional aliases.

### Per-surface composition after migration

**Chat** (`ChatInputContainer`): `Composer.Root` (with drag/paste wired) containing — interactive-panel swap as-is → `Composer.OverlayLane` (CommandPalette, FilePalette, `Composer.ClearArmedHint`) → `Composer.Attachments` → QueuePanel → BackgroundTaskBar → `Composer.Input` (all current props) → ChatStatusSection. Net: the container shrinks to pure chat orchestration; chrome, dropzone, and lane markup leave it.

**Rooms** (`RoomComposer`): replaces `border-t p-3` with `Composer.Root`; MentionPalette + `Composer.ClearArmedHint` move into `Composer.OverlayLane`; `Composer.Input` keeps the exact prop set it has today (draft store, mention wiring, caret bookkeeping, archived gating are untouched). Attach: `Root`'s drop plumbing and `Input`'s `onAttach` stay **unwired** until DOR-947. Slash commands: per Open Question 1's resolution.

**Dashboard** (`DashboardComposerSection`): wraps its `Composer.Input` in `Composer.Root` so the hero composer carries the same card chrome. Everything else unchanged.

### API / data model changes

None. No server, transport, schema, or wire changes of any kind.

## User Experience

- Chat and dashboard: pixel-identical before/after, except the dashboard composer gains the standard card chrome around the box.
- Rooms: the composer becomes the same floating card as chat's — same border, radius, padding, focus ring, spacing. Enter/Shift+Enter/Escape/Escape-Escape, mention picker, draft persistence, archived-room gating all behave exactly as today.
- No new user-visible capability ships in this spec (attach/slash affordances appear for room users only when 947 / the slash follow-up wire them).

## Testing Strategy

- **Unit tests:** the moved components' tests move with them (`features/composer/__tests__/`) and must pass unmodified — a test that has to change signals a behavior change. `RoomComposer.test.tsx` and `ChatInputContainer` tests updated only in import paths and chrome-level DOM assertions (room chrome change is intended and asserted deliberately).
- **DOM-diff proofs (the DOR-956 technique):** for chat and dashboard, render before/after under identical props and diff the serialized DOM — the diff must be empty (chat) or exactly the added Root wrapper (dashboard). For rooms, the diff must be exactly the intended chrome swap and lane reposition, reviewed as such.
- **Keyboard ladder:** `use-input-keyboard` moves without edit; its existing tests are the regression net.
- **E2E:** existing Playwright specs that type into a composer (chat send, room post, mention flow, queue flow) run unmodified — they are the behavior-preservation gate at the browser level.
- **Known false-red:** bare `pnpm vitest run` from repo root falsely fails `RoomComposer.test.tsx` — re-run from `apps/client` before believing a red there.

## Performance Considerations

Pure restructure: no new timers, subscriptions, or context providers. The drag/paste hook mounts once per composer exactly as today. `useRoomPresence`'s 1 Hz tick rule is unaffected (the composer holds no presence timer).

## Security Considerations

None — no server or wire changes; the attach slot stays unwired in rooms.

## Documentation

- TSDoc module doc on the `features/composer` barrel carrying the capability matrix (the reviewable declaration).
- `contributing/design-system.md` composer section: note the single family and where it lives, if the section names the old paths.
- Dev playground: if a composer showcase exists or is warranted, update per `maintaining-dev-playground` during EXECUTE.

## Implementation Phases

1. **Phase 1 — extract the slice (mechanical, zero behavior change).** Create `features/composer`, move `ChatInput` → `ComposerInput`, `FileChipBar` → `ComposerAttachments`, `ClearArmedHint`, `InputActionButton`, the three hooks, and their tests; migrate every import repo-wide; add barrel + namespace. Proof: full client tests green, no DOM change.
2. **Phase 2 — introduce Root + OverlayLane; migrate chat and dashboard.** Move chrome/dropzone/lane out of `ChatInputContainer` into `Composer.Root`/`Composer.OverlayLane`; dashboard adopts `Root`. Proof: chat DOM-diff empty; dashboard diff is the wrapper only.
3. **Phase 3 — migrate rooms.** `RoomComposer` onto `Root`/`OverlayLane`; intended chrome delta captured and reviewed; attach left unwired for DOR-947; slash palette per Open Question 1.

Each phase is a separately reviewable commit (or PR) with its proof attached; adversarial REVIEW.md review before any PR opens.

## Open Questions

1. ~~**Slash commands in rooms — what is the command source?**~~ **(RESOLVED 2026-08-07, Dorian at spec review.)** **Answer:** defer wiring to a follow-up ticket — parity ships the capability slot only. **Rationale:** chat's palette is fed by `transport.getCommands(cwd, { sessionId, runtime })` — commands are agent/session-scoped, and a room has no single cwd, session, or runtime; the semantics (e.g. union of the room's agents' commands, inserted as plain entry text) deserve their own decision, and nothing in DOR-947/948 depends on it. A follow-up work item gets captured when parity closes.

Program-level answers recorded in the same review (they bind the sibling specs): sequencing stays **parity → attachments → rich text** (no images fast-track); DOR-947 attachment paths go to room agents **automatically** with the entry (chat's existing limits, room-membership-scoped upload-then-reference); DOR-948 pastes rich text **converted to markdown**, Enter continues lists / empty item exits / Enter-to-send elsewhere, **chat gets the flag first**.

## Related ADRs

- Draft ADR extracted from this spec: compound composer component family in `features/composer` (capability-by-composition, submit paths never merged).
- ADR 260722-111316 (`first-message` seam) — dashboard submit path, unchanged here.

## References

- DOR-946 · project "Rooms, Channels & Threads" · umbrella DOR-951
- `specs/composer-parity/01-ideation.md`, `specs/composer-parity/design-decisions.md`
- Design session mockups: `.dork/visual-companion/81863-1786054606/content/`
- DOR-947 (`specs/room-attachments/`), DOR-948 (`specs/composer-rich-text/`)
- `.claude/rules/fsd-layers.md`, `.claude/rules/room-conduct.md`, `.claude/rules/components.md`
