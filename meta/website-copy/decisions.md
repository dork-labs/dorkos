# Website Copy Decisions Log

Tracking key creative decisions as they're made.

---

## Decision 1: The Panel

**Date:** 2026-02-27
**Decision:** Use 5 creative agents — Ogilvy (craft), Jobs (narrative), Godin (positioning), Ive (aesthetic), Wieden (provocation)
**Rationale:** Covers the full spectrum from strategic positioning to emotional gut-punch. Dan Wieden specifically for Nike-level identity work (coined "Just Do It").

## Decision 2: Process — Start With Concept, Not Slogan

**Date:** 2026-02-27
**Decision:** Round 1 asks for the organizing concept, not a tagline. A slogan is the compression of a concept — you need the concept first.
**Rationale:** Starting with slogans produces clever lines with no structural integrity. Starting with concepts produces a site where every section reinforces the same idea.

## Decision 3: Reject "Employment" Metaphor

**Date:** 2026-02-27
**Decision:** Ogilvy's "tool → employee" framing is rejected. Too corporate. The relationship between human and agent should use language like "work with," "teammate," "collaborate," "crew" — not "employ," "worker," "hire."
**Nuance:** The human is the lead. Human and agent are not peers. But the tone is warm and collaborative, not managerial. Think: a builder with a crew, not a boss managing headcount.
**Aligns with:** Brand foundation already says "Agents work **like** teammates" (not "are teammates"). The "like" is important — it acknowledges the analogy without overclaiming.

## Decision 4: Add "AI Boldness" Dimension

**Date:** 2026-02-27
**Decision:** The site should speak to developers who are bold enough to embrace AI agents — the ones leaning into the future, not fearing it. This isn't about dismissing AI fear. It's about embodying the answer: the developers who build AI teams will outship those who don't.
**Constraint:** Do not mock or belittle people who are afraid. Invite them. Make the bold path feel achievable, not exclusive.
**Research:** Complete — see `research/20260227_ai_agents_reshaping_software_development.md` (40+ sources).
**Editorial note (2026-03-02):** "Outship those who don't" has been softened in the pro-human positioning update. The new framing is empowerment-focused: "Ship what you've always imagined" rather than competitive framing against other developers. See Decision 16.

## Decision 5: Hero Headline — Test Both in Round 2

**Date:** 2026-02-27
**Decision:** Don't choose between long-form (Ogilvy) and short-form (Jobs/Wieden) yet. Have agents write both versions in Round 2 and pick after seeing them in homepage context.
**Rationale:** Both styles have merit. Better to compare in situ than in the abstract.

## Decision 6: Site Feel — Hybrid (Narrative + Boot Sequence)

**Date:** 2026-02-27
**Decision:** Narrative scroll structure (problem → villain → product → install → tribe) with boot-sequence visual treatment (Ive's design language). Story arc drives the sections, but the aesthetic feels like an OS activating.
**Nuance:** Keep Ive's aesthetic direction — dark screen, subsystem activation, machined typography, monospaced system names, generous whitespace. But the _content flow_ follows the emotional narrative arc, not a literal boot sequence.

## Decision 7: Primary Tagline — "You slept. They shipped."

**Date:** 2026-02-27
**Decision:** "You slept. They shipped." is the primary tagline. Goes on stickers, README, Twitter bio, meta descriptions.
**Rationale:** Three words + three words. Subject, verb. Subject, verb. Identity over features. Centers the developer (you slept) and the outcome (they shipped). Passed Wieden's sticker test and Godin's word-of-mouth test.
**"Your AI Never Sleeps":** Demoted to Pulse module section header. It's a feature line, not an identity line.
**Editorial note (2026-03-02):** "You slept. They shipped." is powerful copy and is kept as a brand line. However, it carries tension with pro-human positioning — the "you slept" framing implicitly treats human rest as a deficiency the agents overcome. New empowerment-focused lines ("Intelligence doesn't scale. Coordination does." and "You've always had more ideas than hours. That ratio just changed.") are now the primary taglines. "You slept. They shipped." remains in the messaging bank with this awareness noted. See Decision 16.

## Decision 8: Module Presentation — Timeline-First with Reference Table

**Date:** 2026-02-27
**Decision:** Lead with Wieden's timeline narrative (11:14pm → 2:47am → 7:00am) as the primary presentation. Support with a clean gap→fix reference below or alongside for the architect persona.
**Rationale:** Autonomous agents are a new concept. Story cements the idea in people's heads better than a table. But the technical persona also needs to quickly map "what does each module do?" — so a compact reference follows the story.
**Aligns with:** Godin's observation that the product modules should feel like _answers_ to problems the reader already felt.

## Decision 9: Hero Headline — Jobs Short-Form

**Date:** 2026-02-27
**Decision:** "Your agents are brilliant. They just can't do anything when you leave."
**Rationale:** Two lines. First builds warmth. Second drops the floor out. No wasted syllable. Punchy and immediate.
**Long-form (Wieden) kept as reserve:** "You closed the laptop at 11pm..." — available for blog posts, launch announcements, or anywhere longer-form copy fits.
**Editorial note (2026-03-02):** The "can't do anything when you leave" framing centers human absence as the problem. Consider reframing for the empowerment direction: the issue is the missing coordination layer, not the human leaving. See Decision 16.

## Decision 10: Villain Card 4 — The 3am Build

**Date:** 2026-02-27
**Decision:** Use Wieden's "The 3am Build" as the fourth villain card instead of "The Flow Killer."
**Copy:** "CI went red at 2:47am. The fix was three lines of code. Your agent knew exactly what to do. Your terminal was closed. The build stayed red until morning."
**Rationale:** Aligns with the 2:47am motif that runs through the timeline. Reinforces the tagline's "you slept" energy. The Flow Killer addresses the Priya persona — can surface on secondary pages or docs.

## Decision 11: New Lines — "Leave the rest to them." + "They need an address."

**Date:** 2026-02-27
**Decision:** Two new lines added to the brand vocabulary:

1. **"Leave the rest to them."** — Replaces Wieden's "Close the laptop" (which was technically inaccurate since local agents die when the laptop closes). Collaborative handoff energy. Use: final site line, stickers, social.
2. **"Your agents don't need more intelligence. They need an address."** (Jobs) — Nine words. Reframes the product as giving agents a place to exist. Use: pivot alternative, social, README.
   **Rejected:** "Close the laptop." — emotionally perfect but technically dishonest for a local-first product.
   **Noted but not adopted:** "The quiet part is the architecture." (Ive) and "They have an infrastructure problem." (Godin) — strong lines, available for future use.

## Decision 12: Keep Existing Design System — Unanimous

**Date:** 2026-02-27
**Decision:** The cream palette, IBM Plex fonts, brand orange (#E85D04), graph paper texture, motion variants, and all current design tokens stay unchanged. Zero new CSS variables. Zero new fonts.
**Rationale:** All 5 agents unanimously agreed the existing warm retro-tech aesthetic is stronger than the dark vision (#0A0A0A) proposed in the Round 2 copy. The cream palette is warmer, more distinctive, and more confident than the dark terminal aesthetic every other developer tool defaults to. The copy is voice-driven, not design-driven — it works on cream.

## Decision 13: Honesty Section — Keep & Move

**Date:** 2026-02-27
**Decision:** Keep the Honesty Section with corner brackets and green eyebrow. Move it from current position (between How It Works and About) to between Module Reference and Install Moment.
**Rationale:** Ogilvy + Wieden argument: in a page with this much emotional architecture, a moment of radical honesty is a credibility anchor. The developers who will adopt DorkOS will notice the _absence_ of a privacy disclosure. Copy tightened. Brackets stay — they're a signature element.

## Decision 14: Hero Layout — Stacked (Headline Over Feed)

**Date:** 2026-02-27
**Decision:** Headline spans full width at top of hero. Activity feed appears below, subordinate. Words first, evidence second.
**Rationale:** 4 of 5 agents recommended stacking (Wieden, Godin, Jobs, Ive). The new headline creates tension that the feed resolves — but only if the reader feels the headline first. Current side-by-side layout lets the eye go to the moving element before reading the words, which undermines the problem statement.

## Decision 15: Prelude — Dark Then Cream

**Date:** 2026-02-27
**Decision:** The Prelude ("DorkOS is starting.") uses a brief dark background (charcoal #1A1814) before transitioning to the cream palette. Holds ~1.2 seconds, then fades.
**Rationale:** Ive's insight — a single moment of darkness makes the warm cream feel like awakening. The system turns on. Reinforces the boot-sequence hybrid aesthetic without breaking the overall warm palette.

## Decision 16: Pro-Human Positioning Shift

**Date:** 2026-03-02
**Decision:** All DorkOS copy shifts to pro-human, empowerment-focused positioning. AI agents are tools for human creativity — like Apple positions the Mac. The human is the creative force; the agents are the coordination layer that lets human vision scale.
**Core principles:**

- Pro-human — never imply agents are better, smarter, or more capable than people
- Don't make people feel bad for human needs (sleep, connection, belonging)
- Champion the creatives and builders — they're the point, not the bottleneck
- "Intelligence doesn't scale. Coordination does." as core thesis
- "You've always had more ideas than hours. That ratio just changed." as empowerment frame
  **The Apple test:** Would Apple say this about the Mac? If not, reframe.
  **Superseded framing:**
- "YOUR AI NEVER SLEEPS" as primary tagline → "Intelligence Doesn't Scale. Coordination Does."
- "YOU'RE THE BOTTLENECK" → "Intelligence Doesn't Scale. Coordination Does."
- "Your AI coding agent can write better code than you at 3am" → removed
- "You — the human — are the scheduler..." → "The coordination layer is missing"
- "outship everyone" → "ship what you've always imagined"
- "they never stop" → "they multiply what you accomplish"
  **Trigger:** IdentityClose.tsx on the marketing site was rewritten to remove anti-human framing. This shift is now cascaded back into all meta brand documents.
  **Affected documents:** `brand-foundation.md`, `dorkos-litepaper.md`, `value-architecture-applied.md`, `rounds/02-homepage/synthesis.md`. Round 1 and Round 2 creative submissions are preserved as historical artifacts with editorial disclaimers.
