# Design Review Synthesis: Applying New Copy to Existing Site

## What Happened

All five agents reviewed the current website code — every component, every CSS class, every animation variant — alongside the approved synthesis copy. They were asked: how does the new copy fit inside the existing design system?

The unanimous verdict: **the existing design system wins.** The cream palette, IBM Plex type, warm retro-tech aesthetic, graph paper texture, and motion variants are stronger than the dark vision proposed in Round 2's copy. The new copy was written for dark backgrounds but works on cream — the emotional beats are voice-driven, not design-driven.

---

## Unanimous Consensus (All 5 Agents Agree)

### Keep Everything About the Design System

- **Cream palette** (#F5F0E6 family) — warmer, more distinctive, more honest than dark terminal aesthetic
- **IBM Plex Sans + Mono** — better than JetBrains Mono for this identity (warmer, humanist)
- **Brand orange** (#E85D04) — hotter and more urgent than the synthesis's muted amber (#D4A843)
- **Graph paper hero background** — says engineering, precision, craft
- **Motion variants** (REVEAL, STAGGER, SCALE_IN) — appropriately restrained, no springs/bounce
- **Terminal interaction patterns** — typing animation, cursor blink, `reveal_email`
- **Module card hover effect** — spotlight cursor tracking, subtle and well-crafted
- **Responsive CTA strategy** — npm on desktop, "Get started" on mobile
- **Retro brand stripes** in footer (orange + green)
- **Zero new CSS variables needed**
- **Zero new fonts needed**

### The Activity Feed Is the Crown Jewel — But Must Not Lead

All five agents agree: the `ActivityFeedPanel` is the single most persuasive element on the current site. It proves the product is real. But with the new headline, the feed must become _proof_, not _premise_.

- **Current:** Feed sits beside the headline at equal visual weight. Eye goes to motion first.
- **New:** Headline owns the viewport. Feed appears below or subordinate — resolving the tension the headline creates.
- The feed's footer line ("While you read this, your agents could be doing all of this") lands harder with the new headline above it.

### New Section Structure

All agents converge on this order:

```
[1] Prelude        — "DorkOS is starting." (brief, then fades)
[2] Hero           — Problem headline + tagline + activity feed (subordinate)
[3] Villain        — 4 pain-point cards
[4] Pivot          — "We solved this 50 years ago..."
[5] Timeline       — "A Night with DorkOS" (biggest new build)
[6] Module Ref     — Compact subsystems table
[7] Install        — npm command at peak desire, maximum breathing room
[8] Identity Close — Origin story + tribal declaration + email postscript
[9] Footer         — Updated with tagline
```

### What Gets Removed

| Component                           | Reason                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **CredibilityBar**                  | Premature reassurance. Its facts ("Open Source / MIT / Self-Hosted") move to the install moment where they convert. |
| **UseCasesGrid**                    | Feature grid from 2019. Replaced entirely by the timeline narrative and villain cards.                              |
| **SystemArchitecture** (standalone) | SVG diagram is an engineer's artifact, not a persuasion device. Module Reference table replaces it.                 |
| **HowItWorksSection** (standalone)  | Three numbered steps are documentation wearing a marketing hat. Absorbed into the Install Moment.                   |

### What Gets Rebuilt

| Component                             | Change                                                                                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ActivityFeedHero** → **Hero**       | Gut and rebuild. Keep layout shell, responsive breakpoints, motion wrappers. Replace all content. Headline owns full width at top. Feed below, subordinate. |
| **AboutSection** → **Identity Close** | Philosophy cards grid replaced with origin story + tribal declaration. Email reveal absorbed as postscript.                                                 |
| **ContactSection** → Absorbed         | Email reveal moves into Identity Close as a quiet line, not a standalone section.                                                                           |

### What's New

| Component           | Complexity | Notes                                                                                                                                                  |
| ------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Prelude**         | Low        | Repurpose `TerminalBlock` typing animation. Brief dark overlay that fades.                                                                             |
| **VillainSection**  | Medium     | 4 cards with scroll-triggered activation. Use existing REVEAL/STAGGER variants. Cards styled like system alerts (flatter than ModuleCards).            |
| **PivotSection**    | Low        | Centered text block. Single `motion.div` with REVEAL variant. Generous padding.                                                                        |
| **TimelineSection** | High       | Vertical timeline with timestamps. Largest new build. Each entry is a `motion.div` with scroll activation. Asymmetric layout breaks centered symmetry. |
| **InstallMoment**   | Low        | Terminal typing animation on a single command. 120-160px breathing room above/below.                                                                   |

---

## Key Disagreements

### The Honesty Section

This is the only substantive disagreement across the panel.

**Keep it (Ogilvy + Wieden):**

- The new copy is more emotionally driven. A moment of radical honesty prevents the page from feeling like it's selling too hard.
- The developers who will adopt DorkOS are precisely the developers who will notice the _absence_ of a privacy disclosure.
- The corner brackets + green eyebrow are a signature visual element.
- Move it to between Module Reference and Install Moment. Tighten the copy.

**Cut it (Jobs + Godin):**

- The timeline grounds the product in specificity ("$4.20 in API calls"), which is more honest than any disclaimer.
- "Open source. Self-hosted. Yours." at the install moment does the trust work in six words.
- The honesty section inadvertently introduces doubt at a moment when the reader should be building trust.

**Ive's position:** Doesn't explicitly advocate either way but designed the section flow without it. His section-by-section mapping skips from Module Reference directly to Install Moment.

### Hero Layout: Side-by-Side vs. Stacked

- **Ogilvy:** Keep left/right layout but make headline + tagline own the left side more forcefully. Feed as right-side proof.
- **Wieden + Godin + Jobs:** Stack headline at full width across the top. Feed below, subordinate. Words first, evidence second.
- **Ive:** Full-width headline, then feed below. Explicit about headline owning the viewport.

### Activity Feed Position (Beyond Hero)

- **Godin:** Move feed to timeline section or install section. After the timeline, every feed entry carries weight because the reader has context.
- **Jobs:** Feed as persistent sidebar companion during timeline scroll, or as proof element after the install command.
- **Ogilvy + Wieden + Ive:** Feed stays in hero area but subordinate to headline.

### Prelude Background

- **Ive:** Dark (#0A0A0A) for Prelude only, then transition to cream. The single moment of darkness makes the warm palette feel like awakening.
- **Wieden:** Cream with monospaced center text. A system POST message in warm light.
- **Others:** Don't specify strongly either way.

### Humorous Feed Entries

- **Wieden (strongly):** Cut the jokes ("Mesh coordinating world domination — ETA 47 minutes"). With the new headline setting a specific emotional tone, every feed entry must reinforce "this is real, this is happening."
- **Others:** Don't address directly.

---

## Implementation Mapping

### Components Unchanged (Update Props Only)

| Component            | Changes                                                       |
| -------------------- | ------------------------------------------------------------- |
| `MarketingNav`       | Update link array for new section anchors                     |
| `MarketingHeader`    | No changes                                                    |
| `MarketingFooter`    | Update copy: add "You slept. They shipped." tagline, simplify |
| `motion-variants.ts` | No changes — animation vocabulary already works               |

### Existing Component Reuse

| Existing            | Reused In                   | How                                                   |
| ------------------- | --------------------------- | ----------------------------------------------------- |
| `TerminalBlock`     | Prelude, Install Moment     | Typing animation, cursor blink                        |
| `FeedItem` styling  | Villain cards               | Left border highlight, monospaced text, tight spacing |
| `ModuleCard` hover  | Subsystems table (optional) | Spotlight cursor tracking                             |
| `ActivityFeedPanel` | Hero (repositioned)         | Same component, new layout position                   |

### Files to Delete (After Rebuild)

- `CredibilityBar.tsx`
- `UseCasesGrid.tsx` + `use-cases.ts`
- `HowItWorksSection.tsx` (absorbed into InstallMoment)
- `PhilosophyCard.tsx` + `PhilosophyGrid.tsx` + `philosophy.ts` (if they exist)
- `ProblemSection.tsx` / `NotSection.tsx` (if unused earlier iterations)

---

## Summary Table

| Element             | Current                          | New                                                                      | Agent Source                   |
| ------------------- | -------------------------------- | ------------------------------------------------------------------------ | ------------------------------ |
| Headline            | "Your AI Never Sleeps."          | "Your agents are brilliant. They just can't do anything when you leave." | All 5                          |
| Eyebrow             | "Autonomous by default"          | "the operating system for autonomous AI agents"                          | Ogilvy                         |
| Subhead/Tagline     | Long product description         | "You slept. They shipped."                                               | All 5                          |
| Hero layout         | 55/45 split (copy/feed)          | Headline full-width top, feed below                                      | 4 of 5 (Wieden/Godin/Jobs/Ive) |
| Credibility Bar     | Between hero and architecture    | Removed — facts move to install moment                                   | All 5                          |
| Use Cases Grid      | 6 capability cards               | Removed — replaced by villain cards + timeline                           | All 5                          |
| System Architecture | SVG + grouped module cards       | Compact subsystems table                                                 | All 5                          |
| How It Works        | 3 numbered steps                 | Absorbed into Install Moment                                             | All 5                          |
| Honesty Section     | Between How It Works and About   | **Disputed** — keep & move (Ogilvy/Wieden) vs. cut (Jobs/Godin)          | Split                          |
| About Section       | Product description + philosophy | Identity Close (origin story + tribal)                                   | All 5                          |
| Contact Section     | Standalone with email reveal     | Email reveal absorbed into Identity Close                                | All 5                          |
| Activity Feed       | Hero co-star                     | Hero subordinate — proof, not premise                                    | All 5                          |
| Villain cards       | N/A                              | New section after hero                                                   | All 5                          |
| Pivot               | N/A                              | New section (OS metaphor)                                                | All 5                          |
| Timeline            | N/A                              | New section (biggest build)                                              | All 5                          |
| Install Moment      | CTA in hero                      | Dedicated section at peak desire                                         | All 5                          |
| Footer              | Current                          | Add tagline, simplify                                                    | All 5                          |
| Palette             | Cream                            | Cream (unchanged)                                                        | All 5                          |
| Fonts               | IBM Plex                         | IBM Plex (unchanged)                                                     | All 5                          |
| Motion              | REVEAL/STAGGER/etc.              | Same (unchanged)                                                         | All 5                          |
