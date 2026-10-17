---
name: designing-frontend
description: Guides design thinking and decision-making for DorkOS UI, pointing at contributing/design-system.md for the rules. Use when planning UI, reviewing designs, or making design decisions. For implementation details, see styling-with-tailwind-shadcn.
license: Complete terms in LICENSE.txt
---

# Frontend Design: Thinking Through a Screen

This skill guides **design thinking** and decision-making for frontend interfaces: the questions to ask, in order, before you build. It focuses on the **what** and **why**, not the implementation.

**For implementation (how to code it)**: Use the `styling-with-tailwind-shadcn` skill.

## Where the rules live

**`contributing/design-system.md` is the source of truth for every design rule** — principles, colour, type, spacing, motion, surfaces and states. This skill does not restate those rules; it points at them. If this skill and the design system ever disagree, the design system wins, and this skill is the one to fix.

A DorkOS style guide is being written. When it lands, it becomes the top source, above the design system, and this skill will point there first.

Read these sections of the design system before you design anything:

| Section                                                            | What it settles                                                                                 |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| **Design Philosophy**, **What We Optimize For**, **Anti-Patterns** | Honesty of materials, no fake depth, calm over stimulation, no bounces                          |
| **Color** and **Brand Accent**                                     | 0%-saturation neutrals, never pure black or white, where orange may appear                      |
| **Typography → Scale**                                             | The type scale. Use its tokens, never a literal size: tokens carry the user's font-size setting |
| **Spacing → Two Spatial Modes**                                    | Content surfaces read, control surfaces operate; the numbers for each                           |
| **Motion**                                                         | Durations, curves, springs, and what never animates                                             |
| **Separation by tint, not by borders**                             | Whitespace, then tint, then a scroll-edge shadow; the sidebar's one tint ramp                   |
| **Interaction States**                                             | Hover, focus, press, disabled, loading, and the two unread tiers                                |
| **Accessibility**                                                  | Contrast, focus rings, reduced motion                                                           |

### Two spatial modes: the test

The numbers are in the design system. The judgement is here.

**The test:** does the user _operate_ this surface many times an hour, or _read_ it? Operating wants density; reading wants air. Sidebars, toolbars, list panes, menus and table rows are control surfaces. Pages, cards, empty states and reading views are content surfaces.

Density is not noise — a compact nav fits about 1.5x more items in the same space and reads calmer, because the eye travels less. The failure this rule prevents is real: "generous space" read without the nuance produced a sidebar with a 30px left inset (12px container + 8px section + 10px row). **Budget the inset once. Never stack container + section + row padding.**

### Separation and chrome: the order to try

1. **Whitespace** — a gap is the cheapest separator
2. **Background tint** — a 5–10% step (in the sidebar, the `--sidebar-accent` ramp; never `--muted` there)
3. **Elevation** — scarce, only for things that genuinely float (popovers, drag previews)

A hairline is the last resort, not the first. Where a header needs to detach from scrolled content, use a **scroll-edge shadow** that appears only once content scrolls under it.

**Nothing renders at rest.** Row and section actions (`+`, kebab, drag handles) are invisible until hover or focus-visible. Each one owes two twins:

- **A keyboard path** — `focus-visible` reveals the same action a pointer reveals.
- **A touch path** — visible on touch pointers, or reachable by long-press / context menu. For anything draggable, WCAG 2.2 §2.5.7 requires a non-drag alternative.

## Design Thinking Process

Before writing any code, work through these questions:

### 1. Purpose

- What problem does this interface solve?
- Who is the user? What's their context? Default to the founder (`meta/personas/the-ai-native-founder.md`): semi-technical, running a business mostly with agents, who must never be scared off. Kai (`meta/personas/the-autonomous-builder.md`), the developer running many agents, is second and wants density with calm.
- Where do agents sit? DorkOS is a workspace for people and agents, and agents are co-workers: they get a name, an avatar and a profile beside people, not the chrome of a tool or a chatbot assistant.
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

Use the scale in `contributing/design-system.md` → Typography → Scale, and its weights (400, 500, 600). Never invent a size: a literal like `text-[13px]` ignores the mobile scale and the user's font-size setting.

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
- **Unread is two-tier.** A bold label alone means _there is activity here_ — no dot, no badge. A numbered badge is reserved for _this is directed at you_ — a mention, a permission prompt, a needs-you. Numbering everything spends the scarce signal. The rule and its reasons: `contributing/design-system.md` → Unread — Two Tiers.

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

**One well-orchestrated moment beats many scattered interactions.** Motion explains where something came from, where it went, or that your input registered. If it does none of those, cut it. Calm over stimulation: no bounces, no loops that run forever, no decoration that moves.

Spend motion on:

1. **Page and panel entry** — orientation: where did this come from?
2. **Modal/dialog** — the focus moved, and why
3. **State changes** — something finished, failed or needs you. Confirm it plainly; never cheer (see the `writing-app-copy` skill)

The durations, curves and springs are in `contributing/design-system.md` → Motion; the implementation patterns are in `contributing/animations.md`.

### Accessibility

Always respect `prefers-reduced-motion`: movement becomes instant, and loops and decorative effects stop entirely. Motion's global setting does not stop opacity, colour or infinite loops, so a loop needs its own reduced-motion path. The mechanics: `contributing/design-system.md` → Accessibility and Identity → The interaction grammar.

## Design Review Checklist

Before implementation, verify:

- [ ] **Purpose is clear** — User knows what to do
- [ ] **Spatial mode is right** — Content surface or control surface, spaced accordingly
- [ ] **Hierarchy is established** — Eye path is intentional
- [ ] **Typography is consistent** — Using the design system's type tokens, no literal sizes
- [ ] **Colors are semantic** — Not hardcoded, using design tokens
- [ ] **Spacing is systematic** — Using spacing scale; inset paid once, not stacked
- [ ] **Separation is earned** — Gap or tint before a border
- [ ] **Edge cases are designed** — Empty, error, loading states
- [ ] **Accessibility is considered** — Contrast, focus states, screen readers
- [ ] **Hover-only affordances have twins** — A keyboard path and a touch path
- [ ] **Animation is intentional** — Explains a change, never decorates; has a reduced-motion path

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

- `contributing/design-system.md` — The source of truth for every design rule
- `styling-with-tailwind-shadcn` skill — Implementation patterns
- `contributing/styling-theming.md` — Styling patterns
- `contributing/animations.md` — Animation patterns
- `research/20260809_design-meta-2026-learnings.md` — The 2026 design meta these rules are drawn from
