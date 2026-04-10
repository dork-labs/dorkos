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

## The Core Idea: Every Project Is a Potential Agent

Mesh starts from a single premise: **a project directory is a potential agent.**

Your `~/projects/backend/` directory has a AGENTS.md, hooks, skills, and memories. It has a purpose, a personality, and a domain. When an agent session runs in that directory, it inherits all of that context. The directory isn't just where the code lives — it's the agent's identity.

But a project doesn't become an agent automatically. **Discovery is reconnaissance. Registration is commitment.** Mesh scans your filesystem and finds candidates — directories that look like they contain agents. A human or agent reviews those candidates and decides which ones to admit to the mesh. Only registered agents get Relay endpoints, access control rules, and network visibility.

This distinction matters. Autonomous agent coordination is powerful. It should also be intentional. You choose which agents join the network. You choose which capabilities they declare. You choose which boundaries they operate within. Mesh doesn't assume — it asks.

---

## The Agent Lifecycle

An agent moves through four states:

**Unknown.** The project exists on the filesystem. Mesh hasn't scanned it yet. It's invisible to the system.

**Discovered.** A discovery strategy found something that looks like an agent — a `.claude/` directory, a `.cursor/` folder, a matching file pattern. Mesh records the candidate with whatever hints the strategy extracted: a suggested name, a detected runtime, inferred context. The candidate awaits review.

**Registered.** A human or agent reviewed the candidate and approved it. Mesh writes a `.dork/agent.json` manifest to the project directory, registers a Relay endpoint, and configures access control rules. The agent is now part of the network — discoverable by other agents, routable through Relay, governed by mesh policy.

**Denied.** A human or agent reviewed the candidate and explicitly rejected it. Mesh records the denial in its own database — not in the project directory. Denied candidates won't resurface on subsequent scans. The denial can be cleared if circumstances change.

A fifth entry point bypasses discovery entirely: **manual registration.** A human provides a directory path, Mesh creates the manifest directly. No discovery strategy needed. Useful for projects that don't match any detection pattern, non-standard layouts, or agents that live outside the scanned roots.

---

## Discovery: Pluggable Strategies

Mesh doesn't hardcode how to find agents. It uses pluggable discovery strategies — each one a detector that knows how to recognize a specific kind of agent project.

**A strategy answers two questions:** Does this directory contain an agent? And if so, what can we infer about it?

Built-in strategies ship with Mesh:

- **Claude Code** — detects `.claude/` with a AGENTS.md. Infers the name from the directory, the runtime as `claude-code`, and extracts context from the AGENTS.md contents.
- **Cursor** — detects `.cursor/` directory. Infers the runtime as `cursor`.
- **Codex** — detects `.codex/` directory. Infers the runtime as `codex`.

Custom strategies can be added for any file-based detection pattern. If your team uses a specific marker file, a particular directory structure, or a naming convention, a strategy can detect it.

**What strategies don't detect:** projects that already have a `.dork/agent.json` manifest. If the manifest exists, the agent is already registered — Mesh imports it directly into the registry without going through the discovery-and-approval flow. The manifest IS the proof of registration.

**Scan configuration.** Mesh scans configured root directories (e.g., `~/projects/`, `~/work/`) with a configurable depth limit. Strategies run against each candidate directory. Results are filtered against the deny list and existing registrations. What remains is the set of candidates awaiting review.

---

## Registration: Intentional Admission

Discovery finds candidates. Registration admits them.

**Three approval interfaces** converge on the same operation:

**Console UI.** A discovery panel shows candidates with their inferred hints — name, runtime, detected strategy. Approve with one click, deny with a reason. Edit the name, description, and capabilities before approving. This is the primary interface for interactive human use.

**MCP Tools.** `mesh_discover` runs a scan and returns candidates. `mesh_register` approves a candidate or manually registers a path. `mesh_deny` rejects a candidate. Agents can use these tools — imagine a "mesh admin" agent that scans your projects, evaluates candidates intelligently, and registers the ones that make sense.

**CLI.** `dorkos mesh discover` lists candidates. `dorkos mesh register <path>` registers by path. Scriptable, composable, automatable.

**What registration does:**

1. Writes `.dork/agent.json` to the project directory with the agent's identity, capabilities, runtime, behavior policy, and budget constraints. This manifest is the portable identity card — it can be version-controlled, cloned to other machines, and read by other tools.
2. Registers a Relay endpoint at `relay.agent.{project}.{agentId}` so the agent is routable through the message bus.
3. Configures access control rules in Relay based on the agent's project namespace and budget constraints.
4. Records the registration in the Mesh registry (SQLite) with metadata: who approved it, when, and from which discovery strategy.

**What denial does:**

1. Records the path, the detecting strategy, an optional reason, who denied it, and when — all in Mesh's SQLite database.
2. Does not write anything to the project directory.
3. Filters the denied path from future scan results.
4. The denial can be cleared, allowing the project to resurface as a candidate.

---

## The Agent Manifest

The manifest at `.dork/agent.json` is Mesh's artifact — written when an agent is registered, updated when its configuration changes, and read when Mesh needs to reconstruct the registry.

**Identity.** A unique ID (ULID), a human-readable name, a description. The basics that let other agents and humans understand what this agent is for.

**Runtime.** Which agent platform runs here — Claude Code, Cursor, Codex, OpenCode. Mesh passes this to the Engine so it knows which adapter to use when executing a session.

**Capabilities and skills.** What this agent can do. Code, test, deploy, analyze, purchase, approve. These are freeform declarations — not enforced permissions, but discoverable metadata. When an agent asks "who can approve a budget?", Mesh can answer.

**Behavior policy.** How this agent responds to incoming messages. Always respond? Only on direct mentions? Silent observer? These preferences travel with the agent's identity and inform how Relay and adapters handle delivery.

**Budget constraints.** Maximum hops, maximum calls per hour. Safety limits that Mesh writes into Relay's access rules when configuring the agent's endpoint.

**Registration metadata.** When the agent was registered, by whom (human or agent), and through which interface. This is the audit trail for admission decisions.

The manifest aligns with the emerging A2A Agent Card standard from the Linux Foundation. As agent interoperability protocols mature, DorkOS manifests will map cleanly to the industry standard.

**The manifest is also hand-authorable.** Power users can write `.dork/agent.json` directly. When Mesh scans a directory and finds an existing manifest, it imports the agent into the registry without requiring approval — the manifest's presence is the approval. This supports teams that want to pre-configure agents before running Mesh, or distribute agent identities through version control.

---

## Network Topology and Access Control

Discovery is one problem. Access control is another. Just because the purchasing agent can find the finance agent doesn't mean it should have unrestricted access.

**Mesh is DNS and iptables.** DNS tells you where things are. iptables controls what traffic is allowed. Mesh handles both roles for the agent network — it maintains the directory of registered agents and writes the rules that govern communication between them.

**Default-allow within a project. Default-deny across projects.** Agents in the same project namespace communicate freely. Cross-project communication requires explicit configuration. This mirrors Linux network namespaces — processes in the same namespace see each other naturally. Traffic between namespaces goes through defined routes.

Mesh doesn't enforce access rules directly. **Mesh writes rules. Relay enforces them.** When an agent is registered, Mesh configures access patterns in Relay — which subjects can send to which other subjects, at what priority. Relay evaluates these rules before every delivery. The separation is clean: Mesh is the policy author, Relay is the policy engine.

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

Mesh adds the discovery, registration, and topology layer. When Mesh arrives, it brings:

- **Endpoint registration on approval.** When a human or agent registers an agent through Mesh, Mesh creates `relay.agent.{project}.{agentId}` as an endpoint in Relay. No registration happens without approval — discovery alone doesn't create Relay endpoints.
- **Access control rules.** Mesh writes cross-project deny rules into Relay's access control. Agents within the same project communicate freely. Cross-project traffic requires explicit allowlisting.
- **Capability-based routing.** An agent asks "who can approve a budget?" Mesh looks up capabilities in its registry of registered agents, finds the finance agent, returns the Relay subject address. The agent sends its message through Relay. Discovery and delivery are cleanly separated.

**The concrete flow:** Pulse fires a schedule. The agent needs to message the finance agent. It calls a Mesh MCP tool — "find agents with the 'approve' capability." Mesh returns the finance agent's identity and Relay subject. The agent publishes a message to that subject through Relay. Relay delivers it. The finance agent responds through Relay. Four components, zero coupling between them.

See the [Relay Litepaper](./relay-litepaper.md) for the messaging layer that Mesh builds on. See the [DorkOS Litepaper](../dorkos-litepaper.md) for the full system vision.

---

## A Concrete Example

The birthday coordination scenario — from Mesh's perspective.

**Setup.** You ran `mesh discover` last week. It found five projects across `~/projects/`. You reviewed the candidates in the Console — approved the scheduling, finance, and purchasing agents, denied the abandoned `~/projects/old-prototype/`, and manually registered the monitoring agent that lives on a different drive. Each approved agent got a `.dork/agent.json` manifest and a Relay endpoint.

**Capability query.** Your scheduling agent detects a birthday next week. It queries Mesh: "Who has the 'budgeting' capability?" Mesh checks its registry of registered agents — the finance agent in `~/projects/finance/` declared this capability in its manifest. Mesh returns the agent's identity, capabilities, and Relay subject address.

**Access control.** These agents are in different projects. Mesh configured cross-project access rules in Relay at registration time that allow the scheduling project to message the finance project (explicitly allowlisted). The scheduling agent's message passes Relay's access check and arrives in the finance agent's mailbox.

**Coordination.** The finance agent approves a $50 budget and queries Mesh for an agent with 'purchasing' capabilities. Same flow: query, route through Relay, deliver. The purchasing agent orders flowers and replies. Four agents, four projects, one coordinated action.

Mesh made the connections. Relay moved the messages. Neither needed to know about the other's internals. And every agent in the network was there because someone chose to put it there.

---

## Roadmap

**Phase 1 — Discovery, Registration, and Registry.** Pluggable discovery strategies (Claude Code, Cursor, Codex). Configurable scan roots and depth. Candidate review workflow (approve, deny, ignore). Manual registration by path. `.dork/agent.json` manifest generation. Agent registry with SQLite persistence. Deny list with SQLite persistence. Automatic Relay endpoint registration on approval. HTTP routes for discovery, registration, and agent listing. MCP tools for agent-driven discovery and registration.

**Phase 2 — Network Topology.** Access control rules authored by Mesh, enforced by Relay. Budget policies per agent and project. Cross-project visibility configuration. Namespace isolation enforcement.

**Phase 3 — Observability.** Console topology visualization. Agent health tracking and lifecycle events. Diagnostic MCP tools and HTTP routes for mesh inspection. Dashboard with aggregate stats.

---

## Changes from v1 → v2 (February 2026)

- **Discovery vs. Registration**: Separated discovery (passive scanning) from registration (intentional admission). Discovery finds candidates; registration admits them to the mesh. The v1 litepaper conflated these — agents were automatically registered upon discovery.
- **Pluggable Discovery Strategies**: Replaced hardcoded `.dork/agent.json` + `.claude/` fallback with a pluggable strategy system. Built-in strategies for Claude Code, Cursor, and Codex. Custom strategies for arbitrary file-based detection.
- **Agent Lifecycle**: Introduced four-state lifecycle (Unknown → Discovered → Registered/Denied) plus manual registration as a fifth entry point.
- **Agent Manifest**: Reframed from hand-authored identity card to Mesh-generated artifact written at registration time. Also importable if hand-authored.
- **Deny List**: Added persistent denial tracking so rejected candidates don't resurface on subsequent scans.
- **Three Approval Interfaces**: Console UI, MCP tools (for agent-driven registration), and CLI. The v1 litepaper only implied programmatic discovery.
- **Relay Integration**: Changed from "automatic endpoint registration" to "endpoint registration upon approval." No Relay endpoints or ACL rules are created until an agent is registered.
- **Roadmap**: Phase 1 expanded from "Discovery and Registry" to "Discovery, Registration, and Registry" to reflect the full lifecycle.

---

## DNS and iptables for Agents

An operating system without service discovery is a collection of isolated processes. An operating system without network policy is an unmanaged free-for-all. You need both — a directory that tells you what exists, and rules that govern what's allowed.

Mesh provides both for DorkOS. It turns a runtime into an operating system — one where agents can find each other, coordinate safely, and operate within defined boundaries.

The layer that turns isolated agents into a network.
