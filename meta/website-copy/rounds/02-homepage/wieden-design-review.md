# Design Review: Applying New Copy to Existing Site

**Dan Wieden — W+K**

---

## 1. Emotional Audit

I have spent time with this site. Every component. Every CSS variable. Every animation choice. Here is where I land.

### Where it succeeds

**The activity feed is doing real emotional work.** I did not expect this. My Round 2 vision was all negative space and darkness and letting words carry the weight. But this scrolling feed of agent actions — "Agent committed 3 files to feature/auth-flow," "Pulse filed your quarterly taxes 3 days before the deadline" — does something my copy alone cannot do. It makes the future _present tense_. The copy says "your agents could be doing this." The feed says "they already are, right now, while you read this." That is a powerful combination.

**The cream palette has warmth that serves the identity section.** The "Built by dorks" close needs warmth. My original dark-screen direction would have required a tonal shift at the identity section — warming the background, loosening the typography. This cream palette already lives in that warmth. The identity section will feel like it belongs here, not like a departure.

**The HonestySection with its corner brackets is genuinely good.** The brackets frame honesty like a code block. They say: this is literal. This is exact. This is the part we are not going to dress up. That mechanical framing around vulnerable copy — "we will not pretend" — is better design instinct than I would have given a developer-built site credit for.

**The graph-paper background in the hero** is the right texture metaphor. It says engineering. It says precision. It says someone measured this.

### Where it falls flat

**The headline "Your AI Never Sleeps" is doing zero emotional work.** It is a feature claim masquerading as a headline. No one feels anything reading it. Compare it to "Your agents are brilliant. They just can't do anything when you leave." The current headline tells you what the product does. The new headline makes you feel the waste of what you already have. That is the difference between information and advertising.

**The subhead is a list of features pretending to be a sentence.** "An open-source operating system for autonomous AI agents. Powered by an engine that never stops. Connected through an agent mesh." This is a spec sheet. Spec sheets do not make people lean forward. They make people scroll past.

**The "How It Works" section is procedural when it should be narrative.** Three numbered steps. Terminal blocks. This is documentation wearing a marketing hat. It belongs in the docs, not on the homepage. The new copy's timeline narrative (11:14pm through 7:04am) does the same job — shows you how to use it — but wraps it in a story you feel. The "How It Works" section explains. The timeline convinces.

**The UseCasesGrid ("What This Unlocks") is feature marketing from 2019.** Grid of capability cards. Title. Description. Repeat six times. This format was already tired before AI existed. It asks the reader to do the work of imagining themselves using it. The timeline does that work for them.

**The CredibilityBar ("Built on Claude Agent SDK / Open Source / MIT") is invisible.** Not because it is bad, but because it carries no emotional weight and sits in the most valuable real estate on the page — right after the hero. It is a factual footnote in a prime location.

**The ContactSection is fine but generic.** The `reveal_email` terminal interaction is a nice touch. But "Have feedback, want to contribute, or just say hello?" could be on any open-source project page ever made. It does not close the emotional arc the new copy opens.

---

## 2. Copy Replacement Map

Here is where every section of the synthesis lands in the existing component structure. I am being specific because specificity prevents drift.

### Section 0: Prelude ("DorkOS is starting.")

**New component.** A brief fullscreen overlay or top-of-hero element. Monospaced, center-screen on `bg-cream-primary`. Character-by-character render at terminal speed. Fades after 1.2s. On cream instead of black, this becomes a system POST message — the machine waking up in warm light rather than darkness. The graph-paper background behind it would reinforce the boot-sequence feel.

### Section 1: Hero

**Replaces: `ActivityFeedHero` headline, subhead, and eyebrow.** The activity feed panel stays (see Section 5 below). The headline becomes "Your agents are brilliant. They just can't do anything when you leave." The subhead becomes "the operating system for autonomous AI agents." The eyebrow becomes "You slept. They shipped." in place of "Autonomous by default." CTA group stays largely intact — npm install button, docs link.

### Section 2: The Villain

**Replaces: `UseCasesGrid` and `CredibilityBar`.** The four villain cards (Dead Terminal, Goldfish, Tab Graveyard, 3am Build) take the spot currently occupied by the use cases grid. Same scroll-reveal animation pattern, but the cards carry pain instead of features. The section header ("What your agents do when you leave. Nothing.") replaces the "What This Unlocks / Not features. Capabilities." copy. The CredibilityBar is removed — its facts move to the footer or a subtle line in the module reference section.

### Section 3: The Pivot

**Replaces: nothing — new section.** Inserted between the Villain and the Product. Centered text, large type. "We solved this for applications fifty years ago..." through "Your agents need the same thing." Uses the existing `REVEAL` + `STAGGER` motion variants. The cream-tertiary background from SystemArchitecture could work here, or keep cream-primary for continuity.

### Section 4: The Timeline

**Replaces: `HowItWorksSection`.** The three-step install procedure is replaced by the overnight narrative (11:14pm through 7:04am). Vertical timeline on the left, narrative on the right. Module names (`[PULSE]`, `[RELAY]`, `[MESH]`) appear inline in `text-brand-orange` monospaced type. The existing `TerminalBlock` component aesthetic (cream-secondary background, mono font, blinking cursor) can inform the timestamp styling.

### Section 5: Module Reference

**Replaces: `SystemArchitecture`.** The SVG connection diagram and grouped module cards are replaced by a tighter two-column table: the gap on the left, the fix on the right. Module names in monospaced orange. The existing card styling is too heavy for what is now reference material rather than a showcase. The architecture diagram SVG is removed — the timeline already showed the modules in action, which is more persuasive than a node graph.

### Section 6: The Install Moment

**New section, or absorb the CTA from the hero.** `npm install -g dorkos` with maximum breathing room. "Open source. Self-hosted. Yours." then "One person. Ten agents. Ship around the clock." The existing `marketing-btn` style and `cursor-blink` utility serve this perfectly. This section gets its own full-viewport moment.

### Section 7: Identity Close

**Replaces: `AboutSection`.** "Built by dorks. For dorks. Run by you." replaces "DorkOS is an autonomous agent operating system by Dork Labs." The philosophy cards grid is removed. The tribal copy fills the section instead. The closing line "The ones who care too much build the things that matter most" replaces "The name is playful. The tool is serious."

### Section 8: The Close

**Replaces: `ContactSection`.** "Your agents are ready. Leave the rest to them." followed by `Ready.` in monospaced brand-orange. The email reveal can move to the footer. The close should feel like the system completing its boot sequence, not like a contact form.

### HonestySection

**Moves, does not get removed.** See Section 3 below.

### Footer

**`MarketingFooter` stays** but gets updated copy. The retro brand stripes (orange + green) are perfect. Version badge stays. Add "You slept. They shipped." as the anchoring tagline. Remove the "System Online" text or make it dynamic. The email contact moves here from the removed ContactSection.

---

## 3. What I Would Fight to Change

Even within the existing palette, fonts, and responsive approach, these elements need to shift to serve the new copy.

### The hero must lead with words, not with the feed

Right now the layout is 55% left (copy) / 45% right (activity feed). The feed dominates visual attention on desktop. For the new copy to land — for "Your agents are brilliant. They just can't do anything when you leave" to hit someone in the chest — the headline needs to own the viewport first. I would flip the visual weight: headline at full width across the top of the hero, subhead below it, and the activity feed panel underneath both, spanning full width or positioned as a secondary element. The feed proves the headline. It should not compete with it.

### Section ordering must follow the emotional arc

Current order: Hero, CredibilityBar, System Architecture, Use Cases, How It Works, Honesty, About, Contact.

New order: Prelude, Hero (with feed), Villain, Pivot, Timeline, Module Reference, Install Moment, Honesty, Identity Close, Close, Footer.

The critical change: **HonestySection moves to after the Install Moment.** In the current site, honesty comes before the about section — it feels like a disclaimer buried in the middle. In the new arc, the reader has just seen the vision (timeline), understood the system (modules), and reached the moment of decision (install). _That_ is when honesty hits hardest. "Claude Code uses Anthropic's API for inference. Your code context is sent to their servers." Right after the install command. That is not a disclaimer. That is confidence. You tell the truth when you have nothing to hide.

### The villain cards need to feel different from the module cards

The current `ModuleCard` component has spotlight cursor-tracking, spring lift hover, and status badges. That premium card treatment is right for modules. The villain cards need to feel like system alerts — flatter, tighter, with a left-border accent in a muted red or warm gray. The existing `FeedItem` styling (left border highlight, monospaced text, tight spacing) is closer to the right feel for villain cards than the module cards are.

### The timeline needs a vertical rhythm the current site does not have

Every section in the current site is horizontally centered with generous vertical padding (py-32 to py-40). The timeline is the one section that needs asymmetry — timestamps on the left, narrative on the right, a thin vertical line connecting them. The existing motion variants (`REVEAL`, `STAGGER`) handle the scroll-activation fine. But the layout needs to break the centered symmetry of the rest of the page. This is the section where the reader should feel time passing.

### The install moment needs isolation

The current site embeds the npm install command in the hero CTA group, competing with docs links and GitHub links. The new copy demands a dedicated section where `npm install -g dorkos` sits alone with 120-160px of vertical space on each side. On the cream palette, this could use a slightly darker band — `bg-cream-tertiary` or even `bg-charcoal` with cream text — to create the gravitational weight the command deserves.

---

## 4. What Works Better Than Expected

I came into this review expecting to argue for a complete aesthetic overhaul. I was wrong about several things.

### The cream palette is better for the timeline than dark would be

My Round 2 vision had timestamps in warm white on near-black. But the cream palette makes the timestamps feel like they belong to a logbook — a physical artifact, something you would read with coffee in the morning. The synthesis mentions "You review the diffs with coffee" at 7:00am. A cream background makes that feel literal. Dark backgrounds make timelines feel cinematic. Cream makes them feel real. Real is better for a product that actually exists and costs $4.20 overnight.

### IBM Plex Mono is better than JetBrains Mono for this copy

The synthesis specified JetBrains Mono. But IBM Plex Mono has a warmth to it — slightly rounded terminals, a humanist quality — that matches the "built by dorks" identity better. JetBrains Mono is clinical. Plex Mono is clinical with a personality. The existing font choice is correct. Do not change it.

### The brand orange (#E85D04) carries more emotion than amber

The synthesis design system specified "muted amber" (#D4A843). The existing brand orange is hotter, more urgent, more alive. For module names in the timeline, for the blinking cursor, for the "You slept. They shipped." tagline — orange says _this matters_ where amber says _this is nice_. Keep the orange.

### The motion variants are appropriately restrained

The existing `REVEAL` (opacity + translateY) and `STAGGER` (sequential children) are exactly what the new copy needs. No springs, no bounce, no overshoot. Things appear. They do not perform. This matches my original direction: "Things switch on. They do not bounce, slide, or wave." The current codebase already does this.

### The graph-paper hero background serves the pivot section too

"We solved this for applications fifty years ago" is an engineering argument. The faint graph-paper grid says: this is where things get built. If the pivot section uses the same background texture (or a subtle variation), it visually connects the hero's promise to the pivot's reasoning. The texture does structural work without calling attention to itself.

---

## 5. The Activity Feed Question

This is the one that kept me up.

**The activity feed helps the new copy. But it must not lead.**

Here is why it helps: the new hero headline names a problem ("they can't do anything when you leave"). The activity feed is the immediate counter-evidence. Before the reader even scrolls, the feed is showing agents committing code, fixing CI, filing taxes, booking appointments. The headline says "this is broken." The feed says "not anymore." That tension is more powerful than either element alone.

Here is why it must not lead: the current layout gives the feed equal or dominant visual weight. On a first visit, the eye goes to the moving element. If the reader sees the feed before they read the headline, they see a feature demo. They do not feel the problem. They jump straight to the solution without ever feeling the wound.

**My recommendation:** Restructure the hero so the headline and "You slept. They shipped." tagline own the top 60% of the viewport. Full width. No competition. Below that, the activity feed panel appears — still in the hero section, still above the fold on desktop, but subordinate to the words. On mobile, this is already the natural order (prose then feed then CTA). On desktop, make the headline span full width at the top, with the feed below or offset to the right at reduced visual scale.

The feed's footer line — "While you read this, your agents could be doing all of this" — is quietly devastating with the new headline above it. Keep it. The "Simulated" disclaimer below the panel is the kind of honesty that builds trust. Keep that too.

One more thing: the activity pool should be trimmed. "Mesh coordinating world domination — ETA 47 minutes" undermines the emotional seriousness the new copy builds. The funny entries were fine when the headline was generic. With "Your agents are brilliant. They just can't do anything when you leave" setting a specific emotional tone, every feed entry needs to reinforce the feeling that _this is real, this is happening, this is what you are missing_. Cut the jokes. Keep the ambition.

---

## Summary: The Three Moves That Matter Most

1. **Headline owns the viewport.** The activity feed becomes proof, not the star. Words first, evidence second.

2. **Section order follows the emotional arc.** Problem (villain) before solution (timeline). Honesty after the install moment, not buried in the middle. Identity close replaces the generic about section.

3. **The cream palette stays.** It is warmer, more human, and more honest than the dark-screen vision. The copy is strong enough to carry itself on cream. It does not need darkness to feel serious.

The copy does the hard work. The design system is already good enough to hold it. The job now is to get out of the copy's way.

---

_"The best advertising does not look like advertising. It looks like someone finally said the thing you already knew was true."_
