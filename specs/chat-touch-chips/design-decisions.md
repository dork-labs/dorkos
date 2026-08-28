# Design Decisions — Chat message list 10×: touch chips & verb motion language

**Animated mockups (normative for motion): `specs/chat-touch-chips/mockups/`** — the five visual-companion screens, checked in so implementors get the real animations, not prose about them. Open any file in a browser; each is a self-contained HTML fragment with inline CSS (screens 01–03 wrap content for the companion frame but the animations run standalone). The mockups are the source of truth for **timing, easing, and choreography**; the CSS is demo-loop code (infinite loops, fixed pixel slots, faked odometers) and must be **ported, not copied** — real components animate once per state change, driven by stream events, with the loops reserved for genuine in-progress states. Once built, the `/dev/chat` showcases supersede these mockups as the living reference.

Original sessions (historical, and no longer on disk anywhere durable — `.dork/visual-companion/` session directories are scratch and are swept): `39852-1785548919/` (direction), `43050-1785584693/` (chips v1/v2, verbs), `18009-1785589506/` (verb refinement). They held the rejected iterations too; the five checked-in mockups above are the surviving record.

Companion research: `research/20260801_touched_file_chip_ui_patterns.md` (cross-product survey: Cursor, Copilot, Claude Code `/diff`, Codex, Devin, Perplexity, ChatGPT Deep Research). Prior research consumed: `20260316_extended_thinking_visibility_ui_patterns.md`, `20260316_subagent_activity_streaming_ui_patterns.md`, `20260320_chat_message_list_animations.md`, `20260320_llm_streaming_text_animation_techniques.md`, `20260309_chat_microinteractions_polish.md`, `20260316_hook_lifecycle_events_ui_patterns.md`.

## 1. Overall ambition level

**Screen:** `mockups/01-direction.html`
**Options:** A) Calm+ — refined Claude.ai-grade polish, zero server work. B) Alive — shimmer/orbit light, live tool-input typing, visible stream-of-consciousness. C) Mission Control — aurora borders, activity EKG, orbiting subagent dots, file-touch chips, context fuel gauge, cost-odometer turn receipt (built from SDK fields the adapters currently drop).
**Chosen:** **A (Calm+) as the base, plus C's file-touch chips** — Dorian: "I like option A overall, but I like that Option C shows the file touch chips."

Everything below designs that grafted chip system. The other B/C elements (shimmer thinking label, EKG, turn receipt, fuel gauge) are explicitly _not_ in scope for this feature; they remain candidates for later passes.

Incidental discovery to fix regardless: the `animate-tasks` class used ~20× across the client (including `ThinkingBlock`'s "thinking" pulse) has **no keyframe/utility definition anywhere** — the pulse is silently dead CSS.

## 2. What a chip is (anatomy — locked)

**Screens:** `mockups/02-chips-v1.html` (anatomy section), `mockups/03-chips-v2-hybrid.html` (locked section)

- A chip represents one unique **target** (file path or URL), never one event. **One chip per target, always** — dedup by folding every tool event into an append-then-merge accumulator, _not_ by "currently tracked state" (Cursor has a confirmed bug where state-tracked dedup silently drops real edits).
- Chip states form a machine: `reading → read → edited`, with **edit-wins**: a read file that later gets edited **upgrades in place** — the 📖 icon morphs to ✏️ with a flip + one ring pulse, and the diffstat appears. Repeat touches accumulate a `×N` count badge and tooltip history ("read ×2, then edited +12 −4"), never duplicate chips.
- Edited chips carry a **net cumulative diffstat** (`+12 −4`, green/red). Reads carry no diffstat. Created files use ✚. Deleted files remain visible as **tombstones** (ghosted, struck-through) — deletions are never invisible.
- URL chips show the **site favicon** + domain; failures tint the chip red.
- In-progress chips run their verb animation (see §5) plus an animated border sweep; settled chips are still.
- **Click behavior:** file chips open the file in the **canvas (right pane)**; URL chips open the page there too, with external-tab fallback. Never navigate away from the transcript.

## 3. Live overflow behavior

**Screens:** `mockups/02-chips-v1.html` (v1: wrap-fold vs flow-ticker vs kind-decks) → rejected; `mockups/03-chips-v2-hybrid.html` (v2 hybrid)
**v1 feedback:** Dorian liked the dynamism of the ticker but correctly objected: arrivals are bursty/random, sliding off-screen makes past chips unreachable. Asked for a hybrid.
**Research verdict:** no product uses a continuous conveyor or per-file toasts; convention is "quiet accretion" (bounded recent window + incrementing count) with **two-tier disclosure** (compact summary → click-through full view). Documented anti-patterns avoided: Copilot's expanded file panel eating the chat by default (vscode#261081); Codex refusing to show even a file roster when the aggregate diff is large (codex#20233).

**Chosen (v2, Option B "Ledger + pile"):**

- A single bounded **live row** on the assistant turn: the newest ~4 chips. A new chip **pops in on the right** (spring, `opacity 0 → 1`, `y 7 → 0`, slight overshoot) only when a tool touches something — motion is event-driven, never continuous.
- When a chip ages out of the window it is visibly **absorbed into a facepile-style pile** on the left: it shrinks/translates into the stack, the pile **wobbles** as it lands, and the pile's single count badge increments. The pile is the turn's physical, growing record.
- The pile is a single click target: it fans open into the **tray** (below).
- Nothing is ever unreachable: pile + tray always hold the full deduped set.

## 4. Settled state & the tray

**Screen:** `mockups/03-chips-v2-hybrid.html`

- After the turn completes, the live row settles into **one quiet collapsed line**: `📖 21 · ✏️ 3 +34 −11 · 🌐 9 — show all`. Collapsed by default (the #1 community complaint about Copilot's panel is that it isn't).
- Expanding opens the **tray**: the full deduped roster, grouped by kind, with per-kind counter-filters (`📖 21 / ✏️ 3 / 🌐 9`) and an **order toggle: kind ⇄ chronological** (precedent: Claude Code `/diff`'s Current-vs-per-turn lenses — aggregate is the default, chronological is the opt-in audit view).
- The tray is **bounded height and scrolls itself** — it never steals transcript height or scroll. Roster rendering must never be gated on diff size (a roster of 40 names is cheap even when 40 diffs are not).

## 5. The verb motion vocabulary

**Screens:** `mockups/04-verb-vocabulary.html` (multi-select), `mockups/05-verbs-search-delete-round2.html` (search/delete round 2)
**Feedback:** "These look really good" — all approved except search and delete, which got a second round.

| Verb          | Signature (live)                                                                                                                                                                                          | Settled                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 📖 Read       | **The scan** — a soft highlight band sweeps smoothly across the chip, eyes-over-lines                                                                                                                     | plain chip, `×N` if repeated               |
| 🔍 Search     | **The beam** — one smooth angled (skewed) light beam sweeps through. **Beam only — no hit-marks/underlines** (S1 modified; Dorian: "just the angled beam sweeping through. No underline")                 | `🔍 "query"` + `N hits` badge              |
| ✏️ Edit       | **The scribble** — pencil icon wiggles as if writing, a caret blinks in the filename, diffstat digits tick up live as hunks land                                                                          | `✏️ name +A −D`                            |
| ✚ Create      | **Penned into existence** — the chip border draws itself around empty space (SVG stroke-dashoffset), the name fades in inside it, one green spark                                                         | `✚ name +A`                                |
| 🗑 Delete      | **Swallowed by the bin** (D3) — the filename is sucked into the trash icon, compressing and skewing as it goes, a tiny puff escapes, and the bin does a satisfied chomp; the tombstone ghost then settles | ghosted, struck-through chip that persists |
| 🌐 Fetch      | **The ping** — radar rings emanate from the favicon; three dots stream downward beside the domain                                                                                                         | favicon + domain/path                      |
| ▮ Run         | **Terminal pulse** — monospace chip, blinking block cursor, faint green heartbeat on the border                                                                                                           | command + `✓ 2.1s`                         |
| 📖→✏️ Upgrade | **The morph** — icon flips read→edit with a single expanding ring pulse; diffstat slides in                                                                                                               | upgraded chip                              |

Rejected in round 2: search S2 (sonar + ticking counter), S3 (self-typing query); delete D1 (disintegrate — initially chosen, revised to D3), D2 (eraser wipe). Search S1 was chosen **modified**: beam only, no hit-marks.

**Grammar rules (apply to every verb):**

- **Motion means in-progress; stillness means done.** Every animation stops the instant the tool settles.
- Every live animation stays **inside the chip's own bounds** — no layout shift, no neighbors moving.
- `prefers-reduced-motion`: fall back to static icon + subtle opacity pulse; absorption/entry become simple fades.
- Durations follow the design-system 100–300ms band for entries/transitions; only the continuous in-progress loops (scan, beam, ping) run longer cycles.

## 6. Data sourcing

Chips derive **entirely client-side** from data already on the wire — zero schema or server changes for v1:

- Files: `tool_call` parts' `toolName` + `input` (Read/Grep/Glob/Edit/Write/MultiEdit paths), result status for error tint; diffstat from Edit tool results (the existing Edit-diff OutputRenderer already parses this shape).
- URLs: WebFetch/WebSearch inputs; favicon via the standard favicon endpoint with 🌐 fallback.
- Bash: command string from input; duration from existing client-side `startedAt`/`completedAt`.
- Live verb state: `tool_call_start` → animate; `tool_call_end` → settle. (`input_json_delta` streaming already arrives as `tool_call_delta`.)

Known follow-up (out of scope here, documented in the runtime audit): OpenCode's `subtask` parts and `session.diff` payloads and Claude's turn-telemetry fields (`duration_ms`, `num_turns`, `ttft_ms`) are currently dropped by the adapters; Codex `file_change` carries `{path, kind}` only (no diffstat possible — chips degrade gracefully to no-diffstat there).

## 7. Implementation notes

- FSD placement: chip components as a new slice under `features/chat` (e.g. `ui/chips/`), accumulator as a pure lib (`lib/touch-chips.ts`) folding `MessagePart[]` → deduped chip models — unit-testable without DOM.
- The accumulator must be derived-on-render from parts (append-then-merge), not a parallel stateful store, so replay/hydration can never disagree with the transcript.
- **Dev playground is part of done:** isolated showcases in `/dev/chat` (every verb, every state, tombstones, pile, tray) and a `/dev/simulator` scenario with bursty tool arrivals to exercise absorption timing. The simulator already has animation toggles to extend.
- Fix the dead `animate-tasks` keyframe as part of this work (or a preceding fix PR).

## Final Design Summary

On each assistant turn, a touch-chip strip lives at the turn level (surviving tool-call auto-hide). As tools touch files/URLs/commands, deduped chips pop into a bounded live row (newest right), each animating its verb: reads scan, searches sweep an angled beam, edits scribble with a live-ticking diffstat, creations pen their own border into existence, deleted filenames are swallowed into the bin with a chomp and remain as persistent tombstones, fetches ping radar rings from the favicon, commands blink a terminal cursor. A file that's read then edited morphs its chip in place with a ring pulse. Chips aging out of the row are visibly absorbed into a wobbling facepile pile with a count badge. When the turn settles, everything collapses to one quiet summary line; expanding it opens a bounded, self-scrolling tray of the full roster — grouped and filterable by kind, with a kind⇄chronological order toggle. Clicking any chip opens the target in the canvas pane. Motion always means in-progress; a still chip is a settled fact.
