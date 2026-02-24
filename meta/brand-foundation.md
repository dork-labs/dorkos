# DorkOS — Brand & Product Foundation

## 1. Executive Summary

**DorkOS** is an autonomous agent operating system for developers, founders, and serious builders.

It makes AI coding agents more capable — giving them an engine that never stops, a life layer that keeps you in context, and a mesh that lets agents discover and talk to each other.

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

## 2. Core Brand Position

### Category

Autonomous Agent Operating System

### Positioning Statement

DorkOS is the operating system for autonomous AI agents — giving developers an engine, a life layer, an agent mesh, and full control over their AI-powered infrastructure.

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

## 3. Big Idea

Your AI never sleeps.

DorkOS makes your agents:

- Your autonomous engineering team
- Your always-running agent system
- Your persistent knowledge infrastructure
- Your extensible AI operating layer

Your agents.
Your engine.
Your mesh.
Your rules.

---

## 4. Product Architecture

DorkOS is modular and open source. Each module can run independently or together.

### Available now

#### 4.1 DorkOS Engine (Runtime)

The runtime that powers everything. Engine connects your AI agents, exposes a secure REST API, and serves as the foundation for all other modules. Agent adapters let you plug in any coding agent — Claude Code today, Codex, OpenCode, and others coming.

- Runs locally on your machine
- Connects AI agents via pluggable adapters (Claude Code first, more coming)
- Exposes a secure REST + SSE API
- Enables remote access via tunnel
- Runs Pulse, Relay, and Mesh as integrated capabilities

This is the foundation.

**Status: Available**

#### 4.2 DorkOS Console (Web UI)

- Browser-based interface
- Connect to your local Claude instance from anywhere
- Remote dev workflow
- Multi-project support

This makes DorkOS location-independent.

**Status: Available**

### On the roadmap

#### 4.3 DorkOS Pulse (Heartbeat System)

- Autonomous execution loop
- Can run per-project or system-wide
- Executes roadmap improvements
- Solicits user feedback
- Self-building software capabilities

This is what makes DorkOS alive.

**Status: Coming Soon**

#### 4.4 DorkOS Relay (Message Bus)

The universal message bus. Relay handles all messaging in DorkOS — agent-to-agent, human-to-agent, and external communication. One message format, one delivery system, one audit trail.

- Hierarchical subjects with NATS-style wildcards
- Persistent Messages (Maildir + SQLite) and ephemeral Signals (typing, presence, receipts)
- Budget envelopes that prevent runaway loops
- Plugin adapter model for external channels (Telegram, Slack, email, webhooks)

Relay is kernel IPC for agents.

**Status: Coming Soon**

#### 4.5 DorkOS Wing (Life Layer)

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

#### 4.6 DorkOS Mesh (Agent Network)

Agent discovery and network topology. Mesh turns isolated agents into a discoverable, governed network.

- Every project is an agent: `.dork/agent.json` manifests with `.claude/` fallback for zero-config discovery
- Agent registry: makes agents aware of each other's capabilities and addresses
- Network topology with namespace isolation (default-allow within project, default-deny across)
- Access control rules authored by Mesh, enforced by Relay

The Mesh is what makes DorkOS an operating system, not just a runtime. Without it, you have isolated agents. With it, you have a workforce.

**Status: Coming Soon**

#### 4.7 Loop (Autonomous Improvement Engine)

A companion product by Dork Labs. Loop closes the feedback loop — collecting signals from the real world, forming hypotheses, dispatching tasks to agents, and measuring outcomes. Fully deterministic, no AI built in, agent-agnostic.

DorkOS's Pulse scheduler polls Loop for the next priority task. Loop returns prepared instructions. Agents execute. Outcomes feed back as new signals. The system improves itself.

See the [Loop Litepaper](../research/loop-litepaper.md) for the full vision.

**Status: [Live](https://www.looped.me/)**

---

## 5. We Believe

- Your AI should work autonomously on your behalf
- Power tools deserve power users
- Open source is infrastructure, not charity
- Autonomy is a feature, not a risk
- Honesty builds trust — we tell you exactly what runs where

DorkOS is:

- Opinionated
- Performance-focused
- Developer-centric
- Built for serious work
- Radically transparent

---

## 6. What DorkOS Is Not

DorkOS is not a hosted service. Not a model aggregator. Not a chat widget. Not an agent wrapper. It's an autonomous agent operating system you run, configure, and control.

**Honesty note:** Claude Code uses Anthropic's API for inference. Your code context is sent to their servers. DorkOS doesn't change that and won't pretend it does. What DorkOS controls: the agent runs on your machine, sessions are stored locally, tools execute in your shell, and the orchestration layer is entirely yours.

---

## 7. Tone & Voice

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

| Don't say | Say |
|---|---|
| "Easy-to-use AI assistant" | "Autonomous agent operating system" |
| "Get started in minutes!" | "Install. Configure. Run." |
| "We help developers..." | "Built for developers who ship." |
| "Powerful AI features" | "Agents that work while you sleep." |
| "No cloud dependency" | "Intelligence from the agents. Everything else is yours." |

---

## 8. Brand Aesthetic

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

## 9. Taglines

**Primary:** Your AI Never Sleeps.

**Messaging bank** (secondary/contextual use):

- Deploy Your AI Workforce
- The Operating System for AI Agents
- Agents That Work While You Sleep
- Your Engine. Your Mesh. Your Rules.
- Not a Chatbot. A System.
- Intelligence from the Agents. Everything Else Is Yours.

---

## 10. Website Structure Draft

### Hero Section

> **Your AI Never Sleeps.**
>
> DorkOS is an open-source operating system for autonomous AI agents. Powered by an engine that never stops. Connected through an agent mesh.
>
> `npm install -g dorkos`

### Sections

1. The System (Architecture Overview)
2. What This Unlocks (Use Cases)
3. How It Works
4. Honest by Design (Transparency)
5. About
6. Contact

---

## 11. Installation Narrative

DorkOS installs via npm. If you know what that means, you're in the right place. If you don't, you will soon.

---

## 12. Open Source Strategy

- Engine open source
- Community contributions encouraged
- Modular architecture allows extension
- GitHub-first presence

Position DorkOS as a movement, not just a tool.

---

## 13. Long-Term Vision

DorkOS becomes:

- The default autonomous agent operating system
- The backbone of autonomous software development
- The operating layer for AI-native companies
- A distributed mesh of privately-run AI agents

---

## 14. Final Brand Summary

DorkOS is not trying to be friendly. It is trying to be powerful.

It is for developers who:

- Want autonomy
- Want control
- Want full capability
- Want serious AI infrastructure
- Want honest tools

It is a tool for operators.
