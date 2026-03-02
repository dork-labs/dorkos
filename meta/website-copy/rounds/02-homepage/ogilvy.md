> **Editorial note (2026-03-02):** This is a historical creative artifact. Some framings have been superseded by the pro-human positioning shift. See `meta/brand-foundation.md` > "Human-Empowerment Positioning" and `meta/website-copy/decisions.md` > Decision 16 for current positioning guidelines.

# DorkOS Homepage Copy

## A Memorandum from David Ogilvy

---

## Preliminary Note

I have read every brief, every decision, every constraint. I note that my Round 1 employment metaphor has been rejected — rightly, on reflection. "Collaborate" is warmer than "employ." The relationship you want is a builder and their crew, not a manager and their headcount. I have rewritten accordingly. Every line below respects Decision 3. You will not find the words hire, employ, worker, employee, boss, or manage headcount anywhere in this document.

I have also noted that the primary tagline is settled: "You slept. They shipped." It is a superior line. I wish I had written it.

What follows is production-ready copy. Every section, in order, as the visitor scrolls.

---

## Section 1: HERO

*Design direction: The page opens dark. Not decoratively dark — dark the way a screen is dark before it wakes. Generous whitespace. The headline appears first, alone, as if the system is initializing. After a beat, the subhead and tagline resolve. Monospaced type for "DorkOS" and the install command. Clean sans-serif for everything else. No images. No illustrations. Just text with the confidence of a system that knows what it is.*

### Option A: Long-Form Hero

> **Your agents are the most capable developers who ever existed.**
> **They have no schedule, no memory, no way to reach you, and no idea what happened five minutes ago.**

Subhead:
> That is not an intelligence problem. That is a missing operating system.

Tagline (below subhead, smaller, steady):
> You slept. They shipped.

---

### Option B: Short-Form Hero

> **Brilliant agents. No memory. No schedule. No way to reach you.**

Subhead:
> DorkOS is the operating system for autonomous AI agents.

Tagline:
> You slept. They shipped.

---

*Note to the reader: Option A builds the absurdity. It forces recognition — the developer reads it and thinks, "That is exactly my situation." Option B compresses the same thought into a single breath. Both work. Option A sells harder. Option B looks better on a t-shirt. I recommend A for the homepage, B for paid media and social cards.*

---

## Section 2: THE VILLAIN

*Design direction: Four cards or blocks, each one activating as it scrolls into view — like subsystems coming online, except these are the failures. Muted, almost terminal-log aesthetic. Each card has a short title in monospace and the body in sans-serif. The section header is understated. Let the cards do the work.*

### Section Header

> **The way it works right now.**

### Card 1: The Dead Terminal

> Your agent finished at 11:47pm. Clean code. Tests passing. PR ready. Then the terminal closed. The work sat there for three days until you found it by accident.
>
> Your best teammate shipped — and had no way to tell you.

### Card 2: The Goldfish

> "Let me give you some context..."
>
> You have typed this sentence a hundred times. Every session starts from zero. Every conversation begins with you re-explaining who you are, what you are building, and what happened yesterday. The most capable developer you have ever worked with has the memory of a goldfish.

### Card 3: The Tab Graveyard

> Five projects. Agents in different terminals. One is waiting for approval. One finished twenty minutes ago and you did not notice. One failed silently.
>
> You are the scheduler, the memory, the messenger, and the router. You are failing at all four.

### Card 4: The Flow-Killer

> Forty minutes into deep work. You need one answer from the codebase. Alt-tab. Terminal. Three paragraphs of context for a ten-second question. Get the answer. Switch back.
>
> The flow is gone. Fifteen minutes re-reading your own notes. This happens four times a day.

### The Truth (below the cards, centered, with weight)

> You pay for the most powerful AI coding agent available.
> It only works when you are sitting in front of it.

---

## Section 3: THE PIVOT

*Design direction: This line appears alone. Full-width. Generous vertical space above and below. It is the hinge of the entire page — the moment the site shifts from problem to solution. Treat it like a title card in a film. No decoration. Just the words.*

> **We solved this for applications fifty years ago. We called it an operating system.**
>
> Your agents are still running without one.

---

## Section 4: THE PRODUCT — TIMELINE NARRATIVE

*Design direction: This is the heart of the page. A vertical timeline, dark background, with timestamps in monospace on the left and narrative on the right. Each timestamp activates as the user scrolls — the boot-sequence aesthetic applied to a developer's night. Subtle status indicators shift from muted to full brightness as each moment resolves. The timestamps should feel like log entries. The descriptions should feel human.*

### Section Header

> **What happens when your agents have an operating system.**

---

### 11:07pm — You queue tomorrow's work.

> Three tasks across two projects. A test suite that needs running. A dependency audit that has been on your list for a week. A refactor you have been putting off.
>
> You open Console, write the prompts, set the schedules. Pulse takes over.
>
> **[Pulse: Cron-based scheduling. Your agents run on your timeline, not your presence.]**

### 11:12pm — You close the laptop.

> No tmux. No caffeinate hacks. No "keep this terminal alive" rituals. Pulse runs independently of your terminal, your IDE, and your attention.
>
> You go to sleep.

### 2:47am — CI breaks.

> A dependency update in your API project fails three integration tests. Pulse catches it on the next scheduled run. An agent picks it up. Reads the failure. Traces the root cause. Writes the fix. Opens the PR.
>
> Your phone buzzes. Telegram: "PR #47 ready for review. Three tests fixed. Root cause: breaking change in v3.2.0 of date-fns."
>
> You do not see this message. You are asleep.
>
> **[Relay: Built-in messaging. Your agents reach you on Telegram, notify each other, connect through any channel.]**

### 3:14am — The dependency audit finishes.

> The security agent scanned every project in the Mesh. Found two outdated packages with known vulnerabilities. Filed patches. Left a summary in your Relay inbox.
>
> It found the security agent in the next project over because Mesh knew it was there.
>
> **[Mesh: Agent discovery and coordination. Your agents find each other, share context, work as a crew.]**

### 7:00am — You open your laptop.

> Three PRs merged. The dependency audit is done. Your Relay inbox has a clean summary of everything that happened. Console shows all sessions — what ran, what completed, what needs you.
>
> Your morning starts with review, not firefighting.
>
> Your agents never stopped.

### The Line (after the timeline, with space)

> **Your AI Never Sleeps.**

*Note: This line earns its place here. It is not the tagline — it is the promise of the Pulse module, delivered at the moment the reader has felt the full weight of what autonomous execution means.*

---

## Section 5: THE MODULE REFERENCE

*Design direction: A compact table. Monospaced module names. Clean, scannable. This is for the architect who scrolled through the story and now wants to map each capability to its module. No prose. Just the gap and the fix. Two columns is all you need.*

### Section Header

> **Six modules. Each one closes a gap your agents have right now.**

| The gap | The fix | |
|---|---|---|
| No schedule — agents only run when you are watching | Cron-based autonomous execution. Overrun protection. Full run history. | **Pulse** |
| No communication — agents cannot reach you or each other | Built-in messaging. Telegram, webhooks, any channel. Messages persist. | **Relay** |
| No coordination — agents are isolated across projects | Agent discovery and network. Scans projects. Governs access. | **Mesh** |
| No oversight — you are alt-tabbing between fifteen terminals | Browser-based command center. Every session, every project, one place. | **Console** |
| No memory — every session starts from zero | Persistent context across all sessions. *Coming soon.* | **Wing** |
| No improvement loop — no feedback, no learning | Signal, hypothesis, dispatch, measure. The system gets better. | **Loop** |

*Note on Wing: It is marked "Coming soon" and nothing more. I do not sell what is not built. The reader will see it and want it. That is enough.*

---

## Section 6: THE INSTALL MOMENT

*Design direction: This is the most important moment on the page. Maximum desire, minimum friction. The terminal prompt sits alone on screen — monospaced, high contrast, generous whitespace above and below. It has the gravity of an action, not the lightness of a button. A blinking cursor, if you must. Below it, three short lines in smaller type. This is the conversion point. Give it the space it demands.*

> ```
> $ npm install -g dorkos
> ```

Below the install command:

> Open source. Self-hosted. Yours.

Below that:

> One person. Ten agents. Ship around the clock.

---

## Section 7: THE PROOF SECTION

*Design direction: This section is a placeholder — designed for social proof that does not yet exist. When it does, place real quotes here. For now, use the structural frame below. Do NOT fabricate testimonials. Do NOT use stock developer photos. The empty space itself communicates honesty.*

### Section Header

> **What developers are building.**

*[Design placeholder: 3-4 cards. Each card shows a real use case or quote. Populate post-launch with actual developer stories. Until then, this section can show the Ten-Agent Team table from the brand foundation — real, concrete, and specific without fabricating social proof.]*

| Agent | Project | Schedule | What it does |
|---|---|---|---|
| **Atlas** | core | Every night, 2am | Runs tests, fixes failures, opens PRs |
| **Scout** | docs | Every 6 hours | Checks for stale docs, updates examples |
| **Sentinel** | production-api | Every 30 minutes | Monitors error rates, triages new errors |
| **Forge** | client-app | On demand | Implements features from the roadmap |
| **Patrol** | security-scanner | Daily, 4am | Dependency audit, vulnerability scanning |

> This is what one person with DorkOS runs today.

---

## Section 8: THE IDENTITY CLOSE

*Design direction: The page has been dark throughout. This section does not brighten — it deepens. The background stays dark. The type gets quieter. This is not a sales close. It is a recognition moment. The reader who has scrolled this far already knows they want this. Now they need to know who built it and why. The origin story is brief, factual, and present — a provenance stamp, not a biography. The closing line is the tribal handshake.*

### The Origin

> Dorian Collier learned to code from library books. No connections to tech. Professional programmer before graduating high school. Built products reaching thirty million users. Took a startup from zero to exit in twelve months.
>
> The throughline: one person, building systems that let you do what should take a team.
>
> When AI agents arrived, he saw what was missing immediately. Not intelligence — they had that. The coordination layer. The scheduling. The communication. The memory. Everything an operating system provides.
>
> He named it after himself.
>
> Because the people who build at 3am, who have opinions about cron expressions, who name their agents and care about message routing — those people deserve a tool that is unapologetically theirs.

### The Close

> **Built by dorks. For dorks. Run by you.**

### Below the close (smaller, quieter)

> Open source on GitHub. Star the repo. Read the docs. Join the build.

*[GitHub link. Docs link. Discord/community link when it exists.]*

---

## Section 9: PERSISTENT FOOTER TAGLINE

*Design direction: Fixed or persistent at the very bottom. Small. Monospaced. The last thing the reader sees as they scroll, and the first thing they remember after they leave.*

> You slept. They shipped.

---

## The New Line

You asked for one line that does not exist yet. Here it is:

> **The gap is not intelligence. Your agents are brilliant. The gap is everything around the intelligence.**

This line works because it reframes the entire product category. Every competitor is selling smarter agents. You are selling the layer that makes smart agents functional. It is a positioning line — usable in the pivot section, in PR, in the README, in any context where you need to explain why DorkOS exists without listing features. It takes the word the audience already uses to describe AI ("intelligence") and redirects it. The intelligence is solved. The infrastructure is not.

Place it in the pivot section if you want to strengthen the turn. Or keep it in reserve for the README and launch announcements.

---

## Summary of Copy Architecture

| Section | Purpose | Key Line |
|---|---|---|
| Hero | Open the gap | "Your agents are the most capable developers who ever existed..." |
| Villain | Name the pain | "The way it works right now." |
| Pivot | Earn the OS metaphor | "We solved this for applications fifty years ago." |
| Timeline | Show the product through story | 11:07pm through 7:00am |
| Module Reference | Satisfy the architect | Six gaps, six fixes |
| Install | Convert at peak desire | `npm install -g dorkos` |
| Proof | Build trust (post-launch) | Real developer use cases |
| Identity | Welcome the tribe | "Built by dorks. For dorks. Run by you." |
| Footer | Leave the mark | "You slept. They shipped." |

---

## A Note on Length

This page is long. I have been asked many times whether long copy sells. The answer is that specific copy sells. This page is specific. Every line identifies a problem, presents a solution, or reduces friction to installation. There is no filler. There are no gradients. There is no "revolutionary AI-powered platform."

Your audience reads documentation for recreation. They will not be frightened by a long page. They will be frightened by a page that wastes their time.

This page does not waste their time.

---

*David Ogilvy*
*February 27, 2026*
