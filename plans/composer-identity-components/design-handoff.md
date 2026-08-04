# Phase-1 identity surfaces — implementor handoff

**Status:** design locked, ready to build the **presentational slice**.
**Mockups:** [`mockups/identity-surfaces.html`](./mockups/identity-surfaces.html) — open it in a browser.

> ⚠︎ **The mockups are directional, not final designs.** They fix the _intent_ — which
> direction won, what distinguishes an agent from a person from an external person, and how
> overflow behaves. Colors, spacing, exact radii, and emoji are illustrative. Build to the
> **Calm Tech** design system (`contributing/design-system.md`, `.claude/rules/components.md`)
> and the real shared primitives; refine in code and review. Where a mockup value and a design
> token disagree, the **token wins**.

This work came out of a research + design session on unifying the chat and room composers
(full context in memory `project_composer_rooms_unification_design`). This doc covers only the
**identity rendering** components. Rich text (Lexical), files-in-rooms, and composer unification
are separate later phases.

---

## What was decided (and what was rejected)

| Surface          | Chosen                       | Rejected                                                    | The rule                                                                                                                                                                                                                    |
| ---------------- | ---------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mention pill** | **B — identity-color pill**  | A (single accent, Buzz-faithful), C (understated underline) | Agent wears its **own identity color** + a Bot glyph **replaces the `@`**; person = neutral `@name` pill; external person = neutral pill + platform glyph after the name; unresolved = **plain text, no pill, no pointer**. |
| **Feed avatar**  | **C — shape + badge + fill** | A (badge only), B (shape only)                              | **Square = agent, circle = person** (colorblind-safe); Bot corner badge on agents; **filled** identity-color disc; external person = circle + platform corner badge.                                                        |
| **Hover card**   | **A — compact**              | B (detailed key/value)                                      | Name on top, **`@handle` as subtitle** (omitted if none), context in chips, **footer bottom-pinned**. Agent chips: runtime · model, working status. Person chips: origin.                                                   |

Precedent studied: Block's **Buzz** (`github.com/block/buzz`) never uses color as the agent/human
differentiator — the glyph replaces the `@` sigil. We keep that glyph **and** add DorkOS's
per-agent identity color (which Buzz lacks). Unresolved mentions are inert, as in Buzz.

---

## Scope of THIS slice

**Build these presentational components + dev-playground showcases. Use mock data. Do NOT wire
them into the live feed/composer yet** (that's the follow-up slice below — it touches message
rendering and the server).

### 1. `IdentityAvatar` — extend (`apps/client/src/layers/shared/ui/identity-avatar.tsx`)

Today it's `rounded-full` for everyone with an 18% `color-mix` tint and a bottom-right `badge`
slot (read the file — the `badge` TSDoc explains the "agents get the glyph, people get nothing"
convention; keep that philosophy).

Add, as **optional props with defaults that preserve current behavior** (so existing call sites
in `RoomMemberRow`, `RoomAvatar`, `AgentAvatar`, `MessageAuthorAvatar` don't change):

- `shape?: 'circle' | 'square'` (default `'circle'`). `'square'` = a `rounded-*` matching the
  Calm Tech radius family (try `rounded-xl`; confirm against the 8px base radius — a 40px disc
  wants a slightly larger radius than a card). Drive via a `cva` variant, not inline classes.
- `variant?: 'tint' | 'fill'` (default `'tint'`). `'fill'` = solid identity color background.
  **Contrast is a real edge case:** the emoji renders fine on any fill, but the `fallback`
  letter needs a foreground chosen from the color's luminance (don't assume white). Add a small
  pure helper (e.g. `readableForeground(color): string`) in `shared/lib` next to
  `hashToHslColor`/`favicon-utils`, and unit-test it against a light and a dark identity color.

The component stays **presentational and kind-agnostic** — it must not learn about `kind`. The
**caller** maps `kind → { shape, variant, badge }` (agent → square/fill/`<Bot/>`, person →
circle/tint/none). That preserves the FSD reason this primitive exists (a room can't import
`entities/agent`).

### 2. `MentionPill` — new (`apps/client/src/layers/shared/ui/mention-pill.tsx`)

Presentational, props-driven, in **`shared/ui`** (both room widgets and chat features must reach
it, and `shared` is the only layer both can import). Follow the shadcn primitive pattern in this
dir: `cva` variants, `data-slot="mention-pill"`, `cn()`, export component + variants.

Suggested props:

```
kind: 'human' | 'agent' | 'system'
label: string            // display name to show
handle?: string          // the @handle (for title/aria; not always shown)
color?: string           // identity color (agents)
origin?: 'local' | { platform: string }   // external → platform glyph
resolved: boolean        // false → render plain inert text (no pill, no pointer)
interactive?: boolean    // whether it carries hover/click affordance (click deferred)
```

Behavior from the mockup + edge-case rules:

- **agent** → identity-color pill, **Bot glyph (lucide `Bot`) replaces the `@`**, then `label`.
- **human, local** → neutral pill, `@label`.
- **human, external** (`origin.platform`) → neutral pill, `@label` + a small platform glyph
  (lucide `Send` as a stand-in for Telegram; a per-platform glyph map can come later).
- **unresolved** (`resolved === false`) → return a plain inert `<span>` (no background, no
  pointer). "A pointer cursor promises a click that does nothing."
- **overflow** → `overflow-wrap:anywhere` + `box-decoration-break:clone` so a long single-token
  handle wraps within the line and the pill background follows. **Never** truncate a mention.
- Click is **deferred** (no profile routes yet). `interactive` only gates hover/cursor for now.

### 3. `IdentityHoverCard` — new (`apps/client/src/layers/shared/ui/identity-hover-card.tsx`)

Wrap the existing Radix `HoverCard`/`HoverCardTrigger`/`HoverCardContent` (`shared/ui/hover-card.tsx`,
`w-64`) with the **compact** card from the mockup. Composes `IdentityAvatar`. Presentational —
takes a descriptor, renders it; the caller supplies data (mocked in the playground).

Suggested descriptor:

```
{ kind, displayName, handle?, color?, emoji?, origin?,
  agent?: { runtime?: string; model?: string; working?: { room?: string; forMs: number } } }
```

Layout (see mockup): avatar + (name / `@handle` subtitle) header; chips row (agent → `runtime ·
model`, and a green-pulse "Working · Nm" chip when `working`; person → origin chip); a
bottom-pinned footer with a **"View profile"** affordance + a muted **"soon"** tag (click is
deferred). `@handle` subtitle is **omitted** when there's no handle.

**Known consideration to flag, not necessarily solve now:** Radix `HoverCard` is hover-only — it
does not open on touch. The design calls for **long-press on touch**. Either add a long-press →
`Popover` path, or scope touch out for this slice and note it. Say which you did.

### 4. Dev playground (required — use the `maintaining-dev-playground` skill)

Add showcases rendering the **real** components with mock data:

- Place on the **Design System → Components** page and/or **Agents → Subsystems** (agent identity
  lives there). One showcase file per surface is fine, or one `IdentityShowcases.tsx`.
- Cover **every state**: agent / human-local / human-external / system; resolved vs unresolved
  mention; `tint` vs `fill` and `circle` vs `square` avatars; hover card for agent vs person;
  and an **edge-case group** (long name, long handle, no-emoji fill, multi-codepoint emoji).
- Put mock identities in `dev/mock-factories.ts` / `dev/mock-samples.ts`, not inline.
- Register sections in the right `dev/sections/*.ts`, import into the page component.

---

## Data the follow-up slice will use (context, not this slice)

The wire already carries what the live surfaces need — this is why the design is cheap:

- `AuthorRef` (`packages/shared/src/room-schemas.ts`): `{ id, kind:'human'|'agent'|'system',
displayName, emoji?, color?, agentRef?, mentionHandle? }`. `RoomRosterEntry.origin`:
  `'local' | { platform }`.
- Mentions resolve once at write time → `RoomEntry.mentions: string[]` (author ids). **Do not
  re-parse text for addressing.** The chosen plan adds **server-emitted mention spans**
  (offset→authorId) for exact, clickable rendering — that's server work, later.
- `system` kind = the room's own voice (notices), **not** DorkBot (DorkBot posts as `agent`).

**Follow-up slice (do NOT do here):** emit mention spans server-side; render `MentionPill` in
`RoomEntryRow` / chat `MarkdownContent` from spans; switch feed avatars
(`MessageAuthorAvatar` / `toMessageAuthor`) to consume `AuthorRef` by id so the feed shows
agent-vs-person (today it drops emoji/badge → hash+initial); wire `IdentityHoverCard` onto avatars
and pills; render `origin` on roster + feed.

---

## Guardrails

- FSD: `shared ← entities ← features ← widgets`; new components live in `shared/ui`, import only
  shadcn primitives + `shared/lib`. Barrel-export from `shared/ui/index.ts`.
- `.claude/rules/components.md`: `cva` variants, `data-slot`, `cn()`, no inline styles except the
  one sanctioned per-identity `color-mix` (as `IdentityAvatar` already does), `focus-visible:`
  only, no `Math.random()` (use `useId`), React 19 `ref` as a prop (no `forwardRef`).
- TSDoc on every export (enforced). Accessibility: the pill/badge are decorative; the row/card
  text names the kind — don't add redundant `aria` noise, but the hover card content must be
  reachable/labelled.
- Tests: co-locate `__tests__`; at minimum unit-test `readableForeground` and the `MentionPill`
  kind/resolved branching. Verify with `pnpm --filter @dorkos/client typecheck`,
  `pnpm --filter @dorkos/client lint`, and `pnpm vitest run <file>` per changed file.
- Keep each component file < 300 lines.
