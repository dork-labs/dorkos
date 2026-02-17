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
3. **Generous space** — Breathing room makes content shine
4. **Micro-delight** — Thoughtful animations that feel tactile and responsive

### Design Rules

| Rule                       | Reasoning                                                    |
| -------------------------- | ------------------------------------------------------------ |
| **No pure black or white** | Rich, tinted neutrals feel warmer and more sophisticated     |
| **Desaturated accents**    | Vibrant but not harsh — easier on the eyes                   |
| **WCAG AA contrast**       | Accessibility is non-negotiable (4.5:1 text, 3:1 large text) |
| **Generous radius**        | Soft corners feel friendly and modern                        |
| **Soft shadows**           | Diffused shadows create depth without visual noise           |

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

**Spacing decisions:**

- Are related elements grouped together?
- Is there enough breathing room?
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
- [ ] **Hierarchy is established** — Eye path is intentional
- [ ] **Typography is consistent** — Using type scale correctly
- [ ] **Colors are semantic** — Not hardcoded, using design tokens
- [ ] **Spacing is systematic** — Using spacing scale
- [ ] **Edge cases are designed** — Empty, error, loading states
- [ ] **Accessibility is considered** — Contrast, focus states, screen readers
- [ ] **Animation is intentional** — Adding value, not decoration

## What NOT to Do

- **Over-design** — Every element should earn its place
- **Inconsistent patterns** — Reuse existing patterns first
- **Skip edge cases** — Design for empty/error/loading states
- **Ignore hierarchy** — Every element needs a clear level
- **Animate everything** — Restraint is sophistication
- **Forget accessibility** — It's not optional

## References

- `contributing/design-system.md` — Full design specifications
- `styling-with-tailwind-shadcn` skill — Implementation patterns
- `contributing/styling-theming.md` — Styling patterns
- `contributing/animations.md` — Animation patterns
