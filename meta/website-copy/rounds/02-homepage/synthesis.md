# Round 2 Synthesis: The Homepage

## What Happened

All five agents delivered full homepage copy with design direction notes. The convergence from Round 1 held: every agent followed the same structure (hero → villain → pivot → timeline → modules → install → identity) and respected all constraints. No employment language appeared anywhere. "You slept. They shipped." is well-placed across all versions.

The differences are in voice, rhythm, and the details that make each section land.

---

## The Best-Of Synthesis

What follows is the recommended homepage copy, pulling the strongest version of each section from across all five agents.

---

## Section 0: Prelude

**Source: Ive**

```
DorkOS is starting.
```

_Design direction: A single monospaced line, center-screen, on black. Holds for 1.2 seconds, then fades as the hero section activates beneath it. Character-by-character at terminal speed (fast, not typewriter-slow). No logo. No navigation. Just the statement. Navigation fades in after this line completes._

**Why this works:** It sets the tone for the entire hybrid approach — the user's first impression is not of a website but of something turning on. Brief enough to not feel like a loading screen. Strong enough to prime the boot-sequence aesthetic.

---

## Section 1: Hero — The Problem

### Option A: Short-Form

**Source: Jobs**

> # Your agents are brilliant.
>
> # They just can't do anything when you leave.

`the operating system for autonomous AI agents`

**You slept. They shipped.**

**Why Jobs wins short-form:** Two lines. First builds warmth ("brilliant"). Second drops the floor out ("when you leave"). The pause between recognition and gut-punch is perfect. No wasted syllable.

**Editorial note (2026-03-02):** "When you leave" centers human absence as the problem. Consider reframing: the issue is the missing coordination layer, not the human stepping away. An empowerment-focused alternative: "Your agents are brilliant. They just have no way to coordinate." See `decisions.md` Decision 16.

---

### Option B: Long-Form

**Source: Wieden**

> # You closed the laptop at 11pm. The smartest developers you've ever worked with sat in the dark for eight hours, waiting for permission to think.

**You slept. They shipped.**

The operating system for autonomous AI agents.

**Why Wieden wins long-form:** It's a scene, not a statement. You feel the waste before you finish reading. The clock detail (11pm, eight hours) is specific enough to be a memory. "Waiting for permission to think" is devastating — it names the absurdity without explaining it.

**Editorial note (2026-03-02):** "Waiting for permission to think" frames human presence as gatekeeping — as if the human is the obstacle. The pro-human positioning reframes this: the agents aren't waiting for the human; the coordination layer is missing. Consider: "The smartest tools you've ever used had no way to keep working — because nothing connected them." See `decisions.md` Decision 16.

---

_Design direction (from Ive): The page opens dark — not decoratively, dark the way a screen is dark before power reaches it. Headline in geometric sans-serif, 48-56px. Tagline in monospaced type, muted amber or warm white at 70% opacity — treated like a system output, not a marketing slogan. Position line at 50% opacity below. No images. No illustrations. The words are the hero. 160-200px of negative space below._

---

## Section 2: The Villain — Recognition

**Section header — Source: Wieden**

> **What your agents do when you leave.**
>
> Nothing.

_Design direction: Four cards, each activating on scroll — opacity from 0 to 1, 8px vertical translation, staggered by 100ms. Monospaced labels in muted amber. Body in sans-serif at 90% opacity. 64px between cards. The feel: a diagnostic readout. The system is scanning before it proposes._

**Card 1: The Dead Terminal** — Source: Ogilvy

> Your agent finished at 11:47pm. Clean code. Tests passing. PR ready. Then the terminal closed. The work sat there for three days until you found it by accident.
>
> Your best teammate shipped — and had no way to tell you.

**Card 2: The Goldfish** — Source: Jobs

> `session_start` "Let me give you some context..."
>
> You have typed this sentence four hundred times. Every session begins at zero. Every session, you re-introduce yourself to something that was brilliant five minutes ago.

**Card 3: The Tab Graveyard** — Source: Wieden

> Ten agents. Ten terminals. One of them is waiting for approval. One finished twenty minutes ago. One broke something. You are alt-tabbing between them like it is 2005 and you are managing browser bookmarks.

**Card 4: The 3am Build** — Source: Wieden

> CI went red at 2:47am. The fix was three lines of code. Your agent knew exactly what to do. Your terminal was closed. The build stayed red until morning.

_Note: Wieden's "3am Build" replaces the "Flow Killer" card. It's more emotionally aligned with the tagline and the timeline that follows. The flow-killer pain point can surface elsewhere (docs, secondary pages)._

**Below the cards — Source: Ogilvy (modified)**

> You pay for the most powerful AI coding agent available.
> It only works when you are sitting in front of it.

---

## Section 3: The Pivot

**Source: Jobs (expanded), with Ive's follow-up**

> We solved this for applications fifty years ago.
>
> Processes needed scheduling. We built cron.
> Processes needed communication. We built IPC.
> Processes needed discovery. We built registries.
> Processes needed memory. We built filesystems.
>
> We called it an operating system.
>
> Your agents need the same thing.

_Design direction (Ive): Centered. Geometric sans-serif, 32-36px for the main lines. The build-up (cron, IPC, registries, filesystems) at smaller size, 60% opacity — it's the structural argument that makes the OS metaphor feel earned, not claimed. "Your agents need the same thing." at 50% opacity, 16px. The background lightens almost imperceptibly — from #0A0A0A to #0D0D0D. The page is waking up._

**Why Jobs' expanded version wins:** The four-line build-up (cron → IPC → registries → filesystems) does the work of turning "operating system" from a metaphor into an inevitability. The reader doesn't need to be told it's an OS. They discover it.

---

## Section 4: The Product — Timeline Narrative

**Section header — Source: Ive**

```
A NIGHT WITH DORKOS
```

_Design direction (Ive): Vertical timeline. Timestamps in monospaced type at 40% opacity, left-aligned. Narrative offset to the right. A thin 1px vertical line connects timestamps. Module names appear inline in monospaced amber — they surface as actors in the story, never introduced as a list. Each moment activates on scroll._

---

**11:14 PM** — Source: Composite (Jobs + Ogilvy)

You queue three tasks. A test suite that needs expanding. A dependency upgrade across two services. A refactor you've been putting off.

You type one command. Pulse schedules all three.

You close the laptop.

---

**11:15 PM** — Source: Jobs

The first agent picks up the test suite. It reads the coverage report, identifies the gaps, starts writing.

You are brushing your teeth.

---

**2:47 AM** — Source: Wieden + Jobs

CI breaks on the dependency upgrade. Pulse detects it. Dispatches an agent. The agent reads the error, traces the cause, opens a fix. Tests go green.

Your phone buzzes once. A Telegram message from Relay: "CI was red. Fixed. PR #247 ready for review."

You do not see it until morning.

---

**2:48 AM** — Source: Jobs

The agent that fixed CI notices the test suite agent is working in the same service. Mesh routes a coordination signal — one waits for the other to merge first, avoiding a conflict.

No human involved. No terminal open.

---

**7:00 AM** — Source: Ive

You open your laptop. Console shows the night at a glance: three PRs ready for review, one CI fix merged, the refactor at 80% — waiting on a design question it queued for you. The overnight cost: $4.20 in API calls.

---

**7:04 AM** — Source: Wieden

You approve two PRs. You request a change on the third. You queue two more tasks for the day.

The system you designed has been productive for eight hours. You've been awake for four minutes.

---

_Note: Ive's $4.20 cost detail is the synthesis MVP. It grounds the entire narrative in reality — this isn't aspirational, it's a Tuesday night that costs less than a latte. Wieden's "four minutes" close is the emotional payoff._

---

## Section 5: Module Reference

**Source: Ive's structure + Ogilvy's descriptions**

```
SUBSYSTEMS
```

_Design direction (Ive): Compact two-column layout, max-width 720px. Each row activates with a subtle 6px status indicator transitioning from dark to amber. No borders — rows separated by 1px lines at 4% opacity._

|                      |                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| **No schedule**      | **Pulse** — Cron-based autonomous execution. Your ideas keep moving forward.                     |
| **No communication** | **Relay** — Built-in messaging. Telegram, webhooks, inter-agent channels. Your agents reach you. |
| **No coordination**  | **Mesh** — Agent discovery and network. Your agents find each other and collaborate.             |
| **No memory**        | **Wing** — Persistent context across sessions. Your agents remember. `Coming soon`               |
| **No oversight**     | **Console** — Browser-based command center. You see everything, from anywhere.                   |
| **No feedback loop** | **Loop** — Signal, hypothesis, dispatch, measure. Your agents improve.                           |

---

## Section 6: The Install Moment

**Source: Ive's design + Ogilvy's copy**

_Design direction (Ive): The gravitational center of the page. Background shifts to #111111 — the faintest warmth. 160px of space above. The command sits alone: JetBrains Mono, 24-28px, full contrast. Dollar sign at 30% opacity. A blinking amber cursor follows the last character. No button. No box. 80px negative space on every side._

```
$ npm install -g dorkos
```

Open source. Self-hosted. Yours.

One person. Ten agents. Ship around the clock.

---

## Section 7: The Identity Close

**Opening — Source: Wieden**

> **Built by dorks. For dorks. Run by you.**

> Dork was never an insult to us.
>
> It is what you call someone who cares too much about something most people do not care about at all. Someone who has opinions about cron expressions. Someone who names their agents. Someone who wakes up at 6am to check a CI pipeline that nobody asked them to check.
>
> We build at 3am because we cannot stop. Not because someone is paying us to. Because the problem is right there and walking away from it feels worse than staying up.

**Origin — Source: Ive**

> One developer. Section 8 housing. Library books. Code before graduation.
> Thirty million users. An exit in twelve months. Warner Bros. Art Blocks.
> And then this — because the tools that matter most are built by the people who need them.

**Boldness invitation — Source: Ive (updated 2026-03-02)**

> You've always had more ideas than hours.
> That ratio just changed.
> The builders who coordinate their agents will ship what they've always imagined.

_Original copy: "The developers building agent teams will outship everyone. / Not because they are better. / Because they never stop." Updated to align with pro-human positioning — empowerment over competitive framing. See `decisions.md` Decision 16._

_Design direction (Ive): Background returns to #0A0A0A. The dot grid reappears faintly. The tribal line at 28-32px, full contrast. The origin at 15px, 45% opacity — provenance, not biography. The boldness invitation at 18px, 70% opacity — trajectory, not taunt._

---

## Section 8: The Close

**Source: Wieden + Ive**

> Your agents are ready. Your ideas keep moving forward.

_Editorial note (2026-03-02): Original was "Your agents are ready. Leave the rest to them." — reframed because "leave the rest to them" implies the human's role is done or lesser. The new framing centers the human's vision continuing through the system they built._

Then, after 80px of space, centered, monospaced:

```
Ready.
```

_Design direction (Ive): "Ready." in monospaced amber, 16px. A period. The boot sequence is complete. The system is running and waiting for input. This is the last thing the user sees before the footer._

---

## Footer

**Source: Godin/Ive**

Left: `DorkOS` wordmark (monospaced, 14px, 40% opacity)
Center: `GitHub` | `Docs` | `Discord` (sans-serif, 13px, 35% opacity)
Right: `v0.4` (monospaced, 13px, 25% opacity)

Anchored by: **You slept. They shipped.**

No email signup. No newsletter. No social icons beyond what's functional.

---

## New Lines Worth Keeping

All five agents delivered strong new lines. Here's the full set, ranked by utility:

| Line                                                                                     | Source | Use                                      | Why                                                                                                        |
| ---------------------------------------------------------------------------------------- | ------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **"Close the laptop."**                                                                  | Wieden | CTA. Second sticker. Final site line.    | Inverts every CTA in technology. Two words. Permission and dare.                                           |
| **"The quiet part is the architecture."**                                                | Ive    | README. Brand motto. Internal compass.   | Names what an OS actually is — the invisible structure. For the people who stay long enough to understand. |
| **"Your agents don't need more intelligence. They need an address."**                    | Jobs   | Pivot section alt. Social. README.       | Nine words. Reframes the product as: we gave your agents a place to exist.                                 |
| **"Your agents don't have a performance problem. They have an infrastructure problem."** | Godin  | Pivot subhead. PR. Blog posts.           | Reframes the conversation from model quality to missing infrastructure.                                    |
| **"The gap is not intelligence. The gap is everything around the intelligence."**        | Ogilvy | Position statement. Launch announcement. | Redirects the word "intelligence" away from what competitors sell.                                         |

---

## Meta Copy

**Word-of-mouth sentence (Godin):**
"You know how your AI agents forget everything and can't do anything when you close the terminal? Someone built an OS for that."

**SEO Title:** DorkOS — The Operating System for Autonomous AI Agents

**Meta Description:** Your AI agents are brilliant. They just can't do anything when you leave. DorkOS gives them scheduling, communication, memory, and a command center. Open source. Self-hosted. You slept. They shipped.

**README one-liner:** The operating system for autonomous AI agents. Schedule, communicate, coordinate, remember. You slept. They shipped.

---

## Design System Summary (from Ive)

| Element                | Specification                                                                   |
| ---------------------- | ------------------------------------------------------------------------------- |
| **Background**         | #0A0A0A (primary) → #0D0D0D (post-pivot) → #111111 (install) → #0A0A0A (close)  |
| **Primary text**       | #F5F5F0, warm white                                                             |
| **Accent**             | #D4A843, muted amber — status indicators, module names, cursor, tagline         |
| **Monospaced**         | JetBrains Mono (or Berkeley Mono) — system names, code, timestamps, install     |
| **Sans-serif**         | Inter (or Neue Haas Grotesk) — human explanation, body copy                     |
| **Grid**               | 8px base. Section spacing: 160-200px. Card spacing: 64px.                       |
| **Animation**          | Opacity + 8-12px vertical translate. 400-600ms ease-out. No springs, no bounce. |
| **Background texture** | Faint dot grid on darkest sections — structural, not decorative                 |

---

## Decisions Made (Post-Synthesis)

1. **Hero headline:** Jobs short-form — "Your agents are brilliant. They just can't do anything when you leave." (Wieden long-form kept as reserve for blog/launch copy.)
2. **Villain Card 4:** Wieden's "The 3am Build" — aligns with the 2:47am motif and tagline energy. (Flow Killer available for secondary pages.)
3. **New lines adopted:**
   - **"Leave the rest to them."** — replaces "Close the laptop" (which was technically inaccurate for a local-first product). Final site line, stickers, social.
   - **"Your agents don't need more intelligence. They need an address."** (Jobs) — pivot alt, social, README.
4. **Final site close updated:** "Your agents are ready. Leave the rest to them." → `Ready.`
5. **Status:** Copy under user review. Next step TBD (design phase or refinement round).
