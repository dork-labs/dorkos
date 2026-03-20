> **Editorial note (2026-03-02):** This is a historical creative artifact. Some framings have been superseded by the pro-human positioning shift. See `meta/brand-foundation.md` > "Human-Empowerment Positioning" and `meta/website-copy/decisions.md` > Decision 16 for current positioning guidelines.

# Round 2: Homepage Copy — Jobs

---

## Section 1: Hero

**Design direction:** The page opens dark. Not stylistically dark — dark the way a screen looks before anything has loaded. A breath of nothing. Then the headline appears, as if the screen just woke up. No animation flourish — a single, clean render. Monospaced subhead. The install command is not here yet. Do not give them the answer before they feel the question.

---

### Hero Option A: Short-Form

# Your agents are brilliant.

# They just can't do anything when you leave.

`the operating system for autonomous AI agents`

**You slept. They shipped.**

---

### Hero Option B: Long-Form

# You have the most capable AI developer who ever existed.

# It has no schedule. No memory. No way to reach you.

# And when you close the laptop, it stops.

`the operating system for autonomous AI agents`

**You slept. They shipped.**

---

## Section 2: The Villain — Recognition

**Design direction:** Four cards. Each one activates on scroll — muted, then full contrast, like a diagnostic flipping from idle to alert. Short. Brutal. No explanation. Every developer who uses agents has lived every one of these. Typography: monospaced labels above each card (like system log entries), clean sans-serif for the description. Generous spacing between cards. Let the silence do the work.

---

`11:47pm` **The dead terminal.**
Your agent finished the refactor at 2am. Opened a PR. Told no one. You found it three days later by accident.

`session_start` **The goldfish.**
"Let me give you some context..." You have typed this sentence four hundred times. Every session begins at zero. Every session, you re-introduce yourself to something that was brilliant five minutes ago.

`tab 7 of 13` **The graveyard.**
Five projects. Ten agents. Thirteen terminal tabs. One of them needs approval. One of them is stuck. You cannot remember which.

`ctrl+tab` **The flow killer.**
You are forty minutes deep in an architecture doc. You need one answer from the codebase. Alt-tab. Terminal. Three paragraphs of context. The answer takes ten seconds. Getting your head back takes fifteen minutes.

---

**Below the villain cards, a single line. Centered. Full width. Let it breathe.**

The intelligence isn't the problem.
Your agents can write code, fix bugs, refactor systems, ship features.

They just have nowhere to live.

---

## Section 3: The Pivot

**Design direction:** This is the moment the page shifts. Everything above was diagnosis. This is the turn. The background subtly warms — not bright, but alive. Like a subsystem switching from standby to active. This line appears alone, with the kind of whitespace that says: this matters. Do not crowd it.

---

We solved this for applications fifty years ago.

Processes needed scheduling. We built cron.
Processes needed communication. We built IPC.
Processes needed discovery. We built registries.
Processes needed memory. We built filesystems.

We called it an operating system.

Your agents need the same thing.

---

## Section 4: The Product — Timeline Narrative

**Design direction:** A vertical timeline. Left-aligned timestamps in monospaced type. Each moment is a scene — tight, specific, felt. As the user scrolls, each timestamp activates. Module names appear as subtle system labels (monospaced, reduced opacity, like a subsystem identifier in a boot log). The modules are never introduced as a list. They are revealed as the infrastructure behind each moment. The night tells the story. The modules are just the names of what made it possible.

---

### One night. Everything changes.

---

`11:14 pm`

You queue three tasks. A test suite that needs expanding. A dependency upgrade across two services. A stale branch that needs rebasing and cleanup.

You type one command. Pulse schedules all three.

You close the laptop.

---

`11:15 pm`

The first agent picks up the test suite. It reads the coverage report, identifies the gaps, starts writing.

You are brushing your teeth.

---

`12:33 am`

The dependency upgrade hits a breaking change in the API layer. The agent working on it needs a decision. It sends you a message on Telegram: "Breaking change in v4 — two options. Reply 1 or 2."

You are asleep. You will answer in the morning. The agent moves to the next task.

Relay.

---

`2:47 am`

CI breaks on main. An unrelated merge introduced a type error.

Pulse detects it. Dispatches an agent. The agent reads the error, traces the cause, opens a fix PR. CI goes green.

Nobody was awake.

---

`2:48 am`

The agent that fixed CI notices the test suite agent is working in the same service. Mesh routes a coordination signal — one waits for the other to merge first, avoiding a conflict.

No human involved. No terminal open.

---

`7:00 am`

You open your laptop. Console shows you everything.

Three PRs ready for review. CI green. One question waiting for your answer. A timeline of every action, every decision, every tool call — across all three agents.

You review the PRs with coffee. You reply "1" to the Telegram message. The agent resumes.

By 7:45, you have shipped more than most teams ship in a day.

You slept. They shipped.

---

### Module Reference

**Design direction:** Compact. A clean table or minimal card grid. This is for the architect who just watched the story and now wants the map. Monospaced module names. One-line descriptions. The "coming soon" label on Wing is understated — a subtle badge, not an apology. This section should feel like a system spec sheet: precise, authoritative, no wasted words.

---

| Module      | The gap                                        | What it does                                                                                 |
| ----------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Pulse**   | Agents only run when you are watching          | Cron-based autonomous scheduling. Your agents work on your schedule, not your screen time.   |
| **Relay**   | Agents can't reach you or each other           | Built-in messaging. Telegram, inter-agent signals, any channel. Your agents talk.            |
| **Mesh**    | Agents are isolated. No coordination.          | Discovery and networking. Agents find each other, coordinate work, avoid conflicts.          |
| **Console** | You are alt-tabbing between thirteen terminals | Browser-based command center. Every session, every action, one place.                        |
| **Wing**    | Every session starts from zero                 | Persistent memory across sessions. Context that survives the terminal closing. `coming soon` |
| **Loop**    | No feedback, no improvement                    | Signal, hypothesis, dispatch, measure. Your agents get better at what they do.               |

---

## Section 5: The Install Moment

**Design direction:** This is the gravitational center of the page. Maximum whitespace. The terminal prompt sits alone — monospaced, high contrast against the dark background, with the weight of an action, not the lightness of a button. This is not "click here to get started." This is: here is the command. You know what to do. Below it, three short lines. No box. No card. Just text, breathing.

---

```
$ npm install -g dorkos
```

Open source. Self-hosted. Yours.

One person. Ten agents. Ship around the clock.

---

## Section 6: The Identity Close

**Design direction:** The page does not end with a footer. It ends with a shift in tone — warmer, closer, almost quiet. The design can open up here: a bit more line height, slightly softer contrast. This is the handshake after the demo. You are not selling anymore. You are recognizing someone.

---

### Built by dorks. For dorks. Run by you.

DorkOS was built by someone who runs agents at 3am and has opinions about cron expressions. Someone who needed their agents to work while they slept and tell them what happened. Someone who looked at the most powerful AI tools ever created and thought: these deserve better infrastructure.

This is not a platform you sign up for. It is not a service that bills you. It is software you run, on your machine, under your control. The code is open. The roadmap is public. The direction belongs to everyone who builds with it.

The ones who care too much build the things that matter most.

If that sounds like you — welcome. You are home.

---

**[GitHub]** --- **[Docs]** --- **[Discord]**

---

## The New Line

> "Your agents don't need more intelligence. They need an address."

Use: mid-page pull quote, social, or README alternative. The insight compressed to nine words — agents are capable but unreachable. An address implies a place to live, a way to be found, a way to receive messages. It reframes the entire product as: we gave your agents a place to exist.

---

## Copy Notes

**Total word count:** Approximately 950 words of visible copy (excluding design notes). Lean enough to read in under 3 minutes. Dense enough that nothing is filler.

**What is deliberately absent:**

- No pricing section (it is free, open source — this is stated, not sold)
- No comparison table (pre-launch, no social proof to leverage — compete on vision, not feature grids)
- No testimonials block (design the space for it, but do not fabricate quotes)
- No screenshots (the copy should make the designer want to build the UI that lives up to it — then the screenshots come)

**The rhythm:** The page has a breathing pattern. Tension (villain) — release (pivot) — wonder (timeline) — gravity (install) — warmth (identity). Each section earns the next. Nothing is out of order. You cannot rearrange these sections and have them work the same way.

**On the employment constraint:** The entire timeline narrative demonstrates the collaborative relationship without ever using management language. The developer queues tasks, reviews PRs, answers questions. The agents execute, coordinate, communicate. It is a crew working together — the human leads, but nobody is being "managed."
