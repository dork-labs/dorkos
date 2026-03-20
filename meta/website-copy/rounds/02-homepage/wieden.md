> **Editorial note (2026-03-02):** This is a historical creative artifact. Some framings have been superseded by the pro-human positioning shift. See `meta/brand-foundation.md` > "Human-Empowerment Positioning" and `meta/website-copy/decisions.md` > Decision 16 for current positioning guidelines.

# Round 2: The Homepage — Dan Wieden

---

## Section 1: Hero (Above the Fold)

### Design Direction

The screen is dark. Not stylistically dark — dark the way a machine is dark before power reaches it. A single blinking cursor. Then the headline arrives, not all at once, but like it was typed. The cursor blinks at 2:47am on a terminal clock in the background — barely visible, almost subliminal. The tagline sits beneath the headline like a stamp. Below that, the position line in a lighter weight. Nothing else competes. This is negative space as conviction.

---

### Option A: Short-Form Hero

# Your agents are the best engineers you've ever worked with. They just can't do anything when you leave the room.

**You slept. They shipped.**

The operating system for autonomous AI agents.

---

### Option B: Long-Form Hero

# You closed the laptop at 11pm. The smartest developers you've ever worked with sat in the dark for eight hours, waiting for permission to think.

**You slept. They shipped.**

The operating system for autonomous AI agents.

---

_Recommendation: Option B. The long-form builds the absurdity into the sentence itself. You feel the waste before you finish reading. The clock detail (11pm, eight hours) is specific enough to be a memory, not a claim._

---

## Section 2: The Villain — Recognition

### Design Direction

Four dark cards. Each one activates on scroll — not sliding in, switching on. A subtle status indicator shifts from dim red to full red as each card enters view. Monospaced timestamps on each card. The feel: system alerts. Error logs you recognize. Typography is tight, spare. Each card is a wound the reader already has. Do not explain. Name it.

---

### Section Header

**What your agents do when you leave.**

Nothing.

---

### The Cards

**The Dead Terminal**
Your agent shipped clean code at 2:47am. Opened a PR. Ran the tests. Then sat in a closed terminal, telling no one, until you found it by accident three days later.

**The Goldfish**
"Let me give you some context..." You have typed this sentence a hundred times. Every session starts from zero. Your agent has no memory of yesterday. No memory of five minutes ago.

**The Tab Graveyard**
Ten agents. Ten terminals. One of them is waiting for approval. One finished twenty minutes ago. One broke something. You are alt-tabbing between them like it is 2005 and you are managing browser bookmarks.

**The 3am Build**
CI went red at 2:47am. The fix was three lines of code. Your agent knew exactly what to do. Your terminal was closed. The build stayed red until morning.

---

### The Pivot

_After the four cards. Centered. Alone on the screen. Earns its weight because the reader just felt the problem in their chest._

We solved this for applications fifty years ago.

We called it an operating system.

---

## Section 3: The Product — "What Happens When You Leave"

### Design Direction

The timeline is the centerpiece. Each timestamp activates sequentially on scroll — like a system log playing back. Monospaced time codes on the left. Human-readable descriptions on the right. The module names appear as subtle system labels (think: `[PULSE]`, `[RELAY]`, `[MESH]`) in a muted accent color beside the relevant timestamp. The entire section should feel like reading a mission log the morning after. The boot-sequence aesthetic peaks here: each timestamp is a subsystem coming online.

---

### Section Header

**You slept. They shipped.**

Here is what a Tuesday night looks like.

---

### The Timeline

**11:14 PM**
You queue three tasks. A refactor that has been sitting in the backlog for two weeks. A test suite for the new auth module. A dependency upgrade you keep putting off. Pulse schedules all three. You set a priority order.
`[PULSE]`

**11:15 PM**
You close the laptop.

**11:47 PM**
First task starts. The refactor agent picks up the work, reads the codebase, begins restructuring. No terminal open. No human watching. Just an agent doing what it was built to do.
`[PULSE]` `[CONSOLE]`

**2:47 AM**
CI breaks on the dependency upgrade. A test fails. Relay routes an alert. A second agent picks up the fix, examines the failure, commits a patch, re-runs the suite. Tests go green. PR opened.
`[RELAY]` `[MESH]`

**2:51 AM**
Your phone buzzes once. A Telegram message: "CI was red. Fixed. PR #247 ready for review." You do not wake up. The notification is there when you are.
`[RELAY]`

**7:00 AM**
You open the console. Three PRs merged. Status across all agents: idle, awaiting next assignment. Overnight summary waiting. You review the diffs with coffee.
`[CONSOLE]`

**7:04 AM**
You approve one PR, request a change on another, and queue two more tasks for the day. Your agents have been productive for eight hours. You have been awake for four minutes.

---

### The Module Reference

_Below the timeline. Clean, compact. For the architect who needs to map capabilities, not feel them. Two columns: the gap and the fix. Module name in monospaced type._

### Design Direction

A minimal table or grid. No icons, no illustrations. Monospaced module names. Each row is a problem/solution pair. The section header is understated — this is reference material, not narrative. It earns its place by being useful, not loud.

---

**The infrastructure your agents are missing.**

| The gap                                                  | The fix                                                                                    |                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------- |
| No schedule — agents only run when you are watching      | Cron-based autonomous execution. Agents work on your schedule, not your presence.          | `PULSE`              |
| No communication — agents cannot reach you or each other | Built-in messaging. Telegram, webhooks, inter-agent channels. They tell you what happened. | `RELAY`              |
| No colleagues — agents are isolated, no coordination     | Agent discovery and network. Your agents find each other, share context, collaborate.      | `MESH`               |
| No memory — every session starts from zero               | Persistent memory across sessions. Context that survives the terminal closing.             | `WING` _coming soon_ |
| No oversight — you are alt-tabbing between terminals     | Browser-based command center. Every agent, every session, one screen.                      | `CONSOLE`            |
| No improvement — no feedback loop, no learning           | Signal, hypothesis, dispatch, measure. Your system gets better without you telling it to.  | `LOOP`               |

---

## Section 4: The Install Moment

### Design Direction

Maximum negative space. The terminal prompt sits alone in the center of the screen with the gravity of a command that changes something. Monospaced. High contrast. A blinking cursor before the command, as if the page is waiting for the reader to press Enter. Below it, two lines in a lighter weight. This is not a button. This is a decision. The boot-sequence aesthetic reaches its final state here: `DorkOS is starting...` could flash for 200ms after hover. Then: `Ready.`

---

```
$ npm install -g dorkos
```

Open source. Self-hosted. Yours.

One person. Ten agents. Ship around the clock.

---

## Section 5: The Social Proof Placeholder

### Design Direction

Reserve this space. Do not fill it with fabricated quotes. When real developers ship things with DorkOS overnight and tell you about it, those stories go here. For now: a single line that implies the space is waiting to be filled with earned proof. Gray text. Understated. Honest.

---

_This section ships empty. The proof writes itself._

**Placeholder design:** A row of empty quote blocks with muted outlines — visible architecture, no content. The message is clear: this is pre-launch. The stories are coming.

---

## Section 6: The Identity Close — "Built by Dorks"

### Design Direction

The screen shifts. Not to light — to warmer dark. The typography loosens slightly. This section is personal. It is not a company bio. It is a handshake. The tone changes from precision to warmth. If the rest of the page is machined aluminum, this section is the handwritten note inside the box.

---

### Section Header

**Built by dorks. For dorks. Run by you.**

---

Dork was never an insult to us.

It is what you call someone who cares too much about something most people do not care about at all. Someone who has opinions about cron expressions. Someone who names their agents. Someone who wakes up at 6am to check a CI pipeline that nobody asked them to check.

We build at 3am because we cannot stop. Not because someone is paying us to. Because the problem is right there and walking away from it feels worse than staying up.

DorkOS exists because one developer got tired of watching brilliant agents sit in closed terminals. Got tired of typing "let me give you some context" for the hundredth time. Got tired of the gap between what AI agents can do and what they are allowed to do.

So he built the missing layer. The scheduling, the memory, the communication, the coordination. The operating system that agents never had.

He named it after himself. After all of us.

The ones who care too much build the things that matter most.

---

## Section 7: The Final Line

### Design Direction

Alone on the screen. The last thing the reader sees before the footer. Centered. Full contrast. The cursor blinks once, then stops. The page is still.

---

Your agents are ready.

Close the laptop.

---

## The New Line

You asked me for one line that does not exist yet. Here it is:

**"Close the laptop."**

Two words. An imperative. It is the opposite of every call to action in technology. Every other product says: open this, click this, start this, engage. DorkOS says: leave. Go to sleep. Go live your life. The product's greatest promise is that it works when you are not there. So the boldest thing the website can say is: go away. We have got this.

It works as the final line of the site. It works on a sticker next to "You slept. They shipped." It works as the thing you say to a developer who is afraid to let go of the terminal. It is permission and dare in two words.

Close the laptop.

---

## Full Copy Summary (Reading Order)

1. **Hero** — The gap. The absurdity of human-gated intelligence. Tagline: You slept. They shipped.
2. **Villain** — Four named wounds. The dead terminal, the goldfish, the tab graveyard, the 3am build.
3. **Pivot** — "We solved this for applications fifty years ago. We called it an operating system."
4. **Product (Timeline)** — 11:14pm through 7:04am. A Tuesday night with DorkOS running.
5. **Product (Reference)** — Six modules. Gap and fix. For the technical mind.
6. **Install** — `npm install -g dorkos`. Open source. Self-hosted. Yours.
7. **Social Proof** — Reserved. Honest about pre-launch.
8. **Identity** — Built by dorks. The tribal close.
9. **Final** — Your agents are ready. Close the laptop.

---

## Notes for the Designer

- The page is one continuous scroll. No pagination, no tabs. Each section activates as it enters the viewport.
- Color: start cold and dark. Warm slightly at the identity section. The temperature of the page follows the emotional arc.
- Motion: restraint above all. Things switch on. They do not bounce, slide, or wave. The only animation that should feel alive is the cursor blink.
- The terminal prompt (`$ npm install -g dorkos`) should feel like it has weight. Like clicking it does something irreversible. Give it room.
- Monospaced type for: timestamps, module names, the install command, system labels. Everything else in a clean sans-serif.
- The four villain cards should feel like system alerts you have seen before. Familiar enough to sting.
- "You slept. They shipped." appears twice: once under the hero headline, once as the timeline section header. It earns the repetition because it means something different each time — first as a claim, then as proof.
- The 2:47am timestamp is a recurring motif. It appears in the hero background, the villain cards, and the timeline. It is the site's emotional anchor: the moment when the work happens and you are not there.
