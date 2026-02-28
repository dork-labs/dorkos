# The Value Architecture — Applied to DorkOS

**Version**: 1.0 (Draft)
**Created**: 2026-02-27
**Framework**: `meta/value-architecture.md` + `meta/value-architecture-handbook.md`
**Personas**: `meta/personas/`
**Brand Foundation**: `meta/brand-foundation.md`

---

## Phase 1: Ground Truth

### 1A. Competitive Alternative Map

For each DorkOS module, what would the customer do if we didn't exist?

```yaml
# --- ENGINE (Runtime) ---
capability: "Engine — Agent Runtime"
alternative: "Run Claude Code directly from the terminal. No unified API. No remote access. No session management beyond what the CLI provides. Each project is a separate terminal tab."
unique_attribute: "REST+SSE API layer with pluggable agent adapters, remote access via optional tunnel, unified session management that sees all sessions regardless of which client started them (CLI, browser, Obsidian)"
so_what: "You can build on top of your agents instead of being limited to one terminal window per session. Every session is visible in one place, from anywhere."

# --- CONSOLE (Web UI) ---
capability: "Console — Browser-Based Command Center"
alternative: "Multiple terminal windows or tmux panes, each running a separate Claude Code session. No visual status indicators. No way to check on sessions from your phone. Copy-paste to share session output."
unique_attribute: "Browser-based UI with rich markdown rendering, visual agent identity (name, color, icon), session status in the tab title (working/done/waiting), cross-device access, tab management for concurrent sessions"
so_what: "Manage agents the way you manage web apps — with tabs, bookmarks, visual status, and from any device. Decades of browser UX applied to agent management."

# --- PULSE (Scheduler) ---
capability: "Pulse — Autonomous Agent Scheduling"
alternative: "Only run agents when you're at your desk, manually typing prompts. Or: cobble together cron jobs + shell scripts that invoke the Claude CLI, with no run tracking, no overrun protection, no concurrency management."
unique_attribute: "First-class cron scheduling with overrun protection, isolated agent sessions per run, run history with SQLite persistence, configurable concurrency limits, API for schedule management, integration with Loop for autonomous task selection"
so_what: "Your agents execute work while you sleep — shipping features, triaging issues, running audits. You wake up to progress, not a stale terminal."

# --- RELAY (Agent Communication) ---
capability: "Relay — Agent Communication"
alternative: "Agents can only output to the terminal they're running in. If you want notifications, you build a custom webhook. If you want agents to coordinate, you manually copy-paste context between sessions. There is no standard way for agents to message each other or to reach you outside the terminal."
unique_attribute: "Built-in messaging between agents and the channels you already use — Telegram, Slack, webhooks, browser. Agents choose where to send notifications. Plugin adapter system makes it easy to add new channels. Messages persist even when terminals close."
so_what: "Agents can reach you — on Telegram, Slack, wherever you are. They can notify each other. They can coordinate across project boundaries. Like giving your team Slack, but for your agents."

# --- MESH (Agent Network) ---
capability: "Mesh — Agent Discovery & Network Topology"
alternative: "You manually track which agents exist, where they are, and what they can do. When one agent needs another, you are the router — copying context between sessions, remembering which project has which capabilities. No discovery, no registry, no access control."
unique_attribute: "Pluggable discovery strategies that scan for agent-capable project directories, intentional registration workflow with human/agent approval, .dork/agent.json portable identity manifests, network topology with namespace isolation (default-allow within project, default-deny across), access control rules enforced by Relay"
so_what: "Your agents know about each other — what they can do, where they are, and who they're allowed to message. You go from isolated agents to a coordinated team."

# --- WING (Life Layer) ---
capability: "Wing — Persistent Memory & Life Context"
alternative: "Every agent session starts cold. You re-explain your goals, coding preferences, project priorities, and personal context every single time. Or: manually maintain CLAUDE.md files per project, which capture project context but not personal context, goals, or life commitments."
unique_attribute: "Persistent memory that survives across all agent sessions, life coordination and commitment tracking, proactive context surfacing (agents automatically receive relevant context about your goals and priorities)"
so_what: "Your agents know you. Your goals, your commitments, your priorities — injected into every session without you saying a word. The agent that runs at 3am knows what you care about."

# --- LOOP (Improvement Engine) ---
capability: "Loop — Autonomous Feedback & Improvement"
alternative: "You manually decide what to work on next. No systematic feedback collection. No hypothesis testing. No measurement of outcomes. You check analytics, read error logs, and make gut decisions about priorities."
unique_attribute: "Fully deterministic signal collection from real-world data (analytics, error logs, user feedback), hypothesis formation, prepared task dispatch with detailed instructions, outcome measurement — zero AI in the loop engine itself, purely data and human-authored templates"
so_what: "Your software improves itself. Loop collects signals, forms hypotheses, dispatches work to agents via Pulse, and measures outcomes. The system closes its own feedback loop."
```

### 1B. Jobs-to-Be-Done Map

```yaml
# --- KAI NAKAMURA (Primary — The Autonomous Builder) ---
persona: "Kai Nakamura — The Autonomous Builder"
core_job: "When I'm sleeping or away from my desk, I want my agents to execute roadmap tasks autonomously, so that my projects make progress 24/7 without burning me out."
emotional_job: "I want to feel confident that progress is happening even when I'm not working — relief from the pressure of being the sole bottleneck."
social_job: "I want to be perceived as someone who ships at an impossible pace — peers wonder how one person maintains five projects."
job_steps:
  - step: "Define what needs to happen"
    features_that_serve: ["Pulse schedules", "Loop task prioritization", "Console schedule management"]
  - step: "Assign work to the right agent"
    features_that_serve: ["Mesh discovery", "Mesh agent registry", "Relay subject routing"]
  - step: "Provide context without repeating myself"
    features_that_serve: ["Wing persistent memory", "Engine context builder", "CLAUDE.md"]
  - step: "Execute autonomously"
    features_that_serve: ["Pulse cron execution", "Engine agent adapters", "Engine isolated sessions"]
  - step: "Stay informed without being at my desk"
    features_that_serve: ["Relay Telegram/Slack adapters", "Console browser UI", "Console session status indicators"]
  - step: "Review what happened"
    features_that_serve: ["Console session history", "Engine JSONL transcripts", "Loop outcome tracking"]
  - step: "Coordinate across projects"
    features_that_serve: ["Mesh network topology", "Relay inter-agent messaging", "Mesh access control"]

# --- PRIYA SHARMA (Secondary — The Knowledge Architect) ---
persona: "Priya Sharma — The Knowledge Architect"
core_job: "When I'm deep in an architecture document in Obsidian, I want to query my coding agent without leaving my flow, so that my thinking and doing environments stay unified."
emotional_job: "I want to feel in flow — no friction, no context-switching, no losing my train of thought to check a terminal."
social_job: "I want to be perceived as someone whose architecture decisions are always grounded in current code reality, not stale mental models."
job_steps:
  - step: "Deep thinking — writing architecture docs, ADRs, system designs"
    features_that_serve: ["Obsidian plugin (DirectTransport)", "Wing life layer (context)"]
  - step: "Need code context while thinking"
    features_that_serve: ["Obsidian plugin in-place agent query", "Engine DirectTransport adapter"]
  - step: "Query agent from thinking environment"
    features_that_serve: ["Console embedded in Obsidian", "Engine session management"]
  - step: "Continue thinking without losing flow"
    features_that_serve: ["Obsidian plugin seamless round-trip", "DirectTransport (no network hop)"]
  - step: "Review sessions later from different device"
    features_that_serve: ["Console browser UI", "Engine JSONL as single source of truth", "Session sync across clients"]
  - step: "Share architectural context across agents"
    features_that_serve: ["Mesh agent discovery", "Relay messaging", "Wing persistent memory"]
```

### 1C. Identity Territory

```yaml
identity_territory:
  worldview: "AI agents work like teammates — they can specialize, communicate, and coordinate. But right now, they're stuck working alone with no memory, no schedule, and no way to reach you. A team needs communication, delegation, shared memory, and structure. DorkOS is the layer that turns isolated agents into a coordinated team."
  tribe: "Developers who build AI teams, not just run AI sessions. People who think in architectures, not prompts. Builders who give their agents names, schedules, and communication channels — because that's how you build a team that works without you. The kind of people who have opinions about coordination, think in terms of delegation, and build tools they'd use themselves."
  signal: "I have an AI team, not a chatbot. My agents coordinate, communicate, and ship while I sleep. One person, ten agents — that's how I maintain five projects."
  anti_identity: "People who see AI as a chat interface. Prompt dabblers who want hosted, no-code, visual builders. Anyone who calls this an 'AI wrapper.' The person who asks 'Can it write my emails?' instead of 'Can my team ship my roadmap overnight?'"
```

### 1D. Anti-Positioning

```yaml
anti_positioning:
  villain: "The villain isn't a company. It's a moment: 7am, laptop open, CI red since 2:47am. The agent could have caught it. The terminal was closed. Nobody was watching. The most powerful coding agent in the world was useless because you weren't sitting in front of it."
  villain_pattern: "The dead terminal (agent shipped code, told no one). The re-introduction (re-explaining context for the hundredth time). The 15-tab juggle (five projects, which agent is doing what?). The flow-killer (alt-tab to terminal, lose 15 minutes of mental state for a 10-second answer)."
  external_problem: "AI agents are powerful but isolated. Each session starts from scratch. They can't run while you sleep. They can't tell you what they did. They can't message each other. You — the human — are the scheduler, the memory, the messenger, and the router."
  internal_problem: "You feel like a bottleneck for capable tools. You pay for the most powerful AI coding agent available, and it only works when you're at your desk. You have agents that can ship real code, and you're still manually invoking every session, copying context between them, and checking terminals to see if anything happened."
  philosophical_problem: "We gave people Slack because teammates can't coordinate in isolation. We gave applications an OS because software needs files, scheduling, and a way to talk to other programs. AI agents work like teammates — but right now, they start every day with amnesia, work alone, and have no way to reach you. That's a missing layer."
```

---

## Benefit Validation — Draft Review

*Cross-reference of user's initial benefit hypotheses against deep research.*


| Draft Benefit            | Verdict   | Evidence Strength    | Notes                                                                                                                                                                           |
| ------------------------ | --------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Work Remote**          | VALIDATED | Very Strong          | Anthropic launched Remote Control Feb 24, 2026. claude-code-telegram has 1.8K GitHub stars. DorkOS architecture is structurally superior (multi-session, terminal-independent). |
| **Autonomous Agents**    | VALIDATED | Strongest            | RedMonk #1 developer wish. Cowork scheduling breaks when Mac sleeps. Only Devin (cloud, $20+/mo) has reliable scheduling. Pulse is the only self-hosted option.                 |
| **Agent-to-Agent Comms** | VALIDATED | Strong, early market | 1,445% surge in multi-agent inquiries (Gartner). C compiler experiment (16 agents, $20K). Research agent pattern accelerating. But 41-86.7% production failure rates.           |
| **Better Multi-tasking** | VALIDATED | Very Strong          | Power users run 4-20 concurrent sessions. Sessions last up to 7+ hours. Every existing tool is terminal-only. No browser-based dashboard exists outside DorkOS.                 |
| **Agent Todo Lists**     | PARTIAL   | Moderate             | Pattern is validated but should be reframed as "autonomous improvement" / "self-improving software."                                                                            |


### Missed Opportunities Identified by Research

*Benefits the product delivers that were absent from the initial draft. All six are now covered by Value Ladders.*


| Missed Benefit                        | Strength        | Why It Matters                                                                                                                                                                                                       | Covered By |
| ------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **Trust & Transparency**              | Critical        | 46% of devs don't trust AI outputs. SaaStr DROP DATABASE incident. Configurable permissions + open source + full session history = the answer.                                                                       | VL-07      |
| **The Mac Sleep Problem**             | High (concrete) | Cowork scheduling only works while Mac is awake. Pulse runs independently of your IDE. Immediately understood.                                                                                                       | VL-01      |
| **Obsidian Integration**              | High (unique)   | Zero competitors have this. "Thinking + doing in one place." No workaround exists.                                                                                                                                   | VL-06      |
| **Open Source + Self-Hosted**         | High (identity) | n8n: 150K+ stars. Self-hosted segment is massive. Identity signal: "I run my own system."                                                                                                                            | VL-10      |
| **Session Visibility Across Clients** | High            | All sessions visible regardless of origin (CLI, browser, Obsidian). Remote Control handles only one session.                                                                                                         | VL-03      |
| **Notification Routing**              | High (concrete) | Relay adapters route messages to Telegram, Slack, or webhooks via subject-based routing. Agents choose their notification channel. Most-wanted Remote Control feature is mobile approval — Relay already enables it. | VL-04      |


---

## Phase 2: Value Ladders

*Each ladder follows the 5-layer model: Feature → Mechanism → Functional → Emotional → Identity, with Proof Anchor and Persona Resonance. Organized by benefit theme rather than internal module.*

### VL-01: Autonomous Execution

```yaml
id: "autonomous-execution"
feature_name: "Scheduled Agent Execution"
module: "Pulse"

# Layer 1: Feature
feature: "Cron-based agent scheduling with overrun protection, isolated sessions per run, SQLite-backed run history, configurable concurrency limits, and pending_approval state for agent-created schedules."

# Layer 2: Mechanism
mechanism:
  alternative: "Manually invoke Claude Code from the terminal every time you want work done. Or: cobble together shell scripts + cron + caffeinate hacks to keep your Mac awake. Cowork's scheduling only runs while your computer is awake and the Claude Desktop app is open (documented by Simon Willison, Feb 25 2026)."
  differentiator: "Pulse runs independently — not tied to your IDE or terminal window. Run it on your laptop, a home server, or a $5 VPS. Overrun protection prevents duplicate runs. Pending_approval gates prevent runaway autonomous execution."

# Layer 3: Functional Benefit
functional: "Your agents ship code, triage issues, and run audits overnight. You wake up to completed pull requests, not a stale terminal waiting for your next prompt."

# Layer 4: Emotional Benefit
emotional: "Relief from being the bottleneck. For the first time, progress happens without you — and you can actually rest without anxiety about what's not getting done."

# Layer 5: Identity Benefit
identity: "I am someone who builds a team that works autonomously. My projects ship around the clock — what used to take a week ships overnight because my agents don't stop when I do."

# Proof Anchor
proof:
  type: "contrast"
  spec: "Independent cron scheduling (not tied to your IDE), vs. Cowork scheduling that breaks on Mac sleep"
  translation: "Your agent keeps running when you close the terminal. Cowork's doesn't."
  social: "[PLACEHOLDER — NEEDS CUSTOMER DATA]"

# Persona Resonance
resonance:
  - persona: "Kai Nakamura"
    primary_layer: "Layer 3 (Functional)"
    why: "Kai's trigger is waking up to broken CI. Pulse directly prevents this scenario. The functional outcome is the most emotionally resonant."
  - persona: "Priya Sharma"
    primary_layer: "Layer 4 (Emotional)"
    why: "Priya wants flow. Knowing scheduled tasks are executing frees her to focus on architecture without worrying about operational gaps."
```

### VL-02: Remote Agent Access

```yaml
id: "remote-agent-access"
feature_name: "Browser-Based Agent Management with Remote Access"
module: "Console + Engine (Tunnel)"

# Layer 1: Feature
feature: "Browser-based command center (React 19, Tailwind, shadcn/ui) accessible from any device. Optional ngrok tunnel for remote access. Rich markdown rendering, tool approval flows, session history with ETag caching. Terminal-independent — sessions are derived from JSONL transcript files, not tied to a running terminal process."

# Layer 2: Mechanism
mechanism:
  alternative: "SSH into your machine and attach to a tmux session. Or: use Claude Code Remote Control (launched Feb 24, 2026 — Max plan only, one session at a time, terminal must stay open, early-stage with auth bugs and API 500s). Or: build your own Telegram bot from scratch (claude-code-telegram, 1.8K stars on GitHub)."
  differentiator: "DorkOS Console is a full web UI — not a remote terminal session. All sessions visible simultaneously. Works from any browser on any device. No terminal dependency. No plan restrictions."

# Layer 3: Functional Benefit
functional: "Check on your agents from your phone at a coffee shop. Approve a tool call from your tablet on the couch. Review what your overnight agents shipped before you sit down at your desk."

# Layer 4: Emotional Benefit
emotional: "Freedom from being chained to your desk. You can walk away from your laptop and still stay connected to your agents — without the anxiety of wondering what's happening."

# Layer 5: Identity Benefit
identity: "I am someone who stays connected to my team from anywhere, not someone who babysits a terminal. My agents reach me wherever I am."

# Proof Anchor
proof:
  type: "contrast"
  spec: "Full browser UI with multi-session visibility vs. Remote Control (one session, terminal-dependent, Max plan only)"
  translation: "See all your agents at once, from any device, without keeping a terminal open."
  social: "[PLACEHOLDER — NEEDS CUSTOMER DATA]"

# Persona Resonance
resonance:
  - persona: "Kai Nakamura"
    primary_layer: "Layer 3 (Functional)"
    why: "Kai runs 5+ projects. Checking agents from his phone while AFK is the specific workflow he wants."
  - persona: "Priya Sharma"
    primary_layer: "Layer 4 (Emotional)"
    why: "Priya values flow. Being able to glance at agent status from her phone without breaking context is emotional relief."
```

### VL-03: Multi-Session Command Center

```yaml
id: "multi-session-command-center"
feature_name: "Visual Multi-Session Agent Management"
module: "Console"

# Layer 1: Feature
feature: "Browser-based UI with visual agent identity (name, color, icon), session status in browser tab titles (working/done/waiting via favicon changes), tab management for concurrent sessions, real-time session sync across clients via SSE, session lock to prevent concurrent writes."

# Layer 2: Mechanism
mechanism:
  alternative: "Multiple terminal windows or tmux panes. Memorize session names. Manually switch between panes to check status. No visual indicators — you read terminal output to figure out what's happening. Tools like Claude Squad and Agent of Empires help, but they're terminal-only with no notifications or mobile access."
  differentiator: "Browsers have been solving multi-tab management for decades. DorkOS brings that UX to agent sessions — named tabs, visual status, color-coded agents, status-aware favicons. Power users run 4-20 concurrent sessions; terminal tools break down at this scale."

# Layer 3: Functional Benefit
functional: "Glance at your browser tabs and instantly know: which agents are working, which are done, and which need your attention. No terminal-switching, no memorization, no cognitive overhead."

# Layer 4: Emotional Benefit
emotional: "Calm clarity instead of cognitive chaos. Ten agents running in parallel, each making progress — and you know the state of all of them at a glance, the way you know which browser tabs are playing audio."

# Layer 5: Identity Benefit
identity: "I am someone who runs a team, not someone who juggles terminals. My agents have names, colors, and status — and together they ship more than I ever could alone."

# Proof Anchor
proof:
  type: "human_metric"
  spec: "Visual agent identity system: name + color + icon per agent, status-aware favicons (working/done/waiting), real-time SSE sync"
  translation: "Know the status of 10 agents in a single glance — the way you scan browser tabs."
  social: "[PLACEHOLDER — NEEDS CUSTOMER DATA]"

# Persona Resonance
resonance:
  - persona: "Kai Nakamura"
    primary_layer: "Layer 3 (Functional)"
    why: "Kai runs 10-20 sessions. The 'which session is doing what' problem is his daily friction. Tab-based management is the direct answer."
  - persona: "Priya Sharma"
    primary_layer: "Layer 5 (Identity)"
    why: "Priya manages architecture across services. A visual command center reinforces her identity as a technical leader who operates at a systems level."
```

### VL-04: Agent Communication & Notification Routing

```yaml
id: "agent-communication"
feature_name: "Built-In Messaging Between Agents and the Channels You Already Use"
module: "Relay"

# Layer 1: Feature
feature: "Built-in messaging between your agents and the channels you already use. Telegram, webhooks, browser — agents send notifications to where you are. Agents can also message each other across project boundaries. Plugin adapter system means new channels are easy to add. Messages persist even when terminals close."

# Layer 2: Mechanism
mechanism:
  alternative: "Agents output to the terminal only. If you want notifications, you build a custom Telegram bot from scratch (claude-code-telegram took the community months to build, has 1.8K stars). If you want agents to coordinate, you copy-paste between sessions. If you want mobile push notifications for approval prompts — the #1 most-wanted feature in the Remote Control ecosystem — you have zero options. Claude Code Agent Teams provides in-terminal messaging but dies when the terminal closes, works only within a single machine, and is experimental."
  differentiator: "Relay comes with Telegram and webhook adapters built in — no custom bot code, no third-party glue. Adding a new channel is a plugin, not a project. Agents can message each other, not just you. It's like giving your agents Slack — they can reach the right person (or agent) on the right channel without you routing everything manually."

# Layer 3: Functional Benefit
functional: "Get a Telegram message when your agent finishes a task. Have your research agent notify your coding agent when it finds something relevant. Your agents can reach you — and each other — without you playing messenger."

# Layer 4: Emotional Benefit
emotional: "Connected — your agents aren't screaming into the void of a terminal. They can reach you on Telegram while you're at lunch, ping your webhook when a deploy finishes, or quietly queue a message for when you're back at your desk. You choose how and when they reach you."

# Layer 5: Identity Benefit
identity: "I am someone whose agents can communicate — with me and with each other — not someone who manually copies context between chat windows."

# Proof Anchor
proof:
  type: "contrast"
  spec: "Built-in Telegram + webhook adapters with plugin system for new channels, vs. DIY Telegram bots or no notification path at all"
  translation: "Telegram notifications? Built in. Webhooks for Slack? Built in. A new channel? Write an adapter plugin. No custom bot code. No glue."
  social: "[PLACEHOLDER — NEEDS CUSTOMER DATA: 'I set up Telegram notifications in 5 minutes...']"

# Persona Resonance
resonance:
  - persona: "Kai Nakamura"
    primary_layer: "Layer 3 (Functional)"
    why: "Kai wants Telegram notifications when agents need him. This is his trigger scenario — checking his phone while AFK and seeing agent status. Relay's built-in Telegram adapter is the direct implementation, no custom bot required."
  - persona: "Priya Sharma"
    primary_layer: "Layer 4 (Emotional)"
    why: "Priya values seamless context flow across her multi-service architecture. Agents that route notifications to the right channel without her manual intervention reinforces her sense of integrated systems under her governance."
```

### VL-05: Agent Network

```yaml
id: "agent-network"
feature_name: "Agent Discovery, Registry, and Network Topology"
module: "Mesh"

# Layer 1: Feature
feature: "Pluggable discovery strategies (Claude Code, Cursor, Codex, custom patterns) that scan for agent-capable project directories. Intentional registration workflow with human/agent approval. .dork/agent.json portable identity manifests. Network topology with namespace isolation (default-allow within project, default-deny across). Access control rules authored by Mesh, enforced by Relay. Topology visualization and agent health monitoring."

# Layer 2: Mechanism
mechanism:
  alternative: "You are the router. You remember which project has which agent, what each agent can do, and manually relay messages between them. Enterprise solutions exist (Kong MCP Registry, Gravitee Agent Mesh) but require Kubernetes and a platform team. Framework-level coordination (CrewAI, LangGraph) is Python-only, in-process, and single-machine."
  differentiator: "Mesh brings enterprise agent discovery to a single developer. Automatic scanning finds agent-capable projects. Registration is intentional — no agent joins the network without approval. Access control is per-namespace. No Kubernetes, no platform team required."

# Layer 3: Functional Benefit
functional: "Mesh scans your projects, finds agent-capable directories, and presents the full roster to each agent. Your scheduling agent knows a finance agent exists. Your research agent is available to any agent that needs context. You approve which agents join the network."

# Layer 4: Emotional Benefit
emotional: "The thrill of building something that coordinates itself. Your agents aren't isolated anymore — they form a network that you designed, governed by rules you set."

# Layer 5: Identity Benefit
identity: "I am someone who operates an agent workforce, not someone who manages disconnected tools. I built a mesh — not a pile of scripts."

# Proof Anchor
proof:
  type: "contrast"
  spec: "Automatic discovery + intentional registration + namespace isolation vs. manual tracking in your head"
  translation: "Mesh finds your agents. You approve who joins. They coordinate through governed channels — like DNS and firewall rules for AI agents."
  social: "[PLACEHOLDER — NEEDS CUSTOMER DATA]"

# Persona Resonance
resonance:
  - persona: "Kai Nakamura"
    primary_layer: "Layer 5 (Identity)"
    why: "Operating a mesh of agents across 5 projects is Kai's aspiration. This is what transforms 'indie hacker with scripts' into 'builder with a workforce.'"
  - persona: "Priya Sharma"
    primary_layer: "Layer 3 (Functional)"
    why: "Priya manages architecture across services. Mesh surfacing agent capabilities across her projects directly serves her cross-service coordination workflow."
```

### VL-06: Unified Environment

```yaml
id: "unified-environment"
feature_name: "Cross-Platform Agent Access (Browser + Obsidian + CLI)"
module: "Console + Engine (Transport Interface)"

# Layer 1: Feature
feature: "Transport interface that decouples the UI from its backend. Two adapters: HttpTransport for standalone web use, DirectTransport for embedded use in Obsidian (in-process, no network hop). Same React UI, different delivery mechanisms. Sessions visible from any client — CLI, browser, or Obsidian — because all use the same JSONL transcript files as the single source of truth."

# Layer 2: Mechanism
mechanism:
  alternative: "Use Claude Code in the terminal. Use a separate Obsidian AI plugin for notes (shallow chatbot wrapper, no deep integration). Copy-paste between them. Sessions started in one tool are invisible in the other. GitHub Copilot spans IDEs (VS Code, JetBrains, Eclipse, Xcode) but has no Obsidian integration and no standalone web UI. No product has designed for Obsidian + browser + CLI from the ground up."
  differentiator: "DorkOS is the only agent system designed for knowledge workers who think in Obsidian and build in code. DirectTransport means zero network overhead in Obsidian. Sessions started in Obsidian appear in the browser and vice versa. One source of truth, three surfaces."

# Layer 3: Functional Benefit
functional: "Query your coding agent from inside Obsidian without leaving your architecture document. See the same session later from your browser. Start a session from the CLI and check on it from your phone."

# Layer 4: Emotional Benefit
emotional: "Flow — your thinking environment and doing environment are finally the same place. No context-switching between Obsidian and terminal. Your train of thought stays intact."

# Layer 5: Identity Benefit
identity: "I am someone who unifies thinking and doing. My tools don't fragment my attention — they converge into one system."

# Proof Anchor
proof:
  type: "contrast"
  spec: "Transport interface with HttpTransport (web) and DirectTransport (Obsidian, in-process) sharing JSONL source of truth, vs. separate terminal + separate Obsidian plugin with no shared state"
  translation: "Start a session in Obsidian, check it from your browser, approve a tool call from your phone. Same session. No copy-paste."
  social: "[PLACEHOLDER — NEEDS CUSTOMER DATA]"

# Persona Resonance
resonance:
  - persona: "Kai Nakamura"
    primary_layer: "Layer 3 (Functional)"
    why: "Kai values multi-surface access. Checking agents from any device fits his workflow of managing 5+ projects."
  - persona: "Priya Sharma"
    primary_layer: "Layer 4 (Emotional)"
    why: "This is Priya's trigger scenario — querying agents from Obsidian. Flow preservation is her core emotional need."
```

### VL-07: Trust & Oversight

```yaml
id: "trust-oversight"
feature_name: "Configurable Permissions and Full Transparency"
module: "Engine (Tool Approvals + Session Locking + JSONL Transcripts)"

# Layer 1: Feature
feature: "Configurable permission modes — from approve-every-tool-call to fully autonomous execution. Session locking with client ID tracking to prevent concurrent writes. JSONL transcript files as the single source of truth for all session data — every message, tool call, and result recorded. Permission mode surfaced in UI. Pending_approval gates for agent-created schedules. Task tracking with status updates."

# Layer 2: Mechanism
mechanism:
  alternative: "Trust the agent and hope for the best — with no way to review what happened. Or: run with --dangerously-skip-permissions and accept the risk (SaaStr July 2025: an autonomous agent executed DROP DATABASE during a code freeze). GitHub Copilot requires 'two human approvals' for agent PRs — a blunt gate with no middle ground. 46% of developers don't trust AI outputs (Stack Overflow 2025). The result: people hold back from autonomous execution because they have no safety net."
  differentiator: "DorkOS gives you the safety net that makes autonomous execution comfortable. Choose your permission mode — from approve-every-call to fully autonomous. Every session is recorded, so you can review what happened instead of hovering in real-time. Open source means you can read the code that runs your agents. The guardrails exist so you can step away."

# Layer 3: Functional Benefit
functional: "Let your agents run autonomously — and review everything they did in the morning. Set the permission mode that matches your comfort level. Open source, self-hosted, every session recorded. No DROP DATABASE surprises, even at full autonomy."

# Layer 4: Emotional Benefit
emotional: "Confidence. You can let your agents run autonomously because you built the guardrails. You're not anxious about what they might do — you designed the boundaries."

# Layer 5: Identity Benefit
identity: "I am someone who trusts their agents because I built the guardrails. I don't hope they behave — I know what they're allowed to do."

# Proof Anchor
proof:
  type: "contrast"
  spec: "Configurable permission modes + open source + full session history vs. --dangerously-skip-permissions (all or nothing) with no visibility"
  translation: "Run autonomous. Review in the morning. Open source, self-hosted, every session recorded. The safety net exists so you can actually let go."
  social: "[PLACEHOLDER — NEEDS CUSTOMER DATA: 'I finally let my agents run overnight because I know I can review everything they did...']"

# Persona Resonance
resonance:
  - persona: "Kai Nakamura"
    primary_layer: "Layer 4 (Emotional)"
    why: "Kai wants to sleep while agents run. The guardrails are what make that possible — not because he approves every action, but because he knows every action is recorded and reviewable. Autonomy without a safety net is just anxiety."
  - persona: "Priya Sharma"
    primary_layer: "Layer 3 (Functional)"
    why: "Priya manages architecture across teams. Audit trails and approval flows are functional requirements for her technical leadership role."
```

### VL-08: Persistent Memory

```yaml
id: "persistent-memory"
feature_name: "Persistent Context Across All Agent Sessions"
module: "Wing"

# Layer 1: Feature
feature: "Persistent memory layer that survives across all agent sessions. Life coordination and commitment tracking. Proactive context surfacing — agents automatically receive relevant context about goals, priorities, and commitments. Context builder injects runtime context (env info, git status, agent identity, persona) into every session via XML blocks."

# Layer 2: Mechanism
mechanism:
  alternative: "Every session starts from scratch. You re-explain your goals, preferences, and priorities every time. Manually maintain per-project CLAUDE.md files (captures project context, not personal context). 95% of organizations see no measurable ROI from AI systems due to context loss between sessions (MIT report). 'AI amnesia' is the #1 reported frustration across developer communities."
  differentiator: "Wing provides a persistent personal context layer — not just project context (CLAUDE.md) but life context (goals, commitments, priorities). The context builder automatically injects relevant context into every session. Agents know what you care about without you saying it."

# Layer 3: Functional Benefit
functional: "An agent running a scheduled task at 3am already knows your project priorities, coding preferences, and commitments — without you writing a single prompt. No more 'let me give you some context' preamble."

# Layer 4: Emotional Benefit
emotional: "Your agents know you. The feeling of being understood — like working with a colleague who's been on the team for years, not an intern on their first day."

# Layer 5: Identity Benefit
identity: "I am someone who builds systems that learn and remember. My tools don't have amnesia — they have context, history, and continuity."

# Proof Anchor
proof:
  type: "contrast"
  spec: "Persistent memory layer + automatic context injection vs. blank-slate sessions where you re-explain everything"
  translation: "Your agents start every session knowing who you are and what you care about. No more repeating yourself."
  social: "[PLACEHOLDER — NEEDS CUSTOMER DATA]"

# Persona Resonance
resonance:
  - persona: "Kai Nakamura"
    primary_layer: "Layer 3 (Functional)"
    why: "Kai runs agents overnight. They must know his priorities without being prompted. Functional outcome is directly valuable."
  - persona: "Priya Sharma"
    primary_layer: "Layer 4 (Emotional)"
    why: "Priya values deep context. An agent that understands her architectural thinking without explanation resonates emotionally as a true collaborator."
```

### VL-09: Autonomous Improvement

```yaml
id: "autonomous-improvement"
feature_name: "Self-Improving Software via Feedback Loops"
module: "Loop + Pulse"

# Layer 1: Feature
feature: "Loop collects signals from real-world data (analytics, error logs, user feedback), forms hypotheses, and dispatches prepared tasks with detailed instructions. Pulse polls Loop on a schedule, receives the next priority task, and executes it as an isolated agent session. Outcomes feed back to Loop as new signals. Zero AI in Loop itself — fully deterministic data system with human-authored templates."

# Layer 2: Mechanism
mechanism:
  alternative: "You manually check analytics, read error logs, and decide what to work on next based on gut feeling. No systematic hypothesis testing. No feedback loops. Work priorities are decided by whoever last looked at a dashboard — not by actual signal data."
  differentiator: "Loop separates signal collection (deterministic, no AI) from task execution (AI agents). The feedback loop is structural, not manual. Hypotheses are formed from data. Tasks are dispatched with prepared instructions. Outcomes are measured against the hypothesis. Human-authored templates mean the system does exactly what you designed — no hallucinated priorities."

# Layer 3: Functional Benefit
functional: "Your software improves overnight. Loop detects a bounce rate spike, hypothesizes the cause, dispatches an agent to fix it via Pulse, and measures the outcome. You wake up to a PR with a fix and a validation report."

# Layer 4: Emotional Benefit
emotional: "Empowerment — your software is learning, not just running. The anxiety of 'what am I missing in the data?' is replaced by confidence that the system is watching."

# Layer 5: Identity Benefit
identity: "I am someone who builds self-improving systems. My software doesn't just run — it gets better."

# Proof Anchor
proof:
  type: "contrast"
  spec: "Automated signal → hypothesis → dispatch → measurement loop vs. manual analytics checking + gut-feel prioritization"
  translation: "Loop watches your metrics while you sleep. It finds the problem, writes the fix, and measures the result — then tells you what it did."
  social: "[PLACEHOLDER — NEEDS CUSTOMER DATA]"

# Persona Resonance
resonance:
  - persona: "Kai Nakamura"
    primary_layer: "Layer 5 (Identity)"
    why: "Self-improving systems is the apex of Kai's builder identity. This is what separates 'running AI tools' from 'building a self-improving team.'"
  - persona: "Priya Sharma"
    primary_layer: "Layer 3 (Functional)"
    why: "Systematic hypothesis testing and outcome measurement aligns with Priya's engineering rigor. This is her method applied to the product itself."
```

### VL-10: Open Foundation

```yaml
id: "open-foundation"
feature_name: "Open-Source, Local-First, Self-Hosted Agent OS"
module: "All (MIT-licensed, local execution, npm install)"

# Layer 1: Feature
feature: "Entire platform is MIT-licensed open source. Installs via npm. Runs locally on your machine. Sessions stored as local JSONL files. Agent runs in your shell. Orchestration layer is entirely yours. No cloud dependency. No vendor lock-in. Pluggable agent adapters mean you bring your own agent (Claude Code first, others coming)."

# Layer 2: Mechanism
mechanism:
  alternative: "Devin: fully cloud-hosted, closed source, $20+/month, your code runs on Cognition's servers. GitHub Copilot: cloud-dependent, Microsoft-locked ecosystem. Claude Code: closed source CLI, API costs only. Cursor/Windsurf: proprietary desktop apps. Or: build your own system from scratch using shell scripts, cron jobs, and DIY webhooks."
  differentiator: "DorkOS is everything Claude Code doesn't have — scheduling, messaging, discovery, UI — but it's open source and runs on your machine. No vendor controls your agent system. Self-hosted tools like n8n (150K+ GitHub stars) and Dify (114K+ stars) prove this segment is massive. No cloud-first competitor can pivot to local-first without abandoning their business model."

# Layer 3: Functional Benefit
functional: "Install in one command. Run on your machine. See the source code. Fork it, extend it, audit it. Your code never leaves your machine for DorkOS — only for the agent's API calls, which DorkOS doesn't control and doesn't pretend to."

# Layer 4: Emotional Benefit
emotional: "Control and transparency. It runs on your machine, you can read every line of code, and you can change anything you want. The honest acknowledgment of what DorkOS does and doesn't control builds real trust."

# Layer 5: Identity Benefit
identity: "I am someone who builds on open foundations. My agent system is mine — I can read it, change it, and run it wherever I want."

# Proof Anchor
proof:
  type: "human_metric"
  spec: "MIT license, npm install, local JSONL storage, open-source on GitHub"
  translation: "`npm install -g dorkos`. That's it. Your machine. Your agents. Your rules."
  social: "[PLACEHOLDER — NEEDS GITHUB STAR COUNT / COMMUNITY DATA]"

# Persona Resonance
resonance:
  - persona: "Kai Nakamura"
    primary_layer: "Layer 5 (Identity)"
    why: "Kai is an indie hacker who values control. Open source + local-first is not just a feature — it's a prerequisite. His anti-adoption signals explicitly list 'if it required a cloud account.'"
  - persona: "Priya Sharma"
    primary_layer: "Layer 4 (Emotional)"
    why: "Priya values transparency and auditability. An open-source system she can inspect and extend aligns with her architectural leadership role."
```

### Persona-Benefit Matrix

*Which layer resonates most for each persona-feature pair:*

```
                              Kai (Primary)     Priya (Secondary)
VL-01 Autonomous Execution    L3 Functional     L4 Emotional
VL-02 Remote Access           L3 Functional     L4 Emotional
VL-03 Multi-Session           L3 Functional     L5 Identity
VL-04 Communication & Routing L3 Functional     L4 Emotional
VL-05 Agent Network           L5 Identity       L3 Functional
VL-06 Unified Environment     L3 Functional     L4 Emotional
VL-07 Trust & Oversight       L4 Emotional      L3 Functional
VL-08 Persistent Memory       L3 Functional     L4 Emotional
VL-09 Autonomous Improvement  L5 Identity       L3 Functional
VL-10 Open Foundation          L5 Identity       L4 Emotional
```

**Pattern**: Kai responds to functional outcomes and identity signals. Lead with "what it does for you" and close with "who you become." Priya responds to emotional flow and functional rigor. Lead with "how it feels" and prove with "how it works."

---

## Phase 3: Message Architecture

### 3A. Message House

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         PRIMARY MESSAGE (Roof)                           │
│                                                                          │
│   "The operating system for autonomous AI agents —                       │
│    scheduling, communication, and coordination                           │
│    so one person can ship like a team."                                  │
│                                                                          │
│   Test: Journalist headline? ✓ Differentiated? ✓ Defensible? ✓          │
├───────────────────┬───────────────────┬──────────────────────────────────┤
│  PILLAR 1         │  PILLAR 2         │  PILLAR 3                        │
│  AUTONOMY         │  COMMUNICATION    │  CONTROL                         │
│                   │                   │                                  │
│  "Ship code       │  "Agents that     │  "Trust your agents             │
│  while you sleep" │  connected"        │  enough to let go"              │
│                   │                   │                                  │
│  VL-01 Scheduling │  VL-04 Relay      │  VL-07 Trust/Audit              │
│  VL-09 Loop       │  VL-05 Mesh       │  VL-10 Open Source              │
│  VL-08 Memory     │  VL-06 Unified    │  VL-03 Multi-Session            │
│                   │  VL-02 Remote     │                                  │
│                   │                   │                                  │
│  Proof:           │  Proof:           │  Proof:                          │
│  • Independent    │  • Agent-to-agent        │  • Configurable                    │
│    scheduling     │    messaging     │    permission modes              │
│    (no IDE needed) │    (not terminal)   │  • Open source code             │
│  • Pending-       │  • Built-in       │  • Self-hosted                    │
│    approval gates │    Telegram +     │  • MIT-licensed                 │
│  • Run history    │    webhook        │                                 │
│    + full record  │    adapters       │  • Browser-based                │
│                   │  • Subject-based   │    command center                │
│                   │    channel routing │                                  │
│                   │  • Agent discovery │                                  │
│                   │    + topology     │                                  │
├───────────────────┴───────────────────┴──────────────────────────────────┤
│                         FOUNDATION                                       │
│                                                                          │
│  Worldview: Agents work like teammates. They need the layer that         │
│  makes teamwork possible.                                               │
│  Identity: Developers who build autonomous systems.                      │
│  Villain: The Isolated Agent Paradigm — brilliant minds in blank rooms.  │
│  Values: Open source. Local-first. Radically honest. Developer-first.    │
│                                                                          │
│  Brand voice: Confident. Minimal. Technical. Sharp. Honest.              │
│  Anti-positioning: Not a chatbot wrapper. Not a hosted service.          │
│                    Not an agent. The layer agents were missing.          │
└──────────────────────────────────────────────────────────────────────────┘
```

### 3B. Headline Bank

```yaml
# --- PILLAR 1: AUTONOMY ---
pillar: "Autonomy — Ship Code While You Sleep"
headlines:
  identity: "Your AI Never Sleeps"
  emotional: "Wake up to progress, not a stale terminal"
  functional: "Scheduled agent execution that runs independently — not tied to your IDE or terminal"
  proof: "Pulse keeps running when you close the terminal. Cowork requires your Mac to stay awake. You do the math."

  alt_identity: "One Person. Ten Agents. Team-Level Output."
  alt_emotional: "Relief from being the bottleneck — your output isn't limited to your hours anymore"
  alt_functional: "Cron scheduling with overrun protection, isolated sessions, and approval gates"
  alt_proof: "RedMonk's #1 developer wish for agentic IDEs: background agents. Pulse is the answer."

# --- PILLAR 2: COMMUNICATION ---
pillar: "Communication — Agents, Connected"
headlines:
  identity: "Teammates Need a Way to Communicate"
  emotional: "Your agents aren't working in isolation anymore"
  functional: "Built-in messaging between your agents and the channels you already use — Telegram, webhooks, browser. No custom bots required."
  proof: "Telegram notifications? Built in. Webhooks for Slack? Built in. A new channel? Write an adapter plugin. Connectivity, not complexity."

  alt_identity: "From Solo Agents to a Team"
  alt_emotional: "Connected — know what your agents are doing, from anywhere"
  alt_functional: "Your agents can message you on Telegram, notify each other across projects, and reach you wherever you are. Like Slack for your AI team."
  proof_alt: "We gave teams Slack. We gave agents Relay. Built-in adapters, plugin system for new channels, messages that persist when terminals close."

# --- PILLAR 3: CONTROL ---
pillar: "Control — Trust Your Agents Enough to Let Go"
headlines:
  identity: "Your Agents. Your Machine. Your Rules."
  emotional: "Confidence — you built the guardrails, now you can actually let go"
  functional: "Open source. Self-hosted. Configurable permission modes. Every session recorded. The safety net that makes autonomy comfortable."
  proof: "npm install -g dorkos. MIT license. Run autonomous, review in the morning. Read every line of code that runs your agents."

  alt_identity: "Open Source. On Your Machine. Yours to Change."
  alt_emotional: "Transparency — you can read the code, change anything, and run it wherever you want"
  alt_functional: "Choose your permission level — from approve-everything to fully autonomous. Open source, self-hosted, every session recorded. No DROP DATABASE surprises."
  alt_proof: "46% of developers don't trust AI outputs. DorkOS is built for the other 54% — and the ones who want to join them."
```

### 3C. Funnel-Stage Messaging

```yaml
# --- DISCOVERY: "What is this and why should I care?" ---
stage: "Discovery"
lead_layer: "L3 Functional + L5 Identity"
support_layer: "L2 Mechanism"
messages:
  - "DorkOS is the operating system for autonomous AI agents. Scheduling, messaging, agent discovery, and a browser-based command center — for developers who want their agents to work like a team, and ship like one."
  - "Your AI never sleeps. An open-source agent OS that turns isolated Claude Code sessions into a coordinated team."
  - "Intelligence comes from the agents. Everything else — scheduling, communication, coordination — comes from DorkOS."

# --- EVALUATION: "How does it work? Is it credible?" ---
stage: "Evaluation"
lead_layer: "L2 Mechanism + L3 Functional"
support_layer: "L1 Feature"
messages:
  - "Pulse schedules your agents independently — not tied to your IDE or terminal. Relay lets agents message you on Telegram and notify each other. Mesh finds agents across your projects. Console gives you a browser-based command center."
  - "Built on Claude Code's Agent SDK. Sessions stored as JSONL transcripts — the same format Claude Code uses natively. Every session visible in one place, regardless of which client started it."
  - "Compare: Remote Control requires Max plan, handles one session, needs an open terminal. DorkOS Console shows all sessions, runs in any browser, terminal-independent."

# --- TRIAL: "Can I actually use this?" ---
stage: "Trial"
lead_layer: "L1 Feature + L3 Functional"
support_layer: "Proof"
messages:
  - "npm install -g dorkos. Open localhost. You're looking at every Claude Code session across all your projects."
  - "Set up your first Pulse schedule in 2 minutes. The agent runs tonight. You'll see the results in the morning."
  - "MIT-licensed. Self-hosted. Your code stays on your machine. Read the source — it's all on GitHub."

# --- ADOPTION: "This is working and I feel it" ---
stage: "Adoption"
lead_layer: "L4 Emotional"
support_layer: "L3 Functional"
messages:
  - "You woke up to three completed PRs. The agent that ran overnight knew your priorities because Wing injected them. Pulse handled the scheduling. Relay sent you a Telegram message at 7am."
  - "You haven't touched a terminal in two hours. All five agents are visible in your browser tabs — named, colored, status-aware. You approved a tool call from your phone."
  - "Your research agent found a breaking API change at 2am and notified your frontend agent through Relay. The fix was waiting in a PR when you opened your laptop."

# --- ADVOCACY: "This is part of who I am now" ---
stage: "Advocacy"
lead_layer: "L5 Identity"
support_layer: "L4 Emotional"
messages:
  - "I don't use AI tools. I build with AI teammates."
  - "I shipped more last month than my old team did in a quarter. Ten agents, one person, running around the clock. I built the team that makes this possible."
  - "DorkOS isn't a product I use. It's how I built my AI team. Open source, on my machine, under my control."
```

---

## Phase 4: Activation Templates

### 4A. Homepage Hero

```
YOUR AI NEVER SLEEPS.

DorkOS turns isolated AI agents into a coordinated team.
Scheduling. Messaging. Agent discovery. A browser-based command center.
One person. Ten agents. Ship around the clock.

npm install -g dorkos
```

### 4B. Feature Sections

**Pillar 1: Autonomy**

```
WAKE UP TO PROGRESS.

Pulse schedules your agents on a cron — independently, not tied to your IDE.
Unlike Cowork, your agents don't stop when you close the terminal.
Isolated sessions. Overrun protection. Approval gates. Full run history.

Your laptop can rest. Your agents won't.
```

**Pillar 2: Communication**

```
YOUR AGENTS AREN'T SCREAMING INTO THE VOID ANYMORE.

Relay connects your agents — to you and to each other.
Get a Telegram message when your agent finishes. Let your research agent
notify your coding agent. Webhooks for Slack, browser for in-app.

Built-in adapters. Plugin system for new channels. Messages that persist.
Like giving your AI team Slack.
```

**Pillar 3: Control**

```
TRUST YOUR AGENTS ENOUGH TO LET GO.

Run autonomous. Review in the morning. Every session recorded.
Choose your permission level — from approve-everything to fully hands-off.
Open source. Self-hosted. You can read every line of code that runs your agents.

npm install -g dorkos. Your machine. Your agents. Your rules.
```

### 4C. Comparison Section (Anti-Positioning)

```
YOU'RE THE BOTTLENECK.

Your AI coding agent can write better code than you at 3am.
But it can't schedule itself to run at 3am.
It can't tell you what it did.
It can't ask the agent next door for help.
It can't remember what you told it yesterday.

You — the human — are the scheduler, the memory, the messenger, and the router.

We solved this for applications fifty years ago.
We called it an operating system.

DorkOS gives your agents what they're missing:
A heartbeat. A connection. A network. A memory. An interface.

The intelligence comes from the agents.
Everything else comes from DorkOS.
```

### 4D. Social Proof Architecture

```yaml
# Tier 1: Numeric Proof (most credible for developers)
numeric_proofs:
  - "[PLACEHOLDER: GitHub star count when available]"
  - "[PLACEHOLDER: npm downloads when available]"
  - "Pulse keeps running when you close the terminal. Cowork requires your Mac to stay awake."
  - "All sessions visible in one place — CLI, browser, or Obsidian."

# Tier 2: Identity-Anchor Quotes
identity_quotes:
  - "[PLACEHOLDER — Need: A quote from a respected developer/indie hacker about running agents overnight]"
  - "[PLACEHOLDER — Need: A quote about multi-session management from a power user]"
  - "[PLACEHOLDER — Need: A quote about the Obsidian integration from a knowledge worker]"

# Tier 3: Community Signals
community_signals:
  - "[PLACEHOLDER: GitHub stars]"
  - "[PLACEHOLDER: Contributors]"
  - "[PLACEHOLDER: npm weekly downloads]"
  - "MIT-licensed. Open source. Self-hosted."

# Anti-pattern: No generic testimonials. No "Great product!" quotes.
# Developer audiences see through these immediately.
```

---

## Appendix A: Research-Backed Evidence Index

Key findings used to validate and build Value Ladders, by source:


| Finding                                                              | Source                               | Used In                     |
| -------------------------------------------------------------------- | ------------------------------------ | --------------------------- |
| "Background Agents" is #1 developer wish from agentic IDEs           | RedMonk Dec 2025                     | VL-01, Pillar 1             |
| Cowork scheduling only runs while Mac is awake                       | Simon Willison Feb 25 2026           | VL-01, Proof Anchor         |
| 46% of developers don't trust AI outputs                             | Stack Overflow 2025                  | VL-07, Pillar 3             |
| SaaStr agent executed DROP DATABASE during code freeze               | Fortune Feb 2026                     | VL-07, Anti-Positioning     |
| claude-code-telegram: 1.8K GitHub stars                              | GitHub                               | VL-02, VL-04                |
| Remote Control: Max plan only, one session, terminal-dependent       | Claude Code Docs Feb 2026            | VL-02, Comparison           |
| Power users run 4-20 concurrent sessions                             | Anthropic 2026 Report, DEV Community | VL-03                       |
| Sessions last minutes to 7+ hours (Rakuten)                          | Anthropic 2026 Report                | VL-01, VL-03                |
| 16 agents built a C compiler ($20K, 100K lines Rust)                 | Anthropic Engineering Feb 2026       | VL-05, Agent Comms          |
| FutureHouse Robin: autonomous drug discovery, 2.5 months             | FutureHouse Research                 | VL-04, VL-05                |
| 1,445% surge in multi-agent inquiries (Gartner)                      | Gartner 2025                         | VL-04, VL-05                |
| 41-86.7% failure rate in production multi-agent systems              | arxiv March 2025                     | VL-07 (trust matters)       |
| No competitor combines scheduling + messaging + discovery + Obsidian | Competitive research                 | VL-06, VL-10                |
| n8n: 150K+ GitHub stars (self-hosted segment)                        | GitHub                               | VL-10                       |
| Agent Teams: experimental, terminal-only, no cross-machine           | Claude Code Docs                     | VL-04, Comparison           |
| Google A2A protocol failed to achieve adoption                       | Multiple sources                     | VL-04 (Relay fills the gap) |


## Appendix B: Research References

- `research/20260227_agent_communication_use_cases.md` — Multi-agent patterns, OpenClaw, Claude Code Teams, centralized research agents
- `research/20260227_multi_session_remote_agent_research.md` — Session management, remote access, scheduling, notifications
- `research/20260227_competitive_landscape_agent_infrastructure.md` — 9 competitors analyzed, market gaps, positioning
- `research/20260227_feature_benefit_marketing_frameworks.md` — 10+ framework analysis (from previous session)
- `research/20260227_feature_to_benefit_messaging_patterns.md` — Apple/Nike/Vercel/Linear patterns (from previous session)

## Appendix C: Version History

```yaml
version: "1.0"
status: "draft"
last_updated: "2026-02-27"
changelog:
  - date: "2026-02-27"
    change: "Initial Value Architecture applied to DorkOS"
    scope: "All phases (1-4)"
    research: "3 deep research reports, 100+ sources"
  - date: "2026-02-27"
    change: "Review Gate 1 complete — 'agents as teammates' reframe cascaded through all phases. Review Gate 2 in progress — L3 corrections applied (VL-01 stale terminal, VL-04 remove approval-to-Telegram, VL-05 Mesh discovers agents, VL-07 autonomy-first reframe, VL-08 3am agent clarity). VL-07 major reframe: trust features enable autonomy rather than requiring constant approval."
    scope: "1C, 1D, VL-01 through VL-10, Message House, Headline Bank, Activation Templates"
  - date: "2026-02-27"
    change: "Comprehensive language reframe: removed 'server-side' (→ independent/not tied to IDE), 'infrastructure' (→ system/foundation/layer), 'audit trail'/'session locking' from marketing layers, 'universal message bus' (→ Apple-style outcome language), 'renting' metaphor, 'can talk' (→ connected). Pillar 2 tagline: 'Agents, Connected'. Relay proof reframed from reliability to connectivity/flexibility. Control pillar refocused on open source + self-hosted + transparency. Productivity woven into 1C, VL-01, VL-03, Hero, Discovery, Advocacy, Headline Bank."
    scope: "All phases — 40+ edits across entire document"
```

