---
title: 'Autonomous Improvement Landscape — Research Report'
date: 2026-02-18
type: exploratory
status: archived
tags: [autonomous-improvement, agent-orchestration, mcp, scientific-method, feedback-loop]
---

# Autonomous Improvement Landscape — Research Report

**Date**: 2026-02-18
**Mode**: Deep Research
**Topics**: 5 interconnected areas covering autonomous software systems, scientific method frameworks, signal processing terminology, AI coding agents, and MCP ecosystem

---

## Research Summary

The landscape of autonomous software improvement is converging around three trends: (1) agent-native development platforms (Devin, Factory, OpenHands) that treat software execution as a pipeline problem, (2) a resurgence of scientific-method frameworks (OODA, Toyota Kata, Build-Measure-Learn) being applied to AI-assisted product cycles, and (3) MCP as the emerging integration glue that connects AI agents to project management systems. The vocabulary from observability engineering (signals, telemetry, spans, traces) is increasingly being borrowed by product teams as a precise language for instrumentation.

---

## Key Findings

### 1. Autonomous Software Systems — Self-Improving Feedback Loops

**Products attempting closed-loop improvement:**

- **Devin (Cognition Labs)** — The canonical example. Grew from $1M to $155M+ ARR in under 18 months. In their 2025 annual performance review, they track specific improvement metrics: PR merge rate doubled from 34% → 67%, 4x faster problem solving, 2x resource efficiency improvement, vulnerability remediation time dropped from 30 min → 1.5 min. The loop is externally validated (humans do first-pass code review) rather than self-referential. Devin 2.0 dropped price from $500/mo to $20/mo. Cognition raised $400M Series C (Founders Fund) valuing it at $10.2B. Now produces 25% of Cognition's own code.

- **Factory.ai (Droids)** — Raised $50M in September 2025, GA launched May 2025. Their "Droids" cover the full SDLC: feature development from tickets, code review, refactoring, documentation, incident response, and codebase Q&A. Integrates with GitHub, Jira, Slack, Datadog, and Google Drive. Key differentiator: "Org and User-level Memory" captures decisions, docs, and runbooks so agents remember context across sessions. Ranked #1 on Terminal-Bench (58.75% score, above Claude Code and Cursor). Raised ~$20M total before the $50M round.

- **OpenHands (formerly OpenDevin)** — Open-source, 67K+ GitHub stars. Multi-agent architecture, web UI, enterprise production-ready. Best for orchestration of multiple agent types. The SDK approach (`OpenHands Software Agent SDK`) is composable and extensible.

- **SWE-Agent (Princeton/Stanford)** — Research-focused, 18K GitHub stars. Key contribution: the concept of Agent-Computer Interfaces (ACIs) — purpose-built interfaces for agents to manipulate code more effectively than raw terminals. Even the best models (gpt-5) resolve only 21% of SWE-EVO tasks vs 65% on SWE-Bench Verified, showing a major gap between benchmark performance and real-world tasks.

- **Sweep AI** — Originally a GitHub App that converts tickets/issues directly into PRs. Pivoted to a JetBrains IDE plugin. Still active in 2026. Ticket-driven: developer writes a GitHub issue, Sweep generates the code change and opens a PR.

- **GitHub Copilot Workspace** — Microsoft's answer to end-to-end autonomous coding. Positioned against Devin for enterprise.

**Self-improvement mechanisms observed:**

- External metric tracking (PR merge rate, benchmark scores) as reward signal
- Human-in-the-loop validation at code review stage rather than pure autonomy
- Organizational memory across sessions (Factory's approach)
- Evolutionary coding agents (Google DeepMind's AlphaEvolve): LLM mutates/combines algorithms, selects best candidates iteratively
- SEAL (Self-Adapting Language Models): generates self-edit instructions → fine-tuning examples → RL weight updates

**Project Management + AI Agent Execution (Combined):**

- **Linear** — Built the "Linear Mission Control Plane (MCP)" to connect AI tools (Cursor, Devin) to Linear issues. Triage Intelligence auto-assigns issues based on historical patterns. Explicitly designed to be assigned work by external AI agents.
- **Height** — Pioneered "autonomous project management" with embedded reasoning engine for bug triage, backlog pruning, spec updates, and standup generation. **Shut down September 24, 2025** after 3.5 years. The market gap it identified remains open.

---

### 2. Scientific Method Applied to Product Development

**Core Frameworks:**

**PDCA (Plan-Do-Check-Act) / Deming Cycle**

- Origin: W. Edwards Deming, adopted deeply by Toyota manufacturing
- Structure: Plan (form hypothesis) → Do (run experiment) → Check (measure outcomes) → Act (standardize or pivot)
- Key property: Each step IS a hypothesis. "What we learn from testing that hypothesis may influence the next step."
- Timescale: Slower, methodical. Suited for quality control and process improvement.

**Toyota Kata (Mike Rother, 2009)**

- Builds on PDCA with four stages:
  1. Understand the Direction (challenge/vision)
  2. Grasp the Current Condition (baseline measurement)
  3. Establish the Next Target Condition (specific, time-boxed goal)
  4. PDCA toward the Target Condition (experiment rapidly)
- Key insight: The _process of improving_ is a learnable habit (kata = practice pattern). The improvement cycle is the product.
- Applied to software: sprint retrospectives + hypothesis-driven feature work

**OODA Loop (John Boyd, military origin)**

- Observe → Orient → Decide → Act
- Designed for rapid, real-time decisions under uncertainty. Faster than PDCA.
- "Orient" is the key differentiating step: mental models, prior experience, cultural norms all filter raw observations.
- Applied to software: incident response, A/B testing decisions, competitive response

**Build-Measure-Learn (Eric Ries, Lean Startup)**

- The software-native adaptation of PDCA
- Structure: Ideas → Build (MVP) → Product → Measure → Data → Learn → repeat
- Key property: Hypothesis-driven. "Each loop is a complete learning cycle and serves as an experiment designed to test specific hypotheses."
- The MVP's primary purpose is to test "leap-of-faith assumptions" as fast as possible
- Speed is the primary metric: reduce time through each loop cycle

**Hypothesis-Driven Development (HDD)**

- Formalized by companies like Thoughtworks
- Every feature starts as: "We believe [action] will [outcome] for [persona]. We'll know this is true when [measurable signal]."
- Explicitly treats product decisions as falsifiable scientific experiments
- Often combined with feature flags for controlled rollout and measurement

**Relationship between frameworks:**

```
Toyota/manufacturing origin: PDCA → Toyota Kata (structured practice)
Military origin: OODA (speed-optimized)
Software origin: Build-Measure-Learn (Lean Startup)
All share: hypothesis → experiment → measure → learn → iterate
```

---

### 3. Signal Processing Terminology in Product Management

**Observability / Infrastructure Terminology (OpenTelemetry standard):**

- **Telemetry** — The process of gathering and transmitting data ("signals") emitted by instrumentation code. Umbrella term.
- **Signals** — The primary observable data types. OpenTelemetry defines signals as: **Traces**, **Metrics**, **Logs**, and (emerging) **Profiles**. "Signal" is the formal term for a type of emitted observable data.
- **Metrics** — Aggregations over time of numeric data about infrastructure or application. Examples: error rate, CPU utilization, request rate per service. Quantitative, aggregated.
- **Traces** — Records showing how a single request moves through distributed services. A trace = one or more spans linked together.
- **Spans** — Atomic units of work within a trace. Each span has: name, timing data, structured logs (events), and metadata (attributes).
- **Logs** — Timestamped messages from services. Not necessarily associated with a specific request. Become more valuable when correlated with spans.
- **Profiles** (4th pillar, newly added to OpenTelemetry in 2025) — Continuous profiling: CPU, memory allocation patterns over time.

**Key 2025 observability status:**

- OpenTelemetry is now the de facto standard. "Instrument once, send to multiple backends." Vendor-neutral.
- 65% of observability practitioners say their practice positively impacts revenue.
- AI/AIOps is playing an increasing role: AI ingests, parses, correlates, and acts on telemetry.

**Product Analytics Terminology:**

- **Events** — The atomic unit. A user action: click, view, feature use. Raw, granular.
- **Metrics** — Derived aggregations from events: retention rate, conversion rate, DAU, engagement score.
- **Properties** — Metadata attached to events (user ID, plan type, feature flag state).

**Platform vocabularies:**

- **Mixpanel**: Event-based. Strong on funnels, flows. JQL for custom queries.
- **Amplitude**: Event-based but metrics-forward. Emphasis on behavioral cohorts and derived metrics.
- **PostHog**: Open-source, dev-centric. Autocapture events. Closest to full-stack (combines analytics + session recording + feature flags + A/B testing). Explicit about "product analytics → product iteration" loop.

**"Signals" vs "Events" vs "Metrics" vs "Telemetry" — the taxonomy:**

| Term      | Layer                         | Granularity          | Who uses it             |
| --------- | ----------------------------- | -------------------- | ----------------------- |
| Telemetry | Collection mechanism          | N/A (umbrella)       | Infra/SRE teams         |
| Signal    | Observable data type category | Category             | Observability engineers |
| Event     | Atomic data point             | Finest               | Product analytics teams |
| Span      | Traced operation              | Atomic, time-bounded | APM/distributed tracing |
| Metric    | Aggregated number             | Coarsest             | Everyone (dashboards)   |
| Indicator | Derived health signal         | Derived              | SRE (SLIs, KPIs)        |

**Event-driven architecture terminology:**

- **Event**: Something that happened at a point in time (immutable fact)
- **Event stream**: Ordered, append-only sequence of events
- **Consumer/subscriber**: Process that reacts to events
- **Dead letter queue**: Events that failed processing
- Apache Kafka and AWS EventBridge use this vocabulary

---

### 4. AI Task Management / Autonomous Coding Competitive Landscape (2025-2026)

**Tier 1: Enterprise-grade autonomous agents**

| Product           | Company          | Status                   | Price              | Key Differentiator                                       |
| ----------------- | ---------------- | ------------------------ | ------------------ | -------------------------------------------------------- |
| Devin             | Cognition        | Active, $10.2B valuation | $20/mo (Devin 2.0) | First mover, Goldman Sachs deployment, 67% PR merge rate |
| Factory Droids    | Factory.ai       | Active, $70M+ raised     | Enterprise         | Full SDLC coverage, org memory, #1 Terminal-Bench        |
| Copilot Workspace | GitHub/Microsoft | Active                   | Part of Copilot    | IDE-integrated, massive distribution                     |
| Amazon Transform  | Amazon           | Active                   | Enterprise         | Legacy migration focus                                   |

**Tier 2: Open-source / research agents**

| Product   | Source             | GitHub Stars | Key Differentiator                          |
| --------- | ------------------ | ------------ | ------------------------------------------- |
| OpenHands | All Hands AI       | 67K+         | Multi-agent, production-ready, SDK          |
| SWE-Agent | Princeton/Stanford | 18K+         | ACI concept, benchmark research             |
| Sweep AI  | Sweep              | —            | JetBrains plugin + GitHub App, ticket-to-PR |

**Tier 3: IDE-focused (less autonomous, more assistive)**

- Cursor (Anysphere) — $100M+ ARR, 40K+ developers. IDE-native, not fully autonomous.
- Windsurf (acquired by Cognition July 2025 from Codeium) — brought hundreds of enterprise customers.
- Amazon Q Developer — Free tier, AWS-integrated.

**"AI Project Manager" products (combined PM + execution):**

- **Height** — DEAD (September 24, 2025). Was most advanced: autonomous bug triage, backlog management, spec updates, standup generation. Market gap now open.
- **Linear** — Alive and growing. Positioned as PM tool that _accepts_ AI agents as task assignees via their MCP. Not an agent itself.
- **Shortcut** — Story-centric, some AI features. More conservative integration approach.
- **Relevance AI** — Provides "Linear Agent Templates" — prebuilt AI agents that interact with Linear.

**Key trends:**

1. Price collapse: Devin went from $500/mo → $20/mo. Race to commoditize.
2. Benchmark inflation: High SWE-Bench scores don't correlate to real-world task completion (21% on harder SWE-EVO).
3. Memory as differentiator: Factory's org-level memory, Devin's codebase understanding. Context persistence across sessions.
4. Integration as moat: Factory integrates with Datadog, Jira, Slack — the whole tool chain. Becoming "agent-native" means integrating everywhere.

---

### 5. MCP (Model Context Protocol) Ecosystem

**Protocol Status:**

- Launched by Anthropic in November 2024
- November 2025: New spec with async execution, OAuth authorization, enterprise governance
- December 2025: Donated to Agentic AI Foundation (AAIF) under Linux Foundation, co-founded by Anthropic, Block, OpenAI
- 5,800+ MCP servers, 300+ MCP clients
- 97M+ monthly SDK downloads
- Backed by Anthropic, OpenAI, Google, Microsoft — becoming a true standard

**Project Management MCP Servers — concrete list:**

_Linear:_

- `tacticlaunch/mcp-linear` — Canonical Linear MCP
- `mkusaka/linear-mcp`, `larryhudson/linear-mcp-server-again`, `cline/linear-mcp`, `ibraheem4/linear-mcp`
- Capabilities: create/update/list issues, manage projects, cycle management, team queries

_Jira / Atlassian:_

- `sooperset/mcp-atlassian` — Covers both Confluence and Jira (most comprehensive)
- `OrenGrinker/jira-mcp-server` — Production-ready, advanced features
- `Warzuponus/mcp-jira` — JIRA tasks and workflows
- `George5562/Jira-MCP-Server` — Natural language Jira interaction
- 62+ Jira MCP servers listed on pulsemcp.com

_GitHub:_

- `taylor-lindores-reeves/mcp-github-projects` — GitHub Projects (Agile Sprints)
- Official GitHub MCP (maintained by GitHub)

_Other PM tools with MCP servers:_

- **Trello**: `Hint-Services/mcp-trello`, `assistantdonnie/trello_mcp`
- **ClickUp**: `bravoure/clickup-mcp`, `nsxdavid/clickup-mcp-server`
- **Asana**: `roychri/mcp-server-asana`
- **Notion**: `Badhansen/notion-mcp`
- **Azure DevOps**: `danielealbano/mcp-for-azure-devops-boards`
- **Todoist**: Multiple servers, natural language task creation
- **Backlog**: `katsuhirohonda/mcp-backlog-server`

**Linear's own MCP strategy:**
Linear explicitly calls their AI integration the "Linear Mission Control Plane (MCP)" — not just using the protocol but building their whole AI integration strategy around it. AI agents (Cursor, Devin) can be assigned Linear issues directly.

**How people are building MCP-based tools:**

1. **Direct API wrapping**: Most PM MCP servers wrap existing REST APIs with MCP tool definitions. Pattern: each API endpoint becomes a tool.
2. **SDK-level**: Anthropic's own `@anthropic-ai/sdk` has `createSdkMcpServer()` and `tool()` for in-process MCP servers (used in DorkOS's `mcp-tool-server.ts`).
3. **Enterprise middleware**: Microsoft Dynamics 365 has an official MCP server. Salesforce, SAP integrations emerging.
4. **Agentic workflows**: Agents use MCP tools to read from PM systems, execute work, then write back status updates — creating autonomous loops.

**November 2025 spec key additions:**

- OAuth 2.0 authorization (security for enterprise)
- Async tool execution (long-running operations)
- Streaming results
- Governed workflows (audit trails)

---

## Detailed Analysis

### The Convergence Pattern

The most important insight across all five research areas is **convergence toward a single architecture**:

```
PM System (Linear/Jira)
    → via MCP
    → AI Agent (Devin/OpenHands/Factory)
    → executes work
    → measures outcome via telemetry
    → signals fed back into PM system
    → loop
```

Height was attempting to close this loop internally (one tool doing PM + execution + feedback). Its failure/shutdown doesn't invalidate the idea — it may have been too early or under-resourced. The market is now attempting this via composition (Linear MCP + Devin + Datadog).

### Vocabulary Precision for Building Feedback Systems

The observability field has the most precise vocabulary for describing feedback loops. Borrowing it for product/agent systems:

- **Telemetry**: What you instrument and collect from agent runs
- **Signal**: The category of observable (was the task completed? did tests pass?)
- **Event**: A specific thing that happened (PR opened, test suite ran, deployment triggered)
- **Metric**: Derived aggregate (PR merge rate over 7 days, avg task completion time)
- **Indicator**: A derived health signal (Leading: PRs opened per day. Lagging: features shipped per quarter)
- **Trace**: The execution path of a single agent session (what tools it called, in what order)

### Scientific Method as Architecture

Toyota Kata maps perfectly onto an autonomous development loop:

1. **Understand the Direction** = roadmap/priority signal from PM system
2. **Grasp Current Condition** = agent reads codebase, existing tests, recent PRs
3. **Establish Next Target Condition** = specific task with acceptance criteria
4. **PDCA toward target** = agent implements, tests, submits PR, collects feedback, retries

The OODA loop maps onto incident response agents specifically: Observe (Datadog alert) → Orient (codebase context) → Decide (which file/function) → Act (patch + deploy).

---

## Research Gaps & Limitations

- **Sweep AI's JetBrains pivot details**: Limited information on whether their GitHub App functionality is still maintained or fully replaced by the IDE plugin.
- **Height's post-mortem**: No detailed post-mortem found on why Height shut down — funding? competition? product-market fit?
- **Factory.ai pricing**: No public pricing found. Enterprise sales motion only.
- **Devin's actual self-improvement mechanism**: The Cognition blog post frames improvements as version-over-version model upgrades, not online learning. True self-improvement is not happening — it's retraining cycles.
- **MCP adoption for write-back**: Most MCP servers found are read-heavy (query Jira, list Linear issues). Write-back (agent updates task status, closes issues) is less documented.

---

## Contradictions & Disputes

- **Benchmark vs. reality gap**: SWE-Bench scores are widely cited as marketing but the SWE-EVO paper shows even gpt-5 only solves 21% of real evolutionary tasks. Factory's Terminal-Bench #1 ranking (58.75%) represents a different, more realistic benchmark.
- **Height's "autonomous PM" claim**: Height positioned itself as autonomous PM, but it shut down in September 2025. This either means the concept failed commercially, or it was too early. Linear's approach (be the PM layer, let agents do execution) may be the more durable model.
- **MCP ecosystem numbers**: Claims of "90% of organizations using MCP by end of 2025" appear to be analyst projection hype. The 5,800+ servers and 97M monthly downloads are verifiable; enterprise adoption at that scale is not.

---

## Sources & Evidence

### Topic 1 — Autonomous Software Systems

- Cognition annual review (PR merge rate 34%→67%, 4x speed): [Devin's 2025 Performance Review](https://cognition.ai/blog/devin-annual-performance-review-2025)
- Cognition $10.2B valuation, $155M ARR: [VentureBeat on Devin 2.0](https://venturebeat.com/programming-development/devin-2-0-is-here-cognition-slashes-price-of-ai-software-engineer-to-20-per-month-from-500)
- Devin produces 25% of Cognition code: [Financial Content](https://markets.financialcontent.com/wral/article/tokenring-2025-12-30-the-worlds-first-autonomous-ai-software-engineer-devin-now-produces-25-of-cognitions-code)
- Factory $50M raise, Droids GA: [SiliconANGLE](https://siliconangle.com/2025/09/25/factory-unleashes-droids-software-agents-50m-fresh-funding/)
- Factory Terminal-Bench #1: [Factory.ai](https://factory.ai/news/terminal-bench)
- OpenHands vs SWE-Agent comparison: [Local AI Master](https://localaimaster.com/blog/openhands-vs-swe-agent)
- SWE-EVO benchmark gap (21% vs 65%): [arxiv SWE-EVO](https://www.arxiv.org/pdf/2512.18470v1)
- Height shutdown September 2025: [Skywork AI](https://skywork.ai/skypage/en/Height-App-The-Rise-and-Sunset-of-an-AI-Project-Management-Pioneer/1975012339164966912)
- Linear MCP strategy: [Linear AI page](https://linear.app/ai)
- Sweep AI current status: [Sweep.dev](https://sweep.dev/)

### Topic 2 — Scientific Method Frameworks

- Toyota Kata overview: [Methods and Tools](https://www.methodsandtools.com/archive/toyotakata.php)
- PDCA vs OODA comparison: [Learn Lean Sigma](https://www.learnleansigma.com/problem-solving/pdca-and-ooda-for-problem-solving/)
- Build-Measure-Learn: [Lean Startup](https://theleanstartup.com/principles)
- BML as hypothesis loop: [Userpilot](https://userpilot.com/blog/build-measure-learn/)

### Topic 3 — Signal/Telemetry Terminology

- OpenTelemetry official definitions (signals, traces, spans, metrics, logs): [OpenTelemetry Primer](https://opentelemetry.io/docs/concepts/observability-primer/)
- Splunk on observability vs monitoring vs telemetry: [Splunk Blog](https://www.splunk.com/en_us/blog/learn/observability-vs-monitoring-vs-telemetry.html)
- State of Observability 2025: [Splunk State of Observability](https://www.splunk.com/en_us/blog/observability/state-of-observability-2025.html)

### Topic 4 — AI Coding Agent Landscape

- Competitive landscape overview: [Contrary Research on Cognition](https://research.contrary.com/company/cognition)
- Factory Droids full SDLC: [Developer-Tech](https://www.developer-tech.com/news/factory-droids-ai-agents-tackle-entire-development-lifecycle/)
- Height autonomous features: [BusinessWire](https://www.businesswire.com/news/home/20241008197812/en/Height.app-Unveils-First-Ever-Autonomous-Project-Collaboration-Tool-for-Product-Builders)

### Topic 5 — MCP Ecosystem

- MCP 1-year anniversary, 5800+ servers: [MCP Blog](http://blog.modelcontextprotocol.io/posts/2025-11-25-first-mcp-anniversary/)
- MCP donated to Linux Foundation: [Wikipedia MCP](https://en.wikipedia.org/wiki/Model_Context_Protocol)
- Awesome MCP Servers project management list: [TensorBlock/awesome-mcp-servers](https://github.com/TensorBlock/awesome-mcp-servers/blob/main/docs/project--task-management.md)
- Linear MCP server: [MCP Servers](https://mcpservers.org/servers/tacticlaunch/mcp-linear)
- Jira MCP servers (62+): [PulseMCP](https://www.pulsemcp.com/servers?q=jira)
- mcp-atlassian: [sooperset/mcp-atlassian](https://github.com/sooperset/mcp-atlassian)

---

## Search Methodology

- Searches performed: 11
- Most productive search terms: "Factory.ai droid SDLC autonomous 2025", "MCP servers project management awesome-mcp", "Devin 2025 performance review"
- Primary information sources: cognition.ai, factory.ai, opentelemetry.io, github.com/TensorBlock, linear.app, arxiv.org
- Research mode: Deep Research
