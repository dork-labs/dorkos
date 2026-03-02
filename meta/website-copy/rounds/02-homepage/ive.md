> **Editorial note (2026-03-02):** This is a historical creative artifact. Some framings have been superseded by the pro-human positioning shift. See `meta/brand-foundation.md` > "Human-Empowerment Positioning" and `meta/website-copy/decisions.md` > Decision 16 for current positioning guidelines.

# DorkOS Homepage — Jony Ive

---

## Overarching Design Philosophy

The page is a single, continuous surface. Dark. Not themed dark — dark the way a display is dark before power reaches it. The experience is one of activation: the user does not scroll through a marketing site. They watch a system come online. Each section is a subsystem revealing itself — not animating in from the margins, but transitioning from dormant to present, the way an instrument panel illuminates.

The palette begins at near-black (`#0A0A0A`) and introduces light only as content activates. Accent color is a restrained warm white (`#F5F5F0`) for primary text, with a single functional color — a muted amber (`#D4A843`) — used exclusively for status indicators and the install command cursor. No gradients. No glows. Color is information, not decoration.

Typography uses two voices only: a monospaced face (JetBrains Mono or Berkeley Mono) for system language — module names, code, status lines, the install command — and a clean geometric sans-serif (Inter or Neue Haas Grotesk) for human explanation. The tension between these two voices is the texture of the entire page. It is the interface between what the machine says and what the developer understands.

Spacing follows an 8px grid with extreme generosity. Sections are separated by 160-200px of negative space. This is not emptiness. It is the space between components on a board — structural, intentional, load-bearing.

All scroll-triggered transitions are opacity and subtle vertical translation (8-12px). No springs. No bounces. No easing curves that call attention to themselves. The motion language is: *appear*, the way a status line appears on a terminal. Duration: 400-600ms, ease-out.

The background carries the faintest suggestion of a dot grid — not illustrative, structural. Like the substrate beneath a circuit board. It is visible only on the darkest sections and fades as content brightens. It says: this is a surface designed to hold systems.

---

## Section 0: Prelude

**What appears:**

```
DorkOS is starting.
```

A single monospaced line, center-screen, on black. It holds for 1.2 seconds. Then it fades — not disappears, fades — as the hero section activates beneath it.

**Design direction:** This is not a splash screen. It is the first frame of the experience. The text appears character by character at terminal speed (not typewriter-effect slow — fast, like a real system message). No logo. No navigation. Just the statement. The nav bar fades in only after this line completes. The user's first impression is not of a website. It is of something turning on.

**Typography:** JetBrains Mono, 16px, `#F5F5F0` on `#0A0A0A`. Letter-spacing: 0.02em. No period animation. The period is there from the start — this is a system message, not a dramatic pause.

---

## Section 1: Hero — The Problem

*Above the fold. The gap.*

### Option A: Short-Form Hero

**Headline:**

> Your agents are the best developers you have ever worked with.
> They cannot do a single thing when you close the laptop.

**Design direction:** Two lines. The first lands with warmth and recognition. The second lands with the weight of a door closing. Set in the geometric sans-serif, 48-56px on desktop, 32-36px on mobile. Line height: 1.15. The line break between sentences is intentional and structural — not a paragraph break, a breath. The first line renders at full contrast (`#F5F5F0`). The second at slightly reduced opacity (85%) — it is the quieter, heavier truth.

Centered on the page. No image. No illustration. The words are the hero.

### Option B: Long-Form Hero

**Headline:**

> You gave the most capable developer who ever existed
> no schedule, no memory, no way to reach you,
> and a terminal that closes when you look away.

**Subhead (slightly smaller, 60% opacity):**

> That is not an intelligence problem.

**Design direction:** Three lines that build the absurdity. Set at 40-48px, geometric sans-serif. Each clause is a new indictment. The subhead appears 200ms after the headline completes its fade-in — a deliberate pause before the reframe. It is set smaller (24px), at reduced opacity, and it does the work of pivoting the reader's frame without stating the answer. The answer comes later. Here, we are only naming what is broken.

---

**Shared elements for both options:**

**Tagline** (below the headline, after a 48px gap):

```
You slept. They shipped.
```

Set in monospaced type, 18-20px. This is the identity line. It is not a headline. It is a stamp — the compression of the entire product into six words. Treated typographically like a system output, not a marketing slogan. Muted amber (`#D4A843`) or warm white at 70% opacity.

**Position line** (below tagline, after 24px gap):

> The operating system for autonomous AI agents.

Geometric sans-serif, 16px, 50% opacity. This is the category declaration. It does not shout. It is metadata — the kind of line you read and nod at, not the kind that convinces you.

**Navigation** fades in after the prelude completes. Minimal: wordmark left, a single `Install` link right (anchors to the install section). No hamburger. No dropdown. The page is one continuous scroll. The nav is a courtesy, not a structure.

---

## Section 2: The Villain — Recognition

*First scroll. Name the specific pain.*

**Section transition:** As the user scrolls past the hero, a thin horizontal rule activates — 1px, `#F5F5F0` at 8% opacity — spanning 60% of the viewport width. This is the structural separator between sections. It does not decorate. It divides.

**Design direction:** Four pain moments, presented as a vertical sequence. Each one is a card — but not a card with a border and a shadow. A card in the sense of a region of elevated contrast against the dark field. Each activates on scroll: opacity from 0 to 1, vertical translation of 8px. Staggered by 100ms.

The layout is a single column, left-aligned, max-width 640px, centered on the page. Each moment has a monospaced label (the name) and a single sentence of human explanation beneath it.

---

**The Dead Terminal**

Your agent finished at 2:47am. Produced clean code. Opened a PR. Told no one. You found it three days later by accident.

**The Goldfish**

"Let me give you some context..." You have typed this sentence a hundred times. Every session begins from zero. Your agent is brilliant and has the memory of a fruit fly.

**The Tab Graveyard**

Five projects. Ten agents. Fifteen terminal windows. You cannot remember which is running, which is stuck, which finished an hour ago and is waiting for you to notice.

**The Flow Killer**

Forty minutes into an architecture document. You need one thing from the codebase. Alt-tab. Terminal. Three paragraphs of context. The flow is gone. Fifteen minutes to find where you were.

---

**Design direction for each card:**

- **Label:** JetBrains Mono, 13px, uppercase, letter-spacing 0.08em, muted amber (`#D4A843`). This is the system name for the pain.
- **Body:** Geometric sans-serif, 18-20px, `#F5F5F0` at 90% opacity, line-height 1.5. Short. Specific. Felt. No abstractions.
- **Spacing:** 64px between cards. Each card breathes.

The overall feeling should be a diagnostic readout — the system is scanning for problems before it proposes solutions. The user is not being sold to. They are being understood.

---

## Section 3: The Pivot

*Earned. Mid-page. After the emotional setup.*

**A moment of stillness.** After the four villain cards, 120px of empty space. Then:

> We solved this for applications fifty years ago.
> We called it an operating system.

**Design direction:** Geometric sans-serif, 32-36px. Centered. Two lines. Full contrast. This is the single most important reframe on the page, and it earns its weight because of everything that preceded it. It is not an argument. It is a recognition — the user should feel the click of something falling into place.

Below it, after 32px, a single quiet line:

> Your agents need the same thing.

16px, 50% opacity. Then the page transitions to the product section.

**Background shift:** The dot grid substrate fades completely here. The background lightens almost imperceptibly — from `#0A0A0A` to `#0D0D0D`. The page is waking up. The diagnosis is complete. What follows is the architecture.

---

## Section 4: The Product — Timeline Narrative

*The night that changes everything.*

**Section header** (monospaced, 13px, uppercase, letter-spacing 0.08em, muted amber):

```
A NIGHT WITH DORKOS
```

**Design direction:** The timeline is presented as a vertical sequence of moments, each anchored by a timestamp in monospaced type. The timestamps are left-aligned in a narrow column (80px). The narrative text is offset to the right. A thin vertical line (1px, `#F5F5F0` at 6% opacity) connects the timestamps — a literal timeline, understated. Each moment activates on scroll.

---

**11:14 PM**

You queue the overnight tasks. Three features across two repos. A refactoring pass on the auth module. You type the cron expressions. Pulse confirms: schedules active.

*Design note: On the word "Pulse," the module name appears in monospaced amber — the first time a module name surfaces. It is not introduced. It simply appears, named, functional.*

**11:15 PM**

You close the laptop. You go to sleep.

*Design note: This is the shortest entry. Two sentences. Maximum whitespace around it. The brevity is the point — it is the moment of letting go. The vertical timeline line continues through the empty space.*

**2:47 AM**

CI breaks on the auth service. Pulse detects the failure. It spins up an agent. The agent reads the error, traces the regression, opens a fix. Relay sends you a summary on Telegram. You do not see it until morning.

*Design note: This is where the system earns trust. The language is factual, not dramatic. Each sentence is a step in a process. "Relay" appears in monospaced amber — second module surfaced. The reader is watching infrastructure work.*

**6:12 AM**

A second agent finishes the feature branch on the payments service. It runs the test suite. Green. It opens a PR and tags you for review. Mesh logs the activity so every agent in the network knows the payments service was just updated.

*Design note: "Mesh" surfaces. Three modules have now appeared without a single feature list or comparison table. They arrived as actors in a story.*

**7:00 AM**

You open your laptop. Console shows the night at a glance: three PRs ready for review, one CI fix merged, auth refactor at 80% — waiting on a design question it queued for you. The overnight cost: $4.20 in API calls.

*Design note: "Console" surfaces. The cost figure is specific and grounding — it makes the scenario real, not aspirational. Set the cost in monospaced type at reduced opacity, like a line item.*

**7:02 AM**

You review the PRs with coffee. You approve two. You leave a note on the third. Your agents have already started the next iteration.

*Design note: This is the closing beat. It is quiet. The developer is in control — reviewing, approving, directing. The agents are collaborators who worked through the night. The human leads. The timeline ends here, without a punctuation mark of triumph. Just the morning, continuing.*

---

**Typography for timestamps:** JetBrains Mono, 14px, `#F5F5F0` at 40% opacity. They are reference points, not headlines.

**Typography for narrative:** Geometric sans-serif, 17-18px, `#F5F5F0` at 85% opacity, line-height 1.6. The tone is observational. Present tense. No exclamation. No amazement. Just: this is what happens.

**Module names inline:** JetBrains Mono, same size as body text, muted amber. They glow faintly — not literally, but in contrast to the surrounding warm white. They are the named components of a system the reader is watching operate.

---

## Section 5: The Module Reference

*For the architect who needs the map.*

**Section transition:** After the timeline, 80px of space, then a horizontal rule (same style as Section 2). Then:

**Header** (monospaced, 13px, uppercase, letter-spacing 0.08em, muted amber):

```
SUBSYSTEMS
```

**Design direction:** A compact, two-column layout. Left column: the gap (what is broken). Right column: the module name and one-line description. Six rows. No borders. Rows are separated by 1px lines at 4% opacity. The entire table is restrained — max-width 720px, centered.

Each row activates on scroll with a subtle status indicator: a small circle (6px) to the left of the module name that transitions from dark to amber as the row enters the viewport. The feeling: subsystems coming online.

---

| | |
|---|---|
| **No schedule** | **Pulse** — Cron-based autonomous execution. Your agents run while you sleep. |
| **No communication** | **Relay** — Built-in messaging. Telegram, webhooks, inter-agent channels. Your agents reach you. |
| **No coordination** | **Mesh** — Agent discovery and network. Your agents find each other and collaborate. |
| **No memory** | **Wing** — Persistent context across sessions. Your agents remember. `Coming soon` |
| **No oversight** | **Console** — Browser-based command center. You see everything, from anywhere. |
| **No feedback loop** | **Loop** — Signal, hypothesis, dispatch, measure. Your agents improve. |

---

**Typography — left column (the gap):** Geometric sans-serif, 15px, `#F5F5F0` at 50% opacity. These are the problems. They are muted — already diagnosed, no longer urgent.

**Typography — right column (the fix):** Module name in JetBrains Mono, 15px, muted amber. Description in geometric sans-serif, 15px, `#F5F5F0` at 80% opacity. The module name has weight. The description is functional.

**"Coming soon" on Wing:** Set in monospaced, 11px, `#F5F5F0` at 30% opacity, inline after the description. No badge. No fanfare. It is a status indicator — this subsystem is not yet online. Honest.

---

## Section 6: The Install Moment

*Maximum desire. The action.*

**Design direction:** This is the gravitational center of the page. Everything above has been building to this moment. The background shifts one final time — from `#0D0D0D` to `#111111`. The faintest increase in warmth. The system is ready.

160px of empty space above. Then, centered:

```
$ npm install -g dorkos
```

**Typography:** JetBrains Mono, 24-28px, `#F5F5F0` at full contrast. The dollar sign and space are at 30% opacity — they are the terminal prompt, not the command. A blinking cursor (muted amber, 500ms interval) follows the last character. The cursor is the invitation. It says: *this is where you begin.*

The command sits alone. No button wraps it. No "Get Started" label. No box. It is a terminal prompt with 80px of negative space on every side. The gravity comes from isolation — it is the only actionable element on the entire page, and by this point, the user knows exactly why they would type it.

**Below the command** (48px gap):

> Open source. Self-hosted. Yours.

Geometric sans-serif, 16px, `#F5F5F0` at 50% opacity. Centered. Three statements. Three periods. These are not selling points. They are properties — the way you would describe the material composition of an object. This is what it is made of.

**Below that** (24px gap):

> One person. Ten agents. Ship around the clock.

Geometric sans-serif, 16px, `#F5F5F0` at 40% opacity. Centered. This is the after-picture, compressed to one line. It does not persuade. It states a possibility.

---

## Section 7: The Identity Close

*Not a footer. An invitation.*

**Design direction:** The background returns to pure black (`#0A0A0A`). The dot grid substrate reappears, faintly. We have come full circle — from the dark before the system booted to the dark after it has finished initializing. But now the dark is populated. The system is running.

80px of space. Then, centered:

> Built by dorks. For dorks. Run by you.

**Typography:** Geometric sans-serif, 28-32px, `#F5F5F0` at full contrast. This line has been waiting for this moment since the start of the page. It lands now because the reader has seen the system, felt the problems, watched the solution activate. They know what a dork is in this context. They know it means: the kind of person who has opinions about cron expressions and message routing at 3am. The kind of person who builds things.

**Below it** (48px gap), a brief origin line:

> One developer. Section 8 housing. Library books. Code before graduation.
> Thirty million users. An exit in twelve months. Warner Bros. Art Blocks.
> And then this — because the tools that matter most are built by the people who need them.

**Typography:** Geometric sans-serif, 15px, `#F5F5F0` at 45% opacity, line-height 1.7, max-width 560px, centered. This is provenance — not biography. It is the maker's mark pressed into the underside of the object. Present. Understated. It explains nothing about DorkOS directly. It says: the person who built this has always built things that one person should not be able to build. And now they are giving you the same capability.

**Below that** (64px gap), the tribal invitation:

> The developers building agent teams will outship everyone.
> Not because they are better.
> Because they never stop.

**Typography:** Geometric sans-serif, 18px, `#F5F5F0` at 70% opacity, centered. This is the boldness dimension — the invitation, not the taunt. It does not mock anyone. It states a trajectory. The reader decides which side of it they are on.

---

**Final element.** After 80px of space, centered, monospaced:

```
Ready.
```

JetBrains Mono, 16px, muted amber. A period. The system has finished initializing. The boot sequence is complete. The page is done — not because it ran out of things to say, but because the system is now running and waiting for input.

This is the last thing the user sees before the footer.

---

## Footer

**Design direction:** Minimal. A thin horizontal rule (1px, 4% opacity). Below it, a single row:

Left: `DorkOS` wordmark (monospaced, 14px, 40% opacity)
Center: Links — `GitHub` | `Docs` | `Discord` (geometric sans-serif, 13px, 35% opacity)
Right: `v0.4` (monospaced, 13px, 25% opacity)

No email signup. No newsletter. No social icons beyond what is functional. The footer is a colophon — the last page of a well-made book. It confirms what this is and where to find it. Nothing more.

---

## The Line I Would Add

> The quiet part is the architecture.

This belongs nowhere specific yet — it is a line for the brand, not for a section. It captures what I believe about DorkOS at the deepest level: the reason this product matters is not the features that are visible. It is the structure beneath them. The scheduling, the messaging, the discovery, the memory — these are not loud capabilities. They are the quiet infrastructure that makes everything else possible.

An operating system is, by definition, the thing you do not see. The quiet part. And architecture — both in software and in the physical world — is the discipline of making the invisible structure so right that everything built upon it feels inevitable.

Use it in the README. Use it as an internal motto. Use it on the second sticker, the one for the people who stayed long enough to understand what this actually is.

---

## Summary of New Copy

| Element | Copy |
|---|---|
| **Prelude** | `DorkOS is starting.` |
| **Hero A** | Your agents are the best developers you have ever worked with. / They cannot do a single thing when you close the laptop. |
| **Hero B** | You gave the most capable developer who ever existed / no schedule, no memory, no way to reach you, / and a terminal that closes when you look away. |
| **Hero B subhead** | That is not an intelligence problem. |
| **Tagline** | You slept. They shipped. |
| **Position** | The operating system for autonomous AI agents. |
| **Villain cards** | The Dead Terminal / The Goldfish / The Tab Graveyard / The Flow Killer |
| **Pivot** | We solved this for applications fifty years ago. We called it an operating system. / Your agents need the same thing. |
| **Timeline header** | A NIGHT WITH DORKOS |
| **Timeline** | 11:14 PM through 7:02 AM (six moments) |
| **Module header** | SUBSYSTEMS |
| **Module table** | Six gap/fix pairs |
| **Install** | `$ npm install -g dorkos` |
| **Trust line** | Open source. Self-hosted. Yours. |
| **Scale line** | One person. Ten agents. Ship around the clock. |
| **Identity** | Built by dorks. For dorks. Run by you. |
| **Origin** | One developer. Section 8 housing... |
| **Boldness** | The developers building agent teams will outship everyone. / Not because they are better. / Because they never stop. |
| **Close** | `Ready.` |
| **New line** | The quiet part is the architecture. |
