---
id: 260808-180001
title: The composer's host contract is markdown text and a markdown offset
status: accepted
created: 2026-08-08
spec: composer-rich-text
superseded-by: null
---

# 260808-180001. The composer's host contract is markdown text and a markdown offset

## Status

Accepted

**Amended 2026-08-18 (DOR-1331).** The decision holds unchanged; two names in the Context below
have moved. `RoomComposer` and `ChatInputContainer` were merged into one composer card,
`Conversation.Composer`, and what is left of each host is its own wiring: `ChannelComposer` is now
the host that lands `insertMention`'s result with `focusAt(pos)`, and `SessionComposer` is the one
that drives `detectCommandTrigger`. The contract those hosts drive the field through — a markdown
string and an offset into it — is exactly what made that merge possible without touching either
palette.

## Context

`Composer.Input` is the one text field on chat, rooms, the dashboard hero, and onboarding
(ADR 260807-173219). Every host drives its own autocomplete off exactly two signals — `onChange(value: string)` and `onCursorChange(pos: number)` — and writes back through the same pair: chat's `use-input-autocomplete` runs `detectCommandTrigger(value, cursor)`, rooms' `use-mention-autocomplete` matches `MENTION_TRIGGER` against `text.slice(0, cursorPos)` and returns a new `{ value, cursorPos }` via `insertMention`, which `RoomComposer` lands with `focusAt(pos)`. Those palettes render in `Composer.OverlayLane`, are keyboard-navigated by the composer's own ladder, and are pinned by committed DOM baselines and browser tests. Replacing the field's internals with a Lexical WYSIWYG editor (DOR-948) puts a document model where a flat string used to be, and a document has no natural integer caret.

## Decision

The editor's contract with its hosts stays a **markdown string and an offset into that same string**. On every document change the Lexical field serializes to markdown, computes the caret's offset into that serialization, and emits the existing `onChange` / `onCursorChange` pair; `focusAt(pos)` maps an offset back to a Lexical selection. One module owns all four directions and builds a position map in the same walk that serializes, because serialization is not identity — `**bold**` contributes four characters no text node owns. Two invariants make the contract safe: `parse(md) → serialize()` is a fixed point for every value a host can write back, and the field re-hydrates from the `value` prop only when that value differs from the last string it emitted. Consequently `use-input-autocomplete` and `use-mention-autocomplete` are not modified, the palettes keep their owners and their DOM, and `LexicalTypeaheadMenuPlugin` is not adopted.

## Consequences

### Positive

- The palettes, their overlay lane, their keyboard contract, and their baselines survive an editor swap untouched — the blast radius of the largest composer change is confined to one file's insides.
- The wire format needs no defending: markdown is what the component holds, not a thing derived from it at send time, so nothing can drift between what is displayed and what is posted.
- The offset map is a single testable module with a property-shaped invariant, rather than caret arithmetic smeared across the field.

### Negative

- Serialization runs on every document change, on the most latency-sensitive surface in the product; it needs a measured budget and a selection-only fast path.
- The round-trip fixed point is a real constraint on which markdown nodes the editor may recognize, and a transformer that does not round-trip cleanly is unusable however nice it looks.
- Dropping the emitted-value latch silently destroys typing (caret resets, undo stack empties) while every other test stays green — the failure mode has to be pinned by its own test.
- The spec knowingly departs from the 2026-08-03 lock naming `LexicalTypeaheadMenuPlugin`; the departure is flagged for confirmation rather than assumed.
