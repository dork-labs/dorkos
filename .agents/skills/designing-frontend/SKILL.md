---
name: designing-frontend
description: Guides design thinking and decision-making using the Calm Tech design language. Use when planning UI, reviewing designs, or making design decisions. For implementation details, see styling-with-tailwind-shadcn.
license: Complete terms in LICENSE.txt
---

# Frontend Design: Calm Tech Design Language

This skill guides **design thinking** and decision-making for frontend interfaces. It focuses on the **what** and **why** of design, not the implementation details.

**For implementation (how to code it)**: Use the `styling-with-tailwind-shadcn` skill.

## Design Philosophy: Calm Tech

Our design system embraces **"Calm Tech"** — interfaces that feel sophisticated, spacious, and effortless.

### Core Principles

1. **Clarity over decoration** — Every element earns its place
2. **Soft depth over flat** — Subtle shadows and layers create hierarchy without noise
3. **Generous space _on content surfaces_** — Breathing room makes content shine; control surfaces run dense (see below)
4. **Micro-delight** — Thoughtful animations that feel tactile and responsive

### Two Spatial Modes

"Generous space" is a **content** rule. Control surfaces follow density instead.

|             | Content surface                           | Control surface                                   |
| ----------- | ----------------------------------------- | ------------------------------------------------- |
| Examples    | Pages, cards, empty states, reading views | Sidebars, toolbars, list panes, menus, table rows |
| Body text   | 15–16px                                   | 13px, metadata 11px                               |
| Row height  | —                                         | 28–32px (4px-grid multiples)                      |
| Inset       | 16–24px and up                            | **16px total**, panel edge to first glyph         |
| Panel width | —                                         | 240–280px for nav sidebars                        |

**The test:** does the user _operate_ this surface many times an hour, or _read_ it? Operating wants density; reading wants air.

Density is not noise — a compact nav fits about 1.5x more items in the same space and reads calmer, because the eye travels less. The failure this rule prevents is real: "generous space" read without the nuance produced a sidebar with a 30px left inset (12px container + 8px section + 10px row). **Budget the inset once. Never stack container + section + row padding.**

### Design Rules

| Rule                        | Reasoning                                                                       |
| --------------------------- | ------------------------------------------------------------------------------- |
| **No pure black or white**  | Rich, tinted neutrals feel warmer and more sophisticated                        |
| **Desaturated accents**     | Vibrant but not harsh — easier on the eyes                                      |
| **WCAG AA contrast**        | Accessibility is non-negotiable (4.5:1 text, 3:1 large text)                    |
| **Generous radius**         | Soft corners feel friendly and modern                                           |
| **Soft shadows**            | Diffused shadows create depth without visual noise                              |
| **Tint, not lines**         | Whitespace separates, tint groups, elevation floats — hairline rules read dated |
| **Nothing renders at rest** | Row and section actions appear on hover and focus; idle chrome is noise         |

#### Tint, not lines

Separate two regions with, in order of preference:

1. **Whitespace** — a gap is the cheapest separator
2. **Background tint** — a 5–10% shift (a zone rendered on `muted/40`)
3. **Elevation** — scarce, only for things that genuinely float (popovers, drag previews)

No `border-b` under a panel header, no `border-t` above a footer. Where a header needs to detach from scrolled content, use a **scroll-edge shadow** that appears only once content scrolls under it. Hover uses the same 5–10% tint step, so grouping and hover share one mechanism.

#### Nothing renders at rest

Row and section actions (`+`, kebab, drag handles) are invisible until hover or focus-visible. Two obligations come with that:

- **A keyboard path** — `focus-visible` reveals the same action a pointer reveals.
- **A touch path** — visible on touch pointers, or reachable by long-press / context menu. For anything draggable, WCAG 2.2 §2.5.7 requires a non-drag alternative.

Keep reserved gutters minimal; a vertical kebab (⋮) needs less width than a horizontal one (⋯).

## Design Thinking Process

Before writing any code, work through these questions:

### 1. Purpose

- What problem does this interface solve?
- Who is the user? What's their context?
- What action do we want them to take?

### 2. Hierarchy

- What's the most important element? (Primary action, key information)
- What's secondary? (Supporting details, alternative actions)
- What can be de-emphasized? (Metadata, less-used options)

### 3. Flow

- How does the user move through this interface?
- What's the natural reading order? (F-pattern, Z-pattern)
- Where should the eye land first?

### 4. Constraints

- Performance requirements (bundle size, render time)
- Accessibility requirements (screen readers, keyboard nav)
- Responsive requirements (mobile-first? desktop-first?)

### 5. Edge Cases

- Empty states (no data)
- Error states (something went wrong)
- Loading states (waiting for data)
- Overflow states (too much content)

## Visual Hierarchy Tools

### Typography Hierarchy

| Role           | Purpose                     |
| -------------- | --------------------------- |
| Display (48px) | Hero moments, landing pages |
| H1 (36px)      | Page titles — one per page  |
| H2 (30px)      | Major sections              |
| H3 (24px)      | Subsections, card titles    |
| Body (15px)    | Primary content             |
| Small (13px)   | Secondary content, captions |
| XS (11px)      | Metadata, labels            |

**Typography decisions:**

- Is this heading the right level for its importance?
- Does the weight reflect the hierarchy? (Bold for important, regular for body)
- Is there enough contrast between levels?

### Color Hierarchy

| Usage               | Color Role                                 |
| ------------------- | ------------------------------------------ |
| Primary actions     | `primary` — most prominent                 |
| Secondary actions   | `secondary` — less prominent               |
| Destructive actions | `destructive` — draws attention as warning |
| Supporting text     | `muted-foreground` — de-emphasized         |
| Backgrounds         | `background`, `card` — establish surfaces  |

**Color decisions:**

- Is the primary action clearly the most prominent?
- Are destructive actions appropriately cautioned?
- Is there enough contrast for readability?

### Spatial Hierarchy

| Relationship    | Spacing                               |
| --------------- | ------------------------------------- |
| Tightly related | 4-8px — elements that belong together |
| Related         | 16px — elements in the same group     |
| Separated       | 24-32px — distinct groups             |
| Major sections  | 48-64px — page-level divisions        |

This ladder is for **content** surfaces. On a control surface, the whole budget is 16px of inset and a 4px rhythm inside the row.

**Spacing decisions:**

- Are related elements grouped together?
- Is there enough breathing room — or, on a control surface, is the inset paid exactly once?
- Does spacing communicate relationships?

## Component Design Decisions

When designing a component, consider:

### Cards

- **When to use**: Grouping related content, creating distinct visual units
- **When not to use**: When content is part of a larger flow
- **Key decision**: Does this content deserve its own visual container?

### Buttons

- **Primary**: One per visible context — the main action
- **Secondary**: Supporting actions — less prominent
- **Ghost/Link**: Navigation, tertiary actions
- **Key decision**: What's the hierarchy of actions?

### Forms

- **Layout**: Vertical for mobile/simple forms, grid for complex forms
- **Grouping**: Related fields together (name, email → contact info)
- **Key decision**: What's the minimum required input?

### Tables

- **When to use**: Structured data comparison, many rows
- **When not to use**: Simple lists, mobile-first contexts
- **Key decision**: Is table format the clearest way to present this?

### Lists and Navigation

- **One row grammar for mixed types** — fixed leading-glyph slot + label + trailing meta/badge slot + hover kebab. The glyph carries the type (avatar = agent or person, `#` = channel); the row chrome never changes between types. Attribution lives in the label (`Agent › thing`) — never show a session without whose it is.
- **One glyph, two jobs** — overload existing chrome before adding chrome. A section header's identity icon _becomes_ its collapse chevron on hover. A collapsed section keeps its signal: unread and activity counts roll up onto the collapsed row.
- **Prediction is additive, never a reorder** — recency and frequency may rank a _dedicated_ layer (Today, Jump back in). Manual structure — pins, groups, channel order — stays exactly where the user put it, and manual overrides are stored separately, never silently discarded. Auto-reordering navigation breaks spatial memory and erodes trust.
- **Chrome appears when the data earns it** — grouping UI at roughly 8+ items or 2+ runtimes; below that it does not render. Never a settings toggle for "advanced mode".
- **Empty is not empty-looking** — a section with nothing to say disappears rather than rendering an empty box. Absence is the calm signal.
- **Personal scope floats above structure** — "where am I needed?" (mentions, permission prompts, wedged sessions) sits above all browsing structure, badge-counted, never collapsible into oblivion.

## Agent Status Vocabulary

Agent state is not human presence. Borrowing presence design — a green dot, a "typing…" line — makes a fleet look like a chat roster and hides the thing an operator actually needs: what is happening, and whether it is stuck.

- **Agent "working" is not human "typing".** Different facts; they never share a UI slot.
- **Parallel activity aggregates.** Ten working agents are one calm line — "10 agents working" — not ten pulsing rows.
- **Status is composed:** process state × heartbeat × activity. "Running but silent past a grace period" reads as _starting_ or _wedged_ (a warning), never _offline_.
- **Only "working" pulses.** Idle, done and error are static. A pulse means _right now_; if everything pulses, nothing does.
- **Live activity verbs are the best glanceable signal** a fleet UI can show — "reviewing PR…" beats a status word.
- **Unread is two-tier.** Bold label + dot means _there is activity here_. A numbered badge is reserved for _this is directed at you_ — a mention, a permission prompt, a needs-you. Numbering everything spends the scarce signal.

Tokens and recipes: `styling-with-tailwind-shadcn` → Control Surfaces. The identity disc's `working` pulse is specified in `contributing/design-system.md` → Identity.

## Animation Design Decisions

### When to Animate

| Scenario                     | Should Animate?             |
| ---------------------------- | --------------------------- |
| State changes (hover, focus) | Yes — feedback              |
| Content appearing            | Yes — orientation           |
| Loading states               | Yes — perceived performance |
| Every interaction            | No — restraint              |
| Decorative motion            | Rarely — must add value     |

### Animation Philosophy

**One well-orchestrated moment beats many scattered interactions.**

Focus animation budget on:

1. **Page entry** — First impression, establish brand
2. **Modal/dialog** — Focus transition, importance signal
3. **Success states** — Celebration, confirmation
4. **Error states** — Attention, importance signal

### Accessibility

Always respect `prefers-reduced-motion`. Users who enable this setting should see:

- Instant state changes (no transitions)
- No parallax or complex motion
- Essential animations only (loading spinners)

## Design Review Checklist

Before implementation, verify:

- [ ] **Purpose is clear** — User knows what to do
- [ ] **Spatial mode is right** — Content surface or control surface, spaced accordingly
- [ ] **Hierarchy is established** — Eye path is intentional
- [ ] **Typography is consistent** — Using type scale correctly
- [ ] **Colors are semantic** — Not hardcoded, using design tokens
- [ ] **Spacing is systematic** — Using spacing scale; inset paid once, not stacked
- [ ] **Separation is earned** — Gap or tint before a border
- [ ] **Edge cases are designed** — Empty, error, loading states
- [ ] **Accessibility is considered** — Contrast, focus states, screen readers
- [ ] **Hover-only affordances have twins** — A keyboard path and a touch path
- [ ] **Animation is intentional** — Adding value, not decoration

## What NOT to Do

- **Over-design** — Every element should earn its place
- **Inconsistent patterns** — Reuse existing patterns first
- **Stack padding** — Container + section + row insets compound into a gutter nobody chose
- **Draw a line where a gap would do** — A border is the last separator, not the first
- **Skip edge cases** — Design for empty/error/loading states
- **Ignore hierarchy** — Every element needs a clear level
- **Reorder the user's structure** — Prediction adds a layer; it never rearranges one
- **Animate everything** — Restraint is sophistication
- **Forget accessibility** — It's not optional

## References

- `contributing/design-system.md` — Full design specifications
- `styling-with-tailwind-shadcn` skill — Implementation patterns
- `contributing/styling-theming.md` — Styling patterns
- `contributing/animations.md` — Animation patterns
- `research/20260809_design-meta-2026-learnings.md` — The 2026 design meta these rules are drawn from
