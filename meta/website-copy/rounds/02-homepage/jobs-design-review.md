# Design Review: Applying the New Copy to the Current Site

**Reviewer:** Jobs
**Date:** 2026-02-27
**Constraint:** Keep the existing design system (cream palette, IBM Plex, warm aesthetic). We are changing content and structure, not redesigning.

---

## 1. The Narrative Audit

### What the current site tells

The current site does not tell a story. It presents a product.

It opens with a statement ("Your AI Never Sleeps"), immediately shows a simulated activity feed, then walks through architecture modules, use cases, installation steps, an honesty disclaimer, an about section, and a contact form. It is organized as a feature tour -- competent, clear, and entirely forgettable.

The activity feed is the most interesting element on the page, and it is doing all of the narrative heavy lifting alone. The rest of the page reads like documentation that wandered onto the marketing site. The SystemArchitecture section is a module catalog. The UseCasesGrid is a feature list. The HowItWorksSection is an install guide. None of these sections make you _feel_ anything. They inform. They do not persuade.

The page answers "what is DorkOS?" six different ways but never answers the only question that matters: "why should I care?"

### What the new copy tells

The new copy tells a story in five acts:

1. **Recognition** -- your agents are brilliant, but crippled (hero + villain cards)
2. **Reframe** -- we solved this for processes fifty years ago (pivot)
3. **Proof** -- one night, everything changes (timeline narrative)
4. **Architecture** -- the subsystems that made it possible (module reference)
5. **Identity** -- who built this and why it matters (close)

Each section earns the next. The villain cards build tension that the pivot releases. The pivot earns the right to show the timeline. The timeline earns the right to present modules, because you have already _seen_ them work. The install command lands with gravity because you now understand what it gives you.

The new copy is better in every dimension that matters. It has emotional range. It has pacing. It has a reason to keep scrolling. The current site has none of these.

---

## 2. What to Strip Away

Be ruthless. Here is what gets cut:

### CredibilityBar -- CUT

"Built on the Claude Agent SDK / Open Source / MIT Licensed" -- this is footer material at best. It interrupts the emotional momentum between the hero and the next section. The new narrative needs the hero to flow directly into the villain cards. This information surfaces naturally in the install section ("Open source. Self-hosted. Yours.").

### UseCasesGrid -- CUT

"Not features. Capabilities." followed by a 3-column grid of use cases. This is a feature list wearing a trench coat. The new timeline narrative replaces this entirely -- and does it better, because showing someone's agents fixing CI at 2:47am is infinitely more compelling than a card that says "24/7 autonomous execution."

### AboutSection (current form) -- CUT

The current about section is a paragraph of product description followed by four philosophy cards. The new Identity Close (Section 7) replaces this with something that has actual emotional weight. "Built by dorks. For dorks. Run by you." followed by the origin story does what four philosophy cards cannot: it makes you feel like you found your people.

### HonestySection (current form) -- RETHINK

The honesty section is noble in intent but awkward in placement. It reads like an apology in the middle of a product page. The new copy does not have this section, and it does not need one -- the timeline narrative grounds the product in specificity ("$4.20 in API calls"), which is more honest than any disclaimer. If transparency about the Anthropic API dependency must live somewhere, it belongs in the docs or a dedicated page, not interrupting the homepage narrative arc.

### HowItWorksSection (current form) -- ABSORBED

The three-step install flow gets absorbed into the new Install Moment (Section 6). More on this below.

---

## 3. What to Keep

### ActivityFeedPanel -- KEEP AND REPOSITION

The live activity feed is the single strongest visual element on the current site. It is proof of concept in motion -- you watch it and immediately understand what autonomous agents look like. But it should not be the hero. In the new narrative, the hero is the problem statement. The feed earns its place _after_ the villain cards and pivot, as a visual complement to the timeline section. Or it becomes a persistent ambient element -- a sidebar that runs during the timeline scroll, showing the night's activity in real time as you read about it.

The component itself (`ActivityFeedPanel`, `FeedItem`, `FeedDot`, `FeedBadge`) is well-built and needs minimal changes. Update the activity pool to align with the timeline events (test suite, dependency upgrade, CI fix, mesh coordination) and it tells the same story as the copy.

### TerminalBlock with typing animation -- KEEP

The typing animation from `HowItWorksSection` is clean and effective. Repurpose it for the Install Moment and potentially the Prelude. The `cursor-blink` CSS class and the character-by-character reveal are exactly what the new copy calls for.

### Motion variants system -- KEEP

The `REVEAL`, `STAGGER`, `SCALE_IN`, `DRAW_PATH`, `VIEWPORT` variants in `motion-variants.ts` are the animation language of the site. They work. The new sections should use the same vocabulary. No new animation system needed.

### Architecture SVG diagram -- KEEP (modified)

The node-and-connection SVG with traveling particles is visually distinctive. It should not be a standalone section anymore, but it could serve as a background element or a compact reference visual within the new Module Reference section. Strip the full-page treatment, keep the diagram as an accent.

### ContactSection -- KEEP

The terminal-style `reveal_email` interaction is charming and on-brand. It survives intact as part of the footer or close.

### MarketingNav, MarketingHeader, MarketingFooter -- KEEP (update links)

The navigation chrome stays. Update the nav links to match the new section structure (remove "system" and "features" anchors, add whatever the new sections need). The footer simplifies per the synthesis: wordmark left, links center, version right, anchored by the tagline.

---

## 4. The "How It Works" Question

The current HowItWorksSection is three steps: install, run, done. Clean. Simple. Speaks to developers who want to know the friction cost before they commit.

The new copy does not have an explicit "How It Works" section. The timeline handles the _emotional_ version of "how it works" -- you queue tasks, you sleep, you wake up to results. The Install Moment handles the _mechanical_ version -- `npm install -g dorkos`, three lines, you know what to do.

**My recommendation:** Do not resurrect a standalone How It Works section. The current three-step version is fine but forgettable. The timeline is unforgettable. However, the install simplicity _must_ be viscerally clear. The Install Moment needs the same weight that the current three-step section gives it -- the sense that this is one command, not a weekend project. The typing animation from the current `TerminalBlock` component, applied to the install command in the new Install Moment, achieves this. One animated terminal line does what three static steps do, but with more presence.

If you feel the gap, consider a single line above the install command: "One command. No config. No cloud account." -- borrowed from the current step 1 description, compressed. It costs nothing and removes the last objection.

---

## 5. Component Reuse Plan

Here is the mapping from new copy sections to existing components:

| New Section                         | Existing Component                    | Action                                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Prelude** ("DorkOS is starting.") | `TerminalBlock`                       | Repurpose. Full-screen variant with dark background, character-by-character animation, then fade. New component wrapping existing animation logic.                                                                                                                                                                 |
| **Hero** (problem statement)        | `ActivityFeedHero`                    | Gut and rebuild. Keep the layout shell (grid, motion wrappers, responsive breakpoints). Replace all content. Remove the activity feed from the hero position. The hero becomes text-only: headline, subhead, tagline.                                                                                              |
| **Villain Cards**                   | None                                  | New component. Four cards with scroll-triggered activation. Use existing `REVEAL`/`STAGGER` variants. The card styling can borrow from `ModuleCard` (warm background, border, hover lift) but content is entirely new.                                                                                             |
| **Pivot**                           | None                                  | New component. Centered text block with the OS metaphor build-up. Simple -- `motion.div` with `REVEAL` variants. The background lightening can be a CSS transition tied to scroll position.                                                                                                                        |
| **Timeline**                        | None                                  | New component. Vertical timeline with timestamps. This is the largest new build. Each timestamp entry is a `motion.div` with scroll-triggered activation. Consider integrating `ActivityFeedPanel` as a sidebar companion.                                                                                         |
| **Module Reference**                | `SystemArchitecture`                  | Heavy modification. Strip the three-group card layout. Replace with the compact two-column table from the synthesis (gap / module / description). Keep the SVG diagram as an optional accent. The `ModuleCard` component is over-built for what the new copy needs -- a table row with a status dot is sufficient. |
| **Install Moment**                  | `TerminalBlock` + `HowItWorksSection` | Combine. The `TerminalBlock` typing animation applied to a single `npm install -g dorkos` command. Surrounded by generous whitespace. Below it: three short text lines. No grid, no steps, no cards.                                                                                                               |
| **Identity Close**                  | `AboutSection` + `HonestySection`     | Replace both. New component with the tribal statement, origin story, and boldness invitation. The bracket-corner decoration from `HonestySection` could survive as a design accent if it fits the tone.                                                                                                            |
| **Footer close**                    | `ContactSection`                      | Keep the `reveal_email` interaction. Add the "Your agents are ready. Leave the rest to them." line and the monospaced "Ready." terminal close above it.                                                                                                                                                            |

### Components to delete

- `CredibilityBar.tsx` -- content absorbed elsewhere
- `UseCasesGrid.tsx` + `use-cases.ts` -- replaced by timeline
- `PhilosophyCard.tsx` + `PhilosophyGrid.tsx` + `philosophy.ts` -- replaced by identity close
- `ProblemSection.tsx` / `NotSection.tsx` -- appear to be earlier iterations; confirm unused before deleting

### Components unchanged

- `MarketingNav.tsx` -- update link array only
- `MarketingHeader.tsx` -- no changes
- `MarketingFooter.tsx` -- simplify per synthesis spec
- `motion-variants.ts` -- keep as-is, the animation vocabulary works

---

## Summary

The current site is a product page. The new copy is a narrative. The gap between them is not a redesign -- it is a restructuring. The cream palette, the IBM Plex fonts, the warm monospaced aesthetic, the motion variant system -- all of this survives. What changes is the _order_ in which things appear and the _emotional logic_ that connects them.

The biggest build is the timeline. Everything else is repurposing existing components or writing straightforward new ones that use the established animation and styling patterns.

The single most important decision: move the activity feed out of the hero position. The hero must be the problem statement. The feed is proof, not premise -- it belongs downstream, after the visitor understands what they are looking at.

The page should feel like a system booting up. The Prelude starts it. The hero names the problem. The villain cards diagnose it. The pivot reframes it. The timeline proves the solution. The modules name the parts. The install gives you the command. The identity tells you who built it. "Ready." The system is running.

Every section earns the next. Nothing is out of order. That is the difference between a product page and a story.
