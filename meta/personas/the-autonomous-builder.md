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

## Context

Kai ships production code daily, often across multiple personal projects. They adopted Claude Code early and run 10-20 agent sessions per week. They've built custom slash commands and CLAUDE.md files for each project. But they're frustrated that each session is isolated — the agent forgets everything, can't talk to other agents, and can't run while Kai sleeps.

## Trigger

Kai wakes up to find a CI pipeline broken overnight. They think: "My agent could have caught this at 2am, fixed it, and told me on Telegram. Why can't it?"

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

## Quote

"I don't need another chatbot wrapper. I need my agents to work while I sleep and tell me what they did."

## Anti-Adoption Signals

- If it required a cloud account or hosted service
- If it only worked with one model provider with no adapter path
- If the UI was dumbed down for non-developers
- If it added latency or abstraction over raw Claude Code

## Key Assumptions to Validate

1. Solo devs actually run enough concurrent agents to need Mesh coordination
2. Telegram/Slack notifications are the preferred channel (vs. email, Discord)
3. The trigger is "overnight CI failure" vs. something else (e.g., wanting to parallelize work)
