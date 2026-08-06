---
slug: composer-rich-text
number: 260806-215029
created: 2026-08-06
status: ideation
---

# Rich text via markdown in the composer (Lexical)

**Slug:** composer-rich-text
**Author:** flow agent (IDEATE stage, DOR-948)
**Date:** 2026-08-06
**Tracker:** DOR-948 · project "Rooms, Channels & Threads" · umbrella DOR-951

---

## 1) Intent & Assumptions

- **Task brief:** The composer should support rich text via markdown (bold, italic, headings, bullets), with slash-commands and mentions highlighted as you type. Biggest lift of the programme; replaces the shared textarea core.
- **Locked architecture forks (decided 2026-08-03 by Dorian — do not relitigate):**
  - Editor = **Lexical WYSIWYG** (~54kb core); **Tiptap is the named fallback** if Lexical proves wrong in practice.
  - **Serialize to markdown on send** — the wire format stays markdown; the server never learns editor state.
  - One **`LexicalTypeaheadMenuPlugin`** drives both `@` (mentions) and `/` (slash-commands).
  - **Phased behind a flag** — the textarea path stays until the editor earns its keep.
- **Assumptions:**
  - Lands **last** in the locked sequencing (after composer parity and files-in-rooms), so the swap happens inside the ComposerShell once and benefits every surface.
  - The keyboard ladder (`use-input-keyboard.ts`), clear-armed behavior, queue semantics, and auto-resize must survive the swap observably unchanged.
  - Mention _addressing_ stays server-side write-time resolution — the editor only highlights while typing; it never becomes the resolver (`.claude/rules/room-conduct.md`).
- **Out of scope:** collaborative editing; persisting editor state server-side; rich text in _rendered_ messages (already markdown via streamdown); changing the send wire format.

## 2) Pre-reading Log

- Memory `project_composer_rooms_unification_design`: fork rationale + ~54kb core cost; one typeahead plugin for both sigils.
- `apps/client/src/layers/features/chat/ui/input/ChatInput.tsx` + `use-input-keyboard.ts`, `use-textarea-resize.ts`: the behaviors the editor must reproduce (Enter-to-send ladder, Shift+Enter newline, clear-armed, resize caps).
- `apps/client/src/layers/widgets/room-view/ui/RoomComposer.tsx`: room mention autocomplete (`useMentionAutocomplete` over the roster) — becomes the `@` typeahead's data source in rooms.
- `plans/composer-identity-components/design-handoff.md`: `MentionPill` exists in `shared/ui` — the in-composer mention highlight should visually rhyme with the in-message pill, but the in-composer one is editor decoration, not the shipped renderer.

## 3) Codebase Map

- **Primary:** `features/chat/ui/input/` (the core being replaced), `features/mentions` (typeahead data), command/slash sources (chat's existing slash-command handling), `shared/ui/mention-pill.tsx` (visual reference).
- **Feature flag:** config-gated rollout (`config-manager` / client settings — pick the exact mechanism in SPECIFY; repo has `adding-config-fields` skill for the schema work).
- **Blast radius:** every composer surface (chat, room, dashboard), e2e specs that type into the composer, IME/mobile input, paste handling, a11y (textarea → contenteditable is a real screen-reader change).

## 5) Research — options

Architecture is already forked (Lexical). Remaining research is UX-level and belongs to the design session; SPECIFY should also confirm:

- Markdown fidelity: which nodes are supported in-editor (bold/italic/headings/bullets confirmed; code? links? blockquotes?) and how unsupported markdown pastes behave.
- Degradation: the flag-off path must remain byte-identical in behavior; define the kill-switch criteria for falling back (perf, IME breakage, a11y regressions).

## 6) Decisions

Architecture: locked (above). **UX is deliberately undecided — parked on the /visual-companion design session with the operator.** Open design questions:

| #   | Design question                                                                                                                      | What hangs on it            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| 1   | The editing feel: markdown shortcuts only (Calm Tech, no chrome), or a minimal formatting toolbar (and if so, when it shows)?        | Plugin set + surface chrome |
| 2   | How do live mentions look while typing — full `MentionPill` styling in-editor, or a quieter highlight that becomes the pill on send? | Editor node design          |
| 3   | Enter semantics inside block contexts (lists, headings): where does Enter-to-send yield to Enter-for-new-block?                      | Keyboard ladder redesign    |
| 4   | Paste behavior: pasted rich text converts to markdown, or pastes as plain text?                                                      | Clipboard plugin scope      |
| 5   | Rollout: which surface gets the flag first (chat vs room), and what graduates it to default?                                         | Phasing plan                |

**Next step:** design session with the operator → record decisions → SPECIFY. Build order dependency: after `composer-parity` (the shell) and ideally after `room-attachments`.
