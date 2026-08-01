---
slug: chat-touch-chips
id: 260801-135340
created: 2026-08-01
status: specified
---

# Chat Touch Chips — files & URLs the agent handled, with a verb motion language

**Status:** Approved (gates pre-approved by Dorian for autonomous execution)
**Author:** Claude (design session with Dorian, 2026-07-31 → 2026-08-01)
**Date:** 2026-08-01

## Overview

Every assistant turn gets a **touch-chip strip**: a live, deduplicated row of the files, URLs, and commands the agent is touching, each chip animating a verb-specific motion signature while its tool runs, absorbing into a growing pile as new touches arrive, and settling into a one-line summary with an expandable tray when the turn completes. Clicking any chip opens its target in the canvas pane. Design authority: `design-decisions.md` + the checked-in animated mockups in `mockups/` (normative for timing/easing/choreography; port, don't copy).

## Background / Problem Statement

Tool calls auto-hide after completion, so a turn's "what did the agent actually touch" record evaporates. During long research/edit turns the user has no ambient signal of what is being read, changed, or fetched without expanding individual tool cards. The design session (spec `260801-135340`) locked a Calm+ direction with touch chips grafted from the Mission Control concept.

## Goals

- Turn-level, durable "what was touched" record that survives tool-call auto-hide.
- Live, verb-specific motion while tools run (read scans, search sweeps, edit scribbles + ticking diffstat, create pens itself in, delete swallowed by the bin, fetch pings, run blinks).
- One chip per unique target (append-then-merge dedup; read→edit upgrades in place with ring pulse; net diffstat; ×N repeat badge; persistent tombstones for deletions).
- Bounded live row (~4 newest) + pile absorption (facepile + count badge, wobble on landing) + settled collapsed summary line + bounded self-scrolling tray (kind filters, kind ⇄ chronological order toggle).
- Chip click opens target in canvas: files via `openCanvasDocument({type:'file', sourcePath})`, URLs via `{type:'url', url}`.
- Fix the dead `animate-tasks` CSS class (used ~20×, keyframe never defined).
- Dev playground showcases + a simulator scenario with bursty arrivals.

## Non-Goals

- No server/schema changes — chips derive entirely client-side from existing `MessagePart[]` data.
- None of the other Mission Control elements (shimmer thinking label, EKG, turn receipt, context gauge, orbiting subagents).
- No runtime-adapter gap fixes (OpenCode `subtask`/`session.diff`, Claude turn telemetry) — documented follow-ups.
- No external favicon fetching (privacy: the cockpit makes no third-party requests). URL chips use hashed-color letter tiles (same spirit as `resolveAgentVisual`), 🌐 only as a non-http fallback.
- No chips inside subagent transcripts (`BackgroundTaskPart.subagentText`) — parent-turn tools only, v1.

## Technical Dependencies

- `motion/react` (installed) — springs, `AnimatePresence`, FLIP layout for row shifts.
- Tailwind v4 + CSS keyframes in `apps/client/src/index.css` for continuous verb loops.
- No new dependencies.

## Detailed Design

### Data derivation (pure, client-side)

New pure module `apps/client/src/layers/features/chat/lib/touch-chips.ts`:

```ts
interface TouchChip {
  key: string; // normalized target identity (abs path or normalized URL or command)
  kind: 'file' | 'url' | 'command';
  label: string; // basename / domain / command
  fullTarget: string; // full path / URL for tooltip + canvas open
  verb: 'read' | 'search' | 'edit' | 'create' | 'delete' | 'fetch' | 'run';
  live: boolean; // any contributing tool_call still pending/running
  error: boolean;
  touches: number; // dedup counter
  additions?: number;
  deletions?: number; // net, edits only
  upgraded?: boolean; // read→edit transition happened (drives morph)
  firstSeq: number;
  lastSeq: number; // ordering for chronological lens
  history: string[]; // tooltip audit trail ("read ×2, then edited +12 −4")
}

function accumulateTouchChips(parts: MessagePart[]): TouchChip[];
```

Fold every `tool_call` part in order (append-then-merge — never track by latest state; Cursor's silent-drop bug is the cautionary tale). Tool → verb mapping:

| Tool                             | Verb                                                 | Target                                                                                                                                                                        |
| -------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read, Glob                       | read                                                 | `input.file_path` / `input.pattern` base dir → file chips (Glob: the pattern as one chip)                                                                                     |
| Grep                             | search                                               | `input.pattern` (label = quoted pattern; hits count from result when parseable)                                                                                               |
| Edit, MultiEdit, NotebookEdit    | edit                                                 | `input.file_path`; diffstat estimated from the tool input's `old_string`/`new_string` line counts (the `parseEditInput` precedent in `OutputRenderer.tsx`), else omit numbers |
| Write                            | create if the result indicates a new file, else edit | `input.file_path`                                                                                                                                                             |
| Bash                             | run                                                  | the command string; additionally parse `rm`/`git rm` argv → delete chips per path (best-effort; unparseable → no delete chip)                                                 |
| WebFetch                         | fetch                                                | `input.url`, key = normalized URL (strip hash), label = registrable domain                                                                                                    |
| WebSearch                        | search                                               | `input.query` labeled with 🔍                                                                                                                                                 |
| Task/Agent, TodoWrite, MCP tools | none (v1)                                            | excluded                                                                                                                                                                      |

Verb precedence on merge: `delete` > `create` > `edit` > everything; read-then-edit sets `upgraded` once (the morph animates exactly once, driven by a key change, not re-render).

### Components (`apps/client/src/layers/features/chat/ui/chips/`)

- `TouchChipStrip.tsx` — orchestrates the three lifecycle states: **live** (row of newest ≤4 live-or-recent chips, pile on the left), **settled** (collapsed one-line summary), **expanded** (tray). Mounted in `AssistantMessageContent` after the parts run, gated on `chips.length > 0`. Memoized: `useMemo(() => accumulateTouchChips(parts), [parts])`.
- `TouchChip.tsx` — one chip; verb animation via a `data-verb` attribute + CSS classes; `motion.button` with pop-in spring (`stiffness 320, damping 28`, `y:7→0`, slight overshoot); click → canvas open; tooltip with `history`.
- `ChipPile.tsx` — overlapping stack (3 mini-chips max + count badge), wobble keyframe on count change; click → expand tray.
- `ChipTray.tsx` — full roster, kind counter-filters, `kind ⇄ chronological` toggle, `max-h` + `overflow-y-auto`, ARIA disclosure (`button[aria-expanded]` + `role=region`).
- Absorption: when a chip leaves the live window, `AnimatePresence` exit animates it toward the pile (translate/scale toward a `layoutId` anchor is overkill — exit `x:-16, scale:.45, opacity:0` over 250ms + pile wobble is the ported mockup behavior).

Canvas integration: `useAppStore().openCanvasDocument` (`layers/shared/model/app-store/app-store-canvas.ts:96`) — `{type:'file', sourcePath}` for files (CodeMirror/Blintz routing is built-in), `{type:'url', url}` for links. In embedded/Obsidian mode where the canvas is unavailable, fall back to opening the URL in a new tab and file chips no-op with tooltip (assumption logged).

### Verb animations (normative source: `mockups/04-verb-vocabulary.html`, `05-…round2.html`)

CSS keyframes added to `index.css` under a `/* touch chips */` block, all scoped `.chip-*`: scan sweep (read), skewed beam (search — beam only, no hit marks), scribble+caret (edit) with diffstat digits ticking via a `motion` spring on number change (not the mockup's fake odometer), border-draw + spark (create, SVG `stroke-dashoffset`), bin-swallow (delete: name compresses/skews into the icon, puff, bin chomp; tombstone ghost persists), radar ping (fetch), block-cursor blink + heartbeat border (run), upgrade morph (icon flip + one ring pulse). Grammar: animation runs only while `live`; stops the frame the tool settles; all motion inside chip bounds; `prefers-reduced-motion` → static icon + gentle opacity pulse, absorption/entry become fades (`useReducedMotion` from motion + the existing `MotionConfig reducedMotion="user"`).

### `animate-tasks` fix

Define the missing utility in `index.css` (`@utility animate-tasks` + `@keyframes tasks` — a calm 1.6s opacity/scale breathe matching the design-system band), restoring the ~20 existing call sites (ThinkingBlock, MemoryRecallBlock, skeletons, …). One focused commit inside this PR.

### Virtualization note

`MessageList` uses TanStack Virtual with dynamic measurement. The strip changes height (live row appears, tray expands). The tray is bounded (`max-h-[240px]`) and the live row is fixed-height, so re-measure events are bounded; follow the existing pattern used by tool-card expand (measureElement on transition end). No `overflow-anchor` changes.

## User Experience

Covered by the design doc's Final Design Summary; the implementing agent should treat `mockups/*.html` as the acceptance reference for feel. Settled default is the collapsed line; user expansion state is per-message, not persisted.

## Testing Strategy

- **Unit (`lib/__tests__/touch-chips.test.ts`)**: dedup by path/URL normalization; read→edit upgrade sets `upgraded` once; net diffstat accumulation across multiple edits; `rm` parsing (plain, `-rf`, multiple args, quoted paths, non-rm commands produce no delete); Write-new vs Write-existing; error tint propagation; chronological vs kind ordering; ×N counting; URL hash stripping.
- **Component (RTL + jsdom)**: strip renders live row for streaming message; settles to summary line when no part is live; tray opens/filters/toggles order with correct ARIA; chip click calls `openCanvasDocument` with the right `UiCanvasContent`; reduced-motion renders no looping animation classes. jsdom cannot verify animation feel — that's the playground/simulator's job (and the known Radix-focus-race lesson: browser-verify interactive flows).
- **Playground**: showcases in `/dev/chat` for every verb × (live, settled, error, tombstone), pile, tray; registered in `playground-registry.ts`.
- **Simulator**: new scenario `touch-chips.ts` — bursty arrivals (3 tools in 1s, idle 10s, more), read-then-edit same file, an `rm`, a WebFetch batch — exercising absorption timing end-to-end.

## Performance Considerations

Accumulator is O(parts) per message render, memoized on `parts` identity. Chips render is bounded (≤4 live + pile + capped tray). Continuous CSS loops only on live chips (≤4 concurrent); all transform/opacity (compositor-friendly). No timers except animation.

## Security Considerations

No external requests (letter-tile favicons). Canvas file opens go through the existing server file-service path confinement. URL chips render `href`-less buttons; opening routes through canvas URL viewer or `window.open` with `noopener,noreferrer`.

## Documentation

- Changelog fragment (writing-for-humans voice): "See every file and link your agent touches, live."
- No docs-site page for v1 (UI is self-explanatory); playground is the internal reference.

## Implementation Phases

- **Phase 1 — accumulator + static chips**: `touch-chips.ts` + tests; `TouchChip`/`TouchChipStrip` with settled line + tray (no motion); canvas click-through; `animate-tasks` fix.
- **Phase 2 — lifecycle motion**: live row, pop-in, pile absorption + wobble, upgrade morph, settle transition.
- **Phase 3 — verb signatures + rigs**: all seven verb loops + reduced-motion fallbacks; playground showcases; simulator scenario; polish pass against mockups.

## Open Questions

- ~~Favicons: external service vs local?~~ **(RESOLVED)** Local letter tiles, no third-party requests. Rationale: privacy-first personas, zero-latency, consistent with agent-emoji hashing.
- ~~Where does the strip live relative to tool cards?~~ **(RESOLVED)** Turn-level, after the parts run in `AssistantMessageContent` — survives tool-call auto-hide, which is the point.
- ~~Embedded (Obsidian) mode without canvas?~~ **(RESOLVED)** URL chips open a new tab; file chips show tooltip only. Logged as assumption; revisit when the plugin surface is verified.

## Related ADRs

- Draft ADR seeded by this spec: touch chips derive client-side from transcript parts (append-then-merge; no schema change).
- ADR 260708-185518 (multi-document canvas), ADR-0290/0291/0292 (canvas editing) — the click-through target.

## References

- `specs/chat-touch-chips/design-decisions.md` + `mockups/` (normative motion reference)
- `research/20260801_touched_file_chip_ui_patterns.md` (cross-product survey)
- `research/20260320_chat_message_list_animations.md`, `research/20260309_chat_microinteractions_polish.md`
- Client seams: `layers/shared/model/app-store/app-store-canvas.ts` (`openCanvasDocument`), `layers/features/chat/ui/message/AssistantMessageContent.tsx`, `layers/shared/model/chat-message-types.ts`, `layers/features/chat/ui/message/OutputRenderer.tsx` (`parseEditInput`), `dev/playground-registry.ts`, `dev/simulator/scenarios/`
