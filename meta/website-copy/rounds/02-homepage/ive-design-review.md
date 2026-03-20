# Design Review: Applying Round 2 Copy to the Existing Site

**Reviewer:** Jony Ive (design agent)
**Date:** 2026-02-27
**Scope:** How to integrate the Round 2 synthesis copy into the current DorkOS marketing site while preserving the established design system.

---

## 1. What to Keep Exactly As-Is

These elements are strong. They work. They should not be touched.

### The Cream Palette

The warm cream foundation (`#F5F0E6`, `#EDE6D6`, `#E5DCC8`, `#FFFEFB`) is the single most distinctive visual choice on the site. It separates DorkOS from every dark-mode-by-default developer tool. It communicates warmth, approachability, and confidence. The palette says: we are not trying to look like a terminal. We are a tool built by someone who cares about how things feel, not just how they function.

This must stay. Every shade. Every warm border (`rgba(139, 90, 43, 0.1)`). The cream is the brand.

### IBM Plex Sans + IBM Plex Mono

The typographic pairing is correct. IBM Plex has the right heritage -- it carries the weight of systems thinking without the coldness of geometric sans-serifs. The mono variant is legible at small sizes, which matters because the site uses 9px, 10px, and 11px monospaced text extensively for labels, badges, and status indicators. The `marketing-btn` utility (11px mono, 0.08em tracking, uppercase) is a particularly considered detail. Keep it.

### The Graph Paper Texture

The subtle grid background in the hero (`rgba(139, 90, 43, 0.05)` at 32px intervals with gradient mask) is a quiet, beautiful detail. It communicates "substrate" -- a surface designed to hold systems. It does this without being decorative or heavy. The mask that fades it at the edges is particularly well done.

### The Activity Feed

The `ActivityFeedPanel` is a piece of engineering-as-design. The live-updating entries with spring-physics layout animations, the colored module dots, the badge system, the gradient masks at top and bottom, the green "Live" indicator with ping animation -- this is the strongest single element on the current site. It makes the product tangible before the user has read a word.

The feed must stay. Its position and prominence may shift, but the component itself is a keeper.

### The Retro Brand Stripes

The orange-green footer stripes are a one-second detail that carries enormous brand weight. They are playful without being juvenile. They reference vintage computing aesthetics without cosplaying. Keep them.

### The Floating Bottom Nav

The pill-shaped bottom navigation is unusual for a marketing site and that is precisely why it works. It stays out of the way, it is functionally minimal, and the scroll-to-top arrow that expands on scroll is a nice motion detail. Keep it.

### Motion Variants

The `SPRING` config (stiffness 100, damping 20), the `REVEAL` (opacity + 20px y-translate), the `STAGGER` (80ms children) -- these are well-tuned. Overdamped springs feel deliberate and controlled. The `VIEWPORT` trigger (once, 20% visible) is correct. The `DRAW_PATH` variant for SVG connections is elegant. The entire `motion-variants.ts` file should be preserved as the animation foundation.

### The Charcoal Footer

Dark footer (`bg-charcoal`) against cream body creates a natural grounding. The colophon-style layout (logo, byline, social, email, version string) is appropriately minimal.

---

## 2. What to Adapt

This is the core of the review: how each section of new copy maps to the existing component structure.

### Current Site Structure (10 components)

```
MarketingHeader
ActivityFeedHero
CredibilityBar
SystemArchitecture
UseCasesGrid
HowItWorksSection
HonestySection
AboutSection
ContactSection
MarketingFooter
MarketingNav
```

### New Copy Structure (9 sections)

```
Section 0: Prelude
Section 1: Hero (The Problem)
Section 2: Villain (Recognition)
Section 3: Pivot
Section 4: Timeline Narrative
Section 5: Module Reference
Section 6: Install Moment
Section 7: Identity Close
Section 8: The Close + Footer
```

### The Mapping

| New Copy Section    | Existing Component                           | Action                                    |
| ------------------- | -------------------------------------------- | ----------------------------------------- |
| Section 0: Prelude  | _None_                                       | **New component**: `Prelude.tsx`          |
| Section 1: Hero     | `ActivityFeedHero`                           | **Major content rewrite**, keep feed      |
| Section 2: Villain  | _None_                                       | **New component**: `VillainSection.tsx`   |
| Section 3: Pivot    | _None_                                       | **New component**: `PivotSection.tsx`     |
| Section 4: Timeline | _None_ (replaces `UseCasesGrid` in function) | **New component**: `TimelineSection.tsx`  |
| Section 5: Modules  | `SystemArchitecture`                         | **Rewrite**: new layout, same data        |
| Section 6: Install  | `HowItWorksSection`                          | **Replace**: new content and layout       |
| Section 7: Identity | `AboutSection` + `HonestySection` (merged)   | **Replace**: new content                  |
| Section 8: Close    | `ContactSection`                             | **Replace**: new content                  |
| Footer              | `MarketingFooter`                            | **Minor update**: simplified layout       |
| --                  | `CredibilityBar`                             | **Remove** (absorbed into other sections) |
| --                  | `UseCasesGrid`                               | **Remove** (replaced by Timeline)         |

**Components to preserve unchanged:** `MarketingHeader`, `MarketingNav`, `MarketingFooter` (minor updates).

**Components to create new:** 4 (Prelude, VillainSection, PivotSection, TimelineSection).

**Components to significantly rewrite:** 4 (ActivityFeedHero, SystemArchitecture, HowItWorksSection, AboutSection).

**Components to remove:** 3 (CredibilityBar, UseCasesGrid, HonestySection -- their content is absorbed elsewhere).

---

## 3. What I Feel Strongly About Changing

### 3a. The Hero Needs a Two-Act Structure

The current hero is a competent split-panel layout: headline left, activity feed right. But the new copy demands something the current layout cannot deliver -- a **dramatic sequence**. The copy opens with a problem statement ("Your agents are brilliant. They just can't do anything when you leave.") and needs emotional space before the product answer appears.

**What I propose:** The hero becomes two visual zones stacked vertically.

**Zone 1 (above the fold):** Full-width. The headline, the tagline ("You slept. They shipped."), and the position line ("The operating system for autonomous AI agents."). Cream background. Graph paper texture. No activity feed yet. This is the problem statement, and it needs silence around it.

**Zone 2 (first scroll):** The activity feed appears here, full-width or offset, with the CTA buttons. This is the answer to the problem. "Here is what your agents could be doing." The transition from Zone 1 to Zone 2 is the scroll itself -- the user moves from the gap to the possibility.

This is the single largest structural change. The current `ActivityFeedHero` component would be split into `HeroSection` (headline + tagline) and a repositioned `ActivityFeedPanel` (below the fold, paired with CTAs). The `ActivityFeedPanel` itself stays intact.

**Why this matters:** The current layout tries to show problem and solution simultaneously. The new copy is written as a sequence -- setup, then payoff. The design must honor that rhythm.

### 3b. The Villain Section Needs Cards, Not Prose Blocks

The synthesis calls for four pain-point cards (Dead Terminal, Goldfish, Tab Graveyard, 3am Build). These need to feel like a diagnostic readout -- the system scanning for problems before proposing solutions.

**Design within the existing system:** Use `bg-cream-white` cards with `border-[var(--border-warm)]` borders (the same treatment as the current module cards in `SystemArchitecture`). Monospaced labels in `text-brand-orange`. Body in `text-warm-gray`. Staggered reveal with the existing `REVEAL` + `STAGGER` variants.

The cards should be single-column on mobile, two-column on desktop, max-width 720px. Each card has a thin left border in its accent color (orange for Dead Terminal, orange for Goldfish, etc.) -- similar to the `borderLeft` treatment on the newest feed item in `ActivityFeedPanel`.

### 3c. The Timeline Is the Centerpiece -- It Needs Proper Vertical Rhythm

The "A Night With DorkOS" timeline is the emotional core of the new copy. Six moments, each with a timestamp and narrative. This does not exist in any current component and must be built from scratch.

**Design within the existing system:**

- Background: `bg-cream-tertiary` (the slightly darker cream, currently used by `SystemArchitecture`)
- Timestamps: `font-mono text-2xs tracking-[0.12em]` in `text-warm-gray-light` -- they are reference points, not headlines
- Narrative: `text-warm-gray` at `text-base` with `leading-[1.7]`
- Module names inline: `font-mono text-brand-orange` -- they surface as actors, never introduced
- Vertical connector: A 1px line in `border-[var(--border-warm)]` connecting timestamps
- Each moment activates with the existing `REVEAL` variant on scroll

The cost detail ("$4.20 in API calls") should be rendered in monospaced type at reduced opacity -- like a line item on a receipt. This grounds the entire narrative.

### 3d. The Module Reference Should Be a Table, Not Cards

The current `SystemArchitecture` component uses a card grid with grouped categories (Platform, Composable Modules, Extensions) and an SVG architecture diagram. The new copy calls for a compact two-column table: gap on the left, module + description on the right.

**What I propose:** Remove the SVG diagram and card layout. Replace with a clean table component, max-width 720px. Rows separated by `border-[var(--border-warm)]` at very low opacity. Each row has a 6px status dot (using the existing `FeedDot` pattern from `ActivityFeedHero`) that transitions from `bg-warm-gray-light` to `bg-brand-orange` on scroll-enter.

The status badges ("Live", "Coming Soon") can be preserved from the current `ModuleCard` implementation.

This is a significant simplification, but the timeline has already done the work of making the modules feel real. The reference table is for the architect who wants the map -- it should be scannable, not explorable.

### 3e. The Install Moment Needs Gravity

The current `HowItWorksSection` is a three-step grid with terminal blocks and typing animations. Functional, but distributed. The new copy demands a single, gravitational moment: the install command, alone, with massive negative space.

**Design within the existing system:**

- Background: `bg-cream-secondary` (a step darker than primary, creating visual weight)
- The command: `font-mono text-2xl md:text-3xl text-charcoal` centered, with the dollar sign at `text-warm-gray-light/30`
- Blinking cursor: The existing `cursor-blink` utility in `text-brand-orange`
- Below: "Open source. Self-hosted. Yours." in `text-warm-gray text-base`
- Below that: "One person. Ten agents. Ship around the clock." in `text-warm-gray-light text-base`
- Vertical padding: `py-40` minimum. The space is the design.

The typing animation from `TerminalBlock` can be reused here for the install command on scroll-enter.

---

## 4. Section-by-Section Mapping

### Section 0: Prelude

**Component:** New -- `Prelude.tsx`
**Replaces:** Nothing (inserts before header)
**Content:** "DorkOS is starting." -- monospaced, center-screen, character-by-character
**Design within existing system:**

- Background: `bg-charcoal` (the darkest color in the current palette -- NOT the near-black from my Round 2 notes)
- Text: `font-mono text-base tracking-[0.02em]` in `text-cream-white`
- Animation: Character-by-character at 30ms intervals, then 1.2s hold, then opacity fade to 0 while the hero section's opacity fades to 1
- After completion: Header and nav fade in via the existing `REVEAL` variant
  **CSS changes:** None. All colors exist. May need a `z-50` overlay class.

### Section 1: Hero

**Component:** Rewritten `ActivityFeedHero.tsx` (or renamed to `HeroSection.tsx`)
**Replaces:** Current `ActivityFeedHero`
**Content:**

- Headline: "Your agents are brilliant. They just can't do anything when you leave."
- Tagline: "You slept. They shipped." (in mono, muted)
- Position: "The operating system for autonomous AI agents."
  **Design within existing system:**
- Background: `bg-cream-primary` with the graph paper texture (preserved exactly)
- Headline: Same style as current -- `font-bold text-charcoal tracking-[-0.04em]` with `clamp(32px, 5.5vw, 64px)`. Two sentences, the second at slightly reduced opacity (`text-charcoal/85`)
- Tagline: `font-mono text-lg tracking-[0.08em] text-brand-orange/70` -- treated as system output
- Position line: `text-warm-gray-light text-base`
- Eyebrow: Remove "Autonomous by default" -- the headline now does this work
- Activity feed: Moves below the fold. The `ActivityFeedPanel` component stays intact but is positioned after the hero, possibly in a new wrapper component, paired with CTAs
  **CSS changes:** Minimal. Remove the two-column grid. Go full-width centered. Increase vertical padding.

### Section 2: Villain

**Component:** New -- `VillainSection.tsx`
**Replaces:** Nothing (new section)
**Content:** Section header ("What your agents do when you leave. Nothing.") + four cards
**Design within existing system:**

- Background: `bg-cream-primary` (continuity with hero)
- Section header: `text-charcoal text-[28px] md:text-[32px] font-medium tracking-[-0.02em]` (same as current `SystemArchitecture` title style)
- "Nothing.": Same style, on its own line. Or potentially `font-mono text-brand-orange` for emphasis.
- Cards: `bg-cream-white rounded-lg p-6 border border-[var(--border-warm)]` (matches current `ModuleCard` styling)
- Card labels: `font-mono text-2xs tracking-[0.12em] uppercase text-brand-orange`
- Card body: `text-warm-gray text-sm leading-relaxed`
- Layout: Single column centered, max-width 640px
- Below cards: "You pay for the most powerful AI coding agent available. It only works when you are sitting in front of it." -- `text-warm-gray text-lg leading-[1.7]` centered
  **CSS changes:** None. All patterns exist.

### Section 3: Pivot

**Component:** New -- `PivotSection.tsx`
**Replaces:** Nothing (new section)
**Content:** "We solved this for applications fifty years ago..." + the build-up (cron, IPC, registries, filesystems) + "Your agents need the same thing."
**Design within existing system:**

- Background: `bg-cream-secondary` (a subtle shift marking the transition from problem to solution)
- Main text: `text-charcoal text-[28px] md:text-[32px] font-medium tracking-[-0.02em] leading-[1.3]` centered
- Build-up lines (cron, IPC, etc.): `text-warm-gray text-base leading-[1.7]` at reduced opacity -- these are the structural argument
- "Your agents need the same thing.": `text-warm-gray-light text-base` at further reduced opacity
- Vertical padding: `py-32` with generous internal spacing (80px above the closing line)
  **CSS changes:** None.

### Section 4: Timeline

**Component:** New -- `TimelineSection.tsx`
**Replaces:** `UseCasesGrid` (in function, not in name)
**Content:** "A NIGHT WITH DORKOS" header + six timestamped moments
**Design within existing system:**

- Background: `bg-cream-tertiary` (the darkest cream, creating visual distinction)
- Section header: `font-mono text-2xs tracking-[0.15em] uppercase text-brand-orange` (the existing `section-label` pattern)
- Timestamp column: `font-mono text-2xs tracking-[0.1em] text-warm-gray-light`
- Narrative: `text-warm-gray text-base leading-[1.7]`
- Module names: `font-mono text-brand-orange` inline (same size as body)
- Connector line: 1px `border-[var(--border-warm)]` vertical
- Layout: Two-column on desktop (80px timestamp column + narrative), single column on mobile (timestamp above narrative)
- Each moment: `REVEAL` variant on scroll
  **CSS changes:** Minor -- may need a custom timeline layout utility. No new colors or fonts.

### Section 5: Module Reference

**Component:** Rewritten `SystemArchitecture.tsx` (or renamed to `SubsystemsSection.tsx`)
**Replaces:** Current `SystemArchitecture`
**Content:** "SUBSYSTEMS" header + six gap/fix rows
**Design within existing system:**

- Background: `bg-cream-primary` (return to base)
- Header: `font-mono text-2xs tracking-[0.15em] uppercase text-brand-orange`
- Table: max-width 720px, centered
- Left column (gap): `text-warm-gray-light text-sm` -- the problems, muted
- Right column (module + description): Module name in `font-mono text-sm text-brand-orange`, description in `text-warm-gray text-sm`
- Row separator: `border-b border-[var(--border-warm)]`
- Status dot: 6px circle using existing `FeedDot` pattern
- "Coming soon" indicator: `font-mono text-3xs text-warm-gray-light` inline
  **CSS changes:** None. Remove the SVG diagram code.

### Section 6: Install Moment

**Component:** Rewritten `HowItWorksSection.tsx` (or renamed to `InstallSection.tsx`)
**Replaces:** Current `HowItWorksSection`
**Content:** `$ npm install -g dorkos` + trust line + scale line
**Design within existing system:**

- Background: `bg-cream-secondary`
- Command: `font-mono text-2xl md:text-3xl text-charcoal` with `cursor-blink`
- Dollar sign: `text-warm-gray-light/30`
- "Open source. Self-hosted. Yours.": `text-warm-gray text-base`
- "One person. Ten agents. Ship around the clock.": `text-warm-gray-light text-base`
- Padding: `py-40` -- enormous breathing room
- Typing animation: Reuse `TerminalBlock` pattern from current `HowItWorksSection`
  **CSS changes:** None.

### Section 7: Identity Close

**Component:** Rewritten -- merges current `AboutSection` + `HonestySection` into `IdentitySection.tsx`
**Replaces:** `AboutSection`, `HonestySection`
**Content:** "Built by dorks. For dorks. Run by you." + origin story + boldness invitation
**Design within existing system:**

- Background: `bg-cream-white` (matches current `HonestySection`)
- Corner brackets: Preserve the bracket decoration from `HonestySection` -- they frame the identity statement beautifully
- Tribal line: `text-charcoal text-[28px] md:text-[32px] font-medium tracking-[-0.02em]`
- Origin paragraph: `text-warm-gray text-sm leading-[1.7]` at reduced opacity
- Boldness invitation: `text-warm-gray text-lg leading-[1.7]`
  **CSS changes:** None. The `BRACKET` variant from `HonestySection` should be preserved.

### Section 8: The Close

**Component:** Rewritten `ContactSection.tsx` (or renamed to `CloseSection.tsx`)
**Replaces:** Current `ContactSection`
**Content:** "Your agents are ready. Leave the rest to them." + "Ready."
**Design within existing system:**

- Background: `bg-cream-secondary`
- Close line: `text-warm-gray text-lg leading-[1.7]` centered
- "Ready.": `font-mono text-base text-brand-orange` centered -- the boot sequence callback
- The `reveal_email` interaction from `ContactSection` could be preserved below "Ready." as a subtle contact mechanism, or moved to the footer
  **CSS changes:** None.

### Footer

**Component:** Updated `MarketingFooter.tsx`
**Replaces:** Current footer (minor updates)
**Content:** Simplified three-column layout + "You slept. They shipped." anchor
**Design changes:**

- Add "You slept. They shipped." as a centered line above the existing layout: `font-mono text-2xs tracking-[0.1em] text-cream-tertiary/60`
- Keep the retro stripes
- Keep the charcoal background
- Update version to `v0.4`
- Remove the large social icons in favor of text links: `GitHub | Docs | Discord`
  **CSS changes:** None.

---

## 5. The Tension

My Round 2 design notes called for:

- **Near-black backgrounds** (`#0A0A0A`, `#0D0D0D`, `#111111`)
- **Warm white text** (`#F5F5F0`)
- **Muted amber accent** (`#D4A843`)
- **JetBrains Mono / Inter typography**
- **Dot grid substrate**
- **No springs, no bounce** -- opacity + subtle translate only
- **400-600ms ease-out** transitions

The existing site uses:

- **Cream backgrounds** (`#F5F0E6` family)
- **Charcoal text** (`#1A1814`)
- **Brand orange accent** (`#E85D04`)
- **IBM Plex Sans / IBM Plex Mono typography**
- **Graph paper grid texture**
- **Spring physics** (stiffness 100, damping 20)
- **Motion.dev with overdamped springs**

These are fundamentally different visual worlds. My Round 2 notes described a machined, dark instrument panel. The existing site is a warm, retro-tech workshop. Both are valid. Both are honest. They simply come from different instincts.

### How to Resolve This

**The existing site wins.** Here is why.

The cream palette is the brand. It has been established across the marketing site, the docs (Fumadocs), and presumably the product itself. Switching to a dark foundation would require rebuilding the entire visual identity -- not just the homepage. The cost of that change is disproportionate to the benefit.

More importantly, the cream palette is _distinctive_. In a landscape where every developer tool defaults to dark mode with neon accents, DorkOS's warm cream is a genuine differentiator. It communicates something that dark backgrounds cannot: approachability without compromising seriousness. The tool is playful (the name is "DorkOS") and the visual language should allow that playfulness to breathe. Dark backgrounds suppress it.

**What my dark vision gets right, though, is contrast.** The new copy has sections that need weight -- the Villain cards, the Install moment, the Identity close. In a cream-dominant palette, weight comes from:

1. **Shifting between cream values** -- `bg-cream-primary` to `bg-cream-tertiary` to `bg-cream-white` to `bg-cream-secondary`. The current site already does this. The new sections should amplify the rhythm.
2. **Using the charcoal sparingly** -- For the Prelude and possibly the Install moment, a `bg-charcoal` section creates the necessary gravity without abandoning the palette. The footer already proves this works.
3. **Typography weight** -- Larger sizes, tighter tracking, bolder weights. The words create the darkness, not the background.

### Specific Concessions from My Round 2 Vision

| My Round 2 Spec            | Existing Site Reality       | Resolution                                                                                                  |
| -------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `#0A0A0A` background       | `#F5F0E6` cream             | Keep cream. Use charcoal only for Prelude and footer.                                                       |
| `#D4A843` amber accent     | `#E85D04` brand orange      | Keep orange. It is more energetic and more distinctive.                                                     |
| JetBrains Mono             | IBM Plex Mono               | Keep Plex. It is already loaded and has excellent small-size rendering.                                     |
| Inter / Neue Haas Grotesk  | IBM Plex Sans               | Keep Plex Sans. Consistent system.                                                                          |
| Dot grid                   | Graph paper grid            | Keep graph paper. Same function, warmer execution.                                                          |
| No springs (ease-out only) | Spring physics (overdamped) | Keep springs. They feel more alive and match the "system coming online" metaphor better than linear easing. |
| 400-600ms transitions      | Spring-determined durations | Keep springs. The stiffness/damping values produce appropriate timing.                                      |

### The One Concession I Ask For

The **Prelude** ("DorkOS is starting.") should use `bg-charcoal` with `text-cream-white` and a monospaced character-by-character animation. This is the one moment where the dark-to-light transition is narratively justified. The system is booting. The screen is dark. Then it wakes into cream. This single transition from dark to warm is more powerful than an entirely dark page, because it only happens once, and it earns its moment.

After the Prelude fades, the entire rest of the page lives in the cream world. The charcoal returns only in the footer, completing the cycle.

---

## Summary of Work

| Category               | Count | Components                                                                                                                                      |
| ---------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **New components**     | 4     | `Prelude`, `VillainSection`, `PivotSection`, `TimelineSection`                                                                                  |
| **Major rewrites**     | 4     | `ActivityFeedHero` (hero), `SystemArchitecture` (subsystems table), `HowItWorksSection` (install), `AboutSection` + `HonestySection` (identity) |
| **Minor updates**      | 2     | `MarketingFooter`, page composition (`page.tsx`)                                                                                                |
| **Preserved as-is**    | 3     | `MarketingHeader`, `MarketingNav`, `ActivityFeedPanel` (inner component)                                                                        |
| **Removed**            | 3     | `CredibilityBar`, `UseCasesGrid`, `ContactSection` (absorbed)                                                                                   |
| **New CSS**            | 0     | Zero new CSS variables, colors, or fonts needed                                                                                                 |
| **Data files updated** | 2-3   | `modules.ts` (simplified for table), `philosophy.ts` (removed), new `timeline.ts` and `villain-cards.ts`                                        |

The design system holds. The copy is the only thing that changes -- and the copy is significantly stronger. The architecture of the page shifts from feature-showcase to narrative-arc, which is the right move for a product that is selling a paradigm (agent OS) rather than a list of capabilities.

The existing site's warmth, its retro-tech honesty, its considered typography and motion -- these are the materials. The new copy is the structure. The two are compatible. The result will be a page that feels like the same object, refined.
