# Identity micro-interactions — audit and design spec

**Status:** proposal, awaiting the product owner's pick on Part 3
**Scope:** every surface that draws an identity — `IdentityAvatar` and the 14 components that compose it
**Ground truth read:** `designing-frontend` skill, `contributing/design-system.md` (incl. the Identity section from DOR-967), `.claude/rules/components.md`, `meta/brand-foundation.md`, and every component listed in Part 1 at full length

> **Note added 2026-08-16 (spec `profile-unification`, DOR-1255):** the surface this
> document calls the Agent Hub no longer exists. Its component names below —
> `AgentHubTabBar`, "the hub hero" — are the record of what was surveyed when this
> was written, and are left as written. The one profile that replaced it lives in
> `features/profile/`; the motion rules in Part 3 still bind it.

---

## 0. The one-paragraph thesis

The cockpit already has a strong identity **language** — one disc, one colour ladder, one shape convention, and it is unusually well-reasoned. What it does not have is an identity **grammar**: nothing on these surfaces answers when you point at it. Sixteen components draw identities; four of them have any hover state at all, and three of those four use a generic response (`hover:opacity-80`, `hover:brightness-95`, `hover:bg-accent`) that says "something is here" without saying _what pressing it would do_. Meanwhile the two places that do have crafted delight — the avatar picker's selection burst and First Light's breathing disc — are both **moments you arrive at once**, and neither has taught the everyday surfaces anything. This spec closes that: a baseline grammar that is consistent, cheap, and mostly CSS, plus a small number of signature moments that are worth their cost. Restraint is the deliverable as much as the motion is — Part 3 says no to five tempting ideas, with reasons.

---

## Part 1 — Audit

### 1.1 The table

Every component under review, its current interactive states, and the gap. "None" means literally nothing — no hover, no focus, no press, no motion.

| #   | Component                                                                        | Current interactive states                                                                                                                                                                                                                           | Gap                                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `shared/ui/identity-avatar.tsx`                                                  | `transition-[background-color] duration-500 ease-in-out` on the root (a colour crossfade for the picker's live preview). Working dot: `animate-ping` + `motion-reduce:hidden`.                                                                       | **No hover, no focus, no press.** It is a `<span>`, so it cannot take focus, and it exposes no hook for a parent to style from. Its identity colour is locked inside an inline `backgroundColor` where no stylesheet can reach it — the single biggest structural blocker in this audit.                                      |
| 2   | `shared/ui/identity-hover-card.tsx`                                              | Radix `HoverCard`, `openDelay=300ms`. Long-press open for touch/pen (`useLongPress`). Content entrance is shadcn's default `animate-in fade-in-0 zoom-in-95`.                                                                                        | Footer reads `View profile` + `soon` — **styled as an affordance, wired to nothing.** No entrance choreography for the chip row. No identity colour anywhere in the card despite the card being _about_ one identity.                                                                                                         |
| 3   | `shared/ui/mention-pill.tsx`                                                     | `interactive` variant only: `cursor-pointer transition-[filter] hover:brightness-95 focus-visible:ring-2`.                                                                                                                                           | Three problems. `brightness-95` **darkens an identity's colour toward mud** rather than intensifying it. The `focus-visible:ring-2` is dormant by the component's own admission — a `<span>` never receives focus. And `cursor-pointer` promises a click that does not exist.                                                 |
| 4   | `entities/agent/ui/AgentAvatar.tsx`                                              | Mesh-health ring (`ring-2` + `ring-status-*`), working dot inherited.                                                                                                                                                                                | None beyond what it inherits. The health ring occupies the exact visual slot (a 2px ring) that an identity-colour hover would want — a real conflict Part 2 has to resolve, not ignore.                                                                                                                                       |
| 5   | `entities/agent/ui/AgentIdentity.tsx`                                            | With `onClick`: `cursor-pointer transition-opacity hover:opacity-80`. Without: nothing.                                                                                                                                                              | **`hover:opacity-80` is the wrong verb.** Dimming is the universal idiom for _disabled_; using it for _clickable_ inverts the convention. No focus-visible ring at all on the button branch — a keyboard user gets nothing. Reaches ~12 call sites, so this one wrong choice is the most-repeated interaction in the cockpit. |
| 6   | `entities/agent/ui/AgentOptionRow.tsx`                                           | None — hover and selection are owned by the parent `CommandItem`.                                                                                                                                                                                    | Correct as-is. Listed for completeness; no prescription.                                                                                                                                                                                                                                                                      |
| 7   | `entities/agent/ui/PresetPill.tsx`                                               | `transition-all`; inactive `hover:text-foreground`; active state is an inline `linear-gradient` + optional `boxShadow` glow.                                                                                                                         | Off-language. `design-system.md` lists gradients under Anti-Patterns. Scoped to the nebula personality picker, so it is grandfathered — but it must not become the precedent any identity surface copies. Flagged as a cleanup candidate, not touched by this spec.                                                           |
| 8   | `entities/room/ui/RoomAvatar.tsx`                                                | None of its own. Multi-face stack uses `-space-x-1.5`.                                                                                                                                                                                               | The stack is the interesting surface — three overlapping discs that never separate, so a group DM's members are permanently unreadable individually.                                                                                                                                                                          |
| 9   | `entities/room/ui/MemberList.tsx`                                                | Button form: `hover:bg-accent transition-colors focus-visible:ring-2`. List form: a `Tooltip` per disc, no hover styling.                                                                                                                            | The button form is right (one target, one response). The list form's discs are tooltip triggers with **zero visual acknowledgement** — you learn a disc is hoverable only by waiting for a tooltip.                                                                                                                           |
| 10  | `features/team-roster/ui/TeamMemberCard.tsx`                                     | `bg-card shadow-soft rounded-lg border p-4` — **static**. Only the owner attribution button has state (`hover:text-foreground hover:underline focus-ring`).                                                                                          | **The single largest gap.** The card is about to become the primary way to open a profile (DOR-978) and today has no hover, no press, no cursor, no focus ring. Four areas with three different actions share one inert surface.                                                                                              |
| 11  | `features/team-roster/ui/TeamRosterGrid.tsx`                                     | None. `ClusterHeader`'s button has `focus-ring` only.                                                                                                                                                                                                | Filter, search and the group toggle all re-render the grid as an **instant DOM swap**. Cards teleport. This is the highest-leverage single move available (Part 3A).                                                                                                                                                          |
| 12  | `features/team-roster/ui/TeamRosterToolbar.tsx`                                  | Inherited `Button` variants; `aria-pressed` correct throughout.                                                                                                                                                                                      | Adequate. One note: person chips are the only place a person is named without their colour or face appearing — a small missed consistency, not a defect.                                                                                                                                                                      |
| 13  | `features/profile/ui/ProfileDrawer.tsx` _(branch `feat/dor-977-profile-drawer`)_ | Sheet CSS: `data-[state=open]:duration-500 slide-in-from-right`, `transition ease-in-out`.                                                                                                                                                           | **500ms is the slowest transition in the identity flow** and the most noticeable. Content has no internal choreography and — notably — no identity colour anywhere, even though the drawer is a full panel about exactly one identity.                                                                                        |
| 14  | `features/chat/ui/status/AgentIdentityChip.tsx`                                  | Inherits `AgentIdentity`'s `hover:opacity-80`. Right-click / long-press context menu.                                                                                                                                                                | Inherits #5's wrong verb. Sits in the status line where it is a genuine, frequently-used control.                                                                                                                                                                                                                             |
| 15  | `features/dashboard-sidebar/ui/AgentListItem.tsx`                                | The richest in the repo: `transition-all duration-100 active:scale-[0.98]`, `hover:bg-accent hover:text-foreground`, `usePulseMotion` border, expand spring 500/35 mass 0.8, staggered child rows (`ROW_STAGGER = 0.04`), hover-reveal `...` action. | Well-built; nearly nothing to add. The avatar inside it is inert, and the identity colour appears only as a left border when _active and idle_. This is the one dense surface where the answer is **do less** (see §2.4).                                                                                                     |
| 16  | `features/chat/ui/message/MessageAuthorAvatar.tsx`                               | None.                                                                                                                                                                                                                                                | It is the message list's identity gutter — a natural hover-card trigger and a natural target — with no visual response of any kind.                                                                                                                                                                                           |

### 1.2 The existing delight precedents, and what they teach

| Precedent                                        | What it does                                                                                                                                                                                                                                        | What it licenses                                                                                                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AvatarPickerGrid` (`celebratory` gate, DOR-970) | Swatch `hover:scale-110` + blurred colour glow at `opacity-50`; emoji `whileHover={{scale:1.25}}` / `whileTap={{scale:0.85}}` spring 500/20; `staggerChildren: 0.04` pop-in (spring 500/25); `SelectionCheck` burst 0.6s ease `[0.34,1.56,0.64,1]`. | That **a deliberate customization moment earns overshoot and scale.** The `celebratory` prop is itself the lesson: the same grid renders plain in the settings form. Delight is opt-in per context, never global. |
| `AvatarPickerPopover.SparkleBurst`               | 14 particles, radial, 0.6s, gated on a `localStorage` key so it fires **once, ever**.                                                                                                                                                               | That the biggest celebration in the product is a **first-run-only** event. Nothing that happens daily celebrates.                                                                                                 |
| `FirstLight`                                     | Disc breathes `scale:[1,1.05,1]`, `opacity:[0.9,1,0.9]`, 3s, `repeat: Infinity`, gated on `useReducedMotion()`.                                                                                                                                     | That **ambient motion is allowed when it is reporting a live fact** (a turn genuinely in flight) and stops when the fact does.                                                                                    |
| `IdentityAvatar` working dot                     | `animate-ping` + `motion-reduce:hidden`, dot survives the preference.                                                                                                                                                                               | The repo's canonical reduced-motion shape: **keep the fact, drop the motion.** Every prescription below inherits this rule.                                                                                       |

### 1.3 Motion ground truth (surveyed, not assumed)

- **One import path.** 158 imports across 148 files, all `from 'motion/react'`. No other subpath is used anywhere.
- **`layout` / `layoutId` are already in production** — `navigation-layout.tsx` (`nav-layout-active-pill`, spring 280/32), `SessionRowFull.tsx` (`active-session-bg`, spring 280/32), `AgentHubTabBar` (500/32), `AgentCommandItem` (duration 0.15), `StatusLine` (`layout="position"`), `SessionsView` (plain `layout`). `LayoutGroup` is used in the command palette and nav layout. **The roster FLIP is not a new capability, it is an existing one applied to a new surface.**
- **The spring vocabulary already clusters**: 320/28 (settle — and it is written into `index.css` as `--msg-enter-stiffness/damping`), 400/30 (interactive), 280/32 (layout slides), 500/30–35 (fast panels).
- **The easing vocabulary is two curves plus two specials**: `[0, 0, 0.2, 1]` (Tailwind ease-out, dominant), `[0.4, 0, 0.2, 1]` (Material standard), `[0.16, 1, 0.3, 1]` (expo-out, used for rises), `[0.34, 1.56, 0.64, 1]` (overshoot, used **only** in the avatar picker and the hub hero).
- **`index.css` already has a global reduced-motion reset** (line ~1558): `*, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }`
- **`index.css` already names motion tokens as CSS custom properties** — the `--msg-*` family (`--msg-enter-y: 8px`, `--msg-enter-stiffness: 320`, `--msg-reaction-pop: 240ms`, …). A new `--identity-*` family is a precedent-following move, not an invention.
- **`color-mix(in oklch, <color> <pct>, transparent)` is the canonical tint**, at 18% (`IdentityAvatar.TINT_STRENGTH`) and 14% (`mention-pill.AGENT_TINT`).
- **Inline CSS custom properties are established**: `--sidebar-width` (`AppShell`, `sidebar.tsx`), `--runtime-accent` (`RuntimeCardView.tsx:193`), `--c` (`AgentRunner.tsx`), all via `as React.CSSProperties`. `--runtime-accent` is the exact analogue of what §2.1 proposes.
- **Reduced motion has no single shared hook and should not get a third one.** Two near-duplicate `usePrefersReducedMotion` wrappers exist (`features/mesh/lib/`, `shared/ui/tour-spotlight/`); `useReducedMotion` from `motion/react` is the 37-call-site majority and the one this spec uses.
- **Existing utilities to build on:** `card-interactive` (`transition: all 150ms ease-out` → `box-shadow: var(--elevation-elevated)` + `border-color: hsl(var(--border)/0.8)`), `focus-ring` (`:focus-visible` → `0 0 0 2px hsl(var(--background)), 0 0 0 4px hsl(var(--ring))`), `shadow-soft|elevated|floating|modal`.

### 1.4 Two honesty defects the audit surfaced

Not delight work, but they sit inside the same components and a builder will trip over them:

1. **`MentionPill interactive` promises a click that does not exist** — `cursor-pointer` plus a `focus-visible` ring on a permanently unfocusable `<span>`.
2. **`IdentityHoverCard`'s footer renders `View profile` in `text-brand` beside the word `soon`** — brand orange is reserved for "interaction or action" by `design-system.md`, and this is neither.

Both are the kind of thing Priya notices before she adopts anything. Prescription in §4.4.

---

## Part 2 — The interaction grammar (baseline tier)

Non-negotiable consistency layer. Every prescription here is **CSS**, which matters for one specific reason given in §2.6.

### 2.1 The keystone enabler: expose the identity colour to CSS

Everything in this part depends on one small change to `identity-avatar.tsx`.

Today the identity colour lives only in an inline `style.backgroundColor`. Inline styles beat stylesheets, so **no `:hover` rule can ever modify or reuse that colour** — no hover tint step, no colour ring, no colour border on an ancestor. This is the structural reason there are no identity-colour interactions today.

The fix is to also publish the colour as a custom property on the disc, following `RuntimeCardView.tsx:193` exactly:

```tsx
// identity-avatar.tsx — in the root <span>'s style object
style={{
  '--identity-color': color,
  backgroundColor: isFill
    ? color
    : `color-mix(in oklch, ${color} ${TINT_STRENGTH}, transparent)`,
  ...(isFill ? { color: readableForeground(color) } : {}),
  ...style,
} as React.CSSProperties}
```

Custom properties inherit, so **every descendant and every ancestor that sets it can now reach the identity's colour from a class string**: `ring-[var(--identity-color)]`, `border-[color-mix(in_oklch,var(--identity-color)_35%,hsl(var(--border)))]`, and so on. Nothing existing changes behaviour — this is purely additive, and the existing `identity-avatar.test.tsx` background assertions keep passing unchanged.

`TeamMemberCard` (and any other card that wants the colour at its own border) sets the same property on its root from the resolved face, so the ancestor does not have to read it back out of a child.

### 2.2 The motion vocabulary

Add to `:root` in `apps/client/src/index.css`, directly beneath the existing `--msg-*` block, matching its comment style:

```css
/* Identity micro-interactions. Three speeds, two curves — see
   plans/identity-micro-interactions/design-spec.md §2.2. */
--identity-press: 80ms;
--identity-answer: 120ms;
--identity-settle: 200ms;
--identity-ease-out: cubic-bezier(0, 0, 0.2, 1);
--identity-ease-standard: cubic-bezier(0.4, 0, 0.2, 1);

/* Colour response. The resting tint is IdentityAvatar's own 18%; these are
   the steps above it. */
--identity-tint-hover: 28%;
--identity-border-mix: 35%;
--identity-ring-mix: 60%;
```

**Three speeds, and the reason each exists:**

| Token               | Value | Applies to                                             | Why this number                                                                                                                                                               |
| ------------------- | ----- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--identity-press`  | 80ms  | `:active` transforms                                   | Press feedback must land before the finger lifts. Anything over ~100ms reads as lag rather than response. Matches the sidebar row's existing `duration-100` neighbourhood.    |
| `--identity-answer` | 120ms | hover in/out on a **mark or chip** (≤48px)             | Small targets need to feel pre-emptive. The repo's fastest existing UI transitions are 100–150ms; 120ms sits inside that band.                                                |
| `--identity-settle` | 200ms | hover on a **surface** (a card, a row), and any reveal | Matches `design-system.md`'s "Normal — 200ms — enter/exit, layout shifts" and the dominant `duration: 0.2` in the motion survey. A large surface moving fast reads as a jolt. |

**Two curves, and nothing else in the baseline tier:**

- `--identity-ease-out` — anything arriving, growing, or appearing. This is Tailwind's own `ease-out` and the repo's most-used curve.
- `--identity-ease-standard` — anything that changes _in place_ and stays (a colour shift, a border firming). Both ends are visible, so both ends need easing.

**No overshoot in the baseline tier.** `[0.34, 1.56, 0.64, 1]` exists in this codebase in exactly two places, both of which are moments you deliberately went to (the avatar picker, the hub hero). Overshoot is a signature-moment budget line, not a hover curve.

### 2.3 What may animate

**Allowed:** `transform` (translate, scale), `opacity`, and the paint-only trio `background-color`, `border-color`, `box-shadow`.

**Banned:** `width`, `height`, `top/left/right/bottom`, `margin`, `padding` — anything that triggers layout. Also banned: `filter: brightness()` **on a surface already carrying an identity colour**. `mention-pill`'s `hover:brightness-95` is the live example — it multiplies a considered colour toward grey, which is the opposite of "the identity answers". Replace it with a `color-mix` step (§2.5).

`transition: all` is discouraged. `card-interactive` currently uses it; when a component wants only the card treatment, prefer the explicit tightened form in §2.5 so the transition list is auditable.

### 2.4 The hover grammar — three tiers, by what the thing does

Every identity surface is exactly one of these. The tier decides the response, so no call site has to invent one.

| Tier        | Definition                                                        | Response                                                                     | Duration            |
| ----------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------- |
| **Surface** | A card or row whose _whole area_ triggers one action              | Lift `-1px` + `shadow-elevated` + border firms                               | `--identity-settle` |
| **Mark**    | An avatar that is itself the target or trigger                    | A ring in **its own identity colour**, from `ring-0` to `ring-2`             | `--identity-answer` |
| **Chip**    | An inline control — a pill, an attribution, a badge-shaped button | A **tint step** (colour surfaces) or text-weight + underline (text surfaces) | `--identity-answer` |

Concrete class strings per tier:

```
Surface:  'transition-[box-shadow,border-color,transform] duration-200
           ease-[--identity-ease-standard]
           hover:-translate-y-px hover:shadow-elevated hover:border-border
           active:translate-y-0 active:scale-[0.99] active:duration-[--identity-press]'

Mark:     'ring-0 ring-[var(--identity-color)]
           transition-[box-shadow] duration-[--identity-answer]
           ease-[--identity-ease-out]
           hover:ring-2 focus-visible:ring-2'

Chip:     'transition-[background-color,color] duration-[--identity-answer]
           ease-[--identity-ease-standard]'
           + the per-kind colour step from §2.5
```

**The Mark tier has one collision to resolve.** `AgentAvatar` already spends the 2px ring slot on mesh health. Rule: **health wins.** When `healthStatus` is present, the disc takes no hover ring at all — a ring that changes colour on hover would make a diagnostic signal look like a hover state. Those surfaces (the mesh topology, the sidebar) are dense anyway and §2.5 excludes them regardless. Implementation: the hover ring is applied by the _caller_ (the roster card, the message gutter), never inside `AgentAvatar`.

### 2.5 Identity-colour response — the signature idea, and its boundary

**The idea:** on hover, an identity's own colour answers — the colour it already wears, one step louder.

**The mechanism** (enabled by §2.1), by tier:

```
Mark   → hover:ring-2 with ring-[var(--identity-color)]
Chip   → background steps color-mix 14% → 20%   (mention pill)
Surface→ border becomes color-mix(in oklch, var(--identity-color)
         var(--identity-border-mix), hsl(var(--border)))
```

**Where it applies** — sparse surfaces where an identity is individually addressable:

| Surface                       | Response                                        | Why it earns it                                                                  |
| ----------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------- |
| `TeamMemberCard`              | Border → identity mix at 35% on hover           | The card _is_ one identity; ≤ ~30 on screen; the border is otherwise unused      |
| `MessageAuthorAvatar`         | Mark ring on hover                              | The gutter avatar is the hover-card trigger and has no response at all today     |
| `MemberList` (list form only) | Mark ring on hover                              | Max 5 discs + overflow. The tooltip should not be the first sign of hoverability |
| `ProfileDrawer` header        | A **static** 2px rule in identity colour at 55% | Static, not a hover — see §3D4                                                   |
| `RoomAvatar` multi-face stack | Mark ring on the hovered disc only              | Max 3 faces; separating them is the whole point                                  |

**Where it must NOT** — and this is the load-bearing half:

| Surface                                    | Verdict                                        | Reason                                                                                                                                                                                                                            |
| ------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentListItem` (sidebar)                  | **No.** Keep `hover:bg-accent`.                | Twenty-plus rows. And the left border is _already_ the identity colour when active+idle — a hover glow would compete with a signal that means something else. Two colour languages in one 32px row is not two facts, it is noise. |
| `AgentOptionRow` / command palette         | **No.**                                        | The palette's selection already rides a `layoutId` pill. A second per-row colour signal fights the one that is doing real work.                                                                                                   |
| `MentionPill` inline in message text       | **Tint step only.** No ring, no glow, no lift. | A pill mid-paragraph that glows pulls the eye out of the sentence. 14% → 20% is enough to confirm "yes, this is the thing you're pointing at" without breaking the line.                                                          |
| `MemberList` **button** form (room header) | **No per-disc response.**                      | One target, one action — the button's `hover:bg-accent` is the answer. Five discs each answering to one hover would suggest five actions.                                                                                         |
| Any grid of >12 simultaneous identities    | **No.**                                        | See the rule below.                                                                                                                                                                                                               |

> **The rule, stated once:** an identity's colour answers only where that identity is **individually addressable** and **fewer than about a dozen** are on screen at once. In a dense list, the row's neutral hover _is_ the answer. Twenty rows able to glow is not twenty answers; it is a Christmas tree with a cursor in it.

### 2.6 Reduced motion — the whole story, once

`index.css` already ships a global reset that collapses **every CSS `transition-duration` and `animation-duration` to 0.01ms** under `prefers-reduced-motion: reduce`. Three consequences, and they shape the entire implementation plan:

1. **Every CSS prescription in Part 2 is reduced-motion-correct for free.** No `motion-reduce:` variant is needed on any of them.
2. **Therefore the hover _end state_ must carry the meaning by itself.** Under reduced motion the user gets the end state instantly with no transition — so a design that only reads _because_ of the movement is broken there. Every state above is a static, legible difference (a ring is present, a border is coloured, a card is lifted), not a movement.
3. **`motion/react` bypasses the reset entirely.** It writes inline styles from JS; CSS `transition-duration` never enters the picture. So **every `motion.*` component added by this spec must call `useReducedMotion()` from `motion/react` and branch.** Not "shorter" — _off_. A card teleporting 400px in 10ms is worse than a card that does not move.

Do **not** add a third `usePrefersReducedMotion` wrapper. Two near-duplicates already exist (`features/mesh/lib/use-reduced-motion.ts`, `shared/ui/tour-spotlight/use-prefers-reduced-motion.ts`); `motion/react`'s own hook is the 37-call-site majority and the one to use.

Per-item reduced-motion behaviour:

| Item                                    | Under reduced motion                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| All Surface / Mark / Chip hovers (§2.4) | End state applies instantly. Nothing lost.                                                          |
| Press `active:scale`                    | Instant. Nothing lost.                                                                              |
| Working dot ping                        | Dot stays, ping hides (`motion-reduce:hidden`) — already shipped, unchanged.                        |
| Roster FLIP (§3A)                       | `layout` prop **off**, `initial`/`animate`/`exit` dropped. Cards appear in place.                   |
| Bot badge wake (§3B1)                   | CSS transform → instant. The tilt still applies; only the travel goes.                              |
| Owner echo (§3C)                        | Highlight applies instantly. It is a state, not a motion.                                           |
| Drawer entrance (§3D)                   | Sheet's own CSS animation is already covered by the reset. A `motion` header settle needs the gate. |

### 2.7 Press, focus, and touch

**Press.** Scale by target size — one number does not fit a 300px card and a 24px disc:

| Target                        | `:active`                                             |
| ----------------------------- | ----------------------------------------------------- |
| Card / panel (≥200px)         | `active:scale-[0.99]`                                 |
| Row / chip (48–200px)         | `active:scale-[0.98]` — matches `AgentListItem` today |
| Mark used as a button (≤48px) | `active:scale-[0.94]`                                 |

All at `--identity-press` (80ms). Scale down only; the release rides the hover duration back up.

**Focus-visible parity — the rule:** _if an area has a hover state, it has a focus-visible twin that conveys the same information._ A keyboard user must never learn less than a mouse user. Two mechanisms:

- The **ring** comes from `focus-ring` (the existing utility). Use it; do not hand-roll.
- The **informational** part of the hover state must also fire on focus. Concretely, everywhere this spec writes a `hover:` class that changes colour, weight, or reveals something, it writes the `focus-visible:` twin beside it. Example from §3C: `hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline`.

`AgentIdentity`'s button branch currently has **no focus ring at all**. That is a bug this spec fixes in Slice 1.

**Touch — there is no hover, so what replaces it:**

| Desktop behaviour                  | Touch equivalent                                                                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Card hover lift                    | Nothing. The press state (`active:scale`) plus the tap opening the drawer is the whole affordance.                                                          |
| Avatar hover → identity hover card | **Already solved** — `identity-hover-card.tsx` long-press, gated to `pointerType === 'touch' \| 'pen'`. Extend the same pattern; never invent a second one. |
| Owner attribution hover            | It is a real `<button>`; tap performs the filter directly. The hover echo is a _preview of_ the tap, so its absence costs nothing.                          |
| Owner echo (§3C)                   | Desktop-only by construction. Acceptable **because** the tap does the real thing.                                                                           |

> **Touch invariant:** nothing that exists only on hover may carry information unavailable another way. Every item above satisfies this. Check any future addition against it.

---

## Part 3 — Signature moments

Options per moment. The product owner picks; each carries a cost/risk line so the pick is informed.

### 3A. The roster FLIP — cards travel when the filter changes

The highest-impact single move in this audit. Today, changing a filter, typing in search, or flipping Group-by-manager re-renders `TeamRosterGrid` as an instant DOM swap: cards teleport, and the relationship between "what I just did" and "what changed" is lost. `layout` animations restore it — and the capability is already in production here (`navigation-layout`, `SessionRowFull`, `StatusLine`, `SessionsView`).

| #      | Option                                 | Mechanism                                                                                                          | Cost / risk                                                                                                                                                                     |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1** | Full layout FLIP                       | `<LayoutGroup id="team-roster">`; each card `motion.article` with `layout` + `layoutId={member.id}`; spring 280/32 | **Medium.** `layout` measures and transforms every card each commit, interpolating size as well as position. At the few-hundred-card bound this is where it stops feeling calm. |
| **A2** | **Position-only FLIP** _(recommended)_ | Same, but `layout="position"`                                                                                      | **Low.** No size interpolation — correct here, since every grid card is the same size. `StatusLine.tsx` already uses this exact prop.                                           |
| **A3** | Enter/exit only, no travel             | `AnimatePresence`; enter `opacity 0→1, y 4→0`; exit `opacity→0, scale→0.96`; survivors snap                        | **Very low.** Captures most of the benefit for _search_ (where cards mostly leave) and none of it for the group toggle (pure re-positioning).                                   |
| **A4** | Group-toggle only                      | A2's machinery, armed only when `grouped` flips; A3 elsewhere                                                      | **Low.** Narrowest blast radius; the group toggle is the one interaction where cards genuinely travel far.                                                                      |

**Spec for A2 (the recommendation), buildable as written:**

```tsx
// TeamRosterGrid.tsx
const reducedMotion = useReducedMotion();
// Above this many cards, layout animation stops being calm and starts being a
// wave. The externals ruling bounds this at a few hundred; 120 is where a
// 3-column grid stops fitting a couple of screens.
const LAYOUT_LIMIT = 120;
const animated = !reducedMotion && members.length <= LAYOUT_LIMIT;
```

- Card root becomes `motion.article` with `layout={animated ? 'position' : false}` and `layoutId={animated ? member.id : undefined}`.
- Transition: `{ type: 'spring', stiffness: 280, damping: 32 }` — **the repo's existing layout spring**, so a card sliding matches a nav pill sliding.
- Enter: `initial={{ opacity: 0, scale: 0.97 }}`, `animate={{ opacity: 1, scale: 1 }}`, `transition duration 0.2 ease [0,0,0.2,1]`. Exit: `{ opacity: 0, scale: 0.97 }`, duration 0.15. Wrap the map in `AnimatePresence` with `mode="popLayout"` (the mode `StatusLine` uses, and the one that stops exiting cards holding their grid slot).
- **`layoutId` strategy:** use `member.id`, never a positional index. Ids are stable and unique across _both_ the flat grid and the grouped sections — which is precisely what lets a card **travel from the flat grid into its owner's cluster** rather than dying in one tree and being born in another. Safe because `groupTeamByOwner` partitions: no member is rendered twice, so no two elements ever claim one `layoutId`.
- Under reduced motion or over the limit: `animated === false` → no layout prop, no initial/animate/exit. Cards render in place.
- Emit `data-layout-animated={String(animated)}` on the grid root. This is the testable shadow of the gate (see §4.3) — one boolean drives both, so the attribute cannot drift from the behaviour.

### 3B. Avatar personality

| #      | Option                                | Mechanism                                                                                                                                                                                         | Cost / risk                                                                                                              |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **B1** | **Bot badge wake** _(recommended)_    | Disc gets `group/avatar`; badge gets `origin-bottom-right transition-transform duration-[--identity-answer] ease-[--identity-ease-out] group-hover/avatar:-rotate-6 group-hover/avatar:scale-110` | **Very low.** Pure CSS → free reduced-motion. Badge is already `aria-hidden` + `pointer-events-none`, so zero a11y cost. |
| **B2** | Photo cross-fade from letter          | Keep the fallback glyph mounted behind the `<img>`; fade in on `onLoad`                                                                                                                           | **Rejected — see §3E.**                                                                                                  |
| **B3** | Working dot breathes instead of pings | Swap `animate-ping` for a 2.4s opacity keyframe                                                                                                                                                   | **Rejected — see §3E.**                                                                                                  |
| **B4** | Ring-in on hover                      | The Mark tier from §2.4                                                                                                                                                                           | Already baseline, not a signature moment. Listed so the option set is honest about what is free.                         |

**B1 detail:** −6°, not more. At 8–12px the badge is a glyph on a plate; beyond about 8° the rotation reads as a rendering fault rather than a gesture. Scale 1.10 keeps the plate inside the disc's corner. Applies **only where the disc is itself interactive** — the roster card, the message gutter, the member list. In the sidebar it does not fire, because the disc there is not a target.

### 3C. The owner-chip hover preview (pre-echo of the filter)

Hovering `by @dorian` on one card previews what clicking it would do.

| #      | Option                                    | Mechanism                                                | Cost / risk                                                                                                              |
| ------ | ----------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **C1** | Dim the others                            | Non-matching cards → `opacity-60` at 120ms               | **Low cost, medium risk.** Dimming 20 cards on a hover is a large visual event; it can read as a glitch.                 |
| **C2** | **Highlight the matches** _(recommended)_ | Matching cards take the identity-colour border from §2.5 | **Low.** Additive, not subtractive. Nothing dims; the answer arrives as emphasis.                                        |
| **C3** | Count only                                | Hovering the attribution reveals `· 3 agents` beside it  | **Very low.** Most restrained; arguably the most _useful_ (it answers a question the border cannot). Composable with C2. |

**Mechanism for C2, no prop-drilling gymnastics:** `TeamRosterGrid` holds `const [echoOwnerId, setEchoOwnerId] = useState<string | null>(null)`. It passes `onOwnerHover` down to the card, and `highlighted={member.ownerId === echoOwnerId || member.id === echoOwnerId}` back down. The card renders `data-owner-echo={highlighted ? 'true' : undefined}` and keys the border off it. Desktop-only by construction (§2.7). Clears on `mouseleave` and on `blur`, and the attribution's `focus` fires it too, so keyboard gets parity.

### 3D. The drawer entrance

| #      | Option                                                         | Mechanism                                                                                                                         | Cost / risk                                                                                                                                                                                                                                         |
| ------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** | **One clean slide** _(recommended floor — do this regardless)_ | Override `data-[state=open]:duration-500` → `duration-300` on `ResponsiveSheetContent`                                            | **Trivial.** 500ms is the slowest transition in the whole identity flow and the most noticeable.                                                                                                                                                    |
| **D2** | Slide + header settle                                          | Panel slides at 300ms; **header only** arrives 60ms later, `y: 4 → 0`, `opacity 0 → 1`, 200ms ease-out, `useReducedMotion` gated  | **Low.** One `motion.div`. Draws the eye to the identity first, which is what the panel is about.                                                                                                                                                   |
| **D3** | Full stagger (header → chips → facts → footer, 40ms apart)     | `staggerChildren: 0.04`, matching `AvatarPickerGrid`                                                                              | **Medium cost, real risk.** A profile drawer is a _reference_ surface — people open it to read a project path. Staggering four groups puts the fact they came for ~200ms behind the panel. That is decoration taxing a lookup. **Not recommended.** |
| **D4** | **Identity accent** _(recommended, independent of the above)_  | A static 2px rule under the drawer header: `border-b-2` with `border-[color-mix(in_oklch,var(--identity-color)_55%,transparent)]` | **Trivial, zero motion.** This is the drawer's "identity answers" moment, and the calm version is that it does not move at all.                                                                                                                     |

Recommended combination: **D1 + D4**, with D2 as a cheap upgrade if the owner wants the panel to feel authored. D3 declined.

### 3E. Restraint — five things this spec says no to, and why

Documented refusals, because taste is mostly what you decline.

1. **No avatar scale-on-hover in lists.** Tempting — `AvatarPickerGrid` does `scale: 1.25` and it is genuinely delightful there. But the picker is a _deliberate customization moment_: you navigated there to play with it. A roster avatar that grows on hover shifts the row's optical baseline, and across a 30-card grid it makes the page feel like it is breathing at the cursor. **The picker earns it; the roster does not.** The Mark tier gets a ring, which is a change in _state_, not in _size_.

2. **No photo cross-fade (B2).** It requires keeping a fallback glyph mounted behind an `<img>` until `onLoad`. That trades away the current structural guarantee — documented at length in `identity-avatar.tsx` — that _no photo means no `<img>` in the tree at all_, which is the only thing preventing the browser painting its broken-image icon. A 150ms fade is not worth reintroducing a bug class that was reasoned out on purpose.

3. **No colour glow on sidebar rows.** The most tempting single idea in this audit, and the clearest no. Twenty-plus rows, and the left border already spends the identity colour on a _different_ fact (active + idle). Restated here as a refusal because it will be proposed again.

4. **No celebration on profile-drawer open.** The sparkle burst is `localStorage`-gated to fire once, ever — that is the product's own standing judgement about how often it may celebrate. A drawer someone opens forty times a day must never do it. This applies to any future "profile opened" moment.

5. **No extension of `PresetPill`'s gradient language.** It uses `linear-gradient` plus a glow `boxShadow`, both listed under Anti-Patterns in `design-system.md`. It is grandfathered inside the nebula personality picker and this spec does not touch it — but it is explicitly **not** a precedent any identity surface may cite. Flagged as a cleanup candidate for a separate ticket.

---

## Part 4 — Implementation map

### 4.1 Per-prescription

| #   | Prescription                                           | File                                                                                          | Mechanism                                                                  | Test                                                                                             |
| --- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| P1  | Publish `--identity-color`                             | `shared/ui/identity-avatar.tsx`                                                               | Inline custom property in the existing `style` object                      | jsdom: assert `disc.style.getPropertyValue('--identity-color')` equals the colour passed         |
| P2  | Motion tokens                                          | `apps/client/src/index.css`                                                                   | `:root` block under `--msg-*`                                              | None (tokens); consumed by P3–P9                                                                 |
| P3  | Surface tier on the roster card + stretched-link shape | `features/team-roster/ui/TeamMemberCard.tsx`                                                  | CSS classes; primary action as a pseudo-element overlay (§4.2)             | jsdom: class-string assertions; a11y: one accessible name per action                             |
| P4  | Per-area suppression                                   | same                                                                                          | `has-[button:hover]:` (§4.2)                                               | jsdom: assert the class string is present                                                        |
| P5  | Mark tier ring                                         | `MessageAuthorAvatar.tsx`, `entities/room/ui/MemberList.tsx`, `RoomAvatar.tsx` (stack branch) | Caller-applied classes, never inside `AgentAvatar`                         | jsdom: class assertions                                                                          |
| P6  | Fix `hover:opacity-80` → Surface tier + add focus ring | `entities/agent/ui/AgentIdentity.tsx`                                                         | Class swap on the `onClick` branch                                         | jsdom: assert `opacity-80` is **gone** and `focus-ring` present — a red-before/green-after check |
| P7  | Chip tint step, drop `brightness-95`                   | `shared/ui/mention-pill.tsx`                                                                  | `color-mix` step in the cva `interactive` variant                          | jsdom: assert `brightness-95` absent                                                             |
| P8  | Drawer duration + identity rule                        | `features/profile/ui/ProfileDrawer.tsx` _(branch)_                                            | className override on `ResponsiveSheetContent`; `border-b-2` on the header | jsdom: class assertions                                                                          |
| P9  | Bot badge wake                                         | `shared/ui/identity-avatar.tsx`                                                               | `group/avatar` + `group-hover/avatar:` on the badge span                   | jsdom: class assertion                                                                           |
| P10 | Roster FLIP                                            | `TeamRosterGrid.tsx`, `TeamMemberCard.tsx`                                                    | `motion` + `LayoutGroup` + `AnimatePresence`; `useReducedMotion` gate      | jsdom: assert `data-layout-animated` (§4.3). **Browser eyes required** for the travel itself     |
| P11 | Owner echo                                             | `TeamRosterGrid.tsx`, `TeamMemberCard.tsx`                                                    | `useState` + `data-owner-echo`                                             | jsdom: `fireEvent.mouseEnter` on the attribution → assert the attribute lands on the right cards |
| P12 | Honesty fixes                                          | `mention-pill.tsx`, `identity-hover-card.tsx`                                                 | §4.4                                                                       | jsdom: assert `cursor-pointer` and the dormant ring are gone until a real target exists          |

### 4.2 The one architectural gotcha the builder will hit

DOR-978 makes the card open the profile. **The card must not become a `<button>`** — the owner attribution inside it is already a button, and a `<button>` inside a `<button>` is invalid HTML that browsers resolve by discarding the inner one. The filter action would silently stop working.

Use the **stretched-link** pattern, which this repo already uses for hit-area expansion (`SidebarGroupAction`'s `after:absolute after:-inset-3`):

```tsx
<article
  data-slot="team-member-card"
  data-member-id={member.id}
  style={{ '--identity-color': face.color } as React.CSSProperties}
  className={cn(
    'bg-card shadow-soft relative flex items-start gap-3 rounded-lg border p-4',
    // Surface tier
    'transition-[box-shadow,border-color,transform] duration-200 ease-[--identity-ease-standard]',
    'hover:-translate-y-px hover:shadow-elevated',
    'hover:border-[color-mix(in_oklch,var(--identity-color)_var(--identity-border-mix),hsl(var(--border)))]',
    'active:translate-y-0 active:scale-[0.99] active:duration-[--identity-press]',
    // Per-area suppression: when any real control inside is hovered, the card
    // stands down, so one pointer never lights two affordances at once.
    'has-[button:hover]:shadow-soft has-[button:hover]:translate-y-0',
    'has-[button:hover]:border-border',
    className
  )}
>
  <IdentityAvatar … />
  <div className="min-w-0 flex-1">
    <h3 className="truncate text-sm font-medium">
      {/* The primary action. The pseudo-element spans the whole card, so the
          card is the target without the card being a button. */}
      <button
        type="button"
        onClick={() => onOpenProfile(member.id)}
        className="focus-ring rounded after:absolute after:inset-0 after:content-['']"
      >
        {member.displayName}
      </button>
    </h3>
    …
    {/* Above the overlay, so it keeps its own click. */}
    <button
      type="button"
      data-slot="team-member-owner"
      onClick={() => onSelectOwner(owner.id)}
      className="… relative z-10 …"
    >
      by {teamMemberLabel(owner)}
    </button>
  </div>
</article>
```

Three things this buys: valid HTML, two independently-named actions in the a11y tree, and a `has-[button:hover]:` rule that makes each area telegraph _its own_ action rather than a generic glow.

### 4.3 Test approach — and the constraint that shapes it

**`apps/client/src/test-setup.ts` globally mocks `motion/react` and strips `layoutId`, `initial`, `animate`, `exit`, `transition`, `variants`, and `whileHover`.** So **no motion prop can be asserted in jsdom, ever.** Any test that appears to check one is checking nothing.

Two consequences:

1. **Assert CSS classes and data attributes** — the same style `AgentNode.reduced-motion.test.tsx` uses (`expect(pingElement!.className).toContain('motion-reduce:hidden')`) and that `identity-avatar.test.tsx` uses throughout.
2. **For anything motion-gated, assert the gate's shadow, not the motion.** P10 emits `data-layout-animated` from the _same boolean_ that drives `layout`. One source of truth, so the attribute cannot drift. Then the test discriminates properly: render 121 members → `"false"`; render 3 → `"true"`; mock `useReducedMotion` → `"false"`. Each has a red-before state.

**Needs browser eyes** (Playwright or manual, `/dev/features#team-roster` and `#team-card`): the FLIP travel itself, the badge wake at real size, colour-mix rendering in both themes, and the drawer at 300ms. jsdom cannot judge any of these.

**Playground:** `/dev/features#team-roster` and `#team-card` (`dev/showcases/TeamShowcases.tsx`) and `/dev/components#identityavatar` (`dev/showcases/IdentityShowcases.tsx`) already exist. Per the `maintaining-dev-playground` skill, add hover/focus/press states to the identity showcase as part of Slice 1 so the grammar is inspectable in one place.

### 4.4 The honesty fixes (P12)

Small, and they belong with this work because they live in the same files:

- **`MentionPill`**: until a profile target exists, `interactive` should not render `cursor-pointer` or a `focus-visible` ring on an unfocusable `<span>`. Either drop the prop, or — better, and it composes with DOR-978 — make `interactive` render a real `<button>` so the ring becomes live and the cursor becomes true.
- **`IdentityHoverCard` footer**: `View profile` in `text-brand` beside `soon` reads as an action. `design-system.md`: "Orange means interaction or action. If you're adding it to a static, structural element — stop." Until it is wired, render it `text-muted-foreground`. When it is wired, make it a real button and _then_ it earns the brand colour.

### 4.5 Build order — three PR-sized slices

**Slice 1 — The grammar (no motion library, no new dependencies).**
P1, P2, P3, P4, P5, P6, P7, P8, P9 + playground states.
All CSS and one inline custom property. Reduced-motion is free via the global reset. Every assertion is a class string or a style property. This slice is independently valuable and independently shippable: it fixes `hover:opacity-80` across ~12 call sites, gives the roster card its first interaction states, adds the missing focus ring, and unblocks everything else by publishing `--identity-color`.
_Ships without any Part 3 decision being made._

**Slice 2 — The FLIP.**
P10. Depends on Slice 1 only for `--identity-color` (the card border it animates into). Needs the owner's pick between A1–A4; A2 is spec'd above and buildable as written.

**Slice 3 — The echoes.**
P11 + P12, plus D2 if the owner wants it. Depends on Slice 1's card shape (§4.2) for the attribution button's `data-slot` and `z-10`.

**Slice 1 has no open questions.** A builder can implement it from §2.1, §2.2, §2.4, §2.5, §2.7 and §4.2 without asking anything. Slices 2 and 3 each need exactly one decision from Part 3.
