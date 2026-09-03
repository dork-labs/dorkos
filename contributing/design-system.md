# DorkOS Design System

**Version:** 1.0
**Philosophy:** Less, but better.

---

## Design Philosophy

This interface exists to disappear. Every pixel serves the conversation. Nothing decorates — everything communicates.

We follow three principles inherited from Dieter Rams and Jony Ive:

1. **Inevitable design** — It couldn't be any other way. Each element feels like it belongs exactly where it is.
2. **Honesty of materials** — The interface doesn't pretend. No fake depth, no gratuitous gradients, no decoration disguised as function.
3. **Quiet confidence** — The best interfaces don't announce themselves. They simply work, and the user feels the difference without being able to name it.

### What We Optimize For

- **Readability** over decoration
- **Calm** over stimulation
- **Speed** over spectacle
- **Content** over chrome

### Anti-Patterns

- Purple/brand gradients
- Pure black (`#000`) or pure white (`#FFF`) backgrounds
- Heavy message bubbles with rounded corners and drop shadows
- Dramatic animations (bounces, spins, elastic effects)
- Custom display fonts for UI elements
- Decorative borders or dividers
- Hairline rules under panel headers or above footers (separate with whitespace, then tint, then a scroll-edge shadow)
- Chrome that renders at rest — row and section actions appear on hover and focus-visible

---

## Color

We avoid pure extremes. Pure white on screens produces glare; pure black creates harsh contrast. Instead, we use **off-white** and **near-black** — colors that feel natural and reduce eye strain.

Tokens are defined as HSL custom properties in `:root`/`.dark` in `apps/client/src/index.css` and exposed to Tailwind via `@theme inline`. Use the Tailwind semantic class names in components, not raw hex values.

### Light Mode

| Tailwind class          | HSL value   | Usage                    |
| ----------------------- | ----------- | ------------------------ |
| `bg-background`         | `0 0% 98%`  | Page background          |
| `bg-muted`              | `0 0% 96%`  | Subtle backgrounds       |
| `bg-secondary`          | `0 0% 92%`  | User message tint        |
| `bg-card`               | `0 0% 100%` | Elevated cards, popovers |
| `text-foreground`       | `0 0% 9%`   | Body text                |
| `text-muted-foreground` | `0 0% 32%`  | Labels, metadata         |
| `border-border`         | `0 0% 83%`  | Card borders, inputs     |

### Dark Mode

| Tailwind class          | HSL value  | Usage                    |
| ----------------------- | ---------- | ------------------------ |
| `bg-background`         | `0 0% 4%`  | Page background          |
| `bg-muted`              | `0 0% 9%`  | Subtle backgrounds       |
| `bg-secondary`          | `0 0% 14%` | User message tint        |
| `bg-card`               | `0 0% 4%`  | Elevated cards, popovers |
| `text-foreground`       | `0 0% 93%` | Body text                |
| `text-muted-foreground` | `0 0% 64%` | Labels, metadata         |
| `border-border`         | `0 0% 25%` | Card borders, inputs     |

### Brand Accent

One brand color, used with purpose: **orange** (HSL `24 90% 44%` light / `24 88% 55%` dark). Derived from the DorkOS brand palette (`#E85D04`), slightly adjusted for AA contrast.

**Where brand orange appears:**

- Focus rings (`--ring`) — every `focus-visible` interaction carries the brand
- `HoverBorderGradient` — the onboarding CTA, the first branded moment users see
- `brand` button variant — opt-in for exceptional CTAs (`<Button variant="brand">`)
- Sidebar active tab indicator — subtle brand presence in navigation
- Assistant message links and inline code — via `--ring`

**Where gray stays:**

- `--primary` — default buttons, switches, badges, selections (the quiet workhorse)
- `--accent` — hover backgrounds in menus, dropdowns
- `--secondary` — user message tint
- All structural surfaces — backgrounds, cards, borders, muted

**Usage rule:** Orange means interaction or action. If you're adding it to a static, structural element — stop. The brand lives in moments of engagement, not in decoration. Like a single red chair in a white room.

---

## Typography

System fonts. They load instantly, render crisply, and feel native to the platform.

### Font Stacks

Default stacks (from `--font-sans` and `--font-mono` in `index.css`):

```
Sans:  system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif
Mono:  ui-monospace, 'SF Mono', 'Cascadia Code', 'Fira Code', Menlo, Consolas, monospace
```

Users can override font family via Settings → Appearance. The app store (`setFontFamily`) loads Google Fonts dynamically and updates `--font-sans`/`--font-mono` via JavaScript. Avoid hardcoding specific font names in component styles.

### Scale

Base values at desktop (no mobile scaling applied). Actual rendered sizes multiply by `--_st` on mobile (default 1.25x). Users can apply a further `--user-font-scale` via Settings → Appearance.

| Token       | Base size | Usage                                     |
| ----------- | --------- | ----------------------------------------- |
| `text-xs`   | 12px      | Timestamps, tool status                   |
| `text-sm`   | 14px      | Message body text, code, metadata, labels |
| `text-base` | 16px      | (unused in chat UI)                       |
| `text-lg`   | 18px      | In-message headings (h3+)                 |

### Weights

- **400 (normal)** — Body text, most content
- **500 (medium)** — Labels ("You", "Claude"), session titles
- **600 (semibold)** — In-message headings, emphasis

### Line Length

Messages are constrained to `max-width: 65ch` (~1040px in characters, roughly 520-544px at 16px). This is the typographic sweet spot for reading comfort. Code blocks may overflow wider.

---

## Spacing

We use an **8-point grid**. All spacing values are multiples of 4px, with 8px as the base unit.

### Two Spatial Modes

The scale below is a **content**-surface scale. Control surfaces — sidebars, toolbars, list panes, menus, table rows — run dense instead, because the user operates them many times an hour rather than reading them.

|             | Content surface                                    | Control surface                                    |
| ----------- | -------------------------------------------------- | -------------------------------------------------- |
| Examples    | Message area, settings panels, cards, empty states | Sidebar, status strip, command palette, table rows |
| Body text   | `text-sm` / `text-base`                            | 13px label, `text-2xs` (11px) metadata             |
| Row height  | —                                                  | 28–32px (`h-7` / `h-8`)                            |
| Inset       | 16px and up (`p-4`, `p-6`)                         | **16px total**, panel edge to first glyph          |
| Panel width | —                                                  | 240–280px (the DorkOS sidebar is 272px)            |

**Budget the inset once.** Container, section and row padding must not compound — 12 + 8 + 10 is how a 30px sidebar gutter happens. Design decisions behind this live in the `designing-frontend` skill; Tailwind recipes live in `styling-with-tailwind-shadcn` → Control Surfaces.

### Scale (Tailwind mapping)

| Token     | Value | Tailwind | Usage                           |
| --------- | ----- | -------- | ------------------------------- |
| `space-1` | 4px   | `p-1`    | Tight padding (icon containers) |
| `space-2` | 8px   | `p-2`    | Base unit, small gaps           |
| `space-3` | 12px  | `p-3`    | Component padding               |
| `space-4` | 16px  | `p-4`    | Card padding, message gap       |
| `space-6` | 24px  | `p-6`    | Section spacing                 |
| `space-8` | 32px  | `p-8`    | Major divisions                 |

### Message Rhythm

- **Between messages:** 2px (almost continuous, grouped by time)
- **Message padding:** 16px horizontal, 12px vertical
- **Between message groups:** 24px
- **Tool card margin:** 8px top

---

## Motion

Animation should feel like physics, not decoration. Things should move because they _are_ moving — entering the viewport, responding to interaction, settling into place.

### Library

**motion.dev** (Motion) for React component animations. CSS transitions for simple hover/focus states.

### Timing

| Duration | Value | Usage                        |
| -------- | ----- | ---------------------------- |
| Instant  | 100ms | Active states, color changes |
| Fast     | 150ms | Hover states, focus rings    |
| Normal   | 200ms | Enter/exit, layout shifts    |
| Slow     | 300ms | Expand/collapse, overlays    |

### Easing

| Curve      | Value                                         | Usage                               |
| ---------- | --------------------------------------------- | ----------------------------------- |
| `ease-out` | `cubic-bezier(0, 0, 0.2, 1)`                  | Entrances (fast start, gentle stop) |
| `ease-in`  | `cubic-bezier(0.4, 0, 1, 1)`                  | Exits (gentle start, fast finish)   |
| `spring`   | `type: "spring", stiffness: 400, damping: 30` | Interactive elements                |

### Animation Catalog

**Message entrance:** Fade in + slide up 8px, spring `stiffness:320 damping:28` (settles ~250ms, no bounce). User messages also scale from 0.97→1. Only animate the _newest_ message; history loads instantly.

**Session switch:** 150ms opacity crossfade via `AnimatePresence mode="wait"`. Total transition 300ms (old exits, then new enters). Duration-based easing, not spring.

**Sidebar active indicator:** `layoutId` sliding background via spring `stiffness:280 damping:32` (smooth, deliberate slide). Animates across sidebar groups.

**Session row tap:** `whileTap` scale to 0.98, spring `stiffness:400 damping:30` (quick press feedback).

**Tool card expand:** Height + opacity transition, 300ms ease-in-out.

**Button press:** Scale to 0.97 on active, spring back.

**Send button:** Subtle scale pulse on hover (1.05), quick press feedback.

**Sidebar toggle:** Width transition 200ms, content fades.

**Command palette:** Spring entrance (scale 0.96 + y: -8, stiffness: 500, damping: 35). Sliding selection indicator via `layoutId`. Stagger items on open (first 8 only, 40ms per item). Directional x-axis page transitions (150ms ease-out). Item hover nudge (2px rightward). Preview panel width spring (stiffness: 400, damping: 35). Dialog width animates from 480px to 640px when preview panel appears.

**Streaming cursor:** 2px wide block, 1.1em tall, `blink-cursor` keyframe at 1s step-end infinite. Appended via `::after` on the last text element inside Streamdown's DOM using a `:last-child` chain. Fades in on appearance (`cursor-fade-in`, 150ms ease-out). Only the deepest matching element renders it; shallower matches use `display: none` to prevent duplicates.

**Scroll-to-bottom button:** Fade in + slide up 10px, 150ms ease-out. Fade out + slide down on exit. Right-aligned in message area overlay wrapper.

**New messages pill:** Fade in + slide up 8px, 200ms ease-out. Fade out on exit (150ms). Centered horizontally in message area overlay wrapper. Appears when new messages arrive while user is scrolled up; dismissed on click or reaching bottom.

**Live lane crossfade:** 150–200ms opacity crossfade between lane states, keyed on the state's discriminant plus its label — so `turn-streaming` re-keys only when the verb itself changes, not every render. Nothing else in the lane moves except the working dot's own breathing. Reduced motion swaps instantly with no crossfade.

**Identity surfaces have their own named grammar** — three speeds, two curves, three tiers — under [Identity → The interaction grammar](#the-interaction-grammar--what-an-identity-says-when-you-point-at-it). Anything that draws an avatar, a mention pill or a roster card follows that section rather than picking numbers from the table above.

### What NOT to Animate

- Message content (text should just appear)
- Scroll position (use native smooth scroll)
- Colors on non-interactive elements
- Anything during initial page load

---

## Components

### Messages

**Flat layout.** No bubbles. AI chat responses are often long and contain code — bubbles add visual noise.

- **User messages:** Subtle background tint (`bg-secondary`), full-width
- **Assistant messages:** No background, content speaks for itself
- **Avatars:** 28px circles. User = primary color with User icon. Claude = subtle warm gray with Bot icon.
- **Labels:** "You" and "Claude" in `text-xs`, `text-secondary`, `font-medium`
- **Links in an answer are real anchors** (`MarkdownLink`, DOR-1272): hover shows the destination, right-click offers the browser's own link menu ("Copy Link Address" included — even inside a room row's own right-click menu). A plain left click always confirms first through the shared link-safety modal; cmd/middle-click bypasses that confirmation and opens a tab, but only for an absolute `http(s)` link — anything else (`tel:`, a relative path, …) still confirms.

### Code Blocks

- **Inline code:** `font-mono`, `text-sm`, light background tint, 3px border-radius, 2px 5px padding
- **Fenced blocks:** Shiki syntax highlighting with `github-light` / `github-dark` themes (via Streamdown)
- **Block chrome:** Language label (top-left, `text-xs`, `text-tertiary`, uppercase tracking). Copy button appears on hover (top-right).
- **Border:** 1px `border-subtle`, 8px border-radius

### Tool Call Cards

- 1px border, 8px border-radius, `bg-surface` background
- Status icon: spinning loader (running), checkmark (complete), X (error)
- Tool name in `font-mono`
- Expandable with smooth height animation
- Hover: border darkens slightly, subtle shadow appears

### Live lane

`Conversation.LiveLane` (`features/conversation/ui/LiveLane.tsx`) is the one reserved line
above every composer — a session's and a channel's alike — that says what is happening here.
Replaces `ChatStatusStrip` and the room's under-composer `RoomPresenceLine`, unifying two
formerly separate lines into one component every surface renders.

**The reserved height is the feature.** Fixed at `h-6` (24px), **never `min-h`**, mounted
whether or not there is anything to say. A room going from quiet to busy moves nothing else on
screen — the line it replaces came and went, which pushed the last message a reader was looking
at. It sits as a flex sibling of the scroller, never inside it: a height change inside the
scrolling element would move `scrollHeight` under the timeline's own scroll-position tracking
and un-pin a reader who never scrolled.

**One status vocabulary — the priority stack.** Nine rungs, evaluated top to bottom, first
match wins, each gated by the capability that makes it possible:

1. **`ask`** (`capabilities.asks`) — a prompt somebody can answer. Grows into the Ask card.
2. **`stalled`** (`capabilities.streamHealth`) — this client cannot read the stream.
3. **`presence`** (`capabilities.presence`) — somebody else is working here.
4. **`turn-waiting`** (`capabilities.turnStatus`) — this turn is parked, with no prompt object
   in hand.
5. **`turn-progress`** (`capabilities.turnStatus`) — a long operation is running.
6. **`turn-system`** (`capabilities.turnStatus`) — an informational runtime event.
7. **`turn-streaming`** (`capabilities.turnStatus`) — a turn in flight.
8. **`turn-complete`** (`capabilities.turnStatus`) — the summary, auto-dismissing.
9. **`empty`** — nothing to say, and the lane looks like it.

Three orderings are decisions, not accidents, and none may be collapsed: **`ask` beats
`stalled`** (a live Ask's countdown runs off `startedAt`, not the stream, so it stays true and
answerable even while the wire is quiet); **`stalled` beats `presence`** (a client that cannot
read the stream must not claim to know who is working — `specs/room-presence` §5.4); and
**`turn-waiting` survives even though `ask` outranks it** (a parked turn with no prompt object —
a capability hold, a runtime that said `blocked` and sent nothing else — is a different fact
from a prompt in hand, and collapsing the two makes the second silently invisible). There is
deliberately **no `queued` rung**: a queue only exists because a turn is already in flight, so
it would never win against `turn-streaming` and would hide what the agent is doing in order to
report a number. Held drafts live in the composer's own queue panel instead (see Composer,
below).

**The announcer rule: one live region, counts not verbs** — the same principle §Zones already
states for the Heads up zone's badge, applied to the lane. `role="status" aria-live="polite"`
wraps the lane's own text, so a change in WHAT it says (presence count, stalled, ask headline)
is announced, but a `turn-streaming` verb changing every couple of seconds while a turn works is
not — a screen reader is not a siren. The Ask card that grows out of rung 1 is announced
separately, through `Conversation.Timeline`'s own `approvalAnnouncement` slot (`role="status"`),
because answering a prompt is a distinct event from the lane's own presence chatter.

**Motion:** the lane crossfades between states in 150–200ms, keyed on the state's discriminant
plus its label (`turn-streaming:${verbKey}` for a changing verb, so it animates only on a real
change) — see the Animation Catalog above. Reduced motion swaps instantly, no crossfade.

### Scroll Overlays

Both overlays live in a `relative flex-1 min-h-0` wrapper in ChatPanel, positioned `absolute` **outside** the scroll container. This ensures they stay fixed relative to the message viewport, not the scrollable content.

- **Scroll-to-bottom button:** `absolute bottom-4 right-4`. Rounded circle, `bg-background`, 1px border, `shadow-sm` → `shadow-md` on hover. `ArrowDown` icon from lucide-react. `aria-label="Scroll to bottom"`. Visible when user is 200px+ from bottom.
- **"New messages" pill:** `absolute bottom-16 left-1/2 -translate-x-1/2`. Rounded pill, `bg-foreground text-background` (inverted for high contrast in both themes), `text-xs font-medium`, `px-3 py-1.5`. `role="status" aria-live="polite"`. Visible when new messages arrive while scrolled up.
- **Layout when both visible:** Pill centered at `bottom-16` (64px), button right-aligned at `bottom-4` (16px). Non-overlapping. Both clickable, both scroll to bottom, both dismiss when bottom is reached.

### Scrollbars

Tailwind's first-party `scrollbar-*` utilities (v4.3+) are the sanctioned surface — never hand-roll `scrollbar-width` / `::-webkit-scrollbar` CSS:

- **`scrollbar-none`** — hide the native scrollbar while keeping scroll (status strip, message list with custom scroll overlays). Radix `ScrollArea` already hides native scrollbars and renders its own; use it for panels that want a styled thumb.
- **`scrollbar-thin`** — thin native scrollbar where visible chrome is fine. The global base style in `index.css` already applies `scrollbar-width: thin` + theme-aware `scrollbar-color` to every element, so reach for this only to re-thin something after overriding.
- **`scrollbar-gutter-stable`** — reserve gutter space on conditionally-scrolling dialog/panel bodies to prevent layout shift on classic-scrollbar platforms (Linux/Windows).

### Input Area

- Full-width textarea with auto-resize
- Placeholder: "Message Claude..." in `text-tertiary`
- Border: 1px `border-default`, lightens on focus to `accent`
- Send button: circular, `accent` color, icon-only
- Stop button: circular, muted red, square icon

### Sidebar

Built on **Shadcn Sidebar** (`layers/shared/ui/sidebar.tsx`) with `collapsible="offcanvas"` mode. On the web cockpit the sidebar body is the `DashboardSidebar` agent roster (in `features/dashboard-sidebar/`) on every route — per-session context now lives in the right-panel inspector, not a sidebar drill-in. A registered `sidebar.body` contribution can take over the body for its route (the marketplace facet panel does on `/marketplace`). The Obsidian embed's chrome is `EmbedSidebar` (`features/session-list/`), a single-view roster with no tab strip — the four-tab `SessionSidebar` it replaced was retired (DOR-401); see [Sidebar Tabs](#sidebar-tabs) below.

- **Width**: the visible panel is **272px** — the number to build to, and the number a browser test measures on `sidebar-inner`. **Do not set `--sidebar-width` to 272px.** That variable on `SidebarProvider` (`AppShell.tsx`) sizes the _slot_, and the `inset` variant adds `p-2` — 8px of padding a side — before the tinted surface starts. So the slot is `calc(272px + 1rem)`, which is what `AppShell` writes, and the panel inside it is 272. Writing `17rem` there would give a 256px panel, not a 272px one. Never set a one-off width on a component to work around any of this.
- **CSS variables**: `--sidebar-*` in `index.css`. The panel sits distinctly off the main background — `--sidebar` is 91% against a 98% background in light mode, and 10% against 4% in dark.
- **Mobile**: Renders as Radix Sheet (drawer) with backdrop and swipe-to-close
- **Desktop**: Push layout via `SidebarProvider` + `SidebarInset`
- **Toggle**: `Cmd+B` / `Ctrl+B` (Shadcn built-in `SIDEBAR_KEYBOARD_SHORTCUT`)
- **SidebarRail**: Invisible hover-target strip at sidebar edge for mouse-over toggle
- **SidebarTrigger**: Toggle button in `SidebarInset` header (outside the sidebar itself)
- **Zones, not temporal grouping**: rows are grouped into Heads up, Getting started, Today and Library — see [Zones and Sections](#zones-and-sections) below — never by session date.
- **Rows**: `SidebarModelRow` draws each row from `buildSidebarModel`'s output; `isActive` highlights whichever row matches the current route.
- **Header block**: `SidebarHeaderBlock`, mounted in `Sidebar` above the body-swap region — persistent chrome that survives a `sidebar.body` takeover (spec BC-43→46). A button named after the operator ("Dorian's team"), opening Workspace settings / Account / a quiet version line; the `NewMenu` (Session, Channel, Direct message, Agent…, Agent group — every create surface in the sidebar, and nowhere else); and `SidebarSearchPill`, the ⌘K pill.
- **Footer**: `SidebarFooter` contains `ProgressCard` (onboarding) and `SidebarFooterStrip` — one slim tinted row of destinations (Home, Team, Marketplace, Connections), a `⋯` menu holding the `sidebar.footer` slot, and ✦ Ask DorkBot. No logo, no version line, no `border-t`: separation is a step up the `--sidebar-accent` ramp (spec `sidebar-now-today-library` BC-47, R1)
- **Dialogs**: All 6 dialogs (Settings, DirectoryPicker, Tasks, Relay, ServerRestartOverlay, ShapeSwitcher) registered in `DialogHost` at the app root level, outside `SidebarProvider` (`layers/widgets/app-layout/model/dialog-contributions.ts`). `OnboardingFlow` renders directly from `AppShell.tsx`, not via `DialogHost`.

### Separation by tint, not by borders

Nav panels separate their levels with tint and whitespace, not hairlines. Add no `border-b` under a header, no `border-t` above a footer, and none between sections; where an edge needs to read at all, it is a scroll-edge shadow that appears only once content scrolls under the header or footer. `SidebarFooter` (`AppShell.tsx`) already carries no `border-t` — do not add one back. That is not the last hairline in the app's nav panels, though: `MarketplaceSidebar.tsx`'s `SidebarHeader` still has a `border-b`, not yet migrated to this rule — remove it when that panel's turn comes, and remove any other hairline you pass.

Every level of separation comes off **one ramp**, `--sidebar-accent`, and no new colour is introduced:

| Level        | Class                                                  | What it does                          |
| ------------ | ------------------------------------------------------ | ------------------------------------- |
| Zone card    | `bg-sidebar-accent/40`                                 | recessive tint, ~2–3% effective delta |
| Footer strip | `bg-sidebar-accent/60`                                 | separates the footer from the panel   |
| Row hover    | `bg-sidebar-accent/70`                                 | reads on top of the zone tint         |
| Row active   | `bg-sidebar-accent` + `text-sidebar-accent-foreground` | the strongest step                    |

**Never use `--muted` inside the sidebar.** It inverts direction between themes. `--sidebar` is 91% light and 10% dark, while `--muted` is 96% light and 9% dark — so a zone tinted with `--muted` is _lighter_ than its panel in light mode and _darker_ in dark mode. `--sidebar-accent` is 86% light (−5%) and 16% dark (+6%): it moves away from the panel in the same perceptual direction in both themes, at the 5–10% delta this system asks for.

Status colour stays on the semantic tokens, which are already calibrated per theme and are already what `status-dot.ts` uses: `bg-status-success` (working), `bg-status-warning` (needs you, directed badges), `bg-status-error` (error or wedged), `bg-status-info` (unseen). No raw hex, and no new `--sidebar-zone-*` variable — one ramp is the point.

Label-on-zone-tint must still meet 4.5:1 in both themes. Check it with an axe-core run over the playground showcase rather than by eye.

#### Where that check lives, and how to not fool yourself with it

The showcase is **`/dev/sidebar-model`** (`apps/client/src/dev/showcases/SidebarModelShowcases.tsx`), which draws `buildSidebarModel` over its four journey fixtures. The axe run over it is `apps/e2e/tests/dashboard-sidebar/sidebar-model-showcase.spec.ts`, in both themes, and it attaches a light/dark screenshot pair to the run.

**An axe run is not a gate until you have proved it can fail.** axe-core's `color-contrast` builds a spatial grid bounded by the viewport, and text whose rect falls outside that grid is not evaluated at all — not a violation, not a pass, not even an `incomplete`. It is simply absent, and the run reports success. At Playwright's default 720px-tall viewport this page evaluated **1 node out of 343**, and a deliberately-injected 1.68:1 label was **not reported**. Every axe check in this repo inherits that trap.

**Guard it with something that moves when the page moves.** The first attempt here was `expect(evaluated).toBeGreaterThan(200)`, and a floor is not coverage: at 1600×2400 the page evaluated 260 nodes and cleared the bar while missing two injected 1.91:1 labels, and at 1600×4000 it evaluated 322 and missed the same two. The number went up as the page got taller; it just never went up as fast as the page did. So assert page-relatively instead, and prefer both:

- **The content fits the viewport** — compare the axe context's height against `window.innerHeight` before running axe. This is what actually guarantees the grid covers everything, and it fails with the real reason ("the page outgrew the viewport") rather than a threshold nobody can interpret.
- **Every element of some class you own was evaluated** — resolve axe's reported targets back to elements and assert a known set is among them. The sidebar-model spec uses its reason chips: one per zone, section and row, spread top to bottom, so the denominator grows on its own when the page does.

A threshold is not coverage unless it moves with the thing it measures.

Two smaller things from the same branch:

- **A one-character label is `incomplete`, not a pass.** axe refuses to judge text shorter than its "is this really text" heuristic, which covers every numbered unread badge. Those land in the run's `incomplete` bucket; the spec pins that bucket to exactly the badges, so a new "cannot determine" elsewhere is caught rather than inherited.
- **The muted quarantine is meant to go red.** The spec quarantines the one contrast failure on the page — muted rows, below — with an equality assertion rather than a filter, so it fails both when a new failure appears and when the muted one is fixed. A green quarantine after the fix lands would be the quarantine outliving its reason.

#### Muted means fewer signals, not less legibility

A muted row keeps **full label contrast** and gives up its attention signals instead: no bold, no badge, no dot. That is already the vocabulary the two-tier unread system speaks, and it is what mute has always meant — "stop pulling me back into this", never "make this harder to read".

Dimming is the wrong mechanism and it is not a tuning problem. `SidebarRow` dims `muted` rows with `opacity-60` over a label that is only 5.9:1 to begin with, which measures **2.6:1 in light and 3.6:1 in dark**; no opacity value clears 4.5:1 from that starting point. Reducing contrast also spends the accessibility budget of exactly the readers least able to afford it. Replacing the dim in `shared/ui/sidebar-row.tsx` is **DOR-1098**.

### Zones and Sections

A nav panel has **two levels and one header style** (`specs/sidebar-simplification` D1, 2026-08-19). It used to have three — a zone label, a section header and rows, each starting on its own x — and a 272px panel cannot teach three.

- **Zone** — a landmark with no chrome of its own (Heads up, Getting started, Today, Library). It draws no heading; it groups, tints and names itself for assistive tech through `aria-label`. `ZONE_LABEL.library` is an accessible name that is never painted. The first zone's label became **Heads up** on 2026-08-11 (DOR-1155) — label only; its id is still `now` in the model, the DOM and config.
- **Section** — a header and its rows. Heads up, Today, Getting started, Pins, Channels, Direct messages, Agents and every section a person makes are all the same header, and all but Getting started fold.

**Every header folds.** Click anywhere on it, or press Enter/Space; `Alt`/`Option`-click folds or unfolds every header in the panel. A folded header keeps its roll-up as trailing text — "12 · 3 unread · 1 working" — so folding never loses signal, and Heads up's roll-up counts what NEEDS answering rather than its rows, so folding it can never quietly hide a permission prompt.

Never nest accordions, and keep nav trees to **one indent level** — depth past two stops helping wayfinding. Section labels are sentence case, **11px medium**, `text-sidebar-foreground/70`, with **no icon**: the rows underneath carry the glyph, and a `#` above a list of `#` rows says the same thing twice. ALL-CAPS with letterspacing reads dated at small sizes.

#### The three geometry tokens

Every horizontal inset in the sidebar comes off three custom properties, declared on `:root` in `apps/client/src/index.css`. They are measured **from the panel's left edge**, not from the element that pays them — the panel already pays 8px (`px-2` on `SidebarContent`), so each consumer applies `calc(var(--token) - 0.5rem)`.

| Token                | Value | What it fixes                                                                    |
| -------------------- | ----- | -------------------------------------------------------------------------------- |
| `--sidebar-header-x` | 12px  | Where every section header's label starts.                                       |
| `--sidebar-row-x`    | 20px  | Where a row's 18px glyph slot starts. The label follows at 20 + 18 + 8 = **46**. |

**Two tokens, because there are two levels.** A third — `--sidebar-nested-x` — indented a hand-made section's members back when a section rendered inside Agents; sections are peers of Channels and Agents now (`specs/sidebar-simplification` D3), so nothing in the panel is nested and the token went with its last consumer.

Never write a sidebar inset as a literal. `apps/e2e/tests/dashboard-sidebar/sidebar-row-gutter.spec.ts` reads these tokens out of the live document and measures the computed padding against them, so retuning one moves every header, every row and the glyph-action overlay together — and changing one half alone goes red with the number it actually got.

**Muted is fewer signals, not less contrast** (DOR-1098). A muted row keeps its label at full contrast and loses the bold, the unread badge and the working dot. The `opacity-60` it used to wear took the label to roughly 3:1 — under the 4.5:1 every label owes — so silencing a conversation made the one thing still worth reading hard to read.

#### Accessibility contract

This is the whole contract a zoned nav panel must meet, and it is what shipped: `SidebarZone.tsx`, `SidebarSection.tsx` and `use-live-region-text.ts` implement it, and `DashboardSidebar.tsx` composes them. Treat it as the spec those components are checked against, not a future one.

- **Landmarks.** The panel root is `<nav aria-label="Sidebar">`. Each zone is `<section aria-label="{label}">` with **no visible heading** — the section header inside it is what a person reads. Sections are `<h3>` containing a `<button aria-expanded aria-controls>`; group sub-headers are `<h4>`.
- **Roving tabindex, per section.** Each section exposes exactly one tab stop — the active row if the section holds it, otherwise the section's first stop, which is its header. `ArrowDown`/`ArrowUp` move within the section (header → its `+` → the rows), `Home`/`End` jump to the **first and last row** (never to the header or the `+` — the header is one `ArrowUp` off the top, and it is where you go to fold a section rather than to start reading it), and `ArrowLeft`/`ArrowRight` on a section header collapse or expand it. `Tab` moves between sections and zones, so a 60-agent Library is four tab stops rather than sixty. A **mounted inline editor keeps its own tab stop**: a rename field is up because somebody is typing in it, and stamping it `-1` with everything else is what made it impossible to Tab out of and back into.
- **One live region, counts only.** A single visually-hidden `aria-live="polite" aria-atomic="true"` element inside the Heads up zone announces how many things need you ("2 agents need you"), debounced 1s. Verbs, activity and unread changes are never announced — a fleet of agents would otherwise turn a screen reader into a siren.
- **Only "working" animates.** The status dot uses `STATUS_DOT_PULSE` (`shared/ui/status-dot.ts`), which is `motion-safe:animate-pulse`; its ping halo carries `motion-reduce:hidden`. Scroll-to-active uses `behavior: 'auto'` under `prefers-reduced-motion`, and the celebratory moments (the welcome-back glow, the all-clear beat) do not render at all under it.
- **Hover-revealed chrome always has two other paths.** `focus-visible` reveals it on the keyboard, and on touch it is either always visible or reachable by long-press (see [Hover Pattern Mobile Alternatives](#hover-pattern-mobile-alternatives)). Nothing may be reachable by hover alone.
- **Every drag has a keyboard and pointer alternate** (WCAG 2.5.7). Reorder, pin/unpin and move-to-group are all reachable from the row kebab and the context menu on every platform. `KeyboardSensor` and `sortableKeyboardCoordinates` stay wired, and the `buildSidebarAnnouncements` strings (`features/dashboard-sidebar/model/use-sidebar-dnd.ts`) are preserved verbatim.
- **Colour is never the sole indicator.** Every status dot is paired with a verb line, a tooltip or an `aria-label`, and the two unread tiers differ in weight and shape as well as hue — see [Unread — Two Tiers](#unread--two-tiers), which is where that rule is defined.

### Sidebar Tabs

Retired. The four-tab `SessionSidebar` strip this section used to document (Overview / Sessions / Schedules / Connections, switched via a CSS `hidden`-toggle so all three stayed mounted) no longer exists. DOR-401 retired it: the Obsidian embed's chrome is now the single-view `EmbedSidebar` roster (see [Sidebar](#sidebar) above), and the Overview/Schedules/Connections context it carried moved to the right-panel Inspector (Pulse, Profile) or was dropped. ADR-0107, which decided the CSS `hidden`-toggle mechanism, is deprecated as of the 2026-08-06 audit — kept as the archival record of a component that no longer ships.

### Tooltip

Standard shadcn Radix tooltip from `shared/ui/tooltip.tsx`. Used for:

- Disabled state indicators (e.g., "Pulse is disabled" on HeartPulse icon)
- Contextual information on icon-only buttons

`TooltipProvider` is mounted in `App.tsx`. Use `<Tooltip>` + `<TooltipTrigger>` + `<TooltipContent>` pattern.

### Toast Notifications (Sonner)

Theme-aware toast via `sonner` from `shared/ui/sonner.tsx`. `<Toaster />` mounted in `App.tsx`.

**When to toast:**

- Background actions with no immediate visible UI change ("Run triggered", "Schedule approved")
- Error notifications for failed mutations

**When NOT to toast:**

- Toggle on/off (switch state is self-evidencing)
- Form submission success (dialog closes)
- Cancel run (status updates inline)
- Reject schedule

Usage: `import { toast } from 'sonner'` then `toast('message')` or `toast.error('message')`.

### Banners

Full-width app banner from `shared/ui/banner.tsx` (`Banner`), for a **standing condition** that stays until it resolves — an agent running unattended, a waiting update, connection lost. A banner is not a toast: a toast fires once for a transient event and fades; a banner persists while the condition is true.

**A banner states a fact; it does not ask a question.** The first-run telemetry invitation used to live here and was moved off it (spec `full-power-defaults` D5): a yes/no question in a slot built for standing conditions just sits above every route until someone answers it. One-time questions belong on the moments rail below. The canonical banner today is the unattended-autonomy one (`UnattendedAutonomyBanner`) — a condition that is true right now and stops being true on its own.

**A banner is the second voice, so it needs the fact to be worth two.** The all-permissions-bypassed banner was retired for this reason (spec `trust-dial`, decision 3A): the status strip already carried the word and the tint for a session the person was sitting in front of, and two alarms about one fact teach people to read neither. Ask what the banner says that the surface the person is looking at does not.

**Banner vs toast:**

- **Banner** — a condition that is _still true_ right now (an agent running unattended, an update waiting, the connection lost). Persistent, dismiss only when it makes sense.
- **Toast** — a moment that just _happened_ (run triggered, save failed). Transient, auto-dismisses.
- **Moment** — a one-time question that has to be answered once and then never again (see below). Modal, at most one per app launch.

**One slot, one banner.** App-wide banners render through a single `AppBannerSlot` mounted just below the shell header (`widgets/app-banner`). It ranks eligible banners by priority and shows only the highest — never a stack. Add one by writing a `BannerDescriptor` hook (`id`, `priority`, `variant`, `render`) and appending it in `useAppBanners`; use `BANNER_PRIORITY` for the standard ladder. See ADR 260720-151913.

**Variants** (severity ladder, `critical > warning > info > neutral`):

| Variant    | Use                                                  | Announce        |
| ---------- | ---------------------------------------------------- | --------------- |
| `critical` | An error blocking the user right now                 | `role="alert"`  |
| `warning`  | A risky standing state (e.g. usage near its ceiling) | `role="status"` |
| `info`     | A neutral heads-up                                   | `role="status"` |
| `neutral`  | Announcements (the default)                          | `role="status"` |

There is **no `success` banner** — a success is a toast. Colors come from the `--status-*` tokens, so light/dark and the Obsidian bridge stay correct. Pass `onDismiss` only for a dismissible banner; pass `details` + `detailsOpen` for a collapsible progressive-disclosure region. The telemetry banner was its only production user before it became a moment, so the working example is now the Dev Playground showcase (`dev/showcases/BannerShowcases.tsx`) rather than a shipped surface.

### Moments (one-time modals)

A **moment** is a question the app asks once and then never again: consent, a new default that needs a decision. It is not a banner — a banner states a condition and waits for it to resolve, and a question parked in one just sits above every route until somebody answers it. Moments ride `widgets/moments`, which is to modals what `AppBannerSlot` is to banners.

- **Eligibility lives in the descriptor hook, not on the descriptor.** Write a hook that returns a `MomentDescriptor` (`id`, `priority`, `render`) when the moment should be asked and `null` when it should not, then append its result in `useMoments` — no other wiring. Returning `null` is what makes an ineligible moment structurally unable to occupy the winning slot.
- **`MomentHost` opens exactly one**, the highest `priority` (`MOMENT_PRIORITY`), ties going to collector order. Never a stack.
- **At most one moment per app launch**, latched by a non-persisted flag in the app store. A reload is a new launch; anything else waits for it.
- **Never over the onboarding overlay**, and never before onboarding is finished or dismissed. Staying quiet does not spend the launch.
- **Never off a cache the server has not confirmed this page load.** `['config','current']` is on the warm-boot persister's allow-list and, inside its 30s staleTime, a reload can serve it without asking the server. The host waits for `isFetchedAfterMount` before opening anything, because re-asking a question already answered in another window — and then overwriting the real answer — is worse than asking one launch later.
- **Focus the dialog, never the affirmative button.** The host sets `onOpenAutoFocus` to focus the content container, so the title and description are announced before any control and no keystroke lands on a consent button the reader has not reached.
- **Persistence is the moment's own concern**, through a real state field it already owns (telemetry's is `telemetry.userHasDecided`). Do not add a `shownMoments` ledger — a parallel record only drifts from the thing it mirrors.

### Command (cmdk)

Searchable combobox from `shared/ui/command.tsx`. Used with Popover for dropdown positioning. Primary use case: timezone selection in Pulse CreateScheduleDialog.

Pattern: `Popover` > `PopoverTrigger` > `PopoverContent` > `Command` > `CommandInput` + `CommandList` > `CommandGroup` > `CommandItem`.

**Global command palette**: The `features/command-palette/` module uses cmdk with `shouldFilter={false}` to disable built-in filtering, delegating all search to Fuse.js (`use-palette-search.ts`). Category prefixes: `#` for channels, `@` for agents and DMs, `>` for commands. The palette uses a `pages` array state for sub-menu drill-down with breadcrumb navigation. List height transitions use the `--cmdk-list-height` CSS variable with a `max-height` cap:

```css
[cmdk-list] {
  max-height: min(var(--cmdk-list-height), 60vh);
  transition: max-height 150ms cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden !important;
}
```

**Split-pane layout**: The palette dialog uses a flex-row container. `CommandList` takes remaining width; `AgentPreviewPanel` (60%) appears when an agent item is keyboard-selected. The `ResponsiveDialogContent` transitions between `max-w-[480px]` and `max-w-[640px]` via a CSS `transition-[max-width] duration-200`. On mobile (`useIsMobile()`), the preview panel is hidden entirely.

**Character highlighting**: `HighlightedText` renders Fuse.js match indices as `<mark>` elements with `bg-transparent text-foreground font-semibold`. All content passes through React's createElement pipeline (no raw HTML).

**PaletteFooter**: Dynamic keyboard hint bar using `<kbd>` elements styled with `border, rounded, monospace font, text-xs, text-muted-foreground`. Shows context-appropriate shortcuts (navigate, open, back, close).

---

## Identity

Every identity in the cockpit — an agent, a person, the room a direct message is with — is drawn as the same disc: `IdentityAvatar` (`shared/ui/identity-avatar.tsx`). It is the only place this convention is implemented, and this section is the only place it is written down.

**Tell it what the identity is, not how to draw it.** Pass `kind` and the disc derives its shape, its fill and its corner mark together:

| `kind`                             | Shape    | Fill   | Badge                                          |
| ---------------------------------- | -------- | ------ | ---------------------------------------------- |
| `agent`                            | `square` | `fill` | `Bot`                                          |
| `human`, on this machine (or none) | `circle` | `tint` | none — absence is the signal                   |
| `human`, bridged from elsewhere    | `circle` | `tint` | the platform's own mark, else a generic `Send` |
| `system`                           | `circle` | `tint` | none                                           |
| _omitted_                          | `circle` | `tint` | none                                           |

Two things make this the shape it is:

- **Square is the agent shape, circle the person shape.** The distinction is carried by silhouette, not colour and not the badge, so it survives colourblindness, a 20px disc, and a row where the badge is switched off. The square's radius steps up with the diameter — a fixed radius that reads well at 48px rounds into a circle at 20px, erasing the distinction exactly where the design leans on it hardest.
- **Only agents get a badge.** A mark on every row would be a column of identical glyphs saying nothing, and one reading "person" would put the burden of proof on the humans. The exception is a person bridged in from another platform: "someone on this machine wrote this" and "a stranger on the internet wrote this" have to be told apart at a glance.

**`kind` takes the repo's own vocabulary** — `AuthorKind` from `@dorkos/shared/room-schemas`, the same `'human' | 'agent' | 'system'` the wire carries. A caller holding `author.kind` passes it straight through; there is no second spelling to translate into and forget. "Circle is the person shape" is a sentence for docs, never a value in code.

**Explicit props win, one axis at a time.** Pass `shape`, `variant` or `badge` and the derivation steps aside for that axis only — an agent drawn round keeps its fill and its badge. `badge={null}` is the explicit "no badge here", which is what an agent-only list wants: keep the shape, drop the redundant glyph. Omitting `kind` reproduces the pre-`kind` defaults exactly, so the prop is additive.

**`status` is the top-right corner, and it is kind-agnostic.** One slot, four states, from `IdentityStatus` (`shared/ui/status-dot.ts`): `idle` draws nothing at all, `working` is a `bg-status-success` dot that pulses, `needs-you` a still `bg-status-warning`, `error` a still `bg-status-error`. Ringed in the page background, opposite the badge. **Only `working` moves** — motion is what the word "now" is made of, so a state that pulsed would claim to still be running; under `prefers-reduced-motion` the dot stays and only the animation goes. An agent mid-turn and a person mid-task are the same fact to a roster, so nothing about the slot is agent-specific.

`working` means a turn is streaming as you look at it, and nothing weaker. It used to default to `healthStatus === 'active'` — the mesh's "seen within the last hour" — so every list row in the cockpit pulsed a right-now claim sourced from an hour-old heartbeat. A caller with no turn-level signal passes nothing.

**One dot vocabulary, everywhere.** The colours live in `STATUS_DOT_COLOR` and reach a dot through `statusDotClass(signal)`, which adds the pulse for `working` and for nothing else. Row-level dots take the same route and add `unseen` (`bg-status-info`) — a fact about a conversation you have not read, which a face never carries. The sidebar's `AgentActivityBadge`, the tab strip's `AppTabItem`, the sidebar `GroupHeader` and the disc's own corner all read that one map; before it they spelled the same green four ways (`bg-green-500`, `bg-emerald-500`, `bg-primary`, `bg-status-success`), each free to drift when either theme moved.

**Reaching the disc.** `AgentAvatar` (`entities/agent/ui/AgentAvatar.tsx`) is the agent-side wrapper: it hard-passes `kind="agent"` and deliberately accepts no `shape` or `variant`, so the convention cannot be skipped through it. It carries **no mesh health** — it used to draw a coloured ring keyed on when the agent was last seen, ~2px outside a working dot lit from the same fact, on every list row in the product. Health is a diagnostic about the last hour and the corner dot is a claim about this second; the two surfaces that genuinely need health (the profile header, the mesh topology page) now say it in their own words, where there is room to say _which_ health it is. Room and roster surfaces pass `kind` to `IdentityAvatar` directly; a room must never import the agent entity to draw an agent square.

**Deciding what to draw: `resolveIdentityFace` (`shared/lib/identity-face.ts`).** One pure function turns the fragments a caller happens to hold into the props the disc takes — colour, emoji, fallback letter, kind, origin. Precedence, highest first: an explicit `override` (an agent's own manifest face, which only a feature-layer caller can reach), then the record's own render cache, then a colour hashed from the opaque id with the first letter of the name. It hashes a colour but never an emoji: a letter admits the face is unknown where an invented emoji would look chosen. **Inventing an agent's emoji is a caller's job, not this function's** — `teamMemberFace` (`entities/team/lib/team-member-face.ts`) does it for roster rows, because a `TeamMember`'s `id` is the agent's manifest ULID and hashing that reaches the same face the sidebar draws. This function's other callers hold author-row ids, which hash differently, so the rung has to sit where the right id is (DOR-1122). It takes no agent types on purpose — that is what lets `entities/room` use the same ladder a feature does, and two roster surfaces hand-rolling their own is what made an agent read as two different identities in one room.

### The interaction grammar — what an identity says when you point at it

Sixteen components draw identities. Before this, four had any hover state and three of those said "something is here" without saying **what pressing it would do**. The grammar below is the consistency layer: it is all CSS, and the tier decides the response so no call site invents one.

**The keystone.** `IdentityAvatar` publishes its colour as `--identity-color` on the disc, alongside the inline `background-color` it always painted. That one line is what makes any of this possible: an inline background outranks every stylesheet rule, so while the colour lived only there, no `:hover` could tint it, ring it, or lend it to an ancestor's border. Custom properties inherit, so the disc, its children, and any ancestor that sets the same property can now reach the colour from a class string. `TeamMemberCard`, `ProfileSheet` and `ProfileView` set it on their own roots from the resolved face, for exactly that reason.

**Three speeds and two curves, in `index.css`. There is no fourth.**

| Token                      | Value                          | Applies to                                        |
| -------------------------- | ------------------------------ | ------------------------------------------------- |
| `--identity-press`         | 80ms                           | `:active` transforms — land before a finger lifts |
| `--identity-answer`        | 120ms                          | hover on a **mark** or a **chip** (≤48px)         |
| `--identity-settle`        | 200ms                          | hover on a **surface**, and any reveal            |
| `--identity-ease-out`      | `cubic-bezier(0, 0, 0.2, 1)`   | anything arriving, growing, appearing             |
| `--identity-ease-standard` | `cubic-bezier(0.4, 0, 0.2, 1)` | anything that changes in place and stays          |

Plus two colour steps: `--identity-border-mix` (35%) and `--identity-ring-mix` (60%). **No overshoot lives here** — `[0.34, 1.56, 0.64, 1]` exists in exactly two places, both moments you deliberately went to (the avatar picker, the hub hero). Overshoot is a signature-moment budget line, not a hover curve.

**Three tiers, decided by what the thing does:**

| Tier        | It is…                                             | It answers with                                                       |
| ----------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| **Surface** | a card or row whose whole area triggers one action | lift `-1px`, `shadow-elevated`, border firms into the identity colour |
| **Mark**    | an avatar that is itself the target or trigger     | a ring in its **own** identity colour, `ring-0` → `ring-2`            |
| **Chip**    | an inline control — a pill, an attribution         | a tint step (colour surfaces) or colour + underline (text surfaces)   |

The Mark tier ships as `identityMarkRing` from `shared/ui` — `.self` for a disc that is the hover target itself, `.group` for a disc inside a control marked `IDENTITY_MARK_GROUP`. Apply it **at the call site, never inside `AgentAvatar`**: the disc does not know whether anything around it is pressable. Shipped Mark surfaces today are the sidebar agent face and the account face. (The room masthead's disc stack was the third until phase R1 replaced the masthead with the one bar, whose members chip is a head count rather than a row of faces.)

**One collision the grammar resolves, rather than ignores** (there were two — mesh health used to spend the same 2px ring, so a pressable disc carrying health took no hover ring and fell back to a neutral `hover:bg-accent`. The health ring is gone, and nothing competes for the slot now):

- **Per-area stand-down.** When a card holds more than one action, hovering an inner control calms the card, so one pointer never lights two affordances at once. Scope the `has-[…]` rule to that control **by name** (`has-[[data-slot=team-member-owner]:hover]`), never `has-[button:hover]`: a stretched-link overlay hit-tests as part of the button that generated it, so the generic form is true everywhere on the card and the lift never fires.

**Where the colour may answer, and where it must not.** The line is not the row — it is the **control**. An identity's colour answers where that identity is a target you can address on its own, and stays out of a container's own hover.

- **It applies to identity controls, even inside a dense row.** The sidebar agent face is the worked example: hovering the face rings it in that agent's colour, because pressing the face opens that agent's profile. Same for the account face, an identity lockup used as a button, and the roster card, whose whole area is one identity's action.
- **It does not apply to the ROW's own hover, which stays neutral.** A sidebar row selects an agent and opens its last session — a different verb from the face inside it — so the row keeps `hover:bg-accent` and nothing more. Its left border already spends the identity colour on a different fact (active + idle); a second colour signal in a 32px row is not two facts, it is noise.
- **It does not apply where the selection already speaks.** The command palette's selection rides a `layoutId` pill; a per-row colour would fight the thing doing real work.
- **It does not apply per-disc where several discs share one action.** `MemberList`'s button form is one target and one verb, so the button's own `hover:bg-accent` is the answer; five discs each answering would suggest five actions.

The bound behind all four: an identity's colour answers only where that identity is **individually addressable** and **fewer than about a dozen** are on screen at once. Twenty rows able to glow is not twenty answers; it is a Christmas tree with a cursor in it.

**Two traps this grammar hit, which apply well beyond identity surfaces:**

- **The app's default border colour lives in `@layer base`, and it must stay there.** `index.css` sets `border-color: hsl(var(--border))` on `*` so a bare `border` class paints the neutral line instead of the text colour. That rule used to be **unlayered**, and an unlayered declaration outranks every `@layer` — Tailwind's `utilities` included — so `border-primary`, `border-destructive` and even `border-transparent` all rendered as the same neutral line across 69 files. It is layered now (DOR-1750) and `border-<colour>` utilities work normally. If you ever move it out of `@layer base`, you silently break every coloured border in the app. A **runtime** colour still has to be inline, because no class expresses `color-mix()` of a custom property; where that colour must also _move_, put only its strength in a custom property a class can set — `TeamMemberCard` is the worked example.
- **`group-hover:` matches ANY `.group` ancestor, not the nearest one.** Tailwind compiles it to `:where(.group):hover &`. The sidebar wraps its rows in an unnamed `.group` that spans most of the pane, so the bare form left every sidebar face permanently ringed. Always use a **named** group (`group/identity` + `group-hover/identity:`) when the control is anywhere it could be nested.

**Press scales by target size:** `0.99` for a card, `0.98` for a row or chip, `0.94` for a mark used as a button. Scale down only; the release rides the hover duration back up.

**Focus-visible parity is a rule, not a nicety.** If an area has a hover state, it has a focus-visible twin conveying the same information — a keyboard user must never learn less than a mouse user. The ring itself comes from the `focus-ring` utility; the _informational_ half (a colour step, an underline, a lift) gets an explicit `focus-visible:` twin beside every `hover:`. That includes a Surface: when the card's primary control takes focus, the **card** answers, not just the word inside it — `has-[[data-slot=team-member-open]:focus-visible]:` is how the roster card does it. The inverse is equally binding: **never put a `focus-visible:` ring on something no keyboard can reach.** A dormant ring on a `<span>` is an affordance wired to nothing.

**Reduced motion needs no work for CSS, and for most Motion props.** `index.css` collapses every transition and animation duration to `0.01ms` under `prefers-reduced-motion: reduce`, globally, and `MotionConfig reducedMotion="user"` (`App.tsx`) does the equivalent for `motion/react`'s **transform and layout** animations. Every prescription above is therefore correct there for free — which is why none of them carries a `motion-reduce:` variant, and why every one of them is a _static_ end state that reads on its own (a ring is present, a border is coloured, a card is lifted). A design that only reads _because_ of the movement is broken there. What neither reset reaches is **opacity, colour, or anything with `repeat: Infinity`** — those are inline styles `MotionConfig` does not suppress, so an infinite opacity or colour loop keeps running under reduced motion regardless of the global config. A `motion.*` component using any of the three must call `useReducedMotion()` itself and branch **off**, not shorter — put the branch in a pure function that also reports itself as a `data-` attribute so the two can never drift — `shouldAnimateRoster()`, below, is the shape to copy.

**Touch invariant:** nothing that exists only on hover may carry information unavailable another way. A card's lift has no touch equivalent and costs nothing, because the tap opens the drawer; an avatar's hover card is reached by long-press (`identity-hover-card.tsx`), which is the one pattern for that — never invent a second.

**Four moments earn more than the baseline, and nothing else does.** The grammar above is the floor every identity surface stands on; these are the only places that spend beyond it.

| Moment              | Where                         | What it does                                                                                                   |
| ------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Roster FLIP**     | `TeamRosterGrid`              | Cards travel to their new positions on filter, search and the group toggle. `layout="position"`, spring 280/32 |
| **Owner echo**      | `TeamMemberCard`              | Hovering or focusing "by @dorian" reveals "· 3 agents" beside it                                               |
| **Drawer entrance** | `ProfileSheet`                | 300ms rather than the Sheet primitive's 500                                                                    |
| **Badge wake**      | `IdentityAvatar`'s badge slot | Pointing at an opted-in disc tilts its kind badge −6° and scales it 1.10                                       |

Four rules they establish, each of which cost something to learn:

- **A JS animation needs its own reduced-motion gate, and the gate belongs in a pure function.** `test-setup.ts` strips `layout`, `layoutId`, `initial`, `animate`, `exit` and `transition` from every `motion.*` component, so **no motion prop is assertable in jsdom, ever** — a test that appears to check one is checking nothing. The roster's answer is `shouldAnimateRoster()` in `features/team-roster/lib/roster-layout.ts`: the rule is unit-tested at full strength, and the grid reports the same boolean as `data-layout-animated` on its root **and on every card**, so the attribute cannot drift from the behaviour. Copy this shape for any future JS-driven motion.
- **Travel is won structurally — and `popLayout` needs a forwarded ref.** A card animates to a new position only while it stays the _same component instance_, so both roster arrangements are one flat list of grid children (a cluster header is a `col-span-full` row, not a `<section>` wrapping a nested grid). That structure removes the need for `layoutId` entirely. Do not add it back to an `AnimatePresence mode="popLayout"` list on the theory that it is harmless: measured one variable at a time in exactly that configuration, adding `layoutId` took a surviving card from 51 sampled positions to 1 (it teleports) and left the exiting cards in the DOM as invisible absolutely-positioned ghosts past three seconds. That is a finding about **this combination**, not a verdict on `layoutId` — the nav pill and the session row use it happily, without `AnimatePresence`. The mechanism was never established, only the behaviour, so re-measure rather than reasoning from a cause. Separately, `popLayout` writes `position: absolute` onto an exiting node through a **ref**, so any component between it and the DOM must pass `ref` along; without that the mode silently does nothing and every survivor waits out the fade before closing the gap. None of it is visible to jsdom, typecheck or lint — all of it came from sampling element positions frame by frame in a real browser.
- **A reveal costs the layout nothing — and does not exist where there is no hover.** Animating `width`/`max-width` reflows, and a suffix that appeared by taking space would shove the thing you are pointing at. Reserving the space in flow instead is the obvious fix and the wrong one: it charges the neighbour permanently for something invisible almost always (measured at 28–63px, enough to truncate handles as short as `@miguel.telegram`). Take the reveal **out of flow** — `absolute left-full` off a `w-fit` row, so it lands just past the text rather than at the far edge of the card — and animate only `opacity`. Accept that out of flow can cross a container edge on the narrowest columns and say where. Gate it on `[@media(hover:hover)]` too: the query asks about the **pointer**, not the viewport, so a phone lays out nothing while a narrow desktop window keeps the echo it can use.
- **Retime a shared primitive at the call site, not in the primitive.** The 300ms lives on `ProfileSheet`'s `ResponsiveSheetContent` className, which `cn`'s tailwind-merge lets outrank the primitive's own duration. Changing `sheet.tsx` would have re-timed Settings' panels too — a decision about every sheet in the app, which this was not.

**One deliberate departure from the spec's reduced-motion table.** The badge wake is gated with `motion-safe:`, which drops the **end state** as well as the travel — the spec's §2.6 table would have kept the tilt. The rule that table serves is "keep the fact, drop the motion", and a 6° tilt carries no fact: nothing about a crooked badge tells you anything a still one does not. With no fact to keep, an instant snap to crooked is all cost. **Generalise from this:** a state that exists purely as personality should go entirely under reduced motion; only a state that _says something_ survives as a static end state.

Full audit and rationale: `plans/identity-micro-interactions/design-spec.md`. **`/dev/identity#motion-and-interaction` is the home for all of it** — the three tiers, focus parity, and all four signature moments, each drivable. `/dev/components#identityavatar` still shows the disc's own states.

---

## FilterBar (Compound Component)

A composable filter bar system for list surfaces. Built using the compound component pattern (`FilterBar.Search`, `FilterBar.Primary`, etc.) with context-based state sharing. The filter engine (`shared/lib/filter-engine.ts`) is pure TypeScript with no React dependency; the UI components (`shared/ui/filter-bar/`) and the `useFilterState` hook (`shared/model/use-filter-state.ts`) bridge it to React and TanStack Router.

### Architecture

```
filter-engine.ts          ← Pure TS: filter factories, schema builder, match/sort
  ↓
useFilterState()          ← React hook: URL sync via TanStack Router search params
  ↓
<FilterBar state={...}>   ← Compound UI: provides state via context to sub-components
  <FilterBar.Search />
  <FilterBar.Primary />
  <FilterBar.AddFilter />
  <FilterBar.Sort />
  <FilterBar.ResultCount />
  <FilterBar.ActiveFilters />
```

### Sub-Components

| Sub-component             | Purpose                                            |
| ------------------------- | -------------------------------------------------- |
| `FilterBar`               | Root container, provides filter state via context  |
| `FilterBar.Search`        | Debounced text input for text filter fields        |
| `FilterBar.Primary`       | Inline enum filter rendered as segmented pills     |
| `FilterBar.AddFilter`     | Popover menu for activating non-primary filters    |
| `FilterBar.Sort`          | Sort field and direction selector                  |
| `FilterBar.ResultCount`   | "4 of 12 agents" result summary                    |
| `FilterBar.ActiveFilters` | Removable chips for currently active filter values |

### Usage

```tsx
import { FilterBar } from '@/layers/shared/ui';
import { useFilterState } from '@/layers/shared/model';
import { agentFilterSchema, agentSortOptions } from '../lib/agent-filter-schema';

function AgentFilterBar() {
  const filterState = useFilterState(agentFilterSchema, {
    debounce: { search: 200 },
  });

  return (
    <FilterBar state={filterState}>
      <FilterBar.Search name="search" placeholder="Filter agents..." />
      <FilterBar.Primary name="status" />
      <FilterBar.AddFilter />
      <FilterBar.Sort options={agentSortOptions} />
      <FilterBar.ResultCount count={filtered.length} total={all.length} noun="agent" />
      <FilterBar.ActiveFilters />
    </FilterBar>
  );
}
```

### Filter Types

The filter engine provides five filter factories:

| Factory              | Value Type                | Use Case                                |
| -------------------- | ------------------------- | --------------------------------------- |
| `textFilter`         | `string`                  | Substring search across multiple fields |
| `enumFilter`         | `string \| string[]`      | Single-select or multi-select dropdowns |
| `dateRangeFilter`    | `DateRangeFilterValue`    | Preset durations or explicit bounds     |
| `booleanFilter`      | `boolean \| null`         | Tri-state toggle (null = no filter)     |
| `numericRangeFilter` | `NumericRangeFilterValue` | Min/max range bounds                    |

### Styling

- Root container: `flex flex-wrap items-center gap-2 px-4 py-3`
- Active filter chips: removable badges with `X` icon
- Primary filters: enum pills inline in the bar
- Search input: standard input with `text-sm` and debounced URL sync
- Enum filter colors: defined per-option via `colors` record in filter schema (Tailwind classes like `text-emerald-400`)

### Key Files

| File                               | Purpose                                                  |
| ---------------------------------- | -------------------------------------------------------- |
| `shared/lib/filter-engine.ts`      | Pure filter factories, schema builder, sort/filter logic |
| `shared/model/use-filter-state.ts` | URL-synced filter state hook                             |
| `shared/ui/filter-bar/`            | Compound UI components (7 sub-components)                |

---

## Form Fields

DorkOS uses [Shadcn Field](https://ui.shadcn.com/docs/components/field) as the foundation for all form field layouts. Field provides accessible label/description/error association via `aria-describedby` and `role="alert"`. Two higher-level components sit on top.

### SettingRow

Horizontal settings row — label and description on the left, control on the right. Use for all settings toggle/select patterns. Built on `<Field orientation="horizontal">`.

```tsx
import { SettingRow, Switch } from '@/layers/shared/ui';

<SettingRow label="Notifications" description="Enable push alerts">
  <Switch checked={enabled} onCheckedChange={setEnabled} />
</SettingRow>;
```

For compound controls (e.g., Badge + Switch), wrap them in a flex container:

```tsx
<SettingRow label="Feature" description="Toggle feature access">
  <div className="flex items-center gap-2">
    <Badge variant="secondary">Disabled</Badge>
    <Switch checked={enabled} onCheckedChange={setEnabled} />
  </div>
</SettingRow>
```

### PasswordInput

Password input with eye/eye-off visibility toggle. Supports controlled and uncontrolled modes.

```tsx
import { PasswordInput } from '@/layers/shared/ui';

// Uncontrolled (manages its own visibility state)
<PasswordInput placeholder="Enter password" />

// Start visible
<PasswordInput visibleByDefault placeholder="API token" />

// Controlled visibility
<PasswordInput showPassword={show} onShowPasswordChange={setShow} />
```

Sentinel mode ("saved value" placeholder that clears on focus) is a consumer concern — pass `onFocus`, `placeholder`, and `value` props.

### FieldCard

Rounded card container for grouping related form fields into Apple-style settings groups. Three components work together:

- **`FieldCard`** — Outer card with `rounded-lg border bg-card`. Use `className` for variants (e.g., `border-destructive/50` for danger zones).
- **`FieldCardContent`** — Content wrapper that applies automatic thin `divide-y` separators between children. Each child gets `px-4 py-3`.
- **`CollapsibleFieldCard`** — Collapsible section with a right-aligned ChevronDown that rotates -90deg when collapsed.

```tsx
import { FieldCard, FieldCardContent, CollapsibleFieldCard } from '@/layers/shared/ui';

// Static group
<FieldCard>
  <FieldCardContent>
    <SettingRow label="Notifications" description="Enable push alerts">
      <Switch />
    </SettingRow>
    <SettingRow label="Sound" description="Play sound on notification">
      <Switch />
    </SettingRow>
  </FieldCardContent>
</FieldCard>

// Collapsible group
<CollapsibleFieldCard
  open={open}
  onOpenChange={setOpen}
  trigger="Advanced"
  badge={<Badge variant="secondary">3 overrides</Badge>}
>
  <div className="px-4 py-3">Content here</div>
</CollapsibleFieldCard>
```

Used across settings panels, agent config tabs, adapter wizard, and binding dialogs.

### Field Orientation Conventions

| Context            | Orientation  | Component                          |
| ------------------ | ------------ | ---------------------------------- |
| Settings rows      | `horizontal` | `<SettingRow>`                     |
| Wizard/form fields | `vertical`   | `<Field orientation="vertical">`   |
| Responsive layouts | `responsive` | `<Field orientation="responsive">` |

For rows that have a label but no description (e.g., simple toggles), use `<Field orientation="horizontal">` + `<FieldLabel>` directly instead of `SettingRow`.

---

## Interaction States

### Hover

Subtle. 150ms transition. A background tint step of 5-10% — the same mechanism that groups a zone, one step stronger.

```css
.interactive:hover {
  background-color: hsl(var(--accent) / 0.5);
}
```

Hover and grouping share one tool on purpose: if a zone is separated by tint rather than a rule, a hover tint is already the vocabulary the surface speaks. Reach for a border only after whitespace and tint have both failed. Inside the sidebar specifically, hover uses the `--sidebar-accent` ramp (`bg-sidebar-accent/70` — see [Separation by tint, not by borders](#separation-by-tint-not-by-borders)), not `--muted`: `--muted` is banned there because it inverts direction between light and dark themes.

**Nothing renders at rest.** Row and section actions — `+`, kebab, drag handles — are invisible until hover or `focus-visible`. Every one needs a keyboard twin (`focus-visible` reveals it) and a touch path (visible under `[@media(hover:hover)]: none`, or long-press / context menu); anything draggable needs a non-drag alternative per WCAG 2.2 §2.5.7. Row overflow uses the vertical kebab (⋮); the horizontal one (⋯) belongs in toolbars and tables. See [Hover Pattern Mobile Alternatives](#hover-pattern-mobile-alternatives) for the shipped touch equivalents.

### Focus

Visible focus rings for keyboard navigation. Brand orange outline, 2px offset.

```css
:focus-visible {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 2px;
}
```

### Active/Press

Scale down to 0.97-0.98 for 100ms. Immediate, tactile.

### Disabled

Opacity 0.5. No cursor change beyond `not-allowed`.

### Loading

- Streaming: blinking cursor after last character
- Tool running: spinning icon (Loader2 from lucide)
- History loading: three pulsing dots in message area

### Unread — Two Tiers

Unread carries two different facts, and they get two different marks. Collapsing them into one badge spends the scarce signal on the common case.

| Tier                | Means                                                        | Renders as                                 |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------ |
| **Activity**        | Something happened here                                      | Bold label only — no dot, no badge         |
| **Directed at you** | A mention, a permission prompt, a reply that needs an answer | A numbered badge (`bg-primary` count pill) |

Rules that come with it:

- **Numbers are for you, not for volume.** A busy channel nobody addressed you in stays at a bold label however many messages it holds.
- **Activity draws no mark of its own** (decided 2026-08-09, `specs/sidebar-now-today-library/design-decisions.md` §18). It used to add a dot. A dot is a third weight in a system that deliberately has two, and the avatar corner already owns dots for agent lifecycle — two dot vocabularies on one row is the confusion this removes.
- **A collapsed container keeps its signal.** Collapsing a section rolls its unread state up onto the collapsed row — never hides it.
- **Only "happening right now" pulses.** An agent mid-turn pulses (see [Identity](#identity)); an unread count does not.

### 3-State Status Pattern

Status indicators that depend on both per-entity configuration and global feature flags use a 3-state model driven by `useAgentToolStatus()`:

| State                | Visual                                 | Meaning                                 |
| -------------------- | -------------------------------------- | --------------------------------------- |
| `enabled`            | Full color, normal opacity             | Feature is active for this agent        |
| `disabled-by-agent`  | Muted/dimmed appearance (`opacity-50`) | Agent manifest has explicitly opted out |
| `disabled-by-server` | Hidden (not rendered)                  | Feature is disabled server-wide         |

### 3-State Toggle Pattern (CapabilitiesTab)

The CapabilitiesTab uses a 3-state display for per-agent tool group toggles:

| State                 | Visual                                        | Meaning                                               |
| --------------------- | --------------------------------------------- | ----------------------------------------------------- |
| Inherited (enabled)   | Switch ON, "Inherited" badge                  | Agent inherits the global default (enabled)           |
| Overridden (disabled) | Switch OFF, "Overridden" badge                | Agent opts out of this tool group's documentation     |
| Inherited (disabled)  | Switch OFF, disabled, "Server disabled" badge | Server feature flag is off; toggle is non-interactive |

The toggle writes to the agent manifest's `enabledToolGroups` field. When a toggle is flipped, it sets an explicit value; when reset, the field is removed (returning to inherited behavior).

This pattern is reusable for any per-entity override of a global setting.

---

## Accessibility

- All interactive elements keyboard-accessible
- Focus indicators meet 3:1 contrast ratio (WCAG 2.1 AA)
- Color is never the sole indicator of state
- `aria-label` on icon-only buttons
- `prefers-reduced-motion` respected — disable entrance animations, reduce transitions to instant
- Text meets 4.5:1 contrast ratio against backgrounds

---

## Mobile Responsive Scale

### Overview

The app uses a CSS custom property scale multiplier system that makes text, icons, and interactive elements proportionally larger on mobile (< 768px). Desktop is the source of truth; mobile sizes are derived via multiplication.

### Configuration

- `--mobile-scale: 1.25` — Master dial (25% larger on mobile)
- Optional per-category overrides:
  - `--mobile-scale-text` — Text scaling
  - `--mobile-scale-icon` — Icon scaling
  - `--mobile-scale-interactive` — Button/interactive element scaling

### Internal Multipliers

- `--_st` — Text multiplier (1 on desktop, scale value on mobile)
- `--_si` — Icon multiplier
- `--_sb` — Interactive element multiplier

### Scaled Values at 1.25x

| Element                  | Desktop | Mobile (x1.25) |
| ------------------------ | ------- | -------------- |
| Body text (`text-sm`)    | 14px    | 17.5px         |
| Small text (`text-xs`)   | 12px    | 15px           |
| Tiny text (`text-2xs`)   | 11px    | 13.75px        |
| Micro text (`text-3xs`)  | 10px    | 12.5px         |
| Large text (`text-base`) | 16px    | 20px           |
| Icon xs                  | 12px    | 15px           |
| Icon sm                  | 16px    | 20px           |
| Icon md                  | 20px    | 25px           |
| Button sm                | 32px    | 40px           |
| Button md                | 36px    | 45px           |
| Button lg                | 40px    | 50px           |

### Icon Size Convention

Three standard sizes, use `size-[--size-icon-*]` for all icon sizing:

| Token     | Desktop | Use Case                                                 |
| --------- | ------- | -------------------------------------------------------- |
| `icon-xs` | 12px    | Decorative, status indicators, inline affordances        |
| `icon-sm` | 16px    | Interactive icons in compact UI (sidebar, tool cards)    |
| `icon-md` | 20px    | Primary action icons (buttons, navigation, prominent UI) |

Usage:

```tsx
<Check className="size-[--size-icon-xs] text-status-success" />
<FolderOpen className="size-[--size-icon-sm] text-muted-foreground" />
<PanelLeft className="size-[--size-icon-md]" />
```

### Hover Pattern Mobile Alternatives

| Pattern                     | Desktop                | Mobile                                                                                         |
| --------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| Message timestamps          | Hidden, shown on hover | Always visible at 40% opacity                                                                  |
| Session expand chevron      | Hidden, shown on hover | Hidden; tap session row to expand                                                              |
| Table action icons          | Hidden, shown on hover | Always visible at 60% opacity                                                                  |
| Sidebar row/section actions | Hidden, shown on hover | Always visible, 44px, plus a long-press sheet — `shared/ui/sidebar-menu-node.tsx` decides both |

`SidebarMenuSurface` answers "is there a hover here?" itself, from `useIsMobile()`,
for every row and every section header at once. It used to be an
`alwaysShowActions` prop — which `SidebarRow` passed and `SectionHeader` did not,
so section menus were unreachable by finger for a release (DOR-1083). Do not
reintroduce a prop for it: a question about the device is not a decision a call
site should be able to get wrong.

### Safe Area Classes

| Class                  | Applied To                         | Purpose                         |
| ---------------------- | ---------------------------------- | ------------------------------- |
| `chat-input-container` | ChatPanel input wrapper            | Bottom safe area inset          |
| `sidebar-container`    | Sidebar root                       | Left + bottom safe area insets  |
| `chat-scroll-area`     | `Conversation.Timeline`'s scroller | `touch-action: pan-y` on mobile |

### Adjusting the Scale

```css
:root {
  --mobile-scale: 1; /* No mobile scaling */
  --mobile-scale: 1.25; /* Default: 25% larger */
  --mobile-scale: 1.5; /* 50% larger */

  /* Per-category overrides */
  --mobile-scale-text: 1.15;
  --mobile-scale-icon: 1.25;
  --mobile-scale-interactive: 1.3;
}
```

---

## Responsive Components

See [`shared/ui/README.md`](../apps/client/src/layers/shared/ui/README.md) for which overlay, row, or form control to reach for — this section is the deep dive on the five overlay wrappers once you've picked one.

Interactive overlays that need different UX on desktop vs mobile use responsive wrappers. These keep the Radix primitive on desktop (keyboard nav, precise positioning) and swap to a Vaul Drawer on mobile (large touch targets, bottom-sheet pattern).

### `ResponsiveDropdownMenu`

Use instead of plain `DropdownMenu` when the menu appears in a touch-accessible area (status bars, toolbars, settings). Plain `DropdownMenu` is fine for desktop-only contexts (right-click menus, dense data tables).

| Sub-component                      | Desktop (≥768px)         | Mobile (<768px)                |
| ---------------------------------- | ------------------------ | ------------------------------ |
| `ResponsiveDropdownMenu`           | `DropdownMenu`           | `Drawer`                       |
| `ResponsiveDropdownMenuTrigger`    | `DropdownMenuTrigger`    | `DrawerTrigger`                |
| `ResponsiveDropdownMenuContent`    | `DropdownMenuContent`    | `DrawerContent` (auto-height)  |
| `ResponsiveDropdownMenuLabel`      | `DropdownMenuLabel`      | `DrawerHeader` + `DrawerTitle` |
| `ResponsiveDropdownMenuRadioGroup` | `DropdownMenuRadioGroup` | `<div role="radiogroup">`      |
| `ResponsiveDropdownMenuRadioItem`  | `DropdownMenuRadioItem`  | Custom button with iOS sizing  |

#### RadioItem Props

| Prop          | Type         | Required | Description                               |
| ------------- | ------------ | -------- | ----------------------------------------- |
| `value`       | `string`     | Yes      | Radio value                               |
| `children`    | `ReactNode`  | Yes      | Label text                                |
| `icon`        | `LucideIcon` | No       | Leading icon (renders in both modes)      |
| `description` | `string`     | No       | Secondary text below label                |
| `className`   | `string`     | No       | Additional classes (e.g., danger styling) |

#### Mobile Sizing (Apple HIG)

- `min-h-[44px]` touch targets
- `text-[17px]` labels (iOS body)
- `text-[13px]` descriptions (iOS footnote)
- Right-aligned `Check` icon for selected item
- `border-b border-border` separators between items

#### Simple Usage (ModelItem)

```tsx
<ResponsiveDropdownMenu>
  <ResponsiveDropdownMenuTrigger asChild>
    <button>Sonnet 4.5</button>
  </ResponsiveDropdownMenuTrigger>
  <ResponsiveDropdownMenuContent side="top" align="start">
    <ResponsiveDropdownMenuLabel>Model</ResponsiveDropdownMenuLabel>
    <ResponsiveDropdownMenuRadioGroup value={model} onValueChange={setModel}>
      <ResponsiveDropdownMenuRadioItem value="sonnet">Sonnet 4.5</ResponsiveDropdownMenuRadioItem>
      <ResponsiveDropdownMenuRadioItem value="opus">Opus 4.6</ResponsiveDropdownMenuRadioItem>
    </ResponsiveDropdownMenuRadioGroup>
  </ResponsiveDropdownMenuContent>
</ResponsiveDropdownMenu>
```

#### Rich Usage (PermissionModeItem)

```tsx
<ResponsiveDropdownMenuRadioItem
  value="default"
  icon={Shield}
  description="Prompt for each tool call"
>
  Default
</ResponsiveDropdownMenuRadioItem>
```

### `ResponsiveDialog`

Use instead of plain `Dialog` when the dialog content needs full-screen treatment on mobile. Shows as a centered `Dialog` on desktop and a `Drawer` on mobile. See `apps/client/src/layers/shared/ui/responsive-dialog.tsx`.

### `ResponsivePopover`

Use instead of plain `Popover` for anything a touch user has to reach. `Popover` on desktop, bottom `Drawer` on mobile. `shared/ui/responsive-popover.tsx`.

| Sub-component              | Desktop (≥768px) | Mobile (<768px)                |
| -------------------------- | ---------------- | ------------------------------ |
| `ResponsivePopover`        | `Popover`        | `Drawer`                       |
| `ResponsivePopoverTrigger` | `PopoverTrigger` | `DrawerTrigger`                |
| `ResponsivePopoverContent` | `PopoverContent` | `DrawerContent`                |
| `ResponsivePopoverTitle`   | _nothing_        | `DrawerHeader` + `DrawerTitle` |

Two props on the **root** decide the shape, and both are about the difference between a **glance** and a **task**:

| Prop         | On                                                              | Off (default)                                     |
| ------------ | --------------------------------------------------------------- | ------------------------------------------------- |
| `modal`      | Tab stays inside; pointer input outside is blocked              | Tab leaves the panel — right for a status readout |
| `fullHeight` | Mobile sheet fills the screen, gets an X, trims its own heading | Mobile sheet hugs its content — right for a menu  |

Turn both on for a picker: a field, a list and a commit button need the screen, and a half-finished selection should not be tabbable away from. `NewDirectMessageMenu` is the reference implementation.

`modal` is **not** `inert`. Measured at 1440×900 it sets `body { pointer-events: none }` and traps focus, but adds neither `aria-modal` nor `inert` — so do not describe it as sealing the page off.

**Name the panel.** A `modal` popover is a focus-trapping `role="dialog"`, and an unnamed one is materially worse than an unnamed non-modal one. `ResponsivePopoverTitle` renders **only** on mobile, so the desktop panel needs its own name: pass `aria-label` to `ResponsivePopoverContent` (mobile ignores it — the sheet's own heading wins under the accname precedence rules), or pair the title with a `hidden md:block` heading. The shell and the `md:` breakpoint are both 768px, so the two halves are exact complements.

Two sizing rules that only surface once a software keyboard is involved, both of which cost real measurement to find:

- **Never pad for the keyboard.** vaul already shrinks the drawer to the visual viewport while a field inside it has focus, so compensating again subtracts the same height twice — it collapsed a result list to 0px on a 390×844 phone.
- **Give a scrollable list a `min-h` floor.** A landscape phone with the keyboard up leaves under 200px of sheet. A list that is only `flex-1` hands all of it to the parts that do not shrink and renders zero rows — a search field above a blank space. A floor plus the sheet's scroll of last resort keeps two rows on screen and the commit button one short scroll away.

Sizes come from the system, not by hand: `Button` is already `responsive` by default (`size="sm"` → `h-10 md:h-8`), rows use `min-h-11` / `min-h-[44px]`, and `--_st` already scales every text token 1.25× below 768px — so writing `text-base md:text-sm` double-scales. When a control has to stay visually small, grow the target rather than the glyph with `after:absolute after:-inset-3 md:after:hidden`, the way `SidebarGroupAction` does.

### `ResponsiveSheet`

Use instead of plain `Sheet` for a right-side panel that should go full-width on a phone instead of leaving a visible strip of the page down one side. Unlike the other wrappers on this page, it does not swap primitives — it is always a `Sheet`; only `ResponsiveSheetContent`'s width changes.

| Sub-component                                                  | Desktop (≥768px)       | Mobile (<768px)        |
| -------------------------------------------------------------- | ---------------------- | ---------------------- |
| `ResponsiveSheet`                                              | `Sheet`                | `Sheet`                |
| `ResponsiveSheetTrigger`                                       | `SheetTrigger`         | `SheetTrigger`         |
| `ResponsiveSheetContent`                                       | `sm:max-w-md`          | `w-full sm:max-w-full` |
| `ResponsiveSheetHeader`/`Footer`/`Title`/`Description`/`Close` | matching `Sheet*` part | matching `Sheet*` part |

### `ResponsiveContextMenu`

Use instead of plain `ContextMenu` when the trigger appears in a touch-accessible area. A right-click opens a `ContextMenu` on desktop; a long-press opens a bottom `Drawer` on mobile. Plain `ContextMenu` is fine for desktop-only surfaces (dense data tables, right-click-only tools).

| Sub-component                    | Desktop (≥768px)                   | Mobile (<768px)                    |
| -------------------------------- | ---------------------------------- | ---------------------------------- |
| `ResponsiveContextMenu`          | `ContextMenu`                      | `Drawer`                           |
| `ResponsiveContextMenuTrigger`   | `ContextMenuTrigger` (right-click) | long-press (`useLongPress`)        |
| `ResponsiveContextMenuContent`   | `ContextMenuContent`               | `DrawerContent`                    |
| `ResponsiveContextMenuItem`      | `ContextMenuItem`                  | `<button>` row, `min-h-[44px]`     |
| `ResponsiveContextMenuSeparator` | `ContextMenuSeparator`             | no-op — mobile rows use `border-b` |

---

## Data Tables

Use semantic `<table>` markup via the shared Table components. Do not use flex-based row layouts for columnar data.

| Data Shape                                  | Use                               | Why                                       |
| ------------------------------------------- | --------------------------------- | ----------------------------------------- |
| Columnar data (rows × columns)              | `Table` primitives or `DataTable` | Semantic HTML, accessible, consistent     |
| Sortable/filterable data                    | `DataTable` + TanStack Table      | Built-in interaction support              |
| Card-based items (expandable, rich content) | Cards/custom layout               | Not tabular — each item is self-contained |
| Sidebar lists (sessions, navigation)        | `SidebarMenu`                     | Navigation pattern, not data display      |

### Table Primitives (`shared/ui/table.tsx`)

Low-level semantic table building blocks with no interaction logic:

```tsx
import {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from '@/layers/shared/ui';

<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Name</TableHead>
      <TableHead>Status</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    <TableRow>
      <TableCell>dorkbot</TableCell>
      <TableCell>active</TableCell>
    </TableRow>
  </TableBody>
</Table>;
```

`Table` wraps the `<table>` in a `relative w-full overflow-auto` container for horizontal scroll. `TableRow` has hover highlight (`hover:bg-muted/50`) and a `data-[state=selected]` highlight for selection.

### DataTable (`shared/ui/data-table.tsx`)

Generic wrapper around TanStack Table (`@tanstack/react-table`). Takes `columns` + `data`, handles the rendering loop, and shows an empty state when there are no rows.

```tsx
import { DataTable } from '@/layers/shared/ui';
import type { ColumnDef } from '@tanstack/react-table';

const columns: ColumnDef<Agent>[] = [
  { accessorKey: 'name', header: 'Name' },
  {
    accessorKey: 'status',
    header: 'Status',
    meta: { hideOnMobile: true }, // hidden below 768px
    cell: ({ row }) => <StatusBadge status={row.getValue('status')} />,
  },
];

<DataTable columns={columns} data={agents} emptyMessage="No agents found." />;
```

For sorting, selection, or pagination, pass `tableOptions`:

```tsx
<DataTable
  columns={columns}
  data={agents}
  tableOptions={{
    state: { sorting },
    onSortingChange: setSorting,
    getSortedRowModel: getSortedRowModel(),
  }}
/>
```

**`meta.hideOnMobile`** — any column with `meta: { hideOnMobile: true }` is automatically hidden on viewports below 768px. User-provided `columnVisibility` in `tableOptions` takes precedence per-column.

### FSD Placement

- **`Table` + `DataTable`** → `shared/ui` (presentation only — no data fetching)
- **Column definitions** → feature module that owns them (e.g., `features/activity-feed-page/`)
- **Data fetching** → entity hooks consumed by the feature component

### Dev Playground

Table showcase at `/dev/tables` — basic tables, sorting, activity log, task history, row selection, empty/loading states, compact/striped variants.

---

## Error Boundaries

Three fallback components handle different failure scopes:

| Component            | Scope                   | Recovery                          | Renders With       |
| -------------------- | ----------------------- | --------------------------------- | ------------------ |
| `AppCrashFallback`   | Entire app              | Full page reload                  | Inline styles only |
| `RouteErrorFallback` | Individual route        | `router.invalidate()` retry + nav | Tailwind + shadcn  |
| `NotFoundFallback`   | 404 (no matching route) | Navigate Home                     | Tailwind + shadcn  |

### `AppCrashFallback`

Outermost safety net — wraps the entire React tree in `main.tsx` via `react-error-boundary`. Uses **inline styles only** because Tailwind, shadcn, and context providers may themselves have crashed. The only recovery action is a hard page reload.

```tsx
// main.tsx
import { ErrorBoundary } from 'react-error-boundary';
import { AppCrashFallback } from '@/layers/shared/ui/app-crash-fallback';

<ErrorBoundary FallbackComponent={AppCrashFallback}>
  <App />
</ErrorBoundary>;
```

Dev builds show an expandable stack trace. Production builds show only the error message.

### `RouteErrorFallback`

Handles runtime errors thrown inside a TanStack Router route. Renders inside the app shell — the sidebar and header remain visible. Uses `router.invalidate()` for retry (not `reset()`) because `reset()` does not re-run loaders.

Registered as `defaultErrorComponent` in the router root:

```tsx
// router.tsx
const rootRoute = createRootRouteWithContext<RouterContext>()({
  defaultErrorComponent: RouteErrorFallback,
  defaultNotFoundComponent: NotFoundFallback,
});
```

### `NotFoundFallback`

Renders when no route matches (404). Shows a Search icon and a "Back to Home" button. Registered as `notFoundComponent` on the router root and on the root layout route.

All three components are exported from `@/layers/shared/ui`.

---

## File Reference

| Concern                  | File                                                             |
| ------------------------ | ---------------------------------------------------------------- |
| CSS variables & Tailwind | `apps/client/src/index.css`                                      |
| shadcn config            | `apps/client/components.json`                                    |
| Component library        | `apps/client/src/layers/shared/ui/`                              |
| Identity disc            | `apps/client/src/layers/shared/ui/identity-avatar.tsx`           |
| Agent-side wrapper       | `apps/client/src/layers/entities/agent/ui/AgentAvatar.tsx`       |
| Identity face resolver   | `apps/client/src/layers/shared/lib/identity-face.ts`             |
| Table primitives         | `apps/client/src/layers/shared/ui/table.tsx`                     |
| DataTable                | `apps/client/src/layers/shared/ui/data-table.tsx`                |
| App crash fallback       | `apps/client/src/layers/shared/ui/app-crash-fallback.tsx`        |
| Route error fallback     | `apps/client/src/layers/shared/ui/route-error-fallback.tsx`      |
| Not-found fallback       | `apps/client/src/layers/shared/ui/not-found-fallback.tsx`        |
| Chat components          | `apps/client/src/layers/features/chat/`                          |
| Session components       | `apps/client/src/layers/features/session-list/`                  |
| App state                | `apps/client/src/layers/shared/model/app-store.ts`               |
| Chat state               | `apps/client/src/layers/features/chat/model/use-chat-session.ts` |
| Filter engine            | `apps/client/src/layers/shared/lib/filter-engine.ts`             |
| Filter state hook        | `apps/client/src/layers/shared/model/use-filter-state.ts`        |
| FilterBar UI             | `apps/client/src/layers/shared/ui/filter-bar/`                   |
