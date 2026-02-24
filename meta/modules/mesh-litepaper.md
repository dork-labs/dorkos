# Mesh: Agent Discovery and Network Topology for DorkOS

**By Dorian Collier**
**February 2026**

---

## The Gap

You have five projects. Each one has a coding agent. The finance agent manages your budget. The backend agent builds your API. The scheduling agent tracks your calendar. The purchasing agent handles orders. The monitoring agent watches production.

None of them knows the others exist.

Each agent runs in its own project directory, sees its own files, and has no awareness of the broader system. There's no registry of agents. No way for one agent to discover another's capabilities. No mechanism to say "the finance agent can approve budgets" and have other agents use that information.

**Without discovery, there is no coordination.** An agent can't delegate work to an agent it doesn't know exists. It can't query capabilities it can't find. It can't respect boundaries it can't see. You end up with five isolated specialists that can't form a team.

Operating systems solved this with service discovery and network configuration. DNS tells you where services live. Firewall rules control who can talk to whom. Process namespaces provide isolation. The services themselves handle communication — but they need a directory and a policy layer to find each other safely.

Agents need the same thing.

---

## The Core Idea: Every Project Is an Agent

Mesh starts from a single premise: **a project directory is an agent.**

Your `~/projects/backend/` directory has a CLAUDE.md, hooks, skills, and memories. It has a purpose, a personality, and a domain. When an agent session runs in that directory, it inherits all of that context. The directory isn't just where the code lives — it's the agent's identity.

Mesh makes this explicit. It scans configured directories for agent manifests, builds a registry of discovered agents, and exposes that registry to the rest of the system. When a new project appears, Mesh notices. When a manifest changes, Mesh updates.

**Agent-agnostic by design.** DorkOS agent configuration lives in `.dork/`, not `.claude/`. The `.claude/` directory is Claude Code specific. `.dork/agent.json` is for any runtime — Claude Code today, Codex or OpenCode tomorrow. DorkOS doesn't care which model runs your agent. It cares that the agent exists, has an identity, and declares its capabilities.

For existing Claude Code projects that haven't adopted DorkOS conventions, Mesh falls back to `.claude/` directory detection. If it finds a `.claude/` directory with a CLAUDE.md, it infers a minimal agent profile — name from the directory, capabilities from context. Zero configuration required. You get discovery for free.

---

## The Agent Manifest

The manifest is an agent's identity card. A JSON file at `.dork/agent.json` that declares who this agent is and what it can do.

**Identity.** A unique ID, a human-readable name, a description. The basics that let other agents and humans understand what this agent is for.

**Runtime.** Which agent platform runs here — Claude Code, Codex, OpenCode. Mesh passes this to the Engine so it knows which adapter to use when executing a session.

**Capabilities and skills.** What this agent can do. Code, test, deploy, analyze, purchase, approve. These are freeform declarations — not enforced permissions, but discoverable metadata. When an agent asks "who can approve a budget?", Mesh can answer.

**Behavior policy.** How this agent responds to incoming messages. Always respond? Only on direct mentions? Silent observer? These preferences travel with the agent's identity and inform how Relay and adapters handle delivery.

**Budget constraints.** Maximum hops, maximum calls per hour. Safety limits that Mesh writes into Relay's access rules when configuring the agent's endpoint.

The manifest aligns with the emerging A2A Agent Card standard from the Linux Foundation. As agent interoperability protocols mature, DorkOS manifests will map cleanly to the industry standard.

**The manifest is optional.** Mesh creates a minimal profile for any project it discovers, even without a manifest. The fallback is always zero-config. The manifest adds richness when you want it.

---

## Network Topology and Access Control

Discovery is one problem. Access control is another. Just because the purchasing agent can find the finance agent doesn't mean it should have unrestricted access.

**Mesh is DNS and iptables.** DNS tells you where things are. iptables controls what traffic is allowed. Mesh handles both roles for the agent network — it maintains the directory of agents and writes the rules that govern communication between them.

**Default-allow within a project. Default-deny across projects.** Agents in the same project namespace communicate freely. Cross-project communication requires explicit configuration. This mirrors Linux network namespaces — processes in the same namespace see each other naturally. Traffic between namespaces goes through defined routes.

Mesh doesn't enforce access rules directly. **Mesh writes rules. Relay enforces them.** When Mesh discovers an agent, it registers the agent's endpoint in Relay and configures access patterns — which subjects can send to which other subjects, at what priority. Relay evaluates these rules before every delivery. The separation is clean: Mesh is the policy author, Relay is the policy engine.

**Invisible boundaries.** When an agent tries to discover or message an agent it doesn't have access to, the response is "not found" — not "forbidden." This is the Microsoft Teams pattern: unauthorized agents don't see restricted resources at all. No information leakage. No indication that something exists behind the boundary.

---

## Agent Behavior Policy

When a message arrives for an agent, two layers of filtering determine what happens.

**Adapter-level filtering** is the first gate. It's crude and configurable per channel: forward all messages, forward only @mentions and direct replies, or forward nothing. This handles the volume problem — an agent monitoring a busy Slack channel doesn't need every message, just the ones directed at it.

**Agent-level judgment** is the second gate. The agent itself — running with LLM intelligence — decides whether to respond, observe silently, or escalate to a human. Behavior preferences in the manifest provide guidance: respond briefly in group contexts, respond in detail to direct messages, escalate billing questions above $500.

The adapter does crude filtering. The agent makes nuanced calls. This mirrors how bots work in Discord and Slack, but with LLM-level contextual understanding instead of rigid keyword matching.

---

## Mesh and Relay

Mesh and Relay are designed as separate modules with a clean dependency: **Mesh depends on Relay. Relay depends on nothing.**

This is deliberate. Relay handles messaging for the entire system — human-to-agent, system-to-agent, agent-to-agent. It ships first and works independently. You can send messages between agents using Relay alone, as long as you know the subject addresses.

Mesh adds the discovery and topology layer. When Mesh arrives, it brings:

- **Automatic endpoint registration.** Mesh discovers an agent, then registers `relay.agent.{project}.{agentId}` as an endpoint in Relay. No manual configuration.
- **Access control rules.** Mesh writes cross-project deny rules into Relay's access control. Agents within the same project communicate freely. Cross-project traffic requires explicit allowlisting.
- **Capability-based routing.** An agent asks "who can approve a budget?" Mesh looks up capabilities in its registry, finds the finance agent, returns the Relay subject address. The agent sends its message through Relay. Discovery and delivery are cleanly separated.

**The concrete flow:** Pulse fires a schedule. The agent needs to message the finance agent. It calls a Mesh MCP tool — "discover agents with the 'approve' capability." Mesh returns the finance agent's identity and Relay subject. The agent publishes a message to that subject through Relay. Relay delivers it. The finance agent responds through Relay. Four components, zero coupling between them.

See the [Relay Litepaper](./relay-litepaper.md) for the messaging layer that Mesh builds on. See the [DorkOS Litepaper](../dorkos-litepaper.md) for the full system vision.

---

## A Concrete Example

The birthday coordination scenario — from Mesh's perspective.

Your scheduling agent detects a birthday next week. It needs to coordinate across four projects, four agents, four domains.

**Discovery.** The scheduling agent queries Mesh: "Who has the 'budgeting' capability?" Mesh checks its registry — the finance agent in `~/projects/finance/` declared this capability in its manifest. Mesh returns the agent's identity, capabilities, and Relay subject address.

**Registration.** The finance agent's endpoint was registered in Relay when Mesh first discovered it. The scheduling agent's endpoint was registered the same way. Both are live, both are routable.

**Access control.** These agents are in different projects. Mesh has configured cross-project access rules in Relay that allow the scheduling project to message the finance project (explicitly allowlisted). The scheduling agent's message passes Relay's access check and arrives in the finance agent's mailbox.

**Coordination.** The finance agent approves a $50 budget and queries Mesh for an agent with 'purchasing' capabilities. Same flow: discover, route through Relay, deliver. The purchasing agent orders flowers and replies. Four agents, four projects, one coordinated action.

Mesh made the connections. Relay moved the messages. Neither needed to know about the other's internals.

---

## Roadmap

**Phase 1 — Discovery and Registry.** Filesystem scanner with chokidar watching. `.dork/agent.json` manifest format with `.claude/` fallback. Agent registry with SQLite persistence. Automatic Relay endpoint registration for discovered agents. HTTP routes for agent listing and detail.

**Phase 2 — Network Topology.** Access control rules authored by Mesh, enforced by Relay. Budget policies per agent and project. MCP tools for agent discovery and topology queries. Cross-project visibility configuration.

**Phase 3 — Observability and Intelligence.** Console topology visualization. Agent lifecycle management. Lazy activation — start an agent when a message arrives. Supervision policies for restart and recovery. CLI commands for mesh inspection.

---

## DNS and iptables for Agents

An operating system without service discovery is a collection of isolated processes. An operating system without network policy is an unmanaged free-for-all. You need both — a directory that tells you what exists, and rules that govern what's allowed.

Mesh provides both for DorkOS. It turns a runtime into an operating system — one where agents can find each other, coordinate safely, and operate within defined boundaries.

The layer that turns isolated agents into a network.
