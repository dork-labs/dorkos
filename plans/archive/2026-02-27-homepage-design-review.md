---
title: Homepage Design Review — Creative Panel
---

# Homepage Design Review — Creative Panel

**Date**: 2026-02-27
**URL**: http://localhost:6244/
**Panel**: David Ogilvy, Steve Jobs, Seth Godin, Jony Ive, Dan Wieden

## Process

Three rounds of structured review and improvement. Each round:

1. **Capture** — Screenshot desktop (1440px) and mobile (375px) of every section
2. **Panel Review** — Each panelist scores and critiques every section on:
   - **Clarity** (1-10): Is the message instantly clear?
   - **Emotion** (1-10): Does it make you feel something?
   - **Design** (1-10): Is the visual execution world-class?
   - **Conversion** (1-10): Does it move the visitor toward action?
3. **Synthesis** — Identify top 3-5 changes with highest impact
4. **Execute** — Implement the changes
5. **Re-capture** — Screenshot the updated state for next round

### Scoring Guide

- **9-10**: World-class. Ship it.
- **7-8**: Strong. Minor polish needed.
- **5-6**: Decent but has clear weaknesses.
- **3-4**: Needs significant rework.
- **1-2**: Fundamentally broken.

### Image/Visual Opportunities

Throughout the review, panelists should identify where imagery (CSS/HTML art, SVG illustrations, or placeholder image slots) would strengthen the page.

---

## Pre-Review: Current Section Inventory

| #   | Section    | Component               | Purpose                                |
| --- | ---------- | ----------------------- | -------------------------------------- |
| 0   | Prelude    | `Prelude.tsx`           | Boot sequence overlay animation        |
| 1   | Header     | `MarketingHeader.tsx`   | Logo + nav                             |
| 2   | Hero       | `ActivityFeedHero.tsx`  | Headline, tagline, activity feed, CTAs |
| 3   | Villain    | `VillainSection.tsx`    | 4 pain-point cards                     |
| 4   | Pivot      | `PivotSection.tsx`      | "What if" OS metaphor                  |
| 5   | Timeline   | `TimelineSection.tsx`   | Overnight narrative                    |
| 6   | Subsystems | `SubsystemsSection.tsx` | 6 modules with gap labels              |
| 7   | Honesty    | `HonestySection.tsx`    | Transparency statement                 |
| 8   | Install    | `InstallMoment.tsx`     | npm install CTA                        |
| 9   | Identity   | `IdentityClose.tsx`     | Origin story + email                   |
| 10  | Close      | `TheClose.tsx`          | Final tagline                          |
| 11  | Footer     | `MarketingFooter.tsx`   | Links + tagline                        |

---

## Round 1

### Desktop Screenshots (1440px)

Captured all 12 sections at 1440px viewport width via browser automation.

### Panel Scoring Summary

| Section    | Clarity | Emotion | Design | Conversion | Avg |
| ---------- | ------- | ------- | ------ | ---------- | --- |
| Prelude    | 8.4     | 8.6     | 8.2    | 7.0        | 8.1 |
| Hero       | 8.8     | 8.4     | 7.6    | 8.2        | 8.3 |
| Villain    | 9.0     | 9.0     | 6.4    | 7.6        | 8.0 |
| Pivot      | 8.8     | 8.6     | 7.2    | 7.0        | 7.9 |
| Timeline   | 8.8     | 9.0     | 7.4    | 7.2        | 8.1 |
| Subsystems | 8.0     | 4.8     | 5.6    | 5.4        | 6.0 |
| Honesty    | 7.6     | 6.0     | 5.8    | 5.4        | 6.2 |
| Install    | 8.6     | 7.4     | 7.2    | 8.2        | 7.9 |
| Identity   | 8.0     | 9.4     | 6.4    | 6.0        | 7.5 |
| Close      | 7.8     | 7.6     | 6.4    | 7.4        | 7.3 |

**Overall R1 Pre-Change Average: 7.5**

### Panel Consensus Findings

1. **Subsystems kills momentum** (unanimous) — Lowest scores across all reviewers. Feels like a spec sheet dropped into a narrative. Needs visual identity per module.
2. **Honesty section is invisible** (4/5 panelists) — Cream-on-cream reads as more of the same. Needs visual separation.
3. **Too much uniform whitespace** (4/5) — Every section has identical py-32/py-40. No breathing rhythm.
4. **Page is too text-heavy** (3/5) — Needs CSS art, micro-illustrations, or visual evidence to break up walls of text.
5. **Pivot closing line is weak** (3/5) — "Your agents need the same thing" is passive. Needs assertive close.
6. **TheClose lacks visual callback** (3/5) — Should echo the Hero's design language.
7. **Villain cards lack visual evidence** (3/5) — Cards should show terminal fragments, not just describe problems.

### Round 1 Changes Made

1. **Dark Honesty section** — Changed `bg-cream-white` to `bg-charcoal` with cream text, green "Honest by Design" label. Corner brackets updated to cream. Creates a tonal break that signals gravity.

2. **Pivot closing line** — Changed "Your agents need the same thing." to "So we built one." — assertive, active, forward-moving.

3. **Spacing rhythm** — Replaced uniform padding with intentional variation:
   - VillainSection: py-32 → py-28
   - PivotSection: py-40 → py-28
   - SubsystemsSection: py-32 → py-20
   - InstallMoment: py-40 → py-24
   - IdentityClose: py-40 → py-28
   - TheClose: py-32 → py-24

4. **Subsystem SVG micro-visualizations** — Added purpose-built SVGs for each module:
   - Pulse: timing bars (cron rhythm)
   - Relay: path with inflection point (message routing)
   - Mesh: triangle with nodes (network topology)
   - Wing: stacked layers (persistent memory)
   - Console: terminal prompt (command center)
   - Loop: circular arrow (feedback cycle)

5. **Villain card CSS art** — Added terminal-style visual fragments to each card:
   - Dead Terminal: `$ claude —session refactor-auth` → `Connection closed.`
   - Goldfish: `> Let me give you some contex` (truncated with cursor)
   - Tab Graveyard: colored progress bars (one orange, rest gray)
   - 3am Build: `✗ CI failed — 2:47am` with context line
   - Also changed left border from cold gray to warm orange `rgba(232, 93, 4, 0.15)`

6. **TheClose enhanced** — Added graph-paper background callback (matching Hero), enlarged headline and "Ready." text, added final CTA button.

7. **Villain closing statement** — Made larger/bolder (`text-xl font-medium`), added divider line above for visual weight.

**Build verified**: `pnpm turbo build --filter=@dorkos/web --force` passed (69 static pages)
**Browser verified**: All changes rendering correctly at localhost:6244

---

## Round 2

### Panel Scoring Summary (Post-R1)

| Section    | Clarity | Emotion | Design | Conversion | Avg |
| ---------- | ------- | ------- | ------ | ---------- | --- |
| Hero       | 8.2     | 8.0     | 8.0    | 6.0        | 7.6 |
| Villain    | 9.0     | 8.6     | 6.8    | 6.4        | 7.7 |
| Pivot      | 8.0     | 6.8     | 6.0    | 4.8        | 6.4 |
| Timeline   | 8.8     | 9.4     | 7.4    | 6.2        | 7.9 |
| Subsystems | 6.6     | 4.2     | 6.4    | 4.2        | 5.4 |
| Honesty    | 7.8     | 7.2     | 7.4    | 4.6        | 6.8 |
| Install    | 6.8     | 5.2     | 6.2    | 7.0        | 6.3 |
| Identity   | 8.0     | 9.2     | 6.6    | 4.2        | 7.0 |
| TheClose   | 6.8     | 6.0     | 6.6    | 7.0        | 6.6 |

### Round 2 Consensus Findings

1. **"So we built one." must be a typographic event** (5/5 unanimous) — Page thesis delivered in body-text gray
2. **"Ready." must be massive** (5/5 unanimous) — 18px orange → needs 48-72px to close boot narrative
3. **Mobile spacing broken** (5/5 unanimous) — py-28 = 112px on mobile, needs responsive reduction
4. **Section reorder** (3/5) — IdentityClose before InstallMoment; story earns the install
5. **Subsystems gap labels invisible on mobile** (4/5) — hidden md:block hides problem-solution frame
6. **Villain closing needs sharper copy** (4/5) — "stops the moment you stop watching it" more visceral
7. **Identity Close three-line kicker needs typographic escalation** (4/5) — Equal weight kills the crescendo
8. **Hero feed footer hedges with "could"** (3/5) — Undermines page confidence

### Round 2 Changes Made

1. **Section reorder** — Swapped IdentityClose and InstallMoment in `page.tsx`. Story now earns the install. Narrative: Honesty → Identity (origin story) → Install (CTA) → TheClose (boot complete).

2. **"So we built one." typographic event** — Changed from `text-warm-gray text-base` to `font-mono text-[24px] md:text-[32px] font-bold` in brand-orange. Now visually dominates the Pivot section as the page's thesis statement.

3. **"Ready." massive close** — Changed from `font-mono text-lg` to `text-[48px] md:text-[72px] font-bold` with cursor blink animation. Closes the boot sequence narrative started by the Prelude.

4. **TheClose headline subordinated** — "Your agents are ready." changed from `text-2xl md:text-[28px] font-medium text-charcoal` to `text-lg md:text-xl text-warm-gray` — now serves "Ready." rather than competing with it.

5. **Mobile responsive padding** — All interior sections now use responsive padding:
   - VillainSection: `py-16 md:py-28`
   - PivotSection: `py-16 md:py-28`
   - TimelineSection: `py-16 md:py-32`
   - HonestySection: `py-14 md:py-24`
   - InstallMoment: `py-14 md:py-24`
   - IdentityClose: `py-16 md:py-28`
   - TheClose: `py-14 md:py-24`

6. **Hero mobile height** — Changed `min-h-[85vh]` to `min-h-0 md:min-h-[85vh]`. Content-driven height on mobile eliminates dead space.

7. **Subsystems mobile gap labels** — Added inline gap label (`md:hidden`) above subsystem name so mobile users see the problem-solution frame.

8. **Villain closing copy sharpened** — "available" → "ever built", "It only works when you are sitting in front of it." → "It stops the moment you stop watching it." Second line rendered in `text-warm-gray` for ironic weight contrast.

9. **Identity Close typographic escalation** — Three closing lines now have distinct visual weights:
   - "will outship everyone." → `text-warm-gray text-lg` (statement)
   - "Not because they are better." → `text-warm-gray-light text-base` (diminishment)
   - "Because they never stop." → `text-charcoal text-xl font-semibold` (revelation)

10. **Hero feed footer de-hedged** — "your agents could be doing all of this" → "With DorkOS running, this is your overnight log." Removed conditional doubt.

**Build verified**: `pnpm turbo build --filter=@dorkos/web --force` passed
**Browser verified**: All changes rendering correctly at localhost:6244 (desktop)

---

## Round 3

### Panel Scoring Summary (Post-R2)

| Section    | Clarity | Emotion | Design | Conversion | Avg |
| ---------- | ------- | ------- | ------ | ---------- | --- |
| Hero       | 8.8     | 8.6     | 8.6    | 7.6        | 8.4 |
| Villain    | 9.0     | 9.4     | 8.0    | 8.0        | 8.6 |
| Pivot      | 8.8     | 7.8     | 8.2    | 7.0        | 7.9 |
| Timeline   | 8.8     | 9.2     | 8.0    | 7.6        | 8.4 |
| Subsystems | 7.0     | 4.8     | 7.0    | 5.4        | 6.0 |
| Honesty    | 9.0     | 7.6     | 7.8    | 7.0        | 7.9 |
| Identity   | 8.0     | 8.8     | 7.8    | 6.6        | 7.8 |
| Install    | 7.4     | 6.0     | 7.6    | 8.0        | 7.3 |
| TheClose   | 8.8     | 9.2     | 9.4    | 8.8        | 9.1 |

**Overall R3 Pre-Change Average: 7.9**

### Round 3 Consensus Findings

1. **Subsystems still weakest section** (5/5 unanimous) — Feature list after emotional high. Needs narrative headline.
2. **Remove cursor-blink from TheClose CTA** (3/5) — Two blinks cancel each other. "Ready." must be the singular event.
3. **InstallMoment triple redundancy** (4/5) — Trust badges, "Open source. Self-hosted. Yours.", and npm command all repeat the same idea.
4. **TheClose setup line passive** (4/5) — "Leave the rest to them" is passive where the page needs active voice.
5. **Honesty opening should lead with strength** (3/5) — Lead with what DorkOS controls, not limitations.
6. **Villain cards need surface weight** (2/5) — Cards vanish into cream background; need border and shadow.
7. **Wing "In development" undermines subsystems** (2/5) — Most emotionally resonant capability marked incomplete; move to last.

### Round 3 Changes Made

1. **TheClose setup line** — "Leave the rest to them." → "Give them the night." Active, specific, echoes "You slept. They shipped." register without repeating it.

2. **TheClose cursor-blink** — Removed `<span className="cursor-blink">` from CTA button. Only "Ready." blinks now. One blink, one meaning, complete authority.

3. **TheClose graph-paper opacity** — Increased from `rgba(139, 90, 43, 0.04)` to `rgba(139, 90, 43, 0.07)`. Stronger visual signal of "we are back at the beginning."

4. **Subsystems narrative headline** — Added `"Six reasons they run while you sleep."` in `text-[24px] md:text-[28px] font-medium text-charcoal` between label and list. Gives the section narrative purpose and anchors the reader before the reference table.

5. **InstallMoment trust badges** — Replaced flat text string with four individual badge pills (`Claude Agent SDK`, `Open Source`, `MIT Licensed`, `Self-Hosted`) using `background: rgba(232,93,4,0.06)`, `border: 1px solid rgba(232,93,4,0.12)`, `rounded-[3px]`. Removed redundant "Open source. Self-hosted. Yours." line.

6. **Honesty section rewrite** — Reversed paragraph order: now leads with what DorkOS controls (bold white), closes with "The intelligence is Claude's. The infrastructure is yours." Cut the third paragraph ("We believe in honest tools for serious builders."). Section is now two focused paragraphs instead of three.

7. **Villain card surface weight** — Added `border: 1px solid rgba(139, 90, 43, 0.1)` and `box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(139,90,43,0.06)`. Increased left accent border opacity from 0.15 to 0.3. Cards now read as real material objects, not floating text.

8. **Wing moved to last** in subsystems list — "In development" on the most emotionally resonant capability (memory) was undermining momentum mid-list. Now appears last where it serves as a teaser for what's coming.

**Build verified**: `pnpm turbo build --filter=@dorkos/web --force` passed
**Browser verified**: All changes rendering correctly on desktop (1440px) and mobile (375px)

---

## Final Assessment

### Score Progression

| Round     | Average              | Best Section    | Worst Section     |
| --------- | -------------------- | --------------- | ----------------- |
| R1 (Pre)  | 7.5                  | Villain (8.0)   | Subsystems (6.0)  |
| R2 (Pre)  | 6.9                  | Timeline (7.9)  | Subsystems (5.4)  |
| R3 (Pre)  | 7.9                  | TheClose (9.1)  | Subsystems (6.0)  |
| R3 (Post) | **~8.3** (estimated) | TheClose (9.1+) | Subsystems (7.0+) |

### Panel Consensus: Final Verdict

**TheClose** is world-class (9.1 average, highest on the page). "Ready." at 72px with a cursor blink, "Give them the night." setup, and graph-paper callback to the Hero closes the boot sequence narrative with authority.

**Villain** is the second strongest (8.6 average). "It stops the moment you stop watching it." was identified as THE line of the page — the sentence that defines the DorkOS brand.

**Timeline** is the emotional high-water mark (8.4 average). "Your agents have been productive for eight hours. You have been awake for four minutes." was identified by multiple panelists as the most screenshot-worthy line on the page.

**Hero** is strong (8.4 average). "You slept. They shipped." remains the best tagline. Activity feed provides evidence before arguments.

**Subsystems** improved with the narrative headline but remains the weakest section (~7.0 post-changes). The panel agreed it should eventually be absorbed into the Timeline as inline callouts or restructured as a visual architecture diagram rather than a reference table.

### Key Lines Identified by Panel

| Line                                                                                      | Location      | Panel Assessment                     |
| ----------------------------------------------------------------------------------------- | ------------- | ------------------------------------ |
| "It stops the moment you stop watching it."                                               | Villain close | **THE line** — defines the brand     |
| "You slept. They shipped."                                                                | Hero tagline  | Best tagline — don't touch           |
| "Your agents have been productive for eight hours. You have been awake for four minutes." | Timeline      | Screenshot moment                    |
| "So we built one."                                                                        | Pivot         | Typographic event earned             |
| "Because they never stop."                                                                | Identity      | Thesis statement                     |
| "Ready."                                                                                  | TheClose      | Boot sequence complete               |
| "Give them the night."                                                                    | TheClose      | Active, specific, echoes "You slept" |
| "The intelligence is Claude's. The infrastructure is yours."                              | Honesty       | Trust builder                        |

### Remaining Opportunities (Future Work)

1. **Subsystems architecture diagram** — Replace individual icons with a single connected SVG showing modules as nodes with dashed connecting lines
2. **Villain section-level illustration** — Terminal window SVG (abandoned terminal at 11:47pm) above the four cards
3. **Identity credential paragraph** — "Section 8 housing. Library books." paragraph deserves typographic distinction, not caption weight
4. **Hero CTA hierarchy** — Consider softening Hero install CTA to curiosity-based ("See what happens overnight") since trust hasn't been established yet
5. **Prelude skip affordance** — On slow connections, prelude could be perceived as broken rather than dramatic
