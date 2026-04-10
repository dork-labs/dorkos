# Kai Nakamura — The Autonomous Builder

**Role**: Primary persona
**Confidence**: Proto-persona (assumption-based)
**Created**: 2026-02-27
**Review by**: 2026-08-27

---

## Demographics

- **Age**: 28-35
- **Role**: Senior full-stack developer / indie hacker
- **Company**: Solo or 2-5 person startup
- **Technical level**: Expert — comfortable with monorepos, TypeScript, Docker, CI/CD
- **Tools**: VS Code/Cursor, Claude Code, GitHub, Obsidian, Telegram
- **Location**: Remote — could be anywhere (Austin, Berlin, Tokyo, Lisbon)

## Context

Kai ships production code daily, often across multiple personal projects. They adopted Claude Code early and run 10-20 agent sessions per week. They've built custom slash commands and AGENTS.md files for each project. But they're frustrated that each session is isolated — the agent forgets everything, can't talk to other agents, and can't run while Kai sleeps.

Kai already thinks in terms of systems, not sessions. They don't want to chat with an AI — they want to operate an AI team.

## Trigger

Kai wakes up to find a CI pipeline broken overnight. They think: "My agent could have caught this at 2am, fixed it, and told me on Telegram. Why can't it?"

## The Worst Day

It's 7:12am on a Monday. Kai checks Slack on their phone — CI is red. Has been since 2:47am. A dependency update cascaded failures across three repos. The agent could have caught this. It could have fixed it in five minutes, created a PR, and sent a Telegram message: "Fixed. PR ready for review." Instead, the terminal was closed. The agent wasn't running. Nobody was watching.

Kai spends the entire morning firefighting something that should have been handled hours ago. The most capable coding agent in the world was useless because Kai wasn't sitting in front of it. That's not a tool limitation — that's a missing layer.

Kai thinks: "I pay for the most powerful AI coding agent available. And it only works when I'm at my desk. That's insane."

## Jobs to Be Done

- When I'm sleeping or away from my desk, I want scheduled agent sessions to execute roadmap tasks, so that I ship features 24/7 without burnout.
- When an agent finishes work, I want it to notify me on Telegram/Slack, so that I can review from my phone without checking the terminal.
- When I have agents across 5 projects, I want them to discover each other and coordinate, so that a scheduling agent can ask a finance agent to approve a budget.

## Goals

1. Multiply personal output by making agents autonomous
2. Maintain oversight without micromanaging every session
3. Keep everything local and under their control (not SaaS)

## Frustrations

1. Every Claude Code session starts from scratch — no continuity
2. Agents can write code but can't tell anyone about it
3. No way to schedule agent work for off-hours
4. Managing agents across multiple projects is manual
5. The agent is the smartest team member but can't do anything without being prompted

## Quote

"I don't need another chatbot wrapper. I need my agents to work while I sleep and tell me what they did."

## How Kai Talks (Language Patterns)

When describing the problem to a friend:

- "My agents just sit there doing nothing when I'm asleep"
- "I'm the bottleneck for my own AI tools"
- "I could have caught this at 2am if the agent was running"
- "I have the most powerful coding agent in the world and it only works when I'm at my desk"
- "Another chatbot wrapper" (dismissive — used to filter products quickly)
- "Ship it" / "Does it ship?"

When excited about a tool:

- "This just works"
- "I woke up to three merged PRs"
- "It runs while I sleep — that's the whole point"
- "I'm running 10 agents across 5 projects right now"

Technical vocabulary (uses naturally): cron, JSONL, sessions, adapters, MCP, REST, SSE, headless, daemon, webhook, self-hosted

## What Kai Brags About

- "I shipped three features while I was asleep"
- "I run five projects solo and ship faster than most teams"
- Number of PRs merged per week, deployment frequency
- The sophistication of their system — "I built an agent team, not a chatbot"
- Speed: "What used to take a week ships overnight"

## Fears & Objections

- "Will it add latency or abstraction over raw Claude Code?" (performance anxiety)
- "Is this another abandoned open source project that'll die in 6 months?" (sustainability)
- "What if an agent runs rogue overnight and breaks prod?" (trust / safety)
- "How much does this actually cost in API tokens per month?" (unit economics)
- "Will it break when Anthropic changes the API?" (dependency risk)

## Media Consumption

- **Daily**: Hacker News, Twitter/X (follows indie hackers, AI devs, Claude Code power users)
- **Reddit**: r/ClaudeAI, r/SelfHosted, r/ExperiencedDevs
- **Newsletters**: TLDR, Latent Space, Lenny's Newsletter
- **YouTube**: Fireship, ThePrimeagen, Theo
- **Podcasts**: Indie Hackers, My First Million, Latent Space
- **GitHub**: Actively stars and watches tools in the AI agent ecosystem
- **Discord**: Claude Code community, indie hacker servers

## Buying Triggers

- Sees a GitHub repo with >1K stars that solves their exact problem
- Hears about it from a respected indie hacker or AI dev on Twitter/X
- Reads a blog post or HN comment that describes their exact frustration
- Discovers it through the Claude Code ecosystem (community, docs, extensions)
- Sees a demo showing agents running overnight and producing real output
- `npm install -g` — one command, runs immediately (no signup, no cloud)

## Anti-Adoption Signals

- If it required a cloud account or hosted service
- If it only worked with one model provider with no adapter path
- If the UI was dumbed down for non-developers
- If it added latency or abstraction over raw Claude Code
- If the README was full of marketing language with no technical substance
- If it required Docker/Kubernetes to run (overengineered for a solo dev)

## Key Assumptions to Validate

1. Solo devs actually run enough concurrent agents to need Mesh coordination
2. Telegram/Slack notifications are the preferred channel (vs. email, Discord)
3. The trigger is "overnight CI failure" vs. something else (e.g., wanting to parallelize work)
4. API token cost is a real concern vs. an abstract worry
5. "Agent team" identity resonates more than "better tooling"
