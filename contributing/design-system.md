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

Portable palette values live in `packages/ui/tokens.css` as namespaced HSL channels. The client bridges its existing semantic names in `apps/client/src/index.css`; sidebar, feature colors, fonts and geometry remain local. Use semantic classes, not raw hex values. Portable controls, overlays and menus retain their customized Radix behavior in `packages/ui`; application wrappers remain local. See [shared UI ownership and release](shared-ui.md) for the ownership matrix and portal theme contract.

### Light Mode

| Tailwind class           | HSL value    | Usage                                                                            |
| ------------------------ | ------------ | -------------------------------------------------------------------------------- |
| `bg-background`          | `0 0% 98%`   | Page background                                                                  |
| `bg-muted`               | `0 0% 96%`   | Subtle backgrounds                                                               |
| `bg-secondary`           | `0 0% 92%`   | User message tint                                                                |
| `bg-card`                | `0 0% 100%`  | Elevated cards, popovers                                                         |
| `text-foreground`        | `0 0% 9%`    | Body text                                                                        |
| `text-muted-foreground`  | `0 0% 32%`   | Labels, metadata                                                                 |
| `text-status-warning-fg` | `38 92% 28%` | Warning text: 4.68:1 or better on the page, cards, the sidebar and its tint ramp |
| `text-brand-text`        | `24 90% 29%` | Orange text: 4.66:1 or better, its own `bg-brand/15` badge tint included         |
| `border-border`          | `0 0% 83%`   | Card borders, inputs                                                             |

### Dark Mode

| Tailwind class           | HSL value    | Usage                                                |
| ------------------------ | ------------ | ---------------------------------------------------- |
| `bg-background`          | `0 0% 4%`    | Page background                                      |
| `bg-muted`               | `0 0% 9%`    | Subtle backgrounds                                   |
| `bg-secondary`           | `0 0% 14%`   | User message tint                                    |
| `bg-card`                | `0 0% 4%`    | Cards, popovers (height comes from elevation, below) |
| `text-foreground`        | `0 0% 87%`   | Body text                                            |
| `text-muted-foreground`  | `0 0% 64%`   | Labels, metadata                                     |
| `text-status-warning-fg` | `38 92% 50%` | Warning text                                         |
| `text-brand-text`        | `24 88% 60%` | Orange text                                          |
| `border-border`          | `0 0% 25%`   | Card borders, inputs                                 |

### Elevation in dark mode: height is light

A black shadow can't darken a 4% page, so in dark mode the `--elevation-*` tokens (in `apps/client/src/index.css`) show height with light. Each step has the same four layers, in the same order, so hover transitions interpolate:

1. **Top-edge highlight:** `inset 0 1px 0` white, 8 → 12 → 16 → 20%. Light catches the upper lip. It isn't a rule, and it curves with the radius.
2. **Surface lift:** `inset 0 0 0 100vmax` white, 2 → 5 → 8 → 11%. It paints over the background and under the content, so a higher surface is a lighter one with no extra surface token.
   3–4. **The black drop**, kept (50 → 70%). It still reads over anything lighter: the sidebar, a muted panel, an image.

Tailwind's `shadow-sm/md/lg/xl` map onto `soft/elevated/floating/modal` through `@theme`, so both scales are theme-aware. Tailwind inlines its default shadow values at build time, so a `.dark` override of `--shadow-*` never reaches them. In light mode the four steps are exactly Tailwind's own values (0.1 alpha), so light mode looks as it did. `shadow-xs`/`2xs` stay Tailwind's: inputs, select triggers and switches use `shadow-xs`, because they should read as recessed, not raised. No button variant has a shadow or a border.

**Use a shadow token for height and never hand-roll a black `box-shadow`**: it'll vanish in dark mode. **Known gap:** `bg-popover` is 4% in dark, so a menu that opens over the 10% sidebar reads as a hole, not a lift. That's a surface-token fix (popover and accent together), tracked separately.

**Tints climb with the surface.** Inside anything at `shadow-md` or above in dark mode, `muted` and `accent` step up with it (13/16% → 16/19% → 19/22%), so a menu's hover or selected row is always a step above its lifted surface rather than a hole in it. They are computed from the `--elevation-lift-*` tokens (muted is 8% plus the lift, accent 3% above muted), so changing a lift moves its tints with it.

### Brand Accent

One brand color, used with purpose: **orange** (HSL `24 90% 44%` light / `24 88% 55%` dark). Derived from the DorkOS brand palette (`#E85D04`), slightly adjusted for AA contrast.

**Where brand orange appears:**

- Focus rings (`--ring`) — every `focus-visible` interaction carries the brand
- `brand` button variant — the site and Cloud marketing only. In the app, a primary button is grey, and `apps/client` has no use of it
- Sidebar active tab indicator — subtle brand presence in navigation
- Assistant message links and inline code — via `--brand-text`

**Where gray stays:**

- `--primary` — primary buttons, switches, badges, selections (the quiet workhorse)
- `--accent` — hover backgrounds in menus, dropdowns
- `--secondary` — user message tint
- All structural surfaces — backgrounds, cards, borders, muted

**Orange text is `text-brand-text`.** The brand fill reads only 3.7:1 as text on the light page; `--brand-text` clears 4.5:1 on every ground it sits on (`__tests__/brand-text-contrast.test.ts`). Plain `brand` stays for fills, rings, icons and large type.

**Usage rule:** Orange means you: focus, a count directed at you, Needs you. If you're adding it to a static, structural element — stop. The brand lives in moments of engagement, not in decoration. Like a single red chair in a white room.

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

| Token          | Base size | Usage                                         |
| -------------- | --------- | --------------------------------------------- |
| `text-3xs`     | 10px      | Corner counts, avatar initials only           |
| `text-2xs`     | 11px      | Section labels, metadata, `xs` badges, counts |
| `text-xs`      | 12px      | Timestamps, tool status                       |
| `text-control` | 13px      | Control-surface labels: sidebar rows, menus   |
| `text-sm`      | 14px      | Message body text, code, metadata, labels     |
| `text-base`    | 16px      | (unused in chat UI)                           |
| `text-lg`      | 18px      | In-message headings (h3+)                     |

Literal sizes (`text-[13px]`) ignore the user's font size; use tokens. `text-control` sets no line height, so it keeps the one its surroundings give it.

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
| Body text   | `text-sm` / `text-base`                            | `text-control` (13px) label, `text-2xs` metadata   |
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

| Curve      | Value                                          | Usage                               |
| ---------- | ---------------------------------------------- | ----------------------------------- |
| `ease-out` | `cubic-bezier(0, 0, 0.2, 1)`                   | Entrances (fast start, gentle stop) |
| `ease-in`  | `cubic-bezier(0.4, 0, 1, 1)`                   | Exits (gentle start, fast finish)   |
| `spring`   | `SPRING.snap`, `glide` or `fold` (`motion.ts`) | Interactive elements                |

### Animation Catalog

**Message entrance:** Fade in + slide up 8px, `SPRING.glide` (no bounce). User messages also scale from 0.97→1. Only animate the _newest_ message; history loads instantly.

**Session switch:** 150ms opacity crossfade via `AnimatePresence mode="wait"`. Total transition 300ms (old exits, then new enters). Duration-based easing, not spring.

**Sidebar active indicator:** `layoutId` sliding background via spring `stiffness:280 damping:32` (smooth, deliberate slide). Animates across sidebar groups.

**Session row tap:** `whileTap` scale to 0.98, spring `stiffness:400 damping:30` (quick press feedback).

**Tool card expand:** Height + opacity transition, 300ms ease-in-out.

**Button press:** Scale to 0.97 in 80ms, back in 120ms, both ease-out, as a CSS transition that can be interrupted. Nothing under reduced motion. See [Button](#button).

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

**The announcer rule: one live region, counts not verbs** — the same principle the sidebar's
accessibility contract states for the phone's needs-you count, applied to the lane. `role="status" aria-live="polite"`
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

Built on **Shadcn Sidebar** (`layers/shared/ui/sidebar.tsx`) with `collapsible="offcanvas"` mode. On the web app the sidebar body is the `DashboardSidebar` agent roster (in `features/dashboard-sidebar/`) on every route — per-session context now lives in the right-panel inspector, not a sidebar drill-in. A registered `sidebar.body` contribution can take over the body for its route (the marketplace facet panel does on `/marketplace`).

- **Width**: the visible panel is **272px** — the number to build to, and the number a browser test measures on `sidebar-inner`. **Do not set `--sidebar-width` to 272px.** That variable on `SidebarProvider` (`AppShell.tsx`) sizes the _slot_, and the `inset` variant adds `p-2` — 8px of padding a side — before the tinted surface starts. So the slot is `calc(272px + 1rem)`, which is what `AppShell` writes, and the panel inside it is 272. Writing `17rem` there would give a 256px panel, not a 272px one. Never set a one-off width on a component to work around any of this.
- **CSS variables**: `--sidebar-*` in `index.css`. The panel sits distinctly off the main background — `--sidebar` is 91% against a 98% background in light mode, and 10% against 4% in dark.
- **Mobile**: Renders as Radix Sheet (drawer) with backdrop and swipe-to-close
- **Desktop**: Push layout via `SidebarProvider` + `SidebarInset`
- **Toggle**: `Cmd+B` / `Ctrl+B` (Shadcn built-in `SIDEBAR_KEYBOARD_SHORTCUT`)
- **SidebarRail**: Invisible hover-target strip at sidebar edge for mouse-over toggle
- **SidebarTrigger**: Toggle button in `SidebarInset` header (outside the sidebar itself)
- **Places, never sessions or threads** (DOR-3092): from the top, the Threads and Directory doors, your own sections, Channels, Direct messages and Add-ons — see [Sections](#sections) below. An agent is one row, as its direct message. Sessions are reached through ⌘K and the agent's profile, threads through the Threads page.
- **Rows**: `SidebarModelRow` draws each row from `buildSidebarModel`'s output; `isActive` highlights whichever row matches the current route.
- **Header block**: `SidebarHeaderBlock`, mounted in `Sidebar` above the body-swap region — persistent chrome that survives a `sidebar.body` takeover (spec BC-43→46). A button named after the operator ("Dorian's team"), opening you (your profile) / DorkOS account / Settings above the destinations and a quiet version line below them (DOR-2628); the `NewMenu` (Session, Channel, Direct message, Agent…, Agent group — every create surface in the sidebar, and nowhere else); and `SidebarSearchPill`, the ⌘K pill.
- **Footer**: `SidebarFooter` contains `ProgressCard` (onboarding) and `SidebarFooterStrip` — one slim tinted row of destinations (Home, Team, Marketplace, Connections), a `⋯` menu holding the `sidebar.footer` slot, and ✦ Ask DorkBot. No logo, no version line, no `border-t`: separation is a step up the `--sidebar-accent` ramp (spec `sidebar-now-today-library` BC-47, R1)
- **Dialogs**: All 6 dialogs (Settings, DirectoryPicker, Tasks, Relay, ServerRestartOverlay, ShapeSwitcher) registered in `DialogHost` at the app root level, outside `SidebarProvider` (`layers/widgets/app-layout/model/dialog-contributions.ts`). `OnboardingFlow` renders directly from `AppShell.tsx`, not via `DialogHost`.

### Separation by tint, not by borders

Nav panels separate their levels with tint and whitespace, not hairlines. Add no `border-b` under a header, no `border-t` above a footer, and none between sections; where an edge needs to read at all, it is a scroll-edge shadow that appears only once content scrolls under the header or footer. `SidebarFooter` (`AppShell.tsx`) already carries no `border-t` — do not add one back. That is not the last hairline in the app's nav panels, though: `MarketplaceSidebar.tsx`'s `SidebarHeader` still has a `border-b`, not yet migrated to this rule — remove it when that panel's turn comes, and remove any other hairline you pass.

Every level of separation comes off **one ramp**, `--sidebar-accent`, and no new colour is introduced:

| Level        | Class                                                  | What it does                                                                    |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Search pill  | `bg-sidebar-accent/40`                                 | recessive tint, ~2–3% effective delta                                           |
| Footer strip | `bg-sidebar-accent/60`                                 | separates the footer from the panel                                             |
| Row hover    | `bg-sidebar-accent/70`                                 | reads on top of the recessive tint; measures as the same step as `bg-row-hover` |
| Row active   | `bg-sidebar-accent` + `text-sidebar-accent-foreground` | the strongest step                                                              |

**Never use `--muted` inside the sidebar.** It inverts direction between themes. `--sidebar` is 91% light and 10% dark, while `--muted` is 96% light and 9% dark — so a surface tinted with `--muted` is _lighter_ than its panel in light mode and _darker_ in dark mode. `--sidebar-accent` is 86% light (−5%) and 16% dark (+6%): it moves away from the panel in the same perceptual direction in both themes, at the 5–10% delta this system asks for.

Status colour stays on the semantic tokens, which are already calibrated per theme and are already what `status-dot.ts` uses: `bg-status-success` (working), `bg-status-warning` (needs you), `bg-status-error` (error or wedged), `bg-status-info` (unseen). No raw hex, and no new `--sidebar-*` tint variable — one ramp is the point.

Label-on-tint must still meet 4.5:1 in both themes. Check it with an axe-core run over the playground showcase rather than by eye.

#### Where that check lives, and how to not fool yourself with it

The showcase is **`/dev/sidebar-model`** (`apps/client/src/dev/showcases/SidebarModelShowcases.tsx`), which draws `buildSidebarModel` over its four journey fixtures. The axe run over it is `apps/e2e/tests/dashboard-sidebar/sidebar-model-showcase.spec.ts`, in both themes, and it attaches a light/dark screenshot pair to the run.

**An axe run is not a gate until you have proved it can fail.** axe-core's `color-contrast` builds a spatial grid bounded by the viewport, and text whose rect falls outside that grid is not evaluated at all — not a violation, not a pass, not even an `incomplete`. It is simply absent, and the run reports success. At Playwright's default 720px-tall viewport this page evaluated **1 node out of 343**, and a deliberately-injected 1.68:1 label was **not reported**. Every axe check in this repo inherits that trap.

**Guard it with something that moves when the page moves.** The first attempt here was `expect(evaluated).toBeGreaterThan(200)`, and a floor is not coverage: at 1600×2400 the page evaluated 260 nodes and cleared the bar while missing two injected 1.91:1 labels, and at 1600×4000 it evaluated 322 and missed the same two. The number went up as the page got taller; it just never went up as fast as the page did. So assert page-relatively instead, and prefer both:

- **The content fits the viewport** — compare the axe context's height against `window.innerHeight` before running axe. This is what actually guarantees the grid covers everything, and it fails with the real reason ("the page outgrew the viewport") rather than a threshold nobody can interpret.
- **Every element of some class you own was evaluated** — resolve axe's reported targets back to elements and assert a known set is among them. The sidebar-model spec uses its reason chips: one per section and row, spread top to bottom, so the denominator grows on its own when the page does.

A threshold is not coverage unless it moves with the thing it measures.

Two smaller things from the same branch:

- **A one-character label is `incomplete`, not a pass.** axe refuses to judge text shorter than its "is this really text" heuristic, which covers every numbered unread badge. Those land in the run's `incomplete` bucket; the spec pins that bucket to exactly the badges, so a new "cannot determine" elsewhere is caught rather than inherited.
- **The muted quarantine is meant to go red.** The spec quarantines the one contrast failure on the page — muted rows, below — with an equality assertion rather than a filter, so it fails both when a new failure appears and when the muted one is fixed. A green quarantine after the fix lands would be the quarantine outliving its reason.

#### Muted means fewer signals, not less legibility

A muted row keeps **full label contrast** and gives up its attention signals instead: no bold, no badge, no dot. That is already the vocabulary the two-tier unread system speaks, and it is what mute has always meant — "stop pulling me back into this", never "make this harder to read".

Dimming is the wrong mechanism and it is not a tuning problem. `SidebarRow` dims `muted` rows with `opacity-60` over a label that is only 5.9:1 to begin with, which measures **2.6:1 in light and 3.6:1 in dark**; no opacity value clears 4.5:1 from that starting point. Reducing contrast also spends the accessibility budget of exactly the readers least able to afford it. Replacing the dim in `shared/ui/sidebar-row.tsx` is **DOR-1098**.

### Sections

A nav panel has **two levels and one header style** (`specs/sidebar-simplification` D1, 2026-08-19): a section header and its rows. It once had a third — zones (Heads up, Getting started, Today, Library), each a landmark above its sections — and a 272px panel cannot teach three. The zones went with the sidebar's new shape (DOR-3092).

- **Top items** — a headerless block of doors at the head of the list: Threads and Directory. A top item never shows before its page exists, and the block never folds.
- **Section** — a header and its rows. Channels, Direct messages, Add-ons and every section a person makes are all the same header.

**Every header folds.** Click anywhere on it, or press Enter/Space; `Alt`/`Option`-click folds or unfolds every header in the panel. A folded header keeps its unread rows on screen beneath it, and one dot when a member is working, so folding never hides a message nobody has read. A header never carries a count.

Never nest accordions, and keep nav trees to **one indent level** — depth past two stops helping wayfinding. Section labels are sentence case, **11px medium**, `text-sidebar-foreground/70`, with **no icon**: the rows underneath carry the glyph, and a `#` above a list of `#` rows says the same thing twice. ALL-CAPS with letterspacing reads dated at small sizes.

#### Casing: sentence case everywhere

The casing and punctuation rules below are the mechanics. Voice, the word-count cap and the rules for buttons, errors, empty states and approvals are the `writing-app-copy` skill.

The rule above is not a sidebar rule, it is the house rule. **Every string a person reads is sentence case** — headings, section labels, buttons, menu items, tab titles, dialog titles, settings rows, tooltips, `aria-label`s. Capitalise the first word and nothing else.

The only exceptions are proper nouns: product names (DorkOS, Claude Code, Codex, OpenCode, Obsidian, Slack, Telegram, GitHub), named surfaces that are titles in their own right (Control Center, Dev Playground), and acronyms (ID, MCP, URL). "Reset all data", not "Reset All Data". "Open in a new tab", not "Open in New Tab". "Marketplace sources", not "Marketplace Sources".

Title Case makes a small UI shout, and mixing the two registers in one menu reads as two products stitched together. DOR-1755 fixed the worst of these collisions and is the rule's origin, but the sweep is not finished everywhere — a survivor is a bug against this rule, not evidence the rule is aspirational. When in doubt, write the words the way you would write them in a sentence.

#### Punctuation: one ellipsis, one apostrophe, one full-stop rule

Three small rules, all settled by DOR-1756, all for the same reason as the casing rule: two spellings of the same mark in one screen read as two products.

- **Ellipsis is `…`, the single character** — never three periods. They render at visibly different widths, and a screen that mixes them looks unfinished. "Saving…", "Search agents…", "Reconnecting…".
- **Apostrophes and quotes are the curly characters** — `’`, `“`, `”` — written **literally**, never as `&apos;`, `&rsquo;`, `&ldquo;`, `&rdquo;` or `&quot;`. The literal is what typesets correctly, and it is the only form a grep for a phrase can find. ESLint's `react/no-unescaped-entities` bans a bare `'` or `"` in JSX text, so the curly characters need no entity — `&quot;` is the escape that rule actually pushes authors toward (nobody here writes `&ldquo;`/`&rdquo;`), which is why it is banned by name rather than left to the general pattern.
- **A headline takes no full stop; a supporting sentence does.** "No chats yet" over "Type a message below to begin." One line that carries both — "No chats yet. Press ⌘↵ to start one." — is a sentence, so it keeps its stops.

None of this binds code: a token placeholder like `xoxb-...`, a JSON preview, or anything inside a `<code>` block is a sample, not copy. Dev Playground commentary is a development tool and is not swept, but a showcase that quotes a real string must quote it exactly as the app renders it. Prompt text written for a model — a task template, the memory rules in `packages/shared/src/convention-files.ts` — is not copy either.

`scripts/check-vocab-gate.ts` enforces the first two rules on every ellipsis and every entity in a copy position across `apps/client/src`, `apps/site/src` and `apps/server/src`. The straight apostrophe is **not** gated, because the sweep of it has only reached `apps/client/src`: the marketing site and server-authored copy the client renders verbatim (a custody disclosure, a provisioning error) still spell it straight in places. Make it curly when you next touch one of those strings.

#### The three geometry tokens

Every horizontal inset in the sidebar comes off three custom properties, declared on `:root` in `apps/client/src/index.css`. They are measured **from the panel's left edge**, not from the element that pays them — the panel already pays 8px (`px-2` on `SidebarContent`), so each consumer applies `calc(var(--token) - 0.5rem)`.

| Token                | Value | What it fixes                                                                    |
| -------------------- | ----- | -------------------------------------------------------------------------------- |
| `--sidebar-header-x` | 12px  | Where every section header's label starts.                                       |
| `--sidebar-row-x`    | 20px  | Where a row's 18px glyph slot starts. The label follows at 20 + 18 + 8 = **46**. |

**Two tokens, because there are two levels.** A third — `--sidebar-nested-x` — indented a hand-made section's members back when a section rendered inside Agents; sections are peers of Channels and Direct messages now (`specs/sidebar-simplification` D3), so nothing in the panel is nested and the token went with its last consumer.

Never write a sidebar inset as a literal. `apps/e2e/tests/dashboard-sidebar/sidebar-row-gutter.spec.ts` reads these tokens out of the live document and measures the computed padding against them, so retuning one moves every header, every row and the glyph-action overlay together — and changing one half alone goes red with the number it actually got.

**Muted is fewer signals, not less contrast** (DOR-1098). A muted row keeps its label at full contrast and loses the bold, the unread badge and the working dot. The `opacity-60` it used to wear took the label to roughly 3:1 — under the 4.5:1 every label owes — so silencing a conversation made the one thing still worth reading hard to read.

#### Accessibility contract

This is the whole contract a nav panel must meet, and it is what shipped: `SidebarSections.tsx` and `SidebarSection.tsx` implement it, and `DashboardSidebar.tsx` composes them. Treat it as the spec those components are checked against, not a future one.

- **Landmarks.** The panel root is `<nav aria-label="Sidebar">`, the one landmark. Sections are `<h3>` containing a `<button aria-expanded aria-controls>`.
- **Roving tabindex, per section.** Each section exposes exactly one tab stop — the active row if the section holds it, otherwise the section's first stop, which is its header. `ArrowDown`/`ArrowUp` move within the section (header → its `+` → the rows), `Home`/`End` jump to the **first and last row** (never to the header or the `+` — the header is one `ArrowUp` off the top, and it is where you go to fold a section rather than to start reading it), and `ArrowLeft`/`ArrowRight` on a section header collapse or expand it. `Tab` moves between sections, so sixty direct messages are one tab stop rather than sixty. A **mounted inline editor keeps its own tab stop**: a rename field is up because somebody is typing in it, and stamping it `-1` with everything else is what made it impossible to Tab out of and back into.
- **One live region, counts only.** The desktop panel no longer lists what needs you (the Inbox does), so it announces nothing. On a phone a single visually-hidden `aria-live="polite" aria-atomic="true"` element beside the tab bar announces how many things need you ("2 agents need you"), debounced 1s (`widgets/mobile-tabs`, `use-live-region-text.ts`). Verbs, activity and unread changes are never announced — a fleet of agents would otherwise turn a screen reader into a siren.
- **Only "working" animates.** The status dot uses `STATUS_DOT_PULSE` (`shared/ui/status-dot.ts`), which is `motion-safe:animate-pulse`; its ping halo carries `motion-reduce:hidden`. Scroll-to-active uses `behavior: 'auto'` under `prefers-reduced-motion`, and the celebratory moments (the welcome-back glow, the all-clear beat) do not render at all under it.
- **Hover-revealed chrome always has two other paths.** `focus-visible` reveals it on the keyboard, and on touch it is either always visible or reachable by long-press (see [Hover Pattern Mobile Alternatives](#hover-pattern-mobile-alternatives)). Nothing may be reachable by hover alone.
- **Every drag has a keyboard and pointer alternate** (WCAG 2.5.7). Reorder, pin/unpin and move-to-group are all reachable from the row kebab and the context menu on every platform. `KeyboardSensor` and `sortableKeyboardCoordinates` stay wired, and the `buildSidebarAnnouncements` strings (`features/dashboard-sidebar/model/use-sidebar-dnd.ts`) are preserved verbatim.
- **Colour is never the sole indicator.** Every status dot is paired with a verb line, a tooltip or an `aria-label`, and the two unread tiers differ in weight and shape as well as hue — see [Unread — Two Tiers](#unread--two-tiers), which is where that rule is defined.

### Sidebar Tabs

Retired. The four-tab `SessionSidebar` strip this section used to document (Overview / Sessions / Schedules / Connections, switched via a CSS `hidden`-toggle so all three stayed mounted) no longer exists. DOR-401 retired it. Per-session context lives in the right-panel Inspector; the later Obsidian embed has also been retired. ADR-0107, which decided the CSS `hidden`-toggle mechanism, is deprecated as of the 2026-08-06 audit — kept as the archival record of a component that no longer ships.

### Tooltip

Standard shadcn Radix tooltip from `shared/ui/tooltip.tsx`. Used for:

- Disabled state indicators (e.g., "Pulse is disabled" on HeartPulse icon)
- Contextual information on icon-only buttons

`TooltipProvider` is mounted in `AppShell.tsx`. Use `<Tooltip>` + `<TooltipTrigger>` + `<TooltipContent>` pattern.

### InfoTip and MoreDetails

Two primitives for rung 3 of the copy overflow ladder (`writing-app-copy` skill): the label or description stays short, and the rest moves somewhere a person can open it. Each paragraph inside is still one block of 15 words or fewer.

| Use           | When                                                                                       | From                         |
| ------------- | ------------------------------------------------------------------------------------------ | ---------------------------- |
| `Tooltip`     | One short line on hover or focus: an icon button's name, why a control is disabled         | `shared/ui/tooltip.tsx`      |
| `InfoTip`     | A note about one control or label, up to a few short paragraphs. Opens on click or tap     | `shared/ui/info-tip.tsx`     |
| `MoreDetails` | Extra paragraphs under a description, read in the page flow. An inline "More details" link | `shared/ui/more-details.tsx` |

Never put a paragraph in a `Tooltip`: it has no touch path and hides as soon as the pointer leaves. `InfoTip` takes a required `label` for its accessible name ("About background agents"), and opens a popover on desktop and a drawer on a phone.

### Toast Notifications (Sonner)

Theme-aware toast via `sonner` from `shared/ui/sonner.tsx`. `<Toaster />` mounted in `AppShell.tsx`.

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

Full-width app banner from `shared/ui/banner.tsx` (`Banner`), for a **standing condition** that stays until it resolves — a sign-in that stopped working, a waiting update, connection lost. A banner is not a toast: a toast fires once for a transient event and fades; a banner persists while the condition is true.

**A banner states a fact; it does not ask a question.** The first-run telemetry invitation used to live here and was moved off it (spec `full-power-defaults` D5): a yes/no question in a slot built for standing conditions just sits above every route until someone answers it. One-time questions belong on the moments rail below. The canonical banner today is the runtime sign-in one (`RuntimeSigninBanner`) — a condition that is true right now and stops being true once it is fixed. (The unattended-autonomy banner was retired by DOR-2739: full power is the normal way agents work, so it was not a condition worth a second voice.)

**A banner is the second voice, so it needs the fact to be worth two.** The all-permissions-bypassed banner was retired for this reason (spec `trust-dial`, decision 3A): the status strip already carried the word and the tint for a session the person was sitting in front of, and two alarms about one fact teach people to read neither. Ask what the banner says that the surface the person is looking at does not.

**Banner vs toast:**

- **Banner** — a condition that is _still true_ right now (a sign-in that stopped working, an update waiting, the connection lost). Persistent, dismiss only when it makes sense.
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

There is **no `success` banner** — a success is a toast. Colors come from the `--status-*` tokens, so light and dark themes stay correct. Pass `onDismiss` only for a dismissible banner; pass `details` + `detailsOpen` for a collapsible progressive-disclosure region. The telemetry banner was its only production user before it became a moment, so the working example is now the Dev Playground showcase (`dev/showcases/BannerShowcases.tsx`) rather than a shipped surface.

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

Every identity in the app — an agent, a person, the room a direct message is with — is drawn as the same disc: `IdentityAvatar` (`shared/ui/identity-avatar.tsx`). It is the only place this convention is implemented, and this section is the only place it is written down.

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

`working` means a turn is streaming as you look at it, and nothing weaker. It used to default to `healthStatus === 'active'` — the mesh's "seen within the last hour" — so every list row in the app pulsed a right-now claim sourced from an hour-old heartbeat. A caller with no turn-level signal passes nothing.

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

- **A `border-<colour>` utility works — and for a long time it did not, which is worth knowing before you read old code.** `index.css` gives every element a neutral `border-color`, and that rule used to be **unlayered**, so it outranked every `@layer` including Tailwind's `utilities`: `border-destructive`, `border-primary`, `border-transparent` and ~290 other border-colour classes rendered as the neutral border, everywhere. It lives in its own `border-defaults` layer now (DOR-1024) — below `utilities` so a class can beat it, above `blintz` so the canvas editor's bundled preflight cannot reset it back to `currentColor` app-wide the moment that chunk loads. Write the class. **A `color-mix()` of a custom property is a class too** — `border-[color-mix(in_oklch,var(--identity-color)_var(--identity-border-strength),hsl(var(--border)))]` is what `TeamMemberCard` wears, the same arbitrary-value shape `identityMarkRing` has always used for its ring, and the strength stays a separate property so `hover:` can move it. A border colour only needs to be **inline** when the value is computed in JS (`AgentNode`, `PresetPill`) or when Motion has to tween it, which it cannot do through a custom property. If you find an inline `borderColor` whose value is a literal, it is a leftover from the old rule; make it a class.
- **`group-hover:` matches ANY `.group` ancestor, not the nearest one.** Tailwind compiles it to `:where(.group):hover &`. The sidebar wraps its rows in an unnamed `.group` that spans most of the pane, so the bare form left every sidebar face permanently ringed. Always use a **named** group (`group/identity` + `group-hover/identity:`) when the control is anywhere it could be nested.

**Press scales by target size:** `0.99` for a card, `0.98` for a row or chip, `0.94` for a mark used as a button. Scale down only; the release rides the hover duration back up.

**Focus-visible parity is a rule, not a nicety.** If an area has a hover state, it has a focus-visible twin conveying the same information — a keyboard user must never learn less than a mouse user. The ring itself comes from the `focus-ring` utility; the _informational_ half (a colour step, an underline, a lift) gets an explicit `focus-visible:` twin beside every `hover:`. That includes a Surface: when the card's primary control takes focus, the **card** answers, not just the word inside it — `has-[[data-slot=team-member-open]:focus-visible]:` is how the roster card does it. The inverse is equally binding: **never put a `focus-visible:` ring on something no keyboard can reach.** A dormant ring on a `<span>` is an affordance wired to nothing.

**Reduced motion needs no work for CSS, and for most Motion props.** `index.css` collapses every transition and animation duration to `0.01ms` under `prefers-reduced-motion: reduce`, globally, and `MotionConfig reducedMotion="user"` (`AppShell.tsx`) does the equivalent for `motion/react`'s **transform and layout** animations. Every prescription above is therefore correct there for free — which is why none of them carries a `motion-reduce:` variant, and why every one of them is a _static_ end state that reads on its own (a ring is present, a border is coloured, a card is lifted). A design that only reads _because_ of the movement is broken there. What neither reset reaches is **opacity, colour, or anything with `repeat: Infinity`** — those are inline styles `MotionConfig` does not suppress, so an infinite opacity or colour loop keeps running under reduced motion regardless of the global config. A `motion.*` component using any of the three must call `useReducedMotion()` itself and branch **off**, not shorter — put the branch in a pure function that also reports itself as a `data-` attribute so the two can never drift — `shouldAnimateRoster()`, below, is the shape to copy.

**Touch invariant:** nothing that exists only on hover may carry information unavailable another way. A card's lift has no touch equivalent and costs nothing, because the tap opens the drawer; an avatar's hover card is reached by long-press (`identity-hover-card.tsx`), which is the one pattern for that — never invent a second.

**Three moments earn more than the baseline, and nothing else does.** The grammar above is the floor every identity surface stands on; these are the only places that spend beyond it.

| Moment          | Where                         | What it does                                                                                                   |
| --------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Roster FLIP** | `TeamRosterGrid`              | Cards travel to their new positions on filter, search and the group toggle. `layout="position"`, spring 280/32 |
| **Owner echo**  | `TeamMemberCard`              | Hovering or focusing "by @dorian" reveals "· 3 agents" beside it                                               |
| **Badge wake**  | `IdentityAvatar`'s badge slot | Pointing at an opted-in disc tilts its kind badge −6° and scales it 1.10                                       |

Four rules they establish, each of which cost something to learn:

- **A JS animation needs its own reduced-motion gate, and the gate belongs in a pure function.** `test-setup.ts` strips `layout`, `layoutId`, `initial`, `animate`, `exit` and `transition` from every `motion.*` component, so **no motion prop is assertable in jsdom, ever** — a test that appears to check one is checking nothing. The roster's answer is `shouldAnimateRoster()` in `features/team-roster/lib/roster-layout.ts`: the rule is unit-tested at full strength, and the grid reports the same boolean as `data-layout-animated` on its root **and on every card**, so the attribute cannot drift from the behaviour. Copy this shape for any future JS-driven motion.
- **Travel is won structurally — and `popLayout` needs a forwarded ref.** A card animates to a new position only while it stays the _same component instance_, so both roster arrangements are one flat list of grid children (a cluster header is a `col-span-full` row, not a `<section>` wrapping a nested grid). That structure removes the need for `layoutId` entirely. Do not add it back to an `AnimatePresence mode="popLayout"` list on the theory that it is harmless: measured one variable at a time in exactly that configuration, adding `layoutId` took a surviving card from 51 sampled positions to 1 (it teleports) and left the exiting cards in the DOM as invisible absolutely-positioned ghosts past three seconds. That is a finding about **this combination**, not a verdict on `layoutId` — the nav pill and the session row use it happily, without `AnimatePresence`. The mechanism was never established, only the behaviour, so re-measure rather than reasoning from a cause. Separately, `popLayout` writes `position: absolute` onto an exiting node through a **ref**, so any component between it and the DOM must pass `ref` along; without that the mode silently does nothing and every survivor waits out the fade before closing the gap. None of it is visible to jsdom, typecheck or lint — all of it came from sampling element positions frame by frame in a real browser.
- **A reveal costs the layout nothing — and does not exist where there is no hover.** Animating `width`/`max-width` reflows, and a suffix that appeared by taking space would shove the thing you are pointing at. Reserving the space in flow instead is the obvious fix and the wrong one: it charges the neighbour permanently for something invisible almost always (measured at 28–63px, enough to truncate handles as short as `@miguel.telegram`). Take the reveal **out of flow** — `absolute left-full` off a `w-fit` row, so it lands just past the text rather than at the far edge of the card — and animate only `opacity`. Accept that out of flow can cross a container edge on the narrowest columns and say where. Gate it on `[@media(hover:hover)]` too: the query asks about the **pointer**, not the viewport, so a phone lays out nothing while a narrow desktop window keeps the echo it can use.
- **Retime a shared primitive at the call site until every call site wants it, then fix the primitive.** The profile drawer used to carry `data-[state=open]:duration-300` on its own className — `cn`'s tailwind-merge lets a caller outrank the primitive's own duration — because re-timing `sheet.tsx` is a decision about every sheet in the app, which that change was not. DOR-1764 made that decision: the Sheet primitive is now **200ms in on `ease-out`, 150ms out on `ease-in`**, with `SheetOverlay` on the same clock so the scrim and the panel land together. The call-site override is gone, and no sheet needs one.

**One deliberate departure from the spec's reduced-motion table.** The badge wake is gated with `motion-safe:`, which drops the **end state** as well as the travel — the spec's §2.6 table would have kept the tilt. The rule that table serves is "keep the fact, drop the motion", and a 6° tilt carries no fact: nothing about a crooked badge tells you anything a still one does not. With no fact to keep, an instant snap to crooked is all cost. **Generalise from this:** a state that exists purely as personality should go entirely under reduced motion; only a state that _says something_ survives as a static end state.

Full audit and rationale: `plans/identity-micro-interactions/design-spec.md`. **`/dev/identity#motion-and-interaction` is the home for all of it** — the three tiers, focus parity, and all three signature moments, each drivable. `/dev/components#identityavatar` still shows the disc's own states.

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
- Active filter chips: `RemovableChip`, in a `data-chip-group` so removing one moves focus to its neighbour
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
    <Badge>Disabled</Badge>
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

### Cards, groups and rows

Three containers, one rule each. A **card** sits on the page. A **group** holds rows inside anything that floats. A **row** is a line in a list. They never nest in one another, and none of them draws a rule between its children.

#### Card (`shared/ui/card.tsx`)

`bg-card` plus `shadow-soft`, and **no border**: height comes from elevation, and in dark mode the soft lift paints the card 2% lighter than the page, so its edge reads without a line.

| Axis       | Values                                          | Use                                                                                                                                                                    |
| ---------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `variant`  | `static` (default), `interactive`               | `interactive` is a whole card you press: `card-interactive` (soft → elevated shadow, 150ms, no translate) plus `PRESS_CARD` and the outer focus outline                |
| `radius`   | `md` (8px, default), `lg` (12px)                | `lg` only for a hero tile at least 320px wide                                                                                                                          |
| `padding`  | `md` (16px, default, desktop and phone), `none` | `none` when the body is rows: the rows pay the inset                                                                                                                   |
| `gap`      | `md`, `sm`, `none`                              | space between children                                                                                                                                                 |
| `selected` | boolean                                         | a chosen card: `outline-2 outline-foreground` at offset 0 plus a check, top right. Never a tint, never orange. `aria-pressed` and `aria-checked` draw the same outline |

`CardTitle` is `text-sm font-semibold leading-5` (`leading-none` clipped descenders on the phone). `CardFooter` is right-aligned actions separated by space (`pt-1`), never a `border-t`.

#### Group (`FieldCard`, `shared/ui/field-card.tsx`)

`FieldCard` is **a tint, not a card**: `bg-row-group rounded-lg`, no border. It is what rows sit on inside a dialog, sheet, popover or drawer. A card there is a surface inside a surface — outlined in light and a hole in dark (a 4% card in a 15% dialog) — while a foreground tint only ever adds light.

- **`FieldCardContent`** gives each direct child `px-4 py-3`. That space is the only separator: no `divide-y`.
- **`CollapsibleFieldCard`** is a group with a header that opens it. Its body has no `border-t`.
- **Danger zone** is the plain group. No `border-destructive`: the "Danger zone" heading and the destructive button carry it, and red is spent on the action, not the frame.
- **`SettingRow`** has a floor of 48px (60 on the phone) and **no hover**: the control acts, not the row, and a tint promises a click.
- A section heading goes above a group (24px above, 8px to it), never inside it.

```tsx
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
```

#### List row (`ListRow`, `shared/ui/list-row.tsx`)

One grammar: **leading glyph · (who ›) title · meta · trailing state · actions**, with an optional second line. `SidebarRow` keeps its own geometry (28 / 44px) and shares the state recipe.

| Part              | Desktop                                                                                            | Phone (< 768)    |
| ----------------- | -------------------------------------------------------------------------------------------------- | ---------------- |
| Height, one line  | 32 (`min-h-8`)                                                                                     | 44 (`min-h-11`)  |
| Height, two lines | 48 (`min-h-12`)                                                                                    | 60 (`min-h-15`)  |
| `inset="page"`    | `px-2`, `rounded-md`; the list sits at `-mx-2` so the glyph lines up with the text column          | same             |
| `inset="group"`   | `px-4`, `rounded-none`, full bleed inside a `FieldCard` (its corners clip the first and last rows) | same             |
| Leading slot      | `sm` 20, `lg` 32 (two-line rows)                                                                   | `sm` 24, `lg` 40 |
| Glyph → title     | 8                                                                                                  | 12               |

- **Title** never wraps (`ROW_TITLE_CLASS`): it truncates and the full name is in `title`. **Meta** never shrinks. Under a 24rem row (`@container/row`, so a phone) the meta and the trailing state move to the start of the subtitle line, joined to the second line with " · ", so the title gets the row's whole width. Actions stay at the end, but leave the flow at rest on a narrow row and come back on hover, focus or an open menu (always shown on touch).
- **State copy wraps.** An empty, filtered or failed list's row takes `wrapTitle`: the words wrap and never truncate. On a narrow row its trailing ("Try again") moves under them.
- **Actions** (up to two ghost icon buttons) are **siblings** of the row's button, never inside it. They are hidden at rest and shown on hover, on focus-within and while their menu is open; always shown on a coarse pointer. Their space is reserved, so the title never reflows. `menu` adds the ⋮, the right-click menu and the long-press sheet from one node list.
- **No `onSelect` and no `asChild`** makes a static row: no hover, no press, not a Tab stop.
- `data-row-state` (`rest | selected | emphasized | disabled`) is stamped so tests read state, not classes.

#### The row ladder (`shared/ui/row.ts`)

Every list outside a menu takes its states from `rowTintVariants` (tint and weight) and `rowStateVariants` (that plus focus and press, for a one-element row). The tints are foreground alpha, so one step reads the same on any ground:

| Token             | Light | Dark | Dark, inside `.shadow-lg`/`-floating` and `.shadow-xl`/`-modal` |
| ----------------- | ----- | ---- | --------------------------------------------------------------- |
| `bg-row-hover`    | 4%    | 5%   | 3%                                                              |
| `bg-row-selected` | 7%    | 9%   | 5%                                                              |
| `bg-row-group`    | 3%    | 4%   | 3%                                                              |

| State                                  | Recipe                                                                                      | Motion                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Hover (only if the row does something) | `bg-row-hover`                                                                              | `background-color`, 150ms                     |
| Pressed                                | `PRESS_ROW` (0.98) over the hover tint                                                      | 80ms in, 120ms out; none under reduced motion |
| Focus-visible                          | `outline-2 -outline-offset-2 outline-ring` **and** the hover tint, actions revealed         | instant                                       |
| Selected / current                     | `bg-row-selected font-medium`, `aria-selected` or `aria-current="page"`; no change on hover | instant                                       |
| Emphasized (unread)                    | `font-semibold`, full ink                                                                   | —                                             |
| Disabled                               | `opacity-50`, `aria-disabled`, still focusable when it says why                             | —                                             |

Inside a dark modal the inks climb with the tints: `--faint` goes to 64% and `--status-error-fg` to `0 72% 74%`, because a group plus a selected row on a 15% dialog composites to about 20%, where the page values measured 3.55 and 3.66:1. Every row state clears 4.5:1 for text and 3:1 for the ring in both themes.

#### Nested rules

| Outer                  | Inner                                | Rule                                                                          |
| ---------------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| Page                   | Card                                 | Yes                                                                           |
| Card                   | Card                                 | Never: the inner one becomes a group or plain space                           |
| Card or group          | An outlined box or row               | Never: a plain row, tinted on hover only if it acts                           |
| Dialog, sheet, popover | Card                                 | Never: a group (`FieldCard`)                                                  |
| Group                  | Group                                | Never: a section heading and 24px of space                                    |
| Any                    | Input, code block, tool output, diff | Keeps its outline: an object you act on                                       |
| Any                    | Callout (a warning block, not a row) | A status wash is allowed, with no border                                      |
| Any                    | A row with a problem                 | A grey row with a status glyph and one word ("Reconnect"). Never wash the row |
| Dark, anywhere         | Any inner surface                    | Never darker than its container                                               |

#### List states

| Condition                    | What renders                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A section with nothing in it | Nothing, header included (absent, not empty)                                                                                     |
| The whole list is empty      | `EmptyState`: one glyph, one fact, one next step ("No schedules yet. Create one.")                                               |
| A filter matches nothing     | One static row, "Nothing matches 'foo'", and a ghost **Clear filter**                                                            |
| Loading                      | Nothing for 300ms, then skeleton rows at the real height, `min(expected, 5)` of them, replaced in place. Never a centred spinner |
| The list failed to load      | The frame stays; one row: error glyph, "Couldn't load schedules.", ghost **Try again**. The raw error is behind More details     |
| One item is broken           | A grey row, a status glyph, one word in `text-status-*-fg`                                                                       |
| Pending                      | Title in `text-muted-foreground`, trailing "Saving…", actions hidden                                                             |
| Offline or stale             | Trailing `text-faint` "Offline" / "Updated 5m ago"                                                                               |

No stagger when a list opens: a list is something you're waiting to read.

### Disclosure — which "Advanced" to reach for

Progressive disclosure only works if the affordance is learnable. Someone who
learns that a chevron and a label open a section in one dialog should get that
knowledge back everywhere. So there are two idioms and one rule for choosing
between them.

**A form or settings group → `CollapsibleFieldCard`.** Always, and always with a
`badge` saying what is behind it ("3 changed", "7 files", "On a schedule"). The
badge is the half of disclosure that makes it safe: a section that hides its
contents without saying how much it is hiding invites a person to skip it. It
unmounts what it hides, so a control inside a closed section is genuinely not on
the page — which is what a test has to open first, exactly as a person does.

**Disclosure inside content → native `<details>`.** A tool card's output, a stack
trace in `route-error-fallback.tsx`, the path list inside one row of the install
preview. These are part of something you are reading rather than a group of
controls, they need no card chrome around them, and the native element brings
keyboard and screen-reader behaviour for free.

**The one exception**: a row whose header already holds its own controls — a
switch, a menu — cannot be a `CollapsibleFieldCard`, because that primitive's
whole header is one button and controls cannot nest inside a button. Those rows
use a bare Radix `Collapsible` with the same chevron treatment (`ChevronDown`,
`-rotate-90` when closed) so they still read as the same affordance;
`settings/ui/tools/ToolGroupRow.tsx` is the example to copy.

Do not hand-roll a third one.

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

Subtle. 150ms transition. One step of the row ladder: `bg-row-hover` (4% foreground in light, 5% in dark, 3% inside anything that floats), the same mechanism that groups a zone, one step stronger. See [The row ladder](#the-row-ladder-sharedrowts). Only a row that does something gets a hover: a tint promises a click.

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

**Rows take it inset**: `outline-2 -outline-offset-2 outline-ring` (`ROW_FOCUS_CLASS` in `shared/ui/row.ts`). Rows tile edge to edge inside clipped scrollers, so an outer ring overlaps the next row and is cut off by `overflow`. Same colour and width; cards and buttons keep the outer offset. A focused row also takes the hover tint.

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

| Tier                | Means                                                        | Renders as                         |
| ------------------- | ------------------------------------------------------------ | ---------------------------------- |
| **Activity**        | Something happened here                                      | Bold label only — no dot, no badge |
| **Directed at you** | A mention, a permission prompt, a reply that needs an answer | Bold, plus a numbered `CountPill`  |

Rules that come with it:

- **Numbers are for you, not for volume.** A busy channel nobody addressed you in stays at a bold label however many messages it holds.
- **Activity draws no mark of its own** (decided 2026-08-09, `specs/sidebar-now-today-library/design-decisions.md` §18). It used to add a dot. A dot is a third weight in a system that deliberately has two, and the avatar corner already owns dots for agent lifecycle — two dot vocabularies on one row is the confusion this removes.
- **A directed count is orange.** `CountPill` (`shared/ui/count-pill.tsx`) defaults to `tone="you"`, the orange ink on its own wash (`bg-brand/15 text-brand-text`), because orange means you. Its label reads the real figure where one exists. In the sidebar it counts @mentions of you in a channel, and every new message in a direct message, both counted by the server from the room log above your read cursor.
- **Caps are honest.** Mentions cap at `9+` (`MENTION_COUNT_CAP`): the server stops counting at `ROOM_MENTION_COUNT_CAP` (10), so its `10` means "10 or more" and anything higher would be a claim nobody measured. A DM's messages are counted in full and cap at `99+`. `directedCountCap(kind)` and `directedCountLabel(count, kind)` pick the cap and the words together. A corner count caps at `9+`.
- **Mute keeps a mention's count, and only that.** A muted row loses its bold, but an @mention of you still shows its number. This holds for a muted direct message too: it counts real @mentions only, never every message. Mute means "stop pulling at me", so a DM that kept counting every message through mute would make mute a lie. Do not "fix" it.
- **A collapsed container keeps its signal, as rows.** A folded section keeps its unread rows on screen under the header, drawn as they are when open. A section header never carries a count; its one mark is a working dot.
- **Only "happening right now" pulses.** An agent mid-turn pulses (see [Identity](#identity)); an unread count does not. A count also never flips or crossfades when its number changes: tabular figures keep the width, and the number is the news. `animate-count-flip` belongs to `ThreadReplyRow` alone, and the design-token check refuses it anywhere else.

### Badge, count and chip

Three primitives, one shape (full radius) and one tint (7% of the foreground). The playground shows every state: `/dev` Components → Badge, Count pill, Chip, Mention pill.

| Primitive       | Is                                                           | Element                   | File                           |
| --------------- | ------------------------------------------------------------ | ------------------------- | ------------------------------ |
| `Badge`         | An inert label: a state, a category, a fact                  | `<span>`                  | `shared/ui/badge.tsx`          |
| `CountPill`     | A number, and who it is for                                  | `<span>`                  | `shared/ui/count-pill.tsx`     |
| `Chip`          | A pill you can press: a toggle, an action, a popover trigger | `<button>`, ref forwarded | `shared/ui/chip.tsx`           |
| `RemovableChip` | A pill you dismiss: an active filter, a tag                  | `<span>` + × `<button>`   | `shared/ui/removable-chip.tsx` |

**Badge.** `tone` is `neutral | warning | error | success | info` (`info` draws neutral: blue is not a resting state). `size` is `sm` (12px, 20px high) or `xs` (11px, 18px). No border, no shadow, `font-medium tabular-nums`. **Colour goes on the glyph, never the word:** `warning` brings `TriangleAlert` in `text-status-warning-fg`, `error` brings `CircleX`, `success` a `Check`, and the word stays on the neutral tint at full strength. A coloured word fails AA on the tint (amber 4.28:1 on the sidebar, red 4.13:1 on a dark selected row); the glyphs clear 3:1 everywhere. `icon` overrides the glyph and `icon={null}` removes it. `live` draws the pulsing working dot. A badge is never a target: one that links or toggles is a `Chip`. `variant` and `shape` are deprecated aliases (`destructive` resolves to `error`) until the codemod removes them.

**CountPill.** `tone` says who the count is for:

| Tone            | Means                                   | Inline wash                                   | Solid                                  |
| --------------- | --------------------------------------- | --------------------------------------------- | -------------------------------------- |
| `you` (default) | Somebody wrote to you: a mention, a DM  | `bg-brand/15 text-brand-text`                 | `bg-brand-text text-background`        |
| `warning`       | Something stopped and waits on a person | `bg-status-warning-bg text-status-warning-fg` | `bg-status-warning-fg text-background` |
| `error`         | Something failed                        | `bg-status-error-bg text-status-error-fg`     | `bg-status-error-fg text-background`   |
| `neutral`       | Activity you asked to see               | `bg-foreground/10 text-foreground`            | `bg-foreground text-background`        |

`placement="inline"` is 18px (22 on a phone) in `text-2xs` semibold and caps at `99+`; `placement="corner"` is 16px (20) in `text-3xs`, always solid, absolutely placed on a `relative` parent, and caps at `9+`. Use `solid` inline where the wash cannot clear the ground: the `you` wash is 4.04:1 on a dark modal hover row, solid is 7.90:1, so the command palette counts solid. `count <= 0` draws nothing. Omit `label` when the parent's own accessible name already says the number, and the pill hides itself from assistive tech, so the count is read once. A count is a glyph, so it may have a coloured ground; a badge may not.

**Chip.** Rests on `bg-foreground/7 text-muted-foreground`, hovers to `/11` and full-strength text in 150ms, presses at `0.98` (80ms in, 120ms out, `motion-safe` only), focuses with `focus-ring`. `pressed` sets `aria-pressed` and **inverts** to `bg-foreground text-background`: 7% against 11% is about 1.1:1, so a tinted selection would be colour-only. `sm` is 24px on a desktop and 40 on a phone with a 44px hit area; `md` is 32 and 44. Long text truncates at `max-w-56`; put the full text in `title`. Neighbours sit `gap-1 max-md:gap-2`.

**RemovableChip.** The body is inert; only the × is a button, 24×24 on a desktop and 44×40 (44 hit) on a phone, and `removeLabel` names the thing removed. Wrap a row of them in `data-chip-group`: removing one moves focus to the next chip, else the previous, else the nearest `data-chip-group-add` control. Never to `<body>`. Nothing animates out.

**Mention pill.** Stays `inline` so it wraps with `box-decoration-break`, and is exempt from target sizes. A person is `bg-foreground/7 text-foreground` (the old `bg-secondary` vanished on the sidebar); an agent keeps its identity tint; a **cc** is the same tint in the muted grey at regular weight, with the visible word `cc` before the name, so it is never told apart by shade alone.

**Guards** (`pnpm check:design-tokens`): `local-count-cap` (no `DISPLAY_CAP` or `MAX_COUNT`; caps live in `count-pill.tsx`), `hand-rolled-count` (`tabular-nums` and `rounded-full` on one line outside `count-pill.tsx`, `badge.tsx` and `TouchChip`'s string), and `count-flip`. All three are hard fails.

### 3-State Status Pattern

Status indicators that depend on both per-entity configuration and global feature flags use a 3-state model driven by `useAgentToolStatus()`:

| State                | Visual                                 | Meaning                                 |
| -------------------- | -------------------------------------- | --------------------------------------- |
| `enabled`            | Full color, normal opacity             | Feature is active for this agent        |
| `disabled-by-agent`  | Muted/dimmed appearance (`opacity-50`) | Agent manifest has explicitly opted out |
| `disabled-by-server` | Hidden (not rendered)                  | Feature is disabled server-wide         |

### Permission Override Pattern (`PermissionsPage`, `PermissionsTab`)

The per-agent `enabledToolGroups` toggle this section used to describe is retired (spec `agent-permissions` D13); the reusable pattern lives on now as how the agent Permissions page (`apps/client/src/layers/features/profile/ui/pages/PermissionsPage.tsx`) and Settings → Permissions (`apps/client/src/layers/features/settings/ui/tabs/PermissionsTab.tsx`) display each area or action:

| State                                               | Visual                                              | Meaning                                                 |
| --------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| Same as everyone                                    | "Same as everyone (Allowed)" label, no dot          | Agent inherits the install-wide default for this area   |
| Set differently                                     | A dot beside the row, a **Reset to default** button | Agent has its own state for this area, set on this page |
| Floor (Safety limits, Permissions, Reach & secrets) | Lock icon, Blocked/Ask only                         | The area can never resolve to Allowed at any layer      |

Reading it back is three states resolved by one function (`resolvePermission`) rather than a boolean per toggle: Blocked, Ask, or Allowed, each carrying WHERE it came from (`source`: agent, default, preset, or floor) so the row can say "Same as everyone" versus "set here." This pattern — one dial with a resolved value and a labelled source, reset by clearing the override rather than flipping a switch — is reusable for any per-entity override of a global setting; it is not specific to permissions.

---

## Accessibility

- All interactive elements keyboard-accessible
- Focus indicators meet 3:1 contrast ratio (WCAG 2.1 AA). The ring colour clears it only at full strength, so never draw it at part opacity (`ring-ring/50` measured 1.9:1 light, 2.5:1 dark). Shared form controls take theirs from `packages/ui/src/focus-ring.ts`, and `apps/design-system/tests/focus-rings.spec.ts` measures them painted (a local run, not in CI yet: `pnpm --filter @dorkos/design-system test:browser`)
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
| Button xs                | 24px    | 44px           |
| Button sm                | 32px    | 44px           |
| Button md                | 36px    | 44px           |
| Button lg                | 40px    | 48px           |
| Button icon-xs           | 24px    | 44px           |
| Button icon-sm           | 32px    | 44px           |
| Button icon-md           | 36px    | 44px           |
| Button icon-lg           | 40px    | 48px           |

### Button

| Variant       | Use                               | Rest                     | Hover         |
| ------------- | --------------------------------- | ------------------------ | ------------- |
| `primary`     | The one main action in a view     | Solid foreground         | 90%           |
| `secondary`   | Every other labelled action       | 7% foreground            | 11%           |
| `ghost`       | Toolbars, rows, icon buttons      | Transparent              | 7% foreground |
| `destructive` | Can't be undone                   | The fill token           | The hover one |
| `link`        | Inline, in running text           | Underline at 35%         | Full          |
| `brand`       | The site and Cloud marketing only | Orange, near-black label | 90%           |

`default` and `outline` are deprecated aliases of `primary` and `secondary`, kept until Cloud has moved. `data-variant` always reports the new name.

- **Secondary is a tint, not a grey.** A fixed grey vanishes on the sidebar, and a tint reads on every ground. `aria-pressed` and `data-state=on` hold the 11% step on `secondary` and `ghost`.
- **One focus ring:** a 2px solid outline, 2px out, on every variant. The gap is transparent, so it works on any ground, and an outline survives forced-colours mode. Don't add `outline-none` beside it: in Tailwind v4 that stops the ring drawing at all.
- **Disabled:** 50%, no pointer events. Pass `disabledReason="Connect Telegram first"` whenever a reason exists: the button stays focusable and shows it in a tooltip. A greyed button with no reason is a locked door with no sign.
- **Loading:** `loading` and `loadingLabel` come together, as a gerund (Save, "Saving…"). No spinner. Focus stays put and the width doesn't move, because both labels share one grid cell.
- **`responsive={false}`** keeps the small box and adds an invisible 44px hit area below `md`.

### Icon Size Convention

Three standard sizes, use `size-(--size-icon-*)` for all icon sizing:

| Token     | Desktop | Mobile | Use Case                                                 |
| --------- | ------- | ------ | -------------------------------------------------------- |
| `icon-xs` | 12px    | 15px   | Decorative, status indicators, inline affordances        |
| `icon-sm` | 16px    | 20px   | Interactive icons in compact UI (sidebar, tool cards)    |
| `icon-md` | 20px    | 25px   | Primary action icons (buttons, navigation, prominent UI) |

Usage:

```tsx
<Check className="size-(--size-icon-xs) text-status-success" />
<FolderOpen className="size-(--size-icon-sm) text-muted-foreground" />
<PanelLeft className="size-(--size-icon-md)" />
```

**Parentheses, not brackets.** `size-(--size-icon-sm)` is Tailwind v4's syntax for "this arbitrary value is a custom property". The v3 spelling `size-[--size-icon-sm]` compiles to `width: --size-icon-sm`, which is not valid CSS — the browser drops it and the icon falls back to its intrinsic 24px. Two files shipped that way until DOR-1750; if an icon looks too big, check the brackets first.

The shared `Button` applies its namespaced `--dui-size-icon-sm` to any `<svg>` a caller hands it unsized, so most icons inside a button need no class at all. Client-owned icon examples above keep the local token names. Every size uses it except the compact `xs` and `icon-xs`, which use `--dui-size-icon-xs`, so their glyphs step from 12px to 15px on a phone with the rest of the icon scale.

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
- 17px labels (iOS body) and 13px descriptions (iOS footnote), scaled by `--user-font-scale` only: a `text-*` token would add the phone's 1.25x a second time
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

Sizes come from the system, not by hand: `Button` is already `responsive` by default (`size="sm"` → `h-11 md:h-8`), rows use `min-h-11` / `min-h-[44px]`, and `--_st` already scales every text token 1.25× below 768px — so writing `text-base md:text-sm` double-scales. When a control has to stay visually small, grow the target rather than the glyph with `after:absolute after:-inset-3 md:after:hidden`, the way `SidebarGroupAction` does.

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

`Table` wraps the `<table>` in a `relative w-full overflow-auto` container for horizontal scroll. `TableRow` has a hover highlight (`hover:bg-accent`, the app's own "you are pointing at this" token) and a `data-[state=selected]:bg-muted` highlight for selection.

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
| Chat list                | `apps/client/src/layers/features/chat-list/`                     |
| App state                | `apps/client/src/layers/shared/model/app-store/app-store.ts`     |
| Chat state               | `apps/client/src/layers/features/chat/model/use-chat-session.ts` |
| Filter engine            | `apps/client/src/layers/shared/lib/filter-engine.ts`             |
| Filter state hook        | `apps/client/src/layers/shared/model/use-filter-state.ts`        |
| FilterBar UI             | `apps/client/src/layers/shared/ui/filter-bar/`                   |
