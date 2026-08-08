---
id: 260808-180003
title: The composer keyboard ladder is surface-agnostic behind an editing-surface port
status: draft
created: 2026-08-08
spec: composer-rich-text
superseded-by: null
---

# 260808-180003. The composer keyboard ladder is surface-agnostic behind an editing-surface port

## Status

Draft (auto-extracted from spec: composer-rich-text)

## Context

`use-input-keyboard.ts` holds the composer's whole keyboard contract: the Escape priority ladder, the 500 ms double-Escape arm and its context key, palette fall-through on a zero-result panel, backslash line continuation, the `isUploading` trigger latch, IME guards, queue navigation, and the three Enter modes. Its tests are its only regression net. Swapping the field for a contenteditable breaks it twice over. First, ordering: React 19 delegates synthetic listeners to the root container while Lexical registers native listeners on the editable element, so Lexical would see Enter first and insert a paragraph before the ladder ran. Second, coupling: five places in the ladder reach into `textareaRef.current` — text before a collapsed caret, caret-at-start, caret-at-end, insert-a-newline, replace-the-escape-with-a-newline, and the double-Escape wipe that must land as one undo entry.

## Decision

Introduce an `EditingSurface` port — seven small methods covering exactly those reach-ins plus `isComposing()` — with a textarea adapter (today's code moved verbatim, `document.execCommand` included) and a Lexical adapter. `useInputKeyboard` takes a surface instead of a ref; its decision logic is not edited. The Lexical field registers the ladder on `KEY_ENTER_COMMAND`, `KEY_ESCAPE_COMMAND`, `KEY_ARROW_UP/DOWN_COMMAND`, and `KEY_TAB_COMMAND` at `COMMAND_PRIORITY_CRITICAL`, so the ladder is consulted before Lexical's own rich-text handlers; returning `false` hands the key back to Lexical, which is precisely how Enter continues a list and how an empty list item exits one. The `preventDefault`-without-`stopPropagation` marking that enclosing surfaces read is preserved, because Lexical passes the original `KeyboardEvent` through. The verification bar is one scenario table executed against both adapters.

## Consequences

### Positive

- The ladder stays one decision table with one set of arguments, rather than forking per field — which is what makes its existing tests continue to mean something.
- "The keyboard survived" becomes a claim that can fail: the same scenarios run on both surfaces, and a rung that behaves differently is red.
- List continuation is expressed as a deliberate fall-through rather than a reimplementation of Lexical's list handling inside the ladder.

### Negative

- One more indirection between the ladder and the thing it edits; a reviewer now has to read two files to see what a key does to the text.
- `COMMAND_PRIORITY_CRITICAL` means the ladder pre-empts every Lexical default, so any future editor behaviour that needs a key the ladder claims must be added to the table rather than registered alongside it.
- The port must be kept minimal on purpose; every method added to it is a new way for the two surfaces to diverge.
