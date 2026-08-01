# Tasks — Chat Touch Chips

Spec: `specs/chat-touch-chips/02-specification.md`
Design authority: `specs/chat-touch-chips/design-decisions.md` + `specs/chat-touch-chips/mockups/*.html` (normative for motion timing/easing/choreography — port, don't copy)
Generated: 2026-08-01T14:23:06Z · Mode: full

14 tasks across 3 phases. Critical path: **1.1 → 1.4 → 2.1 → 2.4 → 3.1 → 3.2 → 3.4** (7 steps).

---

## Phase 1: Accumulator + static chips

### Task 1.1: Build the accumulateTouchChips pure module

Create `apps/client/src/layers/features/chat/lib/touch-chips.ts` — a pure, DOM-free module that folds a message's `MessagePart[]` into a deduplicated `TouchChip[]`. Export the `TouchChip` interface exactly as specified:

```ts
export interface TouchChip {
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

export function accumulateTouchChips(parts: MessagePart[]): TouchChip[];
```

`MessagePart` (import from `@dorkos/shared/types`) `tool_call` variant fields available: `toolCallId`, `toolName`, `input?: string` (JSON-encoded), `result?: string`, `status: 'pending' | 'running' | 'complete' | 'error'`. `firstSeq`/`lastSeq` are the part's index position in the `parts` array (there is no separate seq field on the wire type — use array index as the ordering key, since parts already arrive in chronological order).

Algorithm: iterate `parts` in order, for every `tool_call` part with a mappable `toolName`, derive `(key, kind, verb, target)` per this table, then append-then-merge into a `Map<string, TouchChip>` keyed by `key` — never overwrite by "latest tool state", always fold the new touch into the existing chip's counters/history (Cursor's silent-drop bug is the cautionary tale named in the spec).

Tool → verb/target mapping (parse `input` as JSON; on parse failure, skip the part — never throw):

- `Read`, `Glob` → verb `read`; target = `input.file_path` (Read) or `input.pattern` (Glob, the pattern string itself is the chip's target/label, kind `file`).
- `Grep` → verb `search`; target = `input.pattern`; label = the pattern in quotes; kind `command`. If `result` is parseable for a hit count (best-effort — line-count fallback), surface it via `history`; when not parseable, omit hit-count details.
- `Edit`, `MultiEdit`, `NotebookEdit` → verb `edit`; target = `input.file_path`; kind `file`. **Diffstat correction**: this feature has no `structuredPatch` field anywhere in `packages/shared/src/schemas.ts` or the tool_call result shape — do NOT reference one. Instead, for `Edit`, parse `input.old_string` / `input.new_string` (same fields `OutputRenderer.tsx`'s `parseEditInput` at `apps/client/src/layers/features/chat/ui/message/OutputRenderer.tsx:46-63` already parses) and compute a line-count diffstat via a coarse deterministic heuristic (split on `\n`, difference in line counts). For `MultiEdit`, sum across `input.edits[]`. For `NotebookEdit`, omit `additions`/`deletions` if the shape doesn't match rather than fabricate numbers. Accumulate net across every edit touching the same key.
- `Write` → target = `input.file_path`; kind `file`. Verb `create` if the result indicates a new file, else `edit`. Detection heuristic: parse `result` for the substring "created" (case-insensitive) → `create`, else `edit` — document this with an inline comment since it's runtime-phrasing-dependent; verify in-browser once Phase 1 UI exists.
- `Bash` → verb `run`; target = the raw command string (`input.command`); kind `command`. Additionally, best-effort parse `rm` / `git rm` invocations (split on `&&`/`;`/`|`, extract trailing path args, handle `-rf`/`-r`/`-f` flags and quoted paths with a simple tokenizer). Each parsed path becomes an independent `delete`-verb chip merged into the same pass. Unparseable `rm` invocations produce no delete chip.
- `WebFetch` → verb `fetch`; target = `input.url`; key = the URL with `#hash` stripped; label = the registrable domain; kind `url`.
- `WebSearch` → verb `search`; target = `input.query`; label = `🔍 ${query}`; kind `command`.
- `Task`/`Agent`, `TodoWrite`, and any `mcp__*` tool name → excluded entirely (v1 scope, per spec Non-Goals).

Verb precedence on merge: `delete` > `create` > `edit` > everything else — a chip's final `verb` is the highest-precedence verb it has ever seen. When a chip transitions read→edit for the first time, set `upgraded = true` exactly once (never re-trigger on subsequent edits).

`live`: true if any contributing tool_call currently has `status === 'pending' || 'running'`. `error`: true if any contributing tool_call has `status === 'error'`. `touches`: incremented once per folded tool_call part. `history`: one formatted entry per touch (e.g. `read`, `edited +12 −4`).

Output ordering: returns chips in **first-touch order** (ascending `firstSeq`) by default; callers sort for other lenses.

**Acceptance criteria**: zero React/DOM imports (verify with `pnpm --filter @dorkos/client typecheck` — no JSX, no `motion/react`, no `document`/`window`), named exports `TouchChip` and `accumulateTouchChips`, every branch above implemented with no `// TODO` stubs.

- **Size**: large
- **Priority**: high
- **Dependencies**: none
- **Parallel with**: 1.3

---

### Task 1.2: Write exhaustive unit tests for accumulateTouchChips

Create `apps/client/src/layers/features/chat/lib/__tests__/touch-chips.test.ts` (Vitest, no DOM). Build `MessagePart[]` fixtures directly.

Required scenarios, each its own `it()`:

1. Dedup by path — two `Read` parts on the same file → one chip, `touches: 2`.
2. Dedup by URL normalization — hash-only-differing URLs dedup to one chip; `label` is the registrable domain.
3. Read→edit upgrade sets `upgraded: true` once; a third touch does not re-toggle it.
4. Net diffstat accumulation across two `Edit` parts on the same file — sum, not last-write.
5. `rm` parsing — plain (`rm foo.txt`).
6. `rm` parsing — flags (`rm -rf dist/`, `rm -r -f build/`).
7. `rm` parsing — multiple args (`rm a.txt b.txt c.txt` → 3 delete chips).
8. `rm` parsing — quoted paths with interior spaces.
9. `rm` parsing — `git rm` too.
10. `rm` parsing — non-rm commands (`pnpm test`) produce no delete chip.
11. Write — new file (`result` contains "created") → `verb: 'create'`.
12. Write — existing file (`result` lacks "created") → `verb: 'edit'`.
13. Error tint propagation — sticky: a later success does not clear `error: true`.
14. Chronological vs kind ordering — default array order is ascending `firstSeq`; separately verify sort-by-kind-then-firstSeq produces the tray's expected grouping.
15. ×N counting — three `Read` parts → `touches: 3`, `history` reflects it.
16. URL hash stripping — query preserved, hash dropped.
17. Verb precedence — read → edit → read again stays `verb: 'edit'`.
18. Excluded tools — `TodoWrite`, `Task`, `mcp__foo__bar` produce zero chips.
19. Malformed input JSON is skipped without throwing.

Run `pnpm vitest run apps/client/src/layers/features/chat/lib/__tests__/touch-chips.test.ts`. Every row of the spec's mapping table needs at least one asserting test — this is the highest-value test file in the feature.

- **Size**: large
- **Priority**: high
- **Dependencies**: 1.1

---

### Task 1.3: Define the missing animate-tasks keyframe in index.css

Fix dead CSS in `apps/client/src/index.css`: `animate-tasks` is referenced at 34 call sites (`grep -rln "animate-tasks" apps/client/src | wc -l`) — including `ThinkingBlock.tsx`, `NamespaceGroupNode.tsx`, `ServerTab.tsx`, `TunnelDialog.tsx`, `TaskTemplateGallery.tsx`, `TasksPanel.tsx` — but no `@keyframes tasks` or `@utility animate-tasks` exists anywhere. The pulse is silently dead.

Add, following the exact `@keyframes` + `@utility` pattern already used for `animate-drain` (`apps/client/src/index.css:660-669`):

```css
@keyframes tasks {
  0%,
  100% {
    opacity: 0.6;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.02);
  }
}

@utility animate-tasks {
  animation-name: tasks;
  animation-duration: 1.6s;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
}
```

Match the design-system's calm breathing band — a faster, quieter cousin of the existing `@keyframes breathe` (`index.css:628-639`, 3s cycle on `.dorkbot-avatar`). Do not touch any of the 34 call sites — they already reference the class name. Verify visually: `pnpm dev:dogfood`, open a session with `ThinkingBlock` visible mid-stream, confirm it now pulses. One focused commit, independent of the rest of the feature.

- **Size**: small
- **Priority**: medium
- **Dependencies**: none
- **Parallel with**: 1.1

---

### Task 1.4: Build static TouchChip and TouchChipStrip components

Create the new FSD slice `apps/client/src/layers/features/chat/ui/chips/` (match the barrel convention already used by sibling slices `ui/tools/` and `ui/primitives/` in this same feature).

**`TouchChip.tsx`** — renders one `TouchChip` (task 1.1's type) as a plain `<button>` (the `motion.button` pop-in lands in Phase 2, task 2.1). Props: `{ chip: TouchChip; onOpen: (chip: TouchChip) => void }`. Renders a verb icon (📖 read, 🔍 search, ✏️ edit, ✚ create, 🗑 delete, 🌐 fetch, ▮ run — per `design-decisions.md` §5), the `label`, an `×N` badge when `touches > 1`, and a `+A −D` diffstat badge in green/red using existing design tokens (never hardcoded hex — `.claude/rules/components.md`) when defined. Deleted chips render ghosted + `line-through` (persistent tombstone). Error chips get a destructive-tinted border (reuse the classes already used by `ErrorMessageBlock.tsx`, don't invent new ones). A `title` attribute carries the joined `chip.history` as the tooltip. `data-verb={chip.verb}` and `data-live={chip.live}` on the root — Phase 3's CSS keys off these even though nothing reads them yet.

Click handling (canvas integration, required now): `onClick={() => onOpen(chip)}`. `TouchChipStrip` implements `onOpen` via `useAppStore().openCanvasDocument` (`@/layers/shared/model`; signature at `apps/client/src/layers/shared/model/app-store/app-store-canvas.ts:96`). File kind → `openCanvasDocument({ type: 'file', sourcePath: chip.fullTarget })` (exact shape, `packages/shared/src/schemas.ts:3178-3186` — field is `sourcePath`). URL kind → `openCanvasDocument({ type: 'url', url: chip.fullTarget })` (`packages/shared/src/schemas.ts:3116-3120`). Command kind → click is a no-op (tooltip only).

Embedded/Obsidian-mode fallback (spec Open Questions, resolved): reuse this app's existing embedded-mode detection (search `layers/shared/model/app-store/` — don't invent a new check). When embedded and canvas is unavailable: URL chips `window.open(chip.fullTarget, '_blank', 'noopener,noreferrer')`; file chips become inert (tooltip only) — the logged assumption; never claim in UI copy that this works in the plugin until it's verified (demo-claim gate).

**`TouchChipStrip.tsx`** — mounted in `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx` after the parts render loop, gated on `chips.length > 0`. Props: `{ parts: MessagePart[] }` (pass `message.parts ?? []`, already destructured at `AssistantMessageContent.tsx:251`). `const chips = useMemo(() => accumulateTouchChips(parts), [parts]);`.

This phase implements **settled only** (no live row/pile — Phase 2): a collapsed summary line `📖 21 · ✏️ 3 +34 −11 · 🌐 9 — show all` grouped by kind, trailing "show all" button that expands the tray (task 1.5), local `useState` for expanded state (per-message, not persisted).

- **Size**: large
- **Priority**: high
- **Dependencies**: 1.1

---

### Task 1.5: Build the ChipTray component with kind filters and ordering toggle

Create `apps/client/src/layers/features/chat/ui/chips/ChipTray.tsx`. Props: `{ chips: TouchChip[]; onOpen: (chip: TouchChip) => void; onClose?: () => void }`.

- **Per-verb counter-filters**: `📖 21 / ✏️ 3 / 🌐 9`-style segments grouped by `chip.verb` (matches the spec's example, which groups by glyph not the coarser `kind`). Click toggles filtering to that verb; click again clears back to "all".
- **Order toggle**: `kind ⇄ chronological` (reuse an existing toggle/segmented-control primitive from `layers/shared/ui/` — check before adding a new one). "Kind" groups by `verb` then `firstSeq`; "chronological" sorts the flat list by `lastSeq` ascending (precedent: Claude Code `/diff`'s Current-vs-per-turn lenses). Both are pure `Array.prototype.sort` over the `chips` prop.
- **Bounded, self-scrolling**: `max-h-[240px] overflow-y-auto` (verbatim bound from `02-specification.md:108`) — never steals transcript scroll.
- **ARIA disclosure**: the "show all" trigger (in `TouchChipStrip.tsx`) gets `aria-expanded` + `aria-controls`; the tray container gets `role="region"` + `aria-label` (e.g. "Touched files and links") — per `02-specification.md:93`.

No motion in this task — instant conditional render (`AnimatePresence` is out of scope here). Wire into `TouchChipStrip.tsx` as the expanded-state render.

- **Size**: medium
- **Priority**: high
- **Dependencies**: 1.4

---

### Task 1.6: Component-test the static chip strip, tray, and canvas click-through

Create `apps/client/src/layers/features/chat/ui/chips/__tests__/TouchChipStrip.test.tsx` (split into a sibling `ChipTray.test.tsx` if it grows past the 300/500-line guidance in `.claude/rules/conventions.md`). RTL + jsdom, mock `Transport` via `TransportProvider` (match an existing test in `apps/client/src/layers/features/chat/__tests__/`, e.g. `MessageItem.test.tsx`).

Required scenarios:

1. Settled summary line renders with correct grouped glyphs/counts and a "show all" trigger.
2. No chips ⇒ `TouchChipStrip` renders nothing.
3. Tray opens on "show all" click; trigger's `aria-expanded` flips to `true`.
4. Tray filters by verb — click toggles filtered set, click again restores all.
5. Tray order toggle changes DOM order between kind and chronological modes (use fixtures where the two orders are provably different).
6. ARIA correctness — tray has `role="region"` + accessible name; trigger reflects open state.
7. Chip click calls `openCanvasDocument` with the correct `UiCanvasContent` for both file (`{type:'file', sourcePath}`) and URL (`{type:'url', url}`) chips (mock/spy `useAppStore`, following this repo's existing mocking convention for it).
8. Reduced-motion renders no looping animation class (lighter placeholder in this phase — real teeth land with Phase 3's CSS; note this explicitly in the test file so it isn't mistaken for full coverage).

Run `pnpm vitest run apps/client/src/layers/features/chat/ui/chips/__tests__/TouchChipStrip.test.tsx`. jsdom cannot verify animation feel — deferred to Phase 3's playground/simulator per the spec's Testing Strategy.

- **Size**: medium
- **Priority**: high
- **Dependencies**: 1.4, 1.5

---

## Phase 2: Lifecycle motion

### Task 2.1: Add live-row windowing and pop-in spring to the chip strip

Extend `TouchChipStrip.tsx` with the **live** state: while streaming and at least one chip has `live: true`, render a bounded row of the newest ≤4 live-or-recent chips (order by `lastSeq` descending, take 4, re-reverse for left-to-right newest-on-right — `02-specification.md:90`). Chips beyond the window are not removed here — task 2.2 (`ChipPile`) handles their fate; this task only owns windowing + entry animation.

Convert `TouchChip.tsx`'s root to `motion.button` (import from `motion/react`, already installed — see `AssistantMessageContent.tsx:2`). Pop-in spring, verbatim: `initial={{ opacity: 0, y: 7 }}`, `animate={{ opacity: 1, y: 0 }}`, `transition={{ type: 'spring', stiffness: 320, damping: 28 }}` (from `02-specification.md:91` / `design-decisions.md:38`). Fires only on true mount of a new chip — use the chip's stable `key` as the React `key` prop so entry/exit tracks mount/unmount, not prop diffs.

`useReducedMotion()` from `motion/react`: fallback pop-in becomes an opacity-only fade, no `y` offset (`design-decisions.md:73`). Confirm the app's `MotionConfig reducedMotion="user"` wraps the tree the strip renders under (grep `reducedMotion` in `apps/client/src`).

Strip mode: **live** when any chip has `live: true`; **settled** (task 1.4's summary line) once all are `false`. This task may do a hard swap between the two — the animated settle transition is task 2.3.

- **Size**: medium
- **Priority**: high
- **Dependencies**: 1.4

---

### Task 2.2: Build ChipPile with absorption exit and wobble

Create `apps/client/src/layers/features/chat/ui/chips/ChipPile.tsx`. Renders an overlapping facepile of up to 3 mini-chip tiles plus a total count badge. Props: `{ chips: TouchChip[]; onExpand: () => void }` — click opens the tray (task 1.5).

**Absorption**: wrap the live row in `AnimatePresence`; a chip aging out of the 4-window (task 2.1's cutoff) exits with `exit={{ x: -16, scale: 0.45, opacity: 0 }}` over `250ms` (verbatim, `02-specification.md:94`) — do not attempt the rejected `layoutId`-anchor approach the spec calls "overkill".

**Wobble**: pile count increment triggers a brief wobble (e.g. `rotate: [0, -4, 3, 0]` over ~300ms, keyed to the count bump). If task 2.2 is the first to touch the `/* touch chips */` CSS block in `index.css`, start it; Phase 3 (task 3.1) appends to the same block rather than creating a duplicate. Wobble fires once per landing, not continuously.

Reduced motion: both absorption and wobble collapse to simple fades/no-op.

Wire into `TouchChipStrip.tsx`'s live-row rendering, positioned left of the row per spec ("pile on the left").

- **Size**: medium
- **Priority**: high
- **Dependencies**: 2.1, 1.5

---

### Task 2.3: Implement the upgrade morph and live-to-settled settle transition

**Upgrade morph** (`TouchChip.tsx`): when `chip.upgraded` flips false→true, animate icon flip + one expanding ring pulse + diffstat sliding in (`design-decisions.md:65`, `02-specification.md:100`). Drive off a `key` change (not re-render — spec is explicit, `02-specification.md:86`), e.g. `AnimatePresence mode="wait"` keyed on the icon identity. Ring pulse: `motion.span` overlay, `initial={{ scale: 0.6, opacity: 0.8 }}`, `animate={{ scale: 1.8, opacity: 0 }}`, `transition={{ duration: 0.3 }}`, removed via `onAnimationComplete` or `AnimatePresence` unmount — never left permanently mounted. Diffstat badge fades/slides in alongside.

**Settle transition** (`TouchChipStrip.tsx`): when the strip flips live→settled (task 2.1's hard swap becomes animated), wrap both containers in `AnimatePresence`: live row `exit={{ opacity: 0, height: 0 }}`, settled line `initial={{ opacity: 0 }}` fade-in, `transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}` — reuse the exact easing curve already used for tool-call auto-hide (`AssistantMessageContent.tsx:96`) rather than inventing a new one.

Both respect `useReducedMotion()`: instant icon swap (no ring pulse) and instant opacity swap (no height animation), respectively.

- **Size**: medium
- **Priority**: medium
- **Dependencies**: 2.1

---

### Task 2.4: Handle virtualizer re-measure and test the full lifecycle

**Virtualizer re-measure**: `MessageList.tsx` uses TanStack Virtual with dynamic measurement. `TouchChipStrip`'s height changes across its states (no chips → live row → tray expanded to `max-h-[240px]`) must trigger a bounded re-measure, following "the existing pattern used by tool-card expand (measureElement on transition end)" (`02-specification.md:108`). Locate that pattern (the tool-card auto-hide height animation at `AssistantMessageContent.tsx:93-98` is the adjacent precedent) and apply the identical mechanism at the strip's transition-end points (settle transition from 2.3, tray open/close from 1.5) — not on every animation frame. No `overflow-anchor` changes needed (spec explicitly rules this out).

**Full-lifecycle tests**, extending `apps/client/src/layers/features/chat/ui/chips/__tests__/`:

1. A chip's `live` flips true→false mid-test (re-render with updated `parts`) — strip settles, live row unmounts.
2. A 5th chip's arrival ages the 1st out — pile count increments, aged-out chip leaves the live row's DOM.
3. Read→edit upgrade morph fires exactly once across 3 sequential edits to the same file.
4. `MessageList`'s virtualizer re-measure is invoked when a `TouchChipStrip` changes height (spy/mock `measureElement`, matching this repo's existing virtualizer test setup if `MessageList` already has one).

Run `pnpm vitest run apps/client/src/layers/features/chat/ui/chips/__tests__/` and the relevant `MessageList` test file.

- **Size**: medium
- **Priority**: medium
- **Dependencies**: 2.1, 2.2, 2.3

---

## Phase 3: Verb signatures + rigs

### Task 3.1: Add the seven verb CSS animations and reduced-motion fallbacks

Add to the `/* touch chips */` block in `apps/client/src/index.css` (append to it if task 2.2 started it). Normative source: `specs/chat-touch-chips/mockups/04-verb-vocabulary.html` and `05-verbs-search-delete-round2.html` — port, don't copy; every loop gates on `data-verb` + `chip.live === true` and stops the instant the tool settles (`design-decisions.md:71`).

Seven animations, keyed off `data-verb` (wired in task 1.4):

1. **Read — the scan**: soft highlight band sweeps across the chip.
2. **Search — the beam**: one smooth skewed light beam. Beam only — no hit-marks/underlines (explicitly rejected in round 2, `design-decisions.md:59`/`:67`).
3. **Edit — the scribble**: pencil-icon wiggle + blinking caret (reuse `@keyframes blink-cursor` at `index.css:581` if it fits). Diffstat digits tick up live via a `motion` spring on value change in `TouchChip.tsx`, not a CSS "fake odometer" (`02-specification.md:98-100`) — implement here if not already done in 2.3.
4. **Create — border-draw + spark**: chip border draws itself via SVG `stroke-dashoffset`, name fades in, one green spark. Single-shot (creates don't loop).
5. **Delete — bin-swallow**: filename compresses/skews into the bin icon, a puff, a satisfied chomp. Single-shot into the static tombstone state from task 1.4.
6. **Fetch — the ping**: radar rings from the favicon-tile position + three streaming dots (reuse/adapt `@keyframes typing-dot` at `index.css:568`).
7. **Run — terminal pulse**: monospace styling, blinking block cursor (reuse `@keyframes blink-cursor`), faint green heartbeat border (reuse/adapt `@keyframes health-pulse` at `index.css:919`).

Grammar across all seven (`design-decisions.md:69-74`): motion stays inside chip bounds, no neighbor-shifting; entries/transitions in the 100-300ms band, only the continuous loops (scan, beam, ping) run longer (match mockup cycle periods, don't guess).

**Reduced motion**: a `@media (prefers-reduced-motion: reduce)` block (plus the React-side `useReducedMotion()` gating from tasks 2.1-2.3) replacing all seven loops with a static icon + one subtle opacity pulse — reuse `@keyframes breathe` or `animate-tasks` (task 1.3), don't add an eighth keyframe.

- **Size**: large
- **Priority**: high
- **Dependencies**: 1.4, 2.1
- **Parallel with**: 3.3

---

### Task 3.2: Register touch-chip showcases in the dev playground

Create `apps/client/src/dev/showcases/ChipShowcases.tsx`, following the exact pattern of `apps/client/src/dev/showcases/ToolShowcases.tsx` / `MessageShowcases.tsx` (mock data via `apps/client/src/dev/mock-chat-data.ts`'s `createToolCall`/`createAssistantMessage` helpers, same as the simulator scenarios).

Required sections (per `02-specification.md:118`: "showcases in `/dev/chat` for every verb × (live, settled, error, tombstone), pile, tray"):

1. Every verb, live state (7 chips, `live: true`, Phase 3 CSS visible).
2. Every verb, settled state (`live: false`).
3. Error state (read + edit with `error: true`).
4. Tombstone state (persistent delete chip).
5. `ChipPile` with a representative count + a trigger button to re-fire the wobble on demand.
6. `ChipTray` pre-populated with a realistic 10-20 chip mixed roster, filters and order toggle visible.

Register each section in `apps/client/src/dev/sections/chat-sections.ts` (append to `CHAT_SECTIONS`, matching the existing `{ id, title, page: 'chat', category, keywords }` shape — use `category: 'Chips'`). Wire into `apps/client/src/dev/pages/ChatPage.tsx` (`import { ChipShowcases } from '../showcases/ChipShowcases';` + `<ChipShowcases />`, matching the existing flat composition there).

Verify: `pnpm dev:dogfood`, navigate to `/dev/chat`, confirm the "Chips" category appears in TOC/search and every section renders without console errors.

- **Size**: medium
- **Priority**: medium
- **Dependencies**: 3.1

---

### Task 3.3: Add the touch-chips simulator scenario with bursty arrivals

Create `apps/client/src/dev/simulator/scenarios/touch-chips.ts`, following `apps/client/src/dev/simulator/scenarios/multi-tool-chain.ts` (a `SimScenario` with `id`/`title`/`description`/`steps`, built from `createUserMessage`/`createAssistantMessage`/`createToolCall` and step types `append_message`/`set_status`/`append_tool_call`/`update_tool_call` with `delayMs`).

Required shape (`02-specification.md:119`):

1. Bursty arrival burst — 3 tool calls within roughly 1000ms.
2. Idle gap — roughly 10 seconds of no activity, demonstrating live loops (3.1) genuinely stop.
3. More arrivals resuming after the idle gap, pushing the earlier burst deeper into the pile.
4. Read-then-edit on the same `file_path` — exercises the upgrade morph (2.3) end-to-end, which jsdom unit tests (1.2) cannot verify.
5. An `rm` via `Bash` — exercises delete-chip parsing (1.1) and the bin-swallow animation (3.1).
6. A WebFetch batch — 2-3 URLs fired close together, some sharing a domain to exercise dedup/grouping.

Register in `apps/client/src/dev/simulator/scenarios/index.ts` (add the export alongside the existing ones) and in the simulator's scenario picker/consumer (find it by grepping for how `multiToolChain` is consumed outside `scenarios/`).

Only needs the accumulator (1.1) and existing simulator infrastructure — buildable in parallel with 3.1's CSS work; becomes fully meaningful for visual verification once 3.1 and the chip components exist.

- **Size**: medium
- **Priority**: medium
- **Dependencies**: 1.1
- **Parallel with**: 3.1

---

### Task 3.4: Final polish pass against mockups and changelog fragment

**Polish pass**: with the playground (3.2) and simulator scenario (3.3) available, compare side-by-side against every file in `specs/chat-touch-chips/mockups/` and `design-decisions.md`. Verify: (a) every verb's live animation reads calm, not jittery (`contributing/design-system.md`); (b) the pop-in spring's overshoot (2.1) matches the mockup feel; (c) the pile wobble (2.2) reads as a satisfying landing, not a jarring shake; (d) the settled summary line matches `📖 21 · ✏️ 3 +34 −11 · 🌐 9 — show all` spacing/separators exactly (`design-decisions.md:47`); (e) the tray's bounded scroll (1.5) never steals transcript scroll focus; (f) reduced-motion fallbacks (2.1-2.3, 3.1) genuinely eliminate all looping motion, verified in-browser via `pnpm dev:dogfood` at `/dev/chat` with reduced-motion toggled (check for an existing simulator animation toggle to extend before adding a new one — `design-decisions.md:91`). Fix any drift found; allowed to touch files from any earlier task, but no new components or new spec scope.

**Changelog fragment**: create `changelog/unreleased/<timestamp-id>-chat-touch-chips.md` (generate the id via `.claude/scripts/id.ts`'s `YYMMDD-HHMMSS` convention), following `changelog/README.md`'s format and an existing example (e.g. `changelog/unreleased/260715-150825-friendly-auth-error.md`) — YAML frontmatter with a `covers:` array of the conventional-commit-style PR title(s), then a `### Added`/`### Changed` section. Write the copy per the `writing-for-humans` skill; the spec's suggested line — "See every file and link your agent touches, live." — is a strong start; expand to 1-3 sentences covering the settling summary + expandable tray + verb-specific motion, matching the tone/length of neighboring fragments.

Last task in the feature — after this lands, `specs/chat-touch-chips/` moves toward VERIFY per this repo's `/flow` stage spine.

- **Size**: small
- **Priority**: medium
- **Dependencies**: 3.1, 3.2, 3.3
