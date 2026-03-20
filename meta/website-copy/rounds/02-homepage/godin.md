> **Editorial note (2026-03-02):** This is a historical creative artifact. Some framings have been superseded by the pro-human positioning shift. See `meta/brand-foundation.md` > "Human-Empowerment Positioning" and `meta/website-copy/decisions.md` > Decision 16 for current positioning guidelines.

# DorkOS Homepage Copy — Seth Godin

---

## Section 1: Hero (Above the Fold)

### Design Direction

The screen is dark. Not a gradient, not a decorative dark mode — the black of a display that hasn't turned on yet. The headline appears as if the screen is waking. Monospaced tagline below. No product screenshot. No illustration. Just language and space. The `npm install` does NOT appear here — it comes later, at peak desire. A single subtle animation: a cursor blink after the tagline, as if the system is waiting for input.

---

### Option A: Short-Form Hero

# Your agents are brilliant. And they have no idea what happened five minutes ago.

**Subhead:** The operating system for autonomous AI agents.

**Tagline (below, monospaced, smaller):** You slept. They shipped.

---

### Option B: Long-Form Hero

# You work with the most capable developer who ever existed. You gave them no schedule, no memory, no way to reach you, and a workspace that vanishes the moment you look away.

**Subhead:** That's not an intelligence problem. That's a missing operating system.

**Tagline (below, monospaced, smaller):** You slept. They shipped.

---

## Section 2: The Villain — Recognition (First Scroll)

### Design Direction

Four cards or panels, each one dark, each one activating as the user scrolls. Monospaced labels. Short. These should feel like terminal error messages from your own life. Minimal animation — a status indicator shifting from dim to full contrast as each one enters view. No icons. The text does the work.

---

**Section label (small, monospaced, above):** `// status: familiar`

**The dead terminal.**
Your agent shipped clean code at 2am. Opened a PR. Passed CI. Told no one. You found it three days later by accident.

**The goldfish.**
New session. "Let me give you some context..." Again. Every conversation starts from zero. The most capable developer you've ever worked with can't remember yesterday.

**The tab graveyard.**
Ten agents across five projects. Different terminal windows. One of them has been waiting for approval since lunch. You don't know which one.

**The sleeping Mac.**
Your laptop went to sleep. The agent went with it. Eight hours of potential, gone — because no one told the screen to stay awake.

---

## Section 3: The Pivot

### Design Direction

A single line, centered, with maximum whitespace above and below. This is the fulcrum of the entire page. It earns its weight because the reader just felt four specific pains. Typeset larger than body copy, smaller than the hero headline. Clean serif or monospaced — set apart from everything around it. It should feel like a quiet, certain observation. Not a shout. A realization.

---

We solved this for applications fifty years ago. We called it an operating system.

---

## Section 4: The Product — Timeline Narrative

### Design Direction

A vertical timeline, dark background. Each timestamp is monospaced, left-aligned. The description flows to the right. As the user scrolls, each moment activates — a status indicator shifting from `idle` to `active` to `complete`. The feeling: watching a system operate in real time. The palette shifts subtly from the muted tones of the villain section toward higher contrast. The system is waking up.

---

**Section label (small, monospaced):** `// what changes`

### 11:14 PM

You queue three tasks in Console. A dependency upgrade. A stale test suite. A refactor you've been avoiding. You assign each one to an agent, set the schedule in Pulse, and close the laptop.

The agents don't need your laptop open. They don't need your terminal. Pulse runs them on their own schedule, independent of your machine.

### 11:15 PM

You go to bed.

### 2:47 AM

CI breaks on the dependency upgrade. Relay catches it. Your agent on the test suite gets a message — automatically, through Mesh — that the build is red. It reads the failure, adjusts, re-runs. Forty seconds later, CI is green.

A message hits your Telegram: "CI broke at 2:47. Fixed at 2:48. Three PRs ready for review."

You don't see it yet. You're asleep.

### 7:00 AM

Coffee. Phone. Three PRs merged. A summary of what happened overnight, waiting in your inbox. Console shows every decision, every tool call, every file touched — because you trust your crew, but you review the work.

You shipped three features before breakfast. You wrote zero lines of code.

---

**Below the timeline, a single line:**

This is not a demo. This is Tuesday.

---

## Section 5: Module Reference

### Design Direction

A compact, clean table. Monospaced module names. Two columns: what's broken, what fixes it. Activates after the timeline, for the reader who needs to map capabilities quickly. This is for the architect brain — the person who just felt the story and now wants the schematic. Keep it tight. No marketing copy in the table itself.

---

**Section label (small, monospaced):** `// subsystems`

| The gap                                                   | The fix                                                         |                        |
| --------------------------------------------------------- | --------------------------------------------------------------- | ---------------------- |
| No schedule — agents only run when you're watching        | Cron-based autonomous execution. Agents run on their own clock. | **Pulse**              |
| No communication — agents can't reach you or each other   | Built-in messaging. Telegram, webhooks, inter-agent channels.   | **Relay**              |
| No colleagues — agents work in isolation                  | Agent discovery and coordination across projects.               | **Mesh**               |
| No oversight — you're switching between fifteen terminals | Browser-based command center. Every session, one place.         | **Console**            |
| No improvement loop — no signal, no learning              | Signal detection, hypothesis, dispatch, measurement.            | **Loop**               |
| No memory — every session starts from zero                | Persistent context across all sessions.                         | **Wing** `coming soon` |

---

## Section 6: The Install Moment

### Design Direction

This is the most important moment on the page. Full-width. Dark. A single terminal prompt, monospaced, high contrast, generous whitespace on all sides. This is not a button. It is a command. It has the gravity of something you type deliberately, not something you click casually. Below it, two lines in a smaller weight. Copy-to-clipboard interaction on hover. The spacing above this section should be the largest on the page — a breath before the action.

---

```
$ npm install -g dorkos
```

**One person. Ten agents. Ship around the clock.**

Open source. Self-hosted. Yours.

---

## Section 7: The Identity Close

### Design Direction

The tone shifts here. Warmer. The system boot aesthetic softens. This is not a footer — it's the last thing you read before you decide. The background stays dark but the typography loosens slightly. A monospaced label, then human prose. If there is ever a photo on this page, it goes here — but it's optional. What matters is that this section feels like meeting the person behind the tool. Brief. Factual. Present without demanding attention.

---

**Section label (small, monospaced):** `// identity`

### Built by dorks. For dorks. Run by you.

DorkOS exists because one developer got tired of babysitting genius.

The kind of developer who has opinions about cron expressions and message routing. Who ships at 3am not because anyone asked, but because the problem was interesting. Who names their agents.

This is a tool for people like that. People who care too much about the gap between what should work and what does.

It's open source because the best infrastructure is shared infrastructure. It's self-hosted because your agents, your code, and your data are yours. It's called DorkOS because the people who obsess over systems are the ones who build the things that matter most.

**The ones who care too much build the things that matter most.**

---

## Section 8: Social Proof Placeholder

### Design Direction

Design this section but leave it empty until launch. A row of quote cards, dimmed, with a subtle `// awaiting signal` label. When real testimonials arrive, they should be formatted as confessions — short, raw, first-person. Not "DorkOS is great." More like "I shipped three features before breakfast and wrote zero code." The section heading should be something like `// field reports` — not "What our customers say."

---

**Section label (small, monospaced):** `// field reports`

_[Placeholder — populated post-launch with real developer testimonials. Format: short first-person statements. No attribution needed beyond a handle.]_

---

## Section 9: Persistent Footer

### Design Direction

Minimal. Dark. Three columns max. The tagline lives here as a quiet anchor. Links to GitHub, docs, npm. No newsletter signup — this audience doesn't want email, they want a repo. The footer should feel like the last line of a terminal session — clean, done, nothing wasted.

---

**You slept. They shipped.**

[GitHub] [Docs] [npm]

---

## The New Line

Here is the one line that doesn't exist yet in the brief, the synthesis, or any prior round:

> **Your agents don't have a performance problem. They have an infrastructure problem.**

This belongs in the pivot section, either as a precursor to the "we solved this fifty years ago" line or as an alternative subhead in the hero. It works because it reframes the entire conversation. Every developer has felt frustration with their agents and assumed it was a model limitation or a prompting failure. This line names the real diagnosis — and makes the product feel inevitable.

---

## Meta: The Word-of-Mouth Sentence

Every section on this page is in service of one outcome: the sentence someone uses to describe DorkOS to a friend.

That sentence is:

**"You know how your AI agents forget everything and can't do anything when you close the terminal? Someone built an OS for that."**

If the site works, every visitor walks away with that sentence loaded and ready to fire.

---

## Meta: The SEO Title / Meta Description

**Title:** DorkOS — The Operating System for Autonomous AI Agents

**Meta description:** Your AI agents are brilliant. They just can't do anything when you leave. DorkOS gives them scheduling, communication, memory, and a command center. Open source. Self-hosted. You slept. They shipped.

---

## Meta: The README One-Liner

> The operating system for autonomous AI agents. Schedule, communicate, coordinate, remember. You slept. They shipped.
