# Specification — Composer + Status Bar Redesign

- **Work item:** DOR-452
- **Spec id:** 260724-225225
- **Design:** [04-design-decisions.md](./04-design-decisions.md) · session `.dork/visual-companion/99756-1784931237/`

## Goal

Make the composer footer honest: **one line, quiet by default, everything one tap away.** Status items appear only when actionable or anomalous; the rest live in a Session popover that also replaces the status-bar configure panel. Fix the cluster of composer keyboard defects in the same pass, since they all live in one file and are all the same defect class — Enter or Escape doing something destructive the user didn't ask for.

## Non-goals

- The right-panel Session tab (deferred; the popover covers it).
- Per-agent pin scoping (global only).
- Any change to the agents list / `/agents` page beyond deleting dead code.
- Any change to `PromptSuggestionChips` beyond its alignment fix — it is a separate, legitimate component.

---

## Part 1 — Deletions

Remove entirely, including tests and dev-playground showcases:

| Target                                                                   | Lines | Why                                                                                                  |
| ------------------------------------------------------------------------ | ----- | ---------------------------------------------------------------------------------------------------- |
| `features/agents-list/ui/AgentRow.tsx`                                   | 289   | Superseded by `DataTable` + `agent-columns.tsx`; referenced only by its own test. Not in the barrel. |
| `features/agents-list/ui/SessionLaunchPopover.tsx`                       | 135   | Only consumer was `AgentRow`.                                                                        |
| `__tests__/AgentRow.test.tsx`, `__tests__/SessionLaunchPopover.test.tsx` | ~700  | Test dead code.                                                                                      |
| `features/chat/ui/input/ShortcutChips.tsx`                               | 106   | `/` and `@` are already taught by `placeholder-hints.json`.                                          |
| `__tests__/ShortcutChips.test.tsx`                                       | —     | —                                                                                                    |

Also delete the supporting machinery for `ShortcutChips`:

- `showShortcutChips` — `app-store-helpers.ts` (key + default), `app-store-preferences.ts` (type, getter, setter), and **its row in `features/settings/ui/tabs/PreferencesTab.tsx`**.
- The `onChipClick` prop thread: `ChatInputContainer.tsx:287` → `ChatStatusSection` props → `ShortcutChips`.
- `handleChipClick` in `model/use-input-autocomplete.ts` (implementation + interface member + return).
- The showcase entries in `dev/sections/chat-sections.ts` and `dev/showcases/InputShowcases.tsx`.

**Moved, not deleted:** `AgentIdentity` + `AgentChipContextMenu` (switch agent / open profile / new session) relocate into the status line's left cluster.

Run `pnpm knip` after this part; it must not regress.

---

## Part 2 — Composer keyboard (`ui/input/use-input-keyboard.ts`, `ChatInput.tsx`)

### 2.1 IME composition guard (bug)

There is **no** `isComposing` / `keyCode === 229` guard anywhere in `apps/client/src`. Enter during an active IME composition submits the message instead of committing the candidate — broken for every CJK user.

Guard first, before every other branch:

```ts
if (e.nativeEvent.isComposing || e.keyCode === 229) return;
```

### 2.2 Newline escape (feature)

On `Enter` (palette closed, not composing), inspect the text immediately before the caret:

- Count consecutive trailing `\`. **Odd** → continuation. **Even (incl. 0)** → fall through to normal Enter handling. This is shell semantics: `\\` is an escaped literal and still submits.
- Continuation requires a **collapsed caret** (`selectionStart === selectionEnd`).
- Strict adjacency: the backslash must touch the caret (`foo\ ` + Enter submits).
- Operates at the caret, not end-of-value, so it works mid-prompt.
- Runs **upstream of all three Enter modes** — submit, queue-while-streaming, save-queue-edit. Continuation never queues and never saves.
- On mobile (Enter is already a newline) still **eat the backslash**, so the resulting text is identical across platforms.

Also accept **`Option+Enter`** (`e.altKey`) as a newline. There is no `altKey` check in the composer today, so Option+Enter currently submits.

> **Implementation constraint — undo.** `setInput(value.slice(0, -1) + '\n')` silently destroys the native undo stack, and no unit test catches it. Perform the edit through the browser's editing pipeline: select the backslash, then `document.execCommand('insertText', false, '\n')`. This pushes a proper undo entry in Chromium/WebKit and fires a native `input` event, so the controlled value and `useTextareaResize` stay in sync for free. Deprecated on paper; universally supported; no replacement API exists. Add a test asserting the backslash is consumed and a newline is present.

### 2.3 Escape priority (bug)

Current order makes Escape-while-streaming beat an open palette, so dismissing the palette mid-stream stops the turn. Correct order:

1. IME guard
2. **Palette open → dismiss palette**
3. Editing a queue item → cancel edit
4. Streaming → stop generation
5. Bare Escape → double-tap-to-clear

### 2.4 Double-Escape footgun (bug)

Today the palette-dismiss branch also stamps `lastEscapeRef`, so `Esc` (close palette) → `Esc` (reflex) within 500 ms wipes the entire draft with no undo. **Do not stamp `lastEscapeRef` when the Escape was consumed dismissing a palette.** Clearing then requires two _bare_ escapes.

### 2.5 Composer state

- **Remove `disabled={sessionBusy}`** from the textarea (`ChatInput.tsx:237`). Disabling blurs the field and drops the caret with no restore. The send action is already gated by `sendBlocked`; keep the input typeable.
- **Autofocus on mount only on desktop** (`ChatInput.tsx:114-116`). Unconditional autofocus pops the mobile keyboard and scrolls the view on every session open.

### 2.6 Hints (`config/placeholder-hints.json`, `model/use-rotating-placeholder.ts`)

Final list — four lines, each teaching something not shown anywhere else:

```json
[
  "Type @ to mention a file",
  "Type / to browse commands",
  "End a line with \\ to keep typing",
  "Drop or paste files to attach"
]
```

`"Shift+Enter for a new line"` is replaced by the backslash line (the only platform-independent form, and the one the habit reaches for). `"Press Esc twice to clear"` is **dropped** — stop advertising the destructive path.

**Settle the rotation.** It currently runs every 5 s forever and is now the sole teaching surface; perpetual motion in a resting UI is exactly what Calm Tech is against. Persist one integer counting completed cycles through the hint list; after **3 complete cycles** stop rotating and show the static default (`Message {agent}…`) permanently.

Remove the unused `isHint` from the hook's return type and value.

Register Shift+Enter, Option+Enter, `\`+Enter, and double-Escape-to-clear in `features/shortcuts/ui/ShortcutsPanel.tsx`.

---

## Part 3 — Queue correctness

### 3.1 Nested interactives (a11y bug)

`QueuePanel.tsx:52-70` puts `<span role="button" tabIndex={0}>` **inside** a `<button>`. Invalid HTML, inconsistent browser behavior, broken a11y tree. Restructure to a non-interactive row containing two sibling `<button>`s (edit + remove).

### 3.2 Index-based mutation race (bug)

`onEdit(i)` / `onRemove(i)` pass array indices while the auto-flush concurrently removes index 0 (`use-message-queue.ts:111`). Removing item 3 as a flush lands deletes item 4. **Switch the `QueuePanel` → `useChatQueue` callbacks to the stable `item.id`.** `useMessageQueue` already keys the store by id; the index hop is gratuitous.

### 3.3 Stranded queue item (bug)

`use-message-queue.ts:106`: if the user is editing the **only** queued item when streaming ends, `firstNonEditing` is `null`, nothing flushes, and the streaming→idle edge is gone. There is no manual "send now", so the message sits until the user happens to send something else.

Requirement: **a queued message must never strand.** Flushing must also become reachable when editing ends while idle and not busy. Implement with tests covering: (a) edit the only item, streaming ends, save → it flushes; (b) cancel instead of save → it flushes; (c) no double-flush; (d) no flush on session switch (the DOR-81 guarantee must hold — a message queued in session A can only ever flush into session A).

---

## Part 4 — Status line, registry-driven

### 4.1 Registry becomes the single source of truth

`features/status/model/status-bar-registry.ts` gains, per item:

- `promote(ctx): boolean` — the quiet-by-default rule.
- `severity: number` — the mobile budget ranking.
- `neverInLine?: true` — for `cache`, `sound`, `refresh`.

**Promotion rules:**

| Item               | At rest   | Promotes when                                                                                  |
| ------------------ | --------- | ---------------------------------------------------------------------------------------------- |
| `agent`            | always    | Identity anchor (left cluster).                                                                |
| `model`            | always    | Changes the answer you get.                                                                    |
| `cwd`              | always    | Changes what the agent can touch. Leaf folder only.                                            |
| `context`          | silent    | `≥ 70%`. At `≥ 85%` turns amber and grows an inline **Compact** action.                        |
| `git`              | silent    | Working tree dirty, or branch is not the default.                                              |
| `connection`       | silent    | `!== 'connected'` (already correct today).                                                     |
| `permission`       | silent    | `!== 'default'`.                                                                               |
| `runtime`          | silent    | Non-default runtime, or still selectable pre-launch.                                           |
| `usage`            | silent    | `state` is `warning` or `exhausted`. A creeping `$0.03` is noise.                              |
| `subagents`        | silent    | `count > 0` (already correct today).                                                           |
| `cache`            | **never** | Pure diagnostics — popover only.                                                               |
| `sound`, `refresh` | **never** | Settings, not status — they only change when the user changes them, so they can never be news. |

**Severity order for the mobile budget** (highest first): `connection !== connected` → `context ≥ 85` → `usage exhausted` → `permission = bypassPermissions` → `subagents running` → `context 70–85` / `usage warning` → `permission = plan/acceptEdits/auto` → `runtime non-default` → `git dirty` → `model` → `cwd`.

### 4.2 `StatusLine.tsx` — delete the registration context

Two bugs, one cause. `firstVisibleKey` is `registeredKeys[0]` — _registration_ order, not declared order — so hiding then re-showing an earlier item leaves it rendering with a **leading separator**. And children are rendered in two tree positions (`:88-114`), so the empty→non-empty transition **unmounts and remounts every item**, dropping any open popover.

With the registry driving the line, visibility is known synchronously. **Delete `StatusLineContext`, `registerItem`/`unregisterItem`, and the dual render.** Derive the visible set and its order from the registry; the container renders iff the set is non-empty; the first visible item is the first registry key in the visible set.

### 4.3 `ChatStatusSection.tsx` — 605 lines → target < 300

- **Fix the store subscription.** `:144-170` destructures `useAppStore()` with **no selector**, so every unrelated store write re-renders the whole status bar and its ~11 children. Use per-field selectors (the pattern used elsewhere in the same file).
- **Delete `ItemContextMenu` and the ten hand-written wrappers.** Map over the registry. `useStatusBarVisibility(key)` already exists in the registry and does exactly the store bridging this file open-codes — it was simply unused here.
- **Fold `CompactionChip` into `ContextItem`** as the inline `≥85%` action; delete the separate row (this also fixes the never-firing exit animation at `:522-532`, where `AnimatePresence` wraps a plain `<div>` instead of the `motion.button`).
- **De-duplicate** the gesture-hint localStorage read-and-increment (`:286-290` and `:295-298`) — moot once Part 6 deletes it.
- Extract the item-rendering map to its own file if the section still exceeds 300 lines.

### 4.4 Alignment (7 sites)

Replace every breakpoint alignment flip with a fixed two-cluster layout — left cluster (identity/place/prose), one flexible gap, right cluster (state/numbers/`⋯`). **No separator may abut the gap.**

`ChatStatusStrip.tsx:237,286,338,350` · `TerminalReasonChip.tsx:39` · `ShortcutChips.tsx:71` (deleted) · `PromptSuggestionChips.tsx:23`.

### 4.5 Misc

- `ChatStatusStrip.tsx:193` — name the `8000` complete-state dismissal in `TIMING`.
- `ConnectionItem` — it renders its own `StatusLine.Item` while all siblings are wrapped by the parent; make it consistent with the registry-driven render. Wire `failedAttempts` (never passed today, so the `Reconnecting (n/N)` branch is dead) or delete the prop.

---

## Part 5 — Pins, Session popover, Copy diagnostics

### 5.1 Pins replace toggles

Replace the ten `showStatusBar*` visibility booleans with a single `pins` list of `StatusBarItemKey`s. Pins live in **server config** at `ui.statusBar.pins` — the surface DOR-431 established for status-bar preferences — read with TanStack Query and written as a single-key `PATCH /api/config` with an optimistic update, following the `ui.sidebar` pattern exactly. So this **does** need a Zod schema change (in both `UserConfigSchema` and `ServerConfigSchema`) and a `conf` migration. See §5.1.1.

Config, not `localStorage`, for three reasons: it is where main already put these preferences, `localStorage` does not sync across clients, and — the load-bearing one — an agent must be able to set pins via `config_patch`. Agent-controllability of every operator surface is the product thesis; pins must not regress it.

The pin keys are enumerated in the schema rather than left as free strings, so an agent's `config_patch` is validated at the boundary and the legal values are discoverable in the generated JSON/OpenAPI schema. The enum is exactly the client's pinnable set (Session rows minus `cache`); a drift test keeps registry and schema in step, and the client ignores an unknown pin rather than failing on it.

Semantics: a pinned item shows regardless of its promotion rule. **Pins raise priority but never bypass the mobile budget** — otherwise pinning five items recreates the overflow under a friendlier name.

### 5.1.1 Collision with DOR-431, and the migration

An earlier draft of this section asserted the ten `showStatusBar*` keys were localStorage-only and concluded that **no Zod or `conf` migration was required**. That premise was true when written and false by the time this shipped: `30ac9265d feat(client): status-bar preferences live in server config (DOR-431)` landed on `main` mid-build and moved those ten booleans into `ui.statusBar` (person-scoped, in both `UserConfigSchema` and `ServerConfigSchema`, surfaced on `GET /api/config`, with an append-only `0.57.0` migration and a one-time client lift out of `localStorage`). It also made the items agent-controllable on purpose. Pins were ported onto that surface rather than re-privatized.

**The migration drops the ten booleans and seeds an empty pin list.** There is no faithful mapping: the semantics inverted deliberately, from visible-by-default-with-hide to silent-by-default-with-pin. Deriving pins from the old boolean values would hand anyone who left everything at its default ten pins — losing the entire redesign. This is a deliberate one-time reset, and the changelog says so plainly.

It is keyed `0.57.0` (`migrateStatusBarToPins`), replacing DOR-431's `backfillStatusBarDefaults` body rather than appending a `0.58.0` after it. Editing that body is legitimate here and the append-only rule is not in play: `0.57.0` has never been tagged (v0.56.0 is the latest release), so no user has ever run it. Appending instead would be actively unsafe — the old body writes ten booleans, the new schema is a closed object requiring `pins`, and conf validates the whole store once migrations finish. A `0.58.0` key would not run on a release cut as 0.57.0, so the boolean write would survive into that final validation and hard-fail startup.

Retiring DOR-431's `useStatusBarLegacyMigration` follows from the reset: there is nothing left to lift, and the existing `purgeOrphanedPreferenceKeys` already removes the ten `dorkos-show-status-bar-*` keys from any client that never ran DOR-431. Its agent-controllability coverage is kept — the `config-toggle` case in `packages/evals/src/suite/operate.ts` now asserts an agent pins `git` via `config_patch` instead of hiding it.

### 5.2 Session popover

New `SessionPopover` in `features/status`, anchored to the `⋯` and right-aligned to it, opened by click or `⌘.`. It **replaces** `StatusBarConfigurePopover` + `StatusBarConfigureContent` — delete both.

Rows follow the same two-cluster rule one level down: label left, live value + pin right. Groups:

- **Session** — directory, git, runtime, model, context, cache, usage, permission, each showing its live value. Pinnable **except** `cache`: §4.1 marks it `neverInLine`, and `neverInLine` wins over pinnability. (Resolved conflict — an earlier draft of this section called every Session row pinnable.)
- **Controls** — sound, refresh (toggles, not pins).
- **Diagnostics** — connection (+ last event seq), queue depth, session id. **No pin control** — system-managed rows can never be promoted into the line, which is what stops pins from quietly becoming ten toggles again.

Footer: **Copy diagnostics** and **Reset pins**.

**Mobile:** render as a `Drawer` bottom sheet (`shared/ui` already exports it; `AgentsPage` already uses it for exactly this split). Sort rows **attention-first**, and promote any urgent truncated action to a full-width button at the top (e.g. _"Compact conversation — 78% full"_). This is why the inline Compact action can drop out of the bar on mobile without loss.

### 5.3 Copy diagnostics (new)

Nothing like this exists today — `features/report-issue` is a help menu with no diagnostics path. Copy one JSON blob to the clipboard: session id, runtime, resolved model id, effort, permission mode, context/cache/usage figures, connection state, last event seq, queue depth, cwd, and client version. Confirm with a toast.

---

## Part 6 — Mobile budget

### 6.1 Measured, never scrolled, never wrapped

`useIsMobile()` is a single 768px boolean — it cannot distinguish a 767px tablet from a 320px phone, and cannot see browser zoom, Dynamic Type, or the sidebar opening. **Measure the bar container** instead; `StatusLineScroller` already owns a `ResizeObserver` — repurpose it from "should I show a fade" to "how many items fit".

Fill the right cluster by severity until the budget is exhausted; the remainder becomes a **`+N` count on `⋯`**.

| Available width | Left cluster                      | Right budget     |
| --------------- | --------------------------------- | ---------------- |
| ≥ 640px         | agent · cwd · git, full labels    | 4+, full labels  |
| 440–640px       | drops `cwd`                       | 4, glyph + value |
| 340–440px       | identity only                     | **3**            |
| < 340px         | avatar only (name → `aria-label`) | 2                |

**Invariant:** `⋯` is `shrink-0`, always last, always ≥44px, **never droppable**. The `+N` count is the honesty.

### 6.2 Delete the drag-to-collapse apparatus

It exists because the mobile status area was 3–5 rows tall. One line of ≤3 items leaves nothing to collapse. Remove: `DragHandle` (+ test), `drag="y"` / `dragConstraints` / `dragElastic` / `handleDragEnd`, `SWIPE_THRESHOLD` / `VELOCITY_THRESHOLD`, the `collapsed` state, the "Swipe to collapse" hint with its bounce and `localStorage` counter, `touchAction: 'pan-y'` (`:570`), and `overflow-x-auto` + its fade gradient.

> This also fixes a live bug: `touch-action: pan-y` on the ancestor intersects down the tree and blocks the inner container's horizontal panning, so **overflowed status items are unreachable on mobile today** while the fade advertises that they exist.

### 6.3 Touch targets and a11y

- Every status item and the `⋯` need a **≥44×44px** hit area on touch. The configure button today is a bare `<button>` around `size-3` (12×12px). WCAG 2.5.8 asks 24×24; Apple HIG asks 44×44.
- **`ChatStatusStrip` has no `aria-live` at all** — the surface that says "Waiting for your approval" is silent to screen readers, while `ChatMessageArea`, `BackgroundTaskBar`, and `ToolApproval` all announce. Add `aria-live="polite"` to the strip container and `aria-hidden` to the rotating verb span, so state _changes_ announce without the verb churn spamming.

---

## Verification

- `pnpm verify` green; `pnpm test -- --run` green (never bare `pnpm vitest run` for full runs).
- `pnpm knip` no regression.
- New/updated tests: backslash continuation (incl. `\\`, trailing space, collapsed-caret, mobile), IME guard, Escape priority ladder, double-Escape no longer reachable post-palette, queue id-based mutation, queue never strands, registry promotion rules, severity ranking, budget truncation + `+N`, pins override promotion but not budget.
- Browser verification per `verifying-dorkos-cockpit-in-browser`: resting / working / degraded / streaming states at ≥640px, ~375px, and <340px. Confirm nothing is centered at any width and `⋯` is always reachable.
