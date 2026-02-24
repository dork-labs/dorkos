# Loop: The Autonomous Improvement Engine

**By Dorian Collier**
**February 2026**

---

## The Missing Piece

We have incredible AI coding agents. Claude, Codex, and dozens of alternatives can write code, fix bugs, and ship features autonomously. We also have excellent project management tools — Linear, Jira, GitHub Issues — that organize human work into trackable units.

But there is no system that closes the loop.

Today's workflow looks like this:

```
Human notices problem  ->  Human writes ticket  ->  Agent does work  ->  Ship  ->  ???
```

The "???" is where everything breaks down. After shipping:

- Who checks if the fix actually worked?
- Who notices the new regression?
- Who synthesizes the analytics data, user feedback, and error logs into what to do next?
- Who decides the next priority based on what we just learned?

The answer is always a human. A human who is context-switching, forgetting, and operating on gut feel rather than systematic analysis. The feedback loop lives in their head, and it runs once a week at best — during retros that nobody pays attention to.

**Loop is the engine that closes this gap.** It turns signals into hypotheses, hypotheses into plans, plans into tasks, and tasks into agent sessions — then monitors the outcomes and feeds them back in. Continuously. Automatically. Without a human in the middle.

---

## The Core Idea: Everything Is an Issue

The key insight is that a feedback loop doesn't need a complex orchestration engine, a state machine, or a workflow designer. **Everything is an issue.**

- A signal arrives (user feedback, a metric drop, an error spike) — **create an issue**: "Triage this signal"
- An agent triages the signal — **create an issue**: "Investigate this hypothesis"
- A hypothesis is formed — **create issues**: the implementation tasks
- Tasks are completed by agents — **create an issue**: "Monitor the outcomes"
- Monitoring detects a change — the change is a new signal, and the loop continues

The issue queue IS the orchestration layer. This means:

1. **One unified system** — signals, hypotheses, plans, tasks, and monitors all live in the same place
2. **One priority system** — everything competes in the same backlog, ranked by urgency and strategic alignment
3. **Full auditability** — every decision the system makes is traceable as an issue with a parent chain
4. **Human override at any point** — you can create, modify, prioritize, or cancel any issue at any time

---

## How It Works

### The Loop

```mermaid
graph LR
    Signals["<b>Signals</b><br/>PostHog · User feedback<br/>Error logs · Git events"]
    Triage["<b>Triage</b><br/>Agent picks up signal,<br/>accepts or declines"]
    Hypothesize["<b>Hypothesize</b><br/>Agent forms hypothesis<br/>from signal + context"]
    Plan["<b>Plan</b><br/>Agent breaks hypothesis<br/>into tasks"]
    Execute["<b>Execute</b><br/>Agent writes code,<br/>creates PRs, ships"]
    Monitor["<b>Monitor</b><br/>Outcomes feed back in<br/>as new signals"]

    Signals --> Triage --> Hypothesize --> Plan --> Execute --> Monitor --> Signals
```

### A Concrete Example

1. **Signal arrives**: PostHog detects that sign-up conversion dropped 12% in the last 24 hours. A webhook sends this data to Loop.

2. **Triage**: Loop creates an issue — "PostHog: sign-up conversion -12% (24h)." An AI agent picks it up, reads the PostHog data, checks recent deployments, reviews the git log and error rates, and decides: this is a real problem, not noise.

3. **Hypothesis**: The agent creates a hypothesis — "The OAuth redirect change in PR #847, merged 26 hours ago, adds 1.5-3 seconds of blank white screen, causing users to abandon sign-up." Confidence: 82%. Validation criteria: conversion returns to above 3.4% within 48 hours of a fix.

4. **Plan**: The agent breaks the hypothesis into concrete tasks: add a loading spinner to the redirect page, add latency tracking, and create a monitoring task to verify recovery.

5. **Execute**: Agents pick up each task, write code, create pull requests, and ship.

6. **Monitor**: A monitoring task watches the conversion metric for the next 48 hours. Conversion recovers. The hypothesis is validated. The loop closes.

The entire chain is visible as linked issues. Every agent action is recorded. Every decision is auditable. And if conversion hadn't recovered, the system would generate new signals and try a different hypothesis.

---

## Loop Has No AI

This is the part that surprises people.

Loop is not an AI product. It is a **fully deterministic data system with a prompt layer.** There are zero LLM calls inside Loop. No embeddings. No inference. No token costs. No model dependencies.

Loop is a web application with a database, an API, and a set of human-authored prompt templates. When an agent asks "what should I work on next?", Loop returns the highest-priority unblocked issue along with detailed instructions that tell the agent exactly what to do. The agent executes. Reports back. And the cycle continues.

**This is the key insight: Loop automatically improves every time a better AI model is released — without changing a single line of code.**

The quality of Loop's output depends on two things:

1. **The instructions** — human-authored, stored in Loop, continuously improved by feedback
2. **The model reading them** — owned and operated by you, outside of Loop

When a better model ships, every Loop installation worldwide gets better overnight. When you switch from a smaller model to a larger one, your loop quality improves instantly. Loop doesn't care which model reads its instructions. It doesn't care which agent platform executes the work. It's a protocol, not a runtime.

**Think of it this way:** Loop is a gym. It doesn't do the lifting — it organizes the workout, tracks progress, and tells you what exercise to do next. As the athletes (AI models) get stronger, the results improve without the gym changing. And the workout plans (instructions) can be refined independently of both the gym and the athletes.

### Why This Matters

**No vendor lock-in.** Any AI agent that can make HTTP calls works with Loop. Swap agents without touching Loop. Swap models without touching Loop. Your only costs are the models you already pay for.

**Fully on-premises.** Run Loop on your own infrastructure with any model you choose — local LLMs, Claude, GPT, Gemini. No data leaves your environment for AI processing.

**Deterministic and testable.** The entire system can be validated with standard unit tests. No probabilistic behavior. No prompt engineering regressions from API changes. No AI-specific infrastructure.

**Automatically improves.** Every advance in AI capability — from any provider — makes Loop better without any action on your part. The product gets better by standing still.

---

## The Instruction Layer

Loop's real value isn't just organizing work. It's knowing exactly what to tell an agent to do, given the current state of the system.

### Smart Selection

Loop stores a library of instruction templates, each tagged with conditions describing when it should be used. When an issue is ready for dispatch, Loop finds the most specific matching template.

A generic "triage this signal" template might handle most signals. But if the signal came from PostHog, a more specific "triage this PostHog metric change" template takes priority — one that knows to check recent deployments, compare against historical baselines, and look for correlated error spikes.

This is pattern matching, not AI. The most specific match wins, every time, deterministically.

### Rich Context

The selected template is then filled in with everything the agent needs to know: the issue details, the parent issue chain, sibling tasks, the project goal, any previous failed attempts, and which other issues are waiting on this one to finish.

An agent working on a bug fix doesn't just get "fix this bug." It gets the signal that triggered it, the hypothesis behind it, the project it belongs to, the goal it's working toward, what was tried before and why it failed, and which downstream tasks are blocked until this one completes.

### Self-Improving Instructions

After completing work, agents rate the instructions they were given. Was the prompt clear? Was enough context provided? Did the instructions match the actual work needed?

This feedback accumulates. When instruction quality drops below a threshold, Loop creates an issue — "Improve these instructions" — which enters the same dispatch queue as everything else. An agent picks it up, reads the accumulated feedback, drafts better instructions, and submits them for human review.

The instructions improve through the same loop as the product itself. No special infrastructure. No AI in Loop. Just issues, data, and agents improving each other's work.

---

## Principles

Loop adopts and extends several ideas from the Linear Method — practices that Linear developed for human teams, adapted for autonomous agent execution.

### Build for the Loop, Not the Sprint

The system doesn't operate in artificial time-boxes imposed by humans. It runs continuously. Cycles can exist as observation windows for measuring progress, but the work never stops to wait for a planning meeting.

### Write Issues, Not User Stories

Issues should be concrete and actionable. "As a user, I want..." templates obscure the actual work. Loop issues describe the problem or action directly:

- Good: "Fix OAuth redirect showing blank page for 1.5-3s"
- Bad: "As a user, I want a faster sign-in experience so that I don't abandon the flow"

### Scope Issues Small

Every issue should be completable in a single agent session. If an agent can't finish an issue in one pass, the issue was too big. The planning step breaks hypotheses into sub-issues that are each independently shippable.

### Triage Is Signal Processing

Every incoming signal creates an issue in a triage state. An agent processes the queue: accepting real problems, declining noise, deduplicating duplicates, and snoozing items that need more data. This is Linear's triage inbox repurposed as the front door for all external signals.

### Say No to Busy Work

Not every signal deserves a hypothesis. Not every hypothesis deserves a plan. The system actively prunes: declining noisy signals, archiving low-confidence hypotheses, and keeping backlogs manageable. Agents are cheap, but context pollution degrades their output quality.

### Decide and Move On

Agents form hypotheses at 0.6-0.8 confidence, ship small fixes, and measure outcomes. The system learns from results rather than trying to be right upfront. This is the scientific method applied to software: hypothesize, test, measure, iterate.

### Build in Public

Every agent action is logged. Every hypothesis is traceable to signals. Every outcome is measured. The system can generate changelogs that explain not just *what* changed but *why* — tracing back to the signal that triggered the work.

---

## The Data Model

Loop's data model is intentionally simple. At its core, there are a handful of concepts:

**Issues** are the atomic unit. Everything — signals, hypotheses, plans, tasks, monitors — is an issue with a type. Issues can have one parent (but only one level deep), belong to a project, carry labels, and link to each other with blocking relationships.

**Projects** group issues toward a shared objective. A project called "Improve onboarding" collects all the signals, hypotheses, and tasks related to that effort.

**Goals** are measurable success indicators attached to projects. "Increase sign-up conversion to 4%" gives the system — and the agents — strategic direction. Without goals, the loop optimizes locally (fix the latest bug). With goals, agents have context for prioritization.

**Signals** are raw incoming data from the outside world: analytics webhooks, error tracking alerts, user feedback, git events. Every signal creates an issue for triage.

**Labels** categorize issues — bugs, features, infrastructure, auto-generated. Some labels are system-managed to mark work that was created or completed by agents.

**Issue Relations** express dependencies. "Task A blocks Task B" means Task B won't be dispatched until Task A is complete. This is how the system handles execution ordering without a workflow engine.

**Comments** are how agents and humans communicate on issues. Agents report progress, document findings, and ask questions. Humans provide guidance and overrides.

---

## The Pull Architecture

Loop doesn't push work to agents. Agents pull work from Loop.

On a configurable schedule, an agent asks Loop: "What should I work on next?" Loop evaluates the entire backlog — filtering out blocked issues, scoring by priority, goal alignment, and age — and returns the single highest-priority item along with fully prepared instructions.

The agent executes. Reports results back to Loop's API. And on the next poll, gets the next item.

This design is deliberately simple. Loop never needs to know how to connect to your agent platform. Your agent platform never needs to expose an endpoint. The integration is a single scheduled poll. Any agent that can make HTTP calls works with Loop.

---

## What Loop Tracks

Loop isn't just a to-do list. It tracks the health of the improvement loop itself:

**Loop velocity** — how fast does the system go from signal to validated outcome? This is the equivalent of "cycle time" for the entire feedback loop.

**Hypothesis hit rate** — what percentage of hypotheses are validated versus invalidated? Over time, the system learns which signal patterns produce accurate hypotheses.

**Prompt health** — are the instructions getting better or worse? Which templates have low completion rates? Which ones get poor feedback from agents?

**Goal progress** — are the measurable outcomes actually improving? Conversion rates, error rates, response times — whatever you're tracking.

These metrics are displayed in a dashboard that shows the loop working in real time: signals arriving, hypotheses forming, tasks executing, outcomes being measured.

---

## Open Source and Agent-Agnostic

Loop is fully open source. MIT licensed. No vendor lock-in.

Any agent can use Loop — not just DorkOS. Any tool that can make HTTP calls can poll Loop's dispatch endpoint. Swap agents without changing Loop. Swap models without changing Loop.

The instruction templates are community-improvable. Better templates mean better results for everyone. A PostHog-specific triage template that one team develops benefits every Loop installation that receives PostHog signals.

Because Loop has no AI built in, there are no AI costs from Loop itself. Hosting costs are minimal — it's a standard web application with a database. All AI costs live on the agent side, where you already control them.

---

## Part of the DorkOS Suite

Loop is built by Dork Labs, the team behind DorkOS — the open-source web interface and API for Claude Code. Loop is designed as a companion product: DorkOS provides the agent execution environment, Loop provides the autonomous work management layer on top.

Together, they form a complete autonomous development system:

- **DorkOS** is the hands. It runs AI agent sessions, manages tool approvals, and provides the chat interface for human-agent collaboration.
- **Loop** is the brain. It collects signals, decides what to work on, prepares instructions, and tracks outcomes.

DorkOS's built-in scheduler (Pulse) polls Loop on a regular cadence. Loop returns the next priority item with instructions. DorkOS executes. The agent reports back. The loop runs itself.

But Loop works with any agent platform. DorkOS is the first integration, not the only one.

---

## Why Now

Three things converged to make this possible:

**Agent capability has crossed the threshold.** AI coding agents can now reliably write, test, and ship code autonomously. They're good enough to execute tasks, but they still need someone — or something — to decide what tasks to execute and whether the results actually worked. That's the gap Loop fills.

**The protocol layer exists.** REST APIs, webhooks, and emerging standards like the Model Context Protocol mean that tools can expose capabilities to any agent. Loop's dispatch endpoint is a simple HTTP call. Any agent, any platform, any model.

**The market gap is real.** Height attempted autonomous project management and shut down in September 2025. Linear has positioned itself as the PM layer that accepts AI agents but doesn't close the loop. Factory.ai builds agent fleets but has no PM layer. No existing product sits at the intersection of issue tracking, autonomous execution, and closed feedback loops.

---

## The Vision

The question isn't whether AI agents will manage their own work. It's whether the feedback loop that guides them will be built intentionally — with hypotheses, validation, and scientific rigor — or whether it'll be a mess of cron jobs, Slack notifications, and human intuition.

Loop is the intentional version.

Ship. Measure. Loop.
