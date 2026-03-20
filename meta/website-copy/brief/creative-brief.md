# Creative Brief: DorkOS Website

## What Are We Making?

The marketing website for DorkOS — the first impression for every developer who discovers it. This site needs to do three things in order: make them feel something, make them understand what this is, make them install it.

## What Is DorkOS?

DorkOS is an open-source operating system for autonomous AI agents. It gives AI coding agents (like Claude Code) the infrastructure they're missing: scheduling, communication, agent discovery, persistent memory, and a browser-based command center.

**It is not** a chatbot wrapper, a hosted service, an agent, or a model provider. It's the layer between the agent's intelligence and the developer's intent.

**One line:** The operating system for autonomous AI agents.

**Install:** `npm install -g dorkos`

## Who Is This For?

**Primary audience:** Developers who already use AI coding agents (Claude Code, Codex, etc.) daily and feel the friction of their limitations.

**The person we're writing to:** Someone who has run Claude Code at 11pm, produced clean code, closed the terminal, and found the PR by accident three days later. Someone who has typed "let me give you some context..." a hundred times. Someone who manages five projects in fifteen terminal tabs and can't remember which agent is doing what.

**They are:** Senior developers, indie hackers, technical founders, AI power users. They think in systems, not prompts. They name their agents. They have opinions about cron expressions.

**They are not:** Casual users, prompt dabblers, people looking for a chatbot, people who need hand-holding.

### Persona: Kai Nakamura (Primary — The Autonomous Builder)

28-35, senior full-stack / indie hacker, solo or 2-5 person startup. Ships daily across multiple projects. Runs 10-20 agent sessions per week. Frustrated that each session is isolated, agents forget everything, can't run while sleeping, can't notify him. Already thinks in teams, not sessions.

**Trigger:** Wakes up at 7am. CI has been red since 2:47am. The agent could have fixed it in five minutes. The terminal was closed. Nobody was watching.

**Quote:** "I don't need another chatbot wrapper. I need my agents to work while I sleep and tell me what they did."

**Brags about:** "I shipped three features while I was asleep." Deployment frequency. Number of PRs merged per week.

### Persona: Priya Sharma (Secondary — The Knowledge Architect)

30-40, staff engineer / technical architect. Manages architecture across services. Lives in Obsidian. Uses Claude Code for implementation but context-switches constantly between thinking and doing.

**Trigger:** 40 minutes into flow state writing an architecture doc. Needs to check one thing in the codebase. Alt-tab. Terminal. Three paragraphs of context. The flow is gone. 15 minutes re-reading her own notes.

**Quote:** "My best thinking happens in Obsidian. My best execution happens with Claude Code. I need them in the same place."

## The Villain

Not a company. A moment.

**The dead terminal.** Agent shipped code, told no one. You find the PR by accident.

**The re-introduction.** "Let me give you some context..." for the hundredth time. Every session starts from zero.

**The 15-tab juggle.** Five projects, agents in different terminals, you can't remember which is doing what.

**The flow-killer.** Alt-tab to terminal, lose 15 minutes of mental state for a 10-second answer.

**The truth:** You pay for the most powerful AI coding agent available. And it only works when you're sitting in front of it.

## What DorkOS Actually Does (The Product)

Seven modules, three tiers:

**Platform (the foundation):**

- **Engine** — Runtime that connects agents via adapters, exposes REST/SSE API, manages sessions
- **Console** — Browser-based command center. Chat, approve tools, browse sessions, manage everything

**Modules (composable capabilities):**

- **Pulse** — Cron-based agent scheduling. Agents run while you sleep. Independent of IDE/terminal
- **Relay** — Built-in messaging. Agents reach you on Telegram, notify each other, connect through any channel
- **Mesh** — Agent discovery and network. Scans projects, registers agents, governs access

**Extensions (integrated from outside):**

- **Wing** — Persistent memory and life context across all sessions (coming soon)
- **Loop** — Autonomous improvement engine. Signals, hypotheses, dispatch, measurement (live)

## The Emotional Arc We Want

1. **Recognition** — "That's exactly my problem" (the villain)
2. **Possibility** — "Wait, this exists?" (the product)
3. **Desire** — "I want this running tonight" (the first 5 minutes)
4. **Trust** — "This is real, it's open source, it's mine" (the foundation)
5. **Identity** — "Built by dorks. For dorks." (the tribe)

## Voice & Tone

- Confident, not arrogant
- Technical, not jargon-heavy
- Minimal, not sparse
- Sharp, not mean
- Honest, not humble

**Sounds like:** A senior engineer explaining something they built and are proud of. No marketing fluff. No exclamation points. No "revolutionary."

**Does not sound like:** Enterprise SaaS. "AI-powered." "Unlock the potential." "Seamlessly integrate."

## Key Lines We Already Have

- **Primary tagline:** Your AI Never Sleeps.
- **Brand line:** Built by dorks. For dorks. Run by you.
- **Install CTA:** `npm install -g dorkos`
- **Position:** The operating system for autonomous AI agents.
- **Philosophy:** We solved this for applications fifty years ago. We called it an operating system.
- **Defiant:** The ones who care too much build the things that matter most.

## Competitive Context

- **Claude Code Remote Control** — Max plan only, one session, terminal-dependent
- **Devin** — Cloud-hosted, closed source, $20+/month
- **Cowork** — Scheduling only works while Mac is awake and Claude Desktop is open
- **Claude Code Agent Teams** — Experimental, terminal-only, single machine
- **DIY** — Tailscale + tmux + custom Telegram bots + caffeinate hacks

DorkOS is the only product that combines scheduling + messaging + agent discovery + browser UI + Obsidian integration in a single open-source, self-hosted package.

## Real Developer Frustrations (Verbatim Quotes)

These are actual developers talking about the exact problems DorkOS solves:

> "I was running Claude Code across 10+ terminal tabs and constantly switching between them to check which session needed permission, which was done, which was idle."

> "I use Claude Code overnight almost exclusively... it's simply not worth my time during the day."

> "the agent would finish or get stuck asking a question, and I wouldn't notice until much later."

> "Claude Code starts every session with zero context. There is no memory of previous sessions... It's a goldfish."

> "A couple of weeks ago I asked it to 'clean up' instead of the word I usually use and it ended up deleting both my production and dev databases."

> "one of the main annoyances I've been dealing with is that when Claude works for a long time, my Mac may go to sleep..."

> "Imagine coming into work to find overnight AI PRs for all the refactoring tasks you queued up — ready for your review."

Full customer voice document available at `meta/customer-voice.md` (36 quotes across 6 themes).

## Origin Story

Dorian Collier grew up in Section 8 housing with no connections to tech. Learned to code from library books. Professional programmer before graduating high school. Built products reaching 30 million users. Shipped apps featured on the App Store. Took a startup from zero to exit in twelve months. Created NFTs for Warner Bros, Game of Thrones, The Matrix. Consulted for Art Blocks.

The throughline: one person, building systems that let you do what should take a team.

When AI coding agents arrived, he saw the gap immediately. The agents were brilliant but trapped — stuck in terminals, starting every session with amnesia, unable to run while you sleep. He'd seen this pattern before: every time a powerful capability emerges, the missing piece is the coordination layer.

He named it after himself. Because the people who build at 3am, who have opinions about cron expressions and message routing — those people deserve a tool that's unapologetically theirs.

## Constraints

- No signup, no cloud account — this is a local tool
- Must include `npm install -g dorkos` prominently
- Must work in dark mode (developer audience)
- Must feel like a tool, not a toy
- No cartoon mascots, no emoji-heavy copy
- Wing is "coming soon" — don't oversell it
- Social proof is pre-launch placeholder — design for it but don't fake it
- The name "dork" is intentional — don't explain it, earn it

## Success Criteria

A developer lands on this page and:

1. Within 5 seconds, knows what this is (autonomous agent OS)
2. Within 15 seconds, recognizes their own pain (the villain moments)
3. Within 60 seconds, understands the product shape (modules, what it does)
4. Within 2 minutes, has decided to install it or bookmark it
5. Feels like this was built by someone like them
