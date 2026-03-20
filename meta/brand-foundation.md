# DorkOS — Brand & Product Foundation

## 1. Executive Summary

**DorkOS** is an autonomous agent operating system for developers, founders, and serious builders.

It makes AI coding agents more capable — giving them a scheduling engine, a life layer that keeps you in context, and a mesh that lets agents discover and communicate with each other.

DorkOS is:

- Open source
- Developer-first
- Radically honest
- Modular
- Extremely powerful

It is not a toy.
It is not an agent wrapper.
It is an autonomous agent operating system for people who build.

---

## 2. Origin Story

Dorian Collier grew up in Section 8 housing in West Covina with no family connections to tech. He learned to code from library books and a college textbook a mentor gave him. He was a professional programmer before he graduated high school.

He never fit in. Turns out that's a feature, not a bug.

Over the next decade, Dorian built products that reached 30 million users. He shipped apps featured on the Apple App Store. He took a startup from zero to exit in twelve months. He created half a million NFTs for Warner Bros, Game of Thrones, and The Matrix. He consulted for Art Blocks, one of the most important platforms in generative art.

The throughline across everything: one person, building systems that let you do what should take a team. Tools that multiply what a single builder can accomplish.

When AI coding agents arrived, Dorian saw the gap immediately. The agents were brilliant — they could write code, fix bugs, create entire features. But they were trapped. Each one stuck in a terminal, starting every session with amnesia, unable to run on a schedule, unable to tell you what they did, unable to coordinate with each other. The smartest tools in the world, and they had no way to work independently.

He'd seen this before. Every time a powerful capability emerges, the missing piece is always the same: the layer that lets it coordinate, communicate, and persist. Applications needed an OS. Teams needed Slack. AI agents need DorkOS.

So he built it. Not as a side project — as the system he needed. An autonomous agent operating system. Open source, because the foundation should be owned by the people who build on it. Developer-first, because that's who he is. Named after himself — because the people who build at 3am, who have opinions about cron expressions and message routing, who care about the things most people don't understand — those people deserve a tool that's unapologetically theirs.

---

## 3. Core Brand Position

### Category

Autonomous Agent Operating System

### Positioning Statement

DorkOS is the operating system for autonomous AI agents — scheduling, communication, and coordination so one person can ship like a team.

### Target Audience

**Primary:**

- Professional developers
- Indie hackers
- Technical founders
- AI power users
- DevOps-oriented builders

**Secondary:**

- Technical operators
- Productivity system enthusiasts
- AI-native entrepreneurs

This is not built for casual users.

---

## 4. Big Idea

Intelligence doesn't scale. Coordination does.

You've always had more ideas than hours. AI agents are brilliant — they can specialize, write code, fix bugs, and create entire features. But right now, they're stuck working alone with no memory, no schedule, and no way to reach you. The missing piece isn't smarter agents. It's the coordination layer that lets your vision scale.

DorkOS is that layer. One person with the right system ships like a team — not because the agents replace what you do, but because they multiply what you can accomplish.

DorkOS makes your agents:

- Your coordination layer — scheduling, messaging, and discovery
- Your persistent knowledge layer — context that survives across sessions
- Your always-available system — browser-based, from any device
- Your extensible AI operating layer — open source, modular, yours to shape

Your ideas.
Your agents.
Your rules.

---

## 5. The Villain

The villain isn't a company or a competitor. The villain is a missing layer.

### The Moment

It's 7am. You open your laptop. CI has been red since 2:47am. A dependency update broke three repos. The fix takes five minutes — your agent could have handled it. But the terminal was closed. The agent wasn't running. There was no coordination layer to keep things moving. Your entire morning is consumed by something that should have been resolved six hours ago.

You have the most powerful AI coding agent available. And it has no way to run without you sitting in front of it.

### The Pattern

This missing layer shows up everywhere. Different forms, same root cause:

**The dead terminal.** Your agent shipped clean code at 11pm. Created a PR, wrote tests, refactored the edge cases. Then the terminal closed. The work is done but nobody knows — no Telegram message, no Slack notification, no record of what happened. You find the PR by accident three days later. The agent did its job. The missing piece was a way to tell you about it.

**The re-introduction.** "Let me give you some context..." You've typed these words a hundred times. Every session starts from zero. Every agent interaction begins with you re-explaining who you are, what you're building, and what happened yesterday. The most capable developer tool in the world has no persistent memory — because there's no layer to provide one.

**The 15-tab juggle.** Five projects. Agents running in different terminals. You can't tell which session is doing what. One is waiting for approval. One finished 20 minutes ago. One crashed silently. There's no coordination, no status dashboard, no messaging — every agent is isolated because nothing connects them.

**The flow-killer.** You're deep in an architecture document. Forty minutes of focused thinking. You need to check one thing in the codebase. Alt-tab. Open the terminal. Three paragraphs of context to set up a ten-second question. Get the answer. Switch back. The flow is gone. Fifteen minutes re-reading your own notes. This happens four times a day — not because you're doing something wrong, but because the tools don't connect your thinking and doing environments.

### The Truth

The gap isn't intelligence. The agents are brilliant. The gap is everything around the intelligence — scheduling, memory, communication, coordination. The things an operating system provides.

We solved this for applications fifty years ago. We called it an operating system.

Your agents are still running without one.

---

## 6. Product Architecture

DorkOS is modular and open source. Each module can run independently or together.

### Available now

#### 6.1 DorkOS Engine (Runtime)

The runtime that powers everything. Engine connects your AI agents, exposes a secure REST API, and serves as the foundation for all other modules. Agent adapters let you plug in any coding agent — Claude Code today, Codex, OpenCode, and others coming.

- Runs locally on your machine
- Connects AI agents via pluggable adapters (Claude Code first, more coming)
- Exposes a secure REST + SSE API
- Enables remote access via tunnel
- Runs Pulse, Relay, and Mesh as integrated capabilities

This is the foundation.

**Status: Available**

#### 6.2 DorkOS Console (Web UI)

- Browser-based interface
- Connect to your local Claude instance from anywhere
- Remote dev workflow
- Multi-project support

This makes DorkOS location-independent.

**Status: Available**

#### 6.3 DorkOS Pulse (Scheduler)

- Cron-based agent scheduling, independent of your IDE or terminal
- Overrun protection prevents duplicate runs
- Isolated sessions per run
- Run history with full session recording
- Configurable concurrency limits
- Pending_approval gates for agent-created schedules

This is what makes DorkOS alive. Your agents keep shipping — on schedule, around the clock.

**Status: Available**

#### 6.4 DorkOS Relay (Agent Communication)

Built-in messaging between your agents and the channels you already use. Relay handles all communication in DorkOS — agent-to-agent, human-to-agent, and external notifications. Your agents can reach you on Telegram, notify each other across projects, and connect through any channel.

- Telegram and webhook adapters built in
- Plugin system for adding new channels
- Messages persist even when terminals close
- Agents can message each other, not just you

Like giving your agents Slack.

**Status: Available**

#### 6.5 DorkOS Wing (Life Layer)

Your personal life layer. Wing is the always-on AI companion that lives beside you — remembering what matters, helping you plan, keeping you accountable, and coordinating across every part of your life.

- Memory system
- Life coach
- Project planner
- Journal & knowledge base
- Chief of staff

Acts as:

- Persistent context layer for all agents
- Long-term memory and commitment tracker
- Life coordination intelligence

Wing is supportive, steady, and proactive. Not just storage — presence.

**Status: Coming Soon**

#### 6.6 DorkOS Mesh (Agent Network)

Agent discovery and coordination. Mesh turns solo agents into a discoverable, governed team.

- Scans your projects and finds agent-capable directories automatically
- `.dork/agent.json` manifests with `.claude/` fallback for zero-config discovery
- Intentional registration — you approve which agents join the network
- Namespace isolation (default-allow within project, default-deny across)
- Access control rules authored by Mesh, enforced by Relay

The Mesh is what makes DorkOS an operating system, not just a runtime. Without it, you have solo agents. With it, you have a team.

**Status: Available**

#### 6.7 Loop (Autonomous Improvement Engine)

A companion product by Dork Labs. Loop closes the feedback loop — collecting signals from the real world, forming hypotheses, dispatching tasks to agents, and measuring outcomes. Fully deterministic, no AI built in, agent-agnostic.

DorkOS's Pulse scheduler polls Loop for the next priority task. Loop returns prepared instructions. Agents execute. Outcomes feed back as new signals. The system improves itself.

See the [Loop Litepaper](../research/loop-litepaper.md) for the full vision.

**Status: [Live](https://www.looped.me/)**

---

## 7. We Believe

- AI agents work like teammates — they need communication, scheduling, and coordination to be effective
- Your AI should work autonomously on your behalf — and trust features make that comfortable, not risky
- One person with the right system should be able to ship like a team
- Power tools deserve power users
- Open source is a foundation, not charity
- Honesty builds trust — we tell you exactly what runs where

DorkOS is:

- Opinionated
- Performance-focused
- Developer-centric
- Built for serious work
- Radically transparent

---

## 8. The Name

The word "dork" has been used to dismiss people who care too much about the wrong things. The wrong things turned out to be operating systems, programming languages, networking protocols, and the architecture of the internet.

Every system you depend on was built by someone who stayed up too late because they couldn't stop thinking about it. Someone who named their side projects. Someone who had opinions about message passing before anyone else thought it mattered. Someone who built tools for themselves first, and then the world used them.

That's a dork. And this is their operating system.

### The Identity

DorkOS doesn't explain the name. It earns it.

The name is a filter: if it makes you hesitate, this isn't for you. If it makes you grin — you're home.

Dork isn't an insult reclaimed. It was never an insult to us. It's a description of a builder type: the person who runs agents at 3am, who has opinions about cron expressions, who names their AI team, who cares about coordination primitives most people have never heard of. The kind of person who builds the future while everyone else is still deciding what to call it.

### The Line

**Built by dorks. For dorks. Run by you.**

This is DorkOS's "Think Different." It doesn't apologize. It doesn't explain. It identifies the tribe and welcomes them.

Alternate forms for different contexts:

- **Short**: Built by dorks.
- **Personal**: We named it after ourselves.
- **Defiant**: The ones who care too much build the things that matter most.
- **Community**: Every great system was built by someone who couldn't stop thinking about it.

---

## 9. What DorkOS Is Not

Not a chatbot wrapper. Not a hosted service. Not an agent. The layer agents were missing.

DorkOS is not a model aggregator. Not a chat widget. Not a cloud platform. It's an autonomous agent operating system you run on your machine, configure, and control.

**The philosophical argument:** We gave people Slack because teammates can't coordinate in isolation. We gave applications an OS because software needs files, scheduling, and a way to communicate with other programs. AI agents work like teammates — but right now, they start every day with amnesia, work alone, and have no way to reach you. That's a missing layer.

**Honesty note:** Claude Code uses Anthropic's API for inference. Your code context is sent to their servers. DorkOS doesn't change that and won't pretend it does. What DorkOS controls: the agent runs on your machine, sessions are stored locally, tools execute in your shell, and the orchestration layer is entirely yours.

---

## 10. Tone & Voice

Confident.
Minimal.
Technical.
Sharp.
Honest.
Not corporate.

Avoid hype language.

Use language like:

- Autonomous
- Engine
- Orchestration
- Agents
- Permissions
- Control
- Operator
- Builder

### Voice Examples

| Don't say                  | Say                                                       |
| -------------------------- | --------------------------------------------------------- |
| "Easy-to-use AI assistant" | "Autonomous agent operating system"                       |
| "Get started in minutes!"  | "Install. Configure. Run."                                |
| "We help developers..."    | "Built for developers who ship."                          |
| "Powerful AI features"     | "Agents that multiply what you accomplish."               |
| "No cloud dependency"      | "Intelligence from the agents. Everything else is yours." |

### Language to Avoid

_Established during Value Architecture review (2026-02-27). These rules apply to all marketing copy, landing pages, docs, and README content._

#### Terms to Avoid

| Avoid                                                         | Use Instead                                                                                        | Why                                                                                                                                                                |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "server-side"                                                 | "independently" / "not tied to your IDE or terminal" / "keeps running when you close the terminal" | Most users run DorkOS on their laptop first. "Server-side" sounds enterprise/cloud. The real differentiator is independence from the IDE, not running on a server. |
| "infrastructure"                                              | "system" / "foundation" / "the layer" / just remove it                                             | Too cold, too enterprise. DorkOS is a tool for builders, not an infrastructure play.                                                                               |
| "audit trail"                                                 | "every session recorded" / "full session history"                                                  | Enterprise compliance language. Focus on transparency and reviewability instead.                                                                                   |
| "session locking"                                             | Remove from marketing copy                                                                         | Enterprise term. Keep only in technical API docs.                                                                                                                  |
| "universal message bus" / "message bus"                       | "built-in messaging" / "your agents can message you and each other"                                | Too technical. Describe the outcome (agents reach you), not the mechanism. Think: how would Apple describe this?                                                   |
| "agents that can talk" / "talk to each other"                 | "agents, connected" / "message each other" / "communicate"                                         | Confused with voice/speech agents (ElevenLabs, etc.). "Connected" and "message" are unambiguous.                                                                   |
| "renting" (as metaphor for SaaS)                              | "it runs on your machine, you can read and change every line of code"                              | The rental metaphor is unclear. Be concrete about what ownership means.                                                                                            |
| "durable delivery" / "dead-letter queue" / "budget envelopes" | Save for technical docs                                                                            | These are real features but they're mechanism language, not benefit language.                                                                                      |
| "processes" (as in "isolated processes")                      | "solo agents" / "disconnected agents"                                                              | "Processes" is systems-level jargon. Use human-scale language.                                                                                                     |

#### Metaphor Guidelines

| Use                              | Don't Use                              | Why                                                                                                                                 |
| -------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| "Agents work **like** teammates" | "Agents **are** teammates"             | People aren't ready to place agents on the same level as human teammates yet. "Like" acknowledges the analogy without overclaiming. |
| "Like giving your agents Slack"  | "Kernel IPC for agents"                | The Slack metaphor is immediately understood. IPC is jargon that excludes most of the audience.                                     |
| "From solo agents to a team"     | "From isolated processes to a network" | Human-scale language. Teams, not networks.                                                                                          |
| "Your agents can reach you"      | "Your agents have a voice"             | "Voice" implies speech/audio. "Reach" implies connection on any channel.                                                            |

#### Tone Guardrails

- **Apple-style outcomes over mechanisms.** Describe what happens for the user, not how the system works internally. "Get a Telegram message when your agent finishes" not "Publish to a NATS-style hierarchical subject."
- **No enterprise compliance language.** DorkOS is for indie hackers and builders, not SOC 2 audits. "Every session recorded" not "complete audit trail." "Open source" not "auditable."
- **Laptop-first, not cloud-first.** Most users will run DorkOS on their own computer. Language should reflect that. "Run on your laptop, a home server, or a $5 VPS" — in that order.
- **Connectivity and flexibility over reliability.** When describing Relay, lead with "your agents can reach you on Telegram, notify each other, connect through any channel" — not "durable delivery, guaranteed message persistence."
- **No "infrastructure" identity.** The brand identity is about building teams and shipping code, not about running infrastructure. "I build with AI teammates" not "I own my agent infrastructure."

#### Human-Empowerment Positioning (Added 2026-03-02)

DorkOS positions AI agents as tools for human creativity and empowerment — like Apple positions the Mac, iPhone, and iPad. The human is the creative force. The agents are the coordination layer that lets human vision scale.

| Never Say                         | Say Instead                                | Why                                                 |
| --------------------------------- | ------------------------------------------ | --------------------------------------------------- |
| "Your AI is smarter than you"     | "Your AI amplifies what you build"         | The human is the creator, the agent is the tool     |
| "You're the bottleneck"           | "You've always had more ideas than hours"  | Celebrate human ambition, don't diminish it         |
| "Agents that never stop"          | "Agents that multiply what you accomplish" | Tirelessness framed as empowerment, not superiority |
| "While you sleep" (as deficiency) | "So you can focus on what matters"         | Human choices are valid, not limitations            |
| "Outship everyone"                | "Ship what you've always imagined"         | Empower, don't compete                              |
| "Your agent works when you don't" | "Your ideas keep moving forward"           | Center the human's vision, not the agent's labor    |

**Core thesis:** "Intelligence doesn't scale. Coordination does."
**The Apple test:** Would Apple say this about the Mac? If not, reframe.

---

## 11. Brand Aesthetic

Influence: 144x.co

Design direction:

- Minimal
- High-contrast
- Dark-mode friendly
- Clean typography
- Monospaced accents
- Grid-based layout
- No cartoon mascots

DorkOS should feel like:

- A tool
- A weapon
- A control panel
- A developer instrument

---

## 12. Taglines

**Primary:** Intelligence Doesn't Scale. Coordination Does.

**Brand line:** Built by dorks. For dorks. Run by you.

**Messaging bank** (secondary/contextual use):

- You've Always Had More Ideas Than Hours. That Ratio Just Changed.
- One Person. Ten Agents. Ship What You've Always Imagined.
- The Operating System for AI Agents
- Tools for Builders Who Never Run Out of Ideas.
- From Solo Agents to a Coordinated Team
- Your Ideas. Your Agents. Your Rules.
- Agents That Multiply What You Accomplish.
- Not a Chatbot. A System. The Layer Agents Were Missing.
- Intelligence from the Agents. Everything Else Is Yours.
- We Named It After Ourselves.
- The Ones Who Care Too Much Build the Things That Matter Most.
- You Slept. They Shipped. _(Use with awareness — the power is in celebrating the outcome, not framing sleep as deficiency.)_

---

## 13. Website Structure Draft

### Hero Section

> **INTELLIGENCE DOESN'T SCALE. COORDINATION DOES.**
>
> DorkOS turns isolated AI agents into a coordinated team.
> Scheduling. Messaging. Agent discovery. A browser-based command center.
> You've always had more ideas than hours. That ratio just changed.
>
> `npm install -g dorkos`

### Sections

1. The System (Architecture Overview)
2. What This Unlocks (Use Cases)
3. How It Works
4. Your First 5 Minutes (Getting Started)
5. Honest by Design (Transparency)
6. About
7. Contact

---

## 14. Your First 5 Minutes

This is what happens when you install DorkOS for the first time. No signup. No cloud account. No configuration wizard.

### Minute 0: Install

```
npm install -g dorkos
```

One command. If you know what that means, you're in the right place.

### Minute 1: Launch

```
dorkos
```

Your browser opens. You're looking at every Claude Code session across all your projects — sessions you started from the CLI, from VS Code, from anywhere. One place. Every session. Already there.

### Minute 2: Explore

Pick a session. You see the full conversation: messages, code changes, tool calls, results. Rich markdown, syntax highlighting, the full story of what your agent did. Start a new session from the browser — same Claude Code, no terminal required.

### Minute 3: Schedule

Open Pulse. Create your first schedule:

> "Run my test suite every night at 2am. If anything breaks, create a fix and open a PR."

Set the cron. The agent runs tonight whether you're at your desk or not.

### Minute 4: Connect

Open Relay. Add the Telegram adapter. Connect your account.

Now your agents can reach you — on your phone, while you're at lunch, while you're asleep. When your 2am test run finishes, you'll know.

### Minute 5: Close your laptop.

This is the moment. The terminal is closed. The browser is closed. Your laptop is sleeping.

Your agent is not.

At 2:07am, your phone buzzes. Telegram: "Test suite passed. One flaky test fixed. PR #47 ready for review."

You see it at 7am. Your morning starts with progress, not firefighting.

That's DorkOS.

---

## 15. The Ten-Agent Team

What does "one person, ten agents" actually look like? Here's what Kai runs:

| Agent        | Project           | Schedule         | What It Does                                   |
| ------------ | ----------------- | ---------------- | ---------------------------------------------- |
| **Atlas**    | dorkos/core       | Every night, 2am | Runs tests, fixes failures, opens PRs          |
| **Scout**    | dorkos/docs       | Every 6 hours    | Checks for stale docs, updates examples        |
| **Sentinel** | production-api    | Every 30 minutes | Monitors error rates, triages new errors       |
| **Forge**    | client-app        | On demand        | Implements features from the roadmap           |
| **Lens**     | analytics-service | Daily, 6am       | Analyzes yesterday's metrics, files reports    |
| **Bridge**   | integration-layer | On deploy        | Runs integration tests across services         |
| **Archive**  | knowledge-base    | Weekly           | Organizes and indexes new documentation        |
| **Patrol**   | security-scanner  | Daily, 4am       | Dependency audit, vulnerability scanning       |
| **Herald**   | all projects      | Always on        | Routes notifications to Telegram and Slack     |
| **Loop**     | feedback-engine   | Every 4 hours    | Collects signals, dispatches improvement tasks |

Each agent has a name, a color, an icon, and a Relay address. They appear in Console as browser tabs — you know at a glance who's working, who's done, and who needs you.

This isn't hypothetical. This is what DorkOS makes possible today.

---

## 16. Open Source Strategy

- Engine open source
- Community contributions encouraged
- Modular architecture allows extension
- GitHub-first presence

Position DorkOS as a movement, not just a tool.

---

## 17. Long-Term Vision

DorkOS becomes:

- The default autonomous agent operating system
- The backbone of autonomous software development
- The operating layer for AI-native companies
- A distributed mesh of privately-run AI agents

---

## 18. Final Brand Summary

DorkOS is not trying to be friendly. It is trying to be powerful.

It is for developers who:

- Want autonomy
- Want control
- Want full capability
- Want a serious AI system they own
- Want honest tools

It is a tool for operators.

Built by dorks. For dorks. Run by you.
