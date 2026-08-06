---
slug: composer-parity
number: 260806-215027
created: 2026-08-06
status: ideation
design-session: .dork/visual-companion/81863-1786054606
---

# Composer parity: unify the chat and room composers

**Slug:** composer-parity
**Author:** flow agent (IDEATE stage, DOR-946)
**Date:** 2026-08-06
**Tracker:** DOR-946 · project "Rooms, Channels & Threads" · umbrella DOR-951

---

## 1) Intent & Assumptions

- **Task brief:** The chat and room composers should feel largely the same. They already share the `ChatInput` core; only the orchestration wrapped around it diverges. Needs a shared ComposerShell plus a capability model deciding which affordances each surface exposes.
- **Assumptions:**
  - The shared core stays `ChatInput` until DOR-948 (Lexical) replaces it — parity is about the _shell around_ the core, so the editor swap later happens in one place.
  - "Parity" means consistent chrome, spacing, focus behavior, and predictable capability placement — not identical feature sets (a room has no session queue; chat has no roster mentions today).
  - Sequencing stays as locked on 2026-08-03: identity/mentions (shipped) → files-in-rooms → rich text last. Parity is the enabler that should land before or with files-in-rooms so the attach affordance lands once.
- **Out of scope:**
  - Rich text / Lexical (DOR-948).
  - Room file attachments themselves (DOR-947) — parity only reserves where the affordance lives.
  - Mention _rendering_ in messages (shipped, DOR-904/905) and the mention addressing doctrine (`mentions.ts` — untouchable).

## 2) Pre-reading Log

- `plans/composer-identity-components/design-handoff.md`: the identity phase is shipped; composer unification explicitly deferred as a later phase needing design.
- Memory `project_composer_rooms_unification_design`: all three composers share ONE core (`ChatInput.tsx` — textarea, focus, auto-resize, keyboard ladder, clear/attach/action slots); divergence is only orchestration. Locked: identity-first sequencing.
- `apps/client/src/layers/widgets/room-view/ui/RoomComposer.tsx` (304 lines): wraps `ChatInput` + `ClearArmedHint`, adds `useMentionAutocomplete` over the room roster (from `features/mentions`), careful insert/undo handling.
- `apps/client/src/layers/features/chat/ui/input/ChatInputContainer.tsx` (408 lines): the chat-side orchestration — queue panel, file chip bar, prompt suggestion chips, interactive input panel, drag-and-paste.
- `apps/client/src/layers/widgets/dashboard/ui/DashboardComposerSection.tsx` (71 lines): thin third consumer.

## 3) Codebase Map

- **Primary components:** `features/chat/ui/input/` (ChatInput core + chat orchestration: `ChatInputContainer`, `FileChipBar`, `QueuePanel`, `PromptSuggestionChips`, `InteractiveInputPanel`, `use-drag-and-paste`, `use-input-keyboard`, `use-textarea-resize`); `widgets/room-view/ui/RoomComposer.tsx`; `widgets/dashboard/ui/DashboardComposerSection.tsx`; `features/mentions` (room-side autocomplete).
- **Data flow:** each surface owns its submit path (chat → session trigger POST; room → `POST /api/rooms/:id/entries`). Parity must not merge submit semantics — only the shell.
- **FSD constraint:** a shared shell must live where both `features/chat` and `widgets/room-view` can reach it. Today's core is in `features/chat` and the room widget imports it (`widgets ← features` is legal). A `ComposerShell` could stay in `features/chat` — or move to a neutral slice if chat-specifics leak.
- **Blast radius:** every composer surface; keyboard ladder; mention autocomplete; e2e specs touching the composer.

## 5) Research — options

1. **Shared `ComposerShell` + declarative capability model** (attachments / queue / suggestions / mentions / slash-commands declared per surface; shell renders slots consistently). Pros: one place for chrome + a11y + keyboard; the Lexical swap later lands once; capability matrix becomes reviewable. Cons: biggest refactor of the three; risks over-abstracting two-and-a-half consumers.
2. **Visual-parity only** — align chrome/spacing/placement by convention, keep each orchestration. Pros: cheap, low risk. Cons: drift returns; DOR-947/948 each pay the divergence tax again.
3. **Full unification including state/submit.** Cons: submit semantics genuinely differ (sessions vs room entries); merging them buys nothing users can see. Rejected as over-reach.

**Recommendation:** Option 1, scoped to the shell (slots + chrome + keyboard), never the submit path. But the capability matrix itself is the user's design call — see below.

## 6) Decisions

Resolved in the 2026-08-06 /visual-companion session with Dorian — full detail in [design-decisions.md](./design-decisions.md):

| #   | Decision                    | Choice                                                                                                                                | Rationale                                                                 |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Capability matrix           | Full parity minus session machinery: rooms gain attach + slash commands; queue/suggestions/interactive-panel stay chat/dashboard-only | "As close to full parity as makes sense"; queue etc. are session concepts |
| 2   | Attach affordance placement | Chat's exact treatment (chip bar + attach action) via the shared components                                                           | Parity by construction                                                    |
| 3   | Mentions in chat            | Stay room-only for now; can flip later inside the same capability model                                                               | A single-agent session has nobody to disambiguate                         |
| 4   | Chrome                      | Identical — chat and rooms **literally share the same components**, Compound Components pattern with props for divergence             | Dorian's explicit architecture direction                                  |

**Next step:** SPECIFY — define the compound component API, its FSD home, and the migration order for the three surfaces.
