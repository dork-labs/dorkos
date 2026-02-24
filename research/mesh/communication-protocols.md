# DorkOS Mesh: Agent-to-Agent Communication Protocols

**Research Date:** 2026-02-24
**Research Depth:** Deep
**Searches Performed:** 18
**Sources:** 40+ authoritative sources

---

## Research Summary

This report covers the full landscape of agent-to-agent communication: classical AI protocols (FIPA ACL, KQML, Contract Net), modern AI framework internals (AutoGen, CrewAI, LangGraph, Swarm, MetaGPT), local IPC mechanisms (Unix sockets, maildir, SQLite), emerging interoperability standards (MCP, A2A, ACP, ANP), and loop prevention strategies. The central recommendation for DorkOS Mesh is a **file-based maildir protocol with a JSON message envelope**, augmented by a local agent registry (JSON manifests), layered safety (TTL + hop count + circuit breaker), and optional upgrade to Unix domain sockets for high-throughput workloads.

---

## Table of Contents

1. [Classical Agent Communication Protocols](#1-classical-agent-communication-protocols)
2. [Modern AI Framework Communication Patterns](#2-modern-ai-framework-communication-patterns)
3. [Emerging Interoperability Standards (2025)](#3-emerging-interoperability-standards-2025)
4. [Inter-Process Communication on a Single Machine](#4-inter-process-communication-on-a-single-machine)
5. [Message Passing Patterns](#5-message-passing-patterns)
6. [Loop Prevention and Safety](#6-loop-prevention-and-safety)
7. [Design Recommendations for DorkOS Mesh](#7-design-recommendations-for-dorkos-mesh)
8. [Worked Example: DorkOS Mesh Message Flow](#8-worked-example-dorkos-mesh-message-flow)
9. [Research Gaps and Open Questions](#9-research-gaps-and-open-questions)
10. [Sources](#10-sources)

---

## 1. Classical Agent Communication Protocols

### 1.1 KQML — The First Standard (1990s)

**KQML (Knowledge Query and Manipulation Language)** was developed under the DARPA Knowledge Sharing Effort in the early 1990s as the first standardized agent communication language. It introduced the foundational concept of a **performative** — a declaration of the communicative intent of a message, borrowed from speech act theory.

A KQML message is an S-expression with a performative as the outermost token and named parameters as fields:

```lisp
(ask-one
  :sender agent-A
  :receiver agent-B
  :reply-with query-001
  :language KIF
  :ontology scheduling-ontology
  :content (schedule ?task ?time)
)
```

**Key KQML performatives** include: `tell`, `ask-one`, `ask-all`, `achieve`, `subscribe`, `advertise`, `broker-one`, `forward`. The `advertise` and `broker-one` performatives enabled an early form of service discovery through **communication facilitators** — routing agents that knew which agents could handle which types of requests.

**Weaknesses that led to FIPA ACL:**
- No formal semantics; implementations varied widely
- No interoperability guarantees between systems
- The meaning of performatives was underspecified
- No standard for content languages or ontologies

### 1.2 FIPA ACL — The Refined Standard

**FIPA (Foundation for Intelligent Physical Agents)** was incorporated in 1996 to produce interoperability standards for agent systems, and was accepted into the IEEE Computer Society in 2005. FIPA ACL is a direct descendant of KQML, with rigorous formal semantics based on modal logic.

**FIPA ACL Message Structure:**

Every FIPA ACL message must contain exactly one **performative** (the communicative act type) and may contain any combination of:

| Parameter | Description |
|---|---|
| `:performative` | Mandatory. The speech act (request, inform, query-if, etc.) |
| `:sender` | Agent identifier of sender |
| `:receiver` | One or more agent identifiers |
| `:reply-to` | Where to send replies (if different from sender) |
| `:content` | The actual payload (in a content language) |
| `:language` | Content language (e.g., FIPA-SL, Prolog, KIF) |
| `:encoding` | Content encoding |
| `:ontology` | Ontology name for interpreting content |
| `:protocol` | Interaction protocol this message belongs to |
| `:conversation-id` | Groups messages belonging to a dialogue |
| `:reply-with` | Expected reply identifier |
| `:in-reply-to` | Identifier this message replies to |
| `:reply-by` | Deadline for a reply |

**FIPA ACL Performatives (22 total):**

```
accept-proposal    agree           cancel          call-for-proposal
confirm            disconfirm      failure         inform
inform-if          inform-ref      not-understood  propagate
propose            proxy           query-if        query-ref
refuse             reject-proposal request         request-when
request-whenever   subscribe
```

**Wire format (FIPA ACL message literal syntax):**

```
(request
  :sender  (agent-identifier :name researcher@platform1)
  :receiver (agent-identifier :name coder@platform2)
  :content "((action (agent-identifier :name coder) (write-function factorial)))"
  :language FIPA-SL
  :ontology software-development
  :protocol fipa-request
  :conversation-id conv-7a3f2b
  :reply-with req-001
  :reply-by 20260224T120000Z
)
```

**FIPA ACL Content Languages:**

FIPA defined a hierarchy of content languages (SL0, SL1, SL2, SL — full Semantic Language) with progressively richer expressive power. SL supports logical connectives, quantifiers, modal operators, and temporal expressions.

**Reference implementation:** JADE (Java Agent DEvelopment Framework) is the canonical FIPA-compliant platform, still used in academic and industrial multi-agent research.

### 1.3 Contract Net Protocol (CNP)

Introduced by Reid G. Smith in 1980, the **Contract Net Protocol** is the standard mechanism for distributed task allocation. It was later standardized by FIPA. CNP models a market: agents bid on tasks, and the "manager" awards a contract to the best bidder.

**Protocol phases:**

```
1. ANNOUNCE  Manager → Contractors  "I have task T. Who can do it? Deadline: T+30s"
2. BID       Contractors → Manager  "I can do it. Estimated cost: 3 tool calls, 45s"
             OR
             NO-BID  Contractors → Manager  "I cannot handle this"
3. AWARD     Manager → Winner       "You win the contract for task T"
4. REJECT    Manager → Losers       "You were not selected"
5. RESULT    Contractor → Manager   "Task complete. Here is the output."
             OR
             FAILURE Contractor → Manager  "I failed. Here is why."
```

**Task decomposition:** The winner of a contract can itself become a manager, sub-contracting parts of the task to other agents. This enables hierarchical problem decomposition.

**Modern relevance:** This is exactly how CrewAI's hierarchical mode works, how AutoGen's group chats delegate, and how OpenAI Swarm handoffs operate — the underlying pattern has not changed in 45 years.

---

## 2. Modern AI Framework Communication Patterns

### 2.1 AutoGen (Microsoft) — Async Event-Driven Actors

**AutoGen v0.4** (released January 2025, merged into Microsoft Agent Framework in October 2025) adopts a three-layer architecture:

```
Core API          → Message passing, event-driven agents, distributed runtime
AgentChat API     → Two-agent chat, group chats (built on Core)
Extensions API    → Third-party integrations (built on AgentChat)
```

**Message types in AgentChat:**

All messages inherit from `BaseChatMessage` (agent-to-agent) or `BaseAgentEvent` (internal events).

```python
# Agent-to-agent messages
TextMessage(content="Hello, world!", source="researcher")
MultiModalMessage(content=["Describe this image:", img], source="vision-agent")
StructuredMessage(content=MyPydanticModel(...), source="coder")

# Internal events (not propagated to other agents)
ToolCallRequestEvent(...)
ToolCallExecutionEvent(...)
ToolCallSummaryMessage(...)
```

**Key message fields:**
- `id` — UUID of the message
- `source` — string name of the sending agent
- `content` — payload (string, list, or Pydantic BaseModel)
- `models_usage` — token consumption metadata
- `metadata` — arbitrary key-value dict
- `created_at` — ISO timestamp

**Orchestration patterns AutoGen supports:**

| Pattern | Description | Use Case |
|---|---|---|
| Sequential | Agent A → Agent B → Agent C in fixed order | Pipeline workflows |
| Group Chat | All agents see the same thread; a selector picks who responds | Deliberation, debate |
| Handoff | Active agent transfers control with context to next agent | Specialization routing |
| Hierarchical | Supervisor decomposes and delegates to sub-agents | Complex tasks |
| Concurrent | Multiple agents handle independent subtasks in parallel | Batch processing |

**Critical v0.4 architectural shift:** All interactions are now **asynchronous message exchanges** using Python `asyncio`. Agents run as actors with mailboxes. This eliminates blocking and enables prolonged multi-step workflows.

### 2.2 CrewAI — Hub-and-Spoke Role-Based Teams

CrewAI uses a **strict hub-and-spoke topology** — subagents communicate only with the orchestrator, never directly with each other. This architectural choice eliminates a whole class of coordination bugs at the cost of flexibility.

**Communication mechanisms:**

1. **Task Context passing:** The primary information channel. Tasks declare dependencies, and the output of task A becomes part of the context input for task B.

2. **`allow_delegation=True`:** Automatically equips agents with two tools:
   - `delegate_work(task, context, coworker)` — assign a subtask to a named teammate
   - `ask_question(question, context, coworker)` — request information from a teammate

3. **Memory subsystems:**
   - Short-term (in-context)
   - Long-term (persistent vector store)
   - Entity memory (named entities across conversations)

**Execution modes:**

- **Sequential:** Agents execute in specified order, each receiving the output of the previous
- **Hierarchical:** A manager LLM (or user-designated manager agent) dynamically assigns tasks

**What makes CrewAI's approach distinctive:** The Zero Trust, least-privilege execution model where each agent sees only its allowed toolset for a given task. Task-level scope overrides agent-level privileges. This is a security pattern borrowed from IAM design.

### 2.3 LangGraph — Graph-State Machine

LangGraph models multi-agent systems as **directed graphs where nodes are agents and edges are message routes**. State is shared across nodes via a typed state object (TypedDict or Pydantic).

**Core communication primitives:**

```python
# State flows through the graph
class AgentState(TypedDict):
    messages: list[BaseMessage]
    next_agent: str
    artifacts: list[dict]

# Edges define routing
graph.add_edge("researcher", "coder")
graph.add_conditional_edges("supervisor", route_fn)  # dynamic routing

# Handoff tools enable peer-to-peer transfer
transfer_to_coder = create_handoff_tool(agent_name="coder")
```

**Orchestration patterns:**

| Pattern | Description |
|---|---|
| Supervisor | Central coordinator node routes to specialist nodes |
| Scatter-Gather | Fan out to N agents, merge results downstream |
| Pipeline | Sequential linear graph |
| Cyclical (loop) | Nodes can route back to previous nodes (with termination conditions) |
| Peer-to-peer handoff | Agents transfer control without central coordinator |

**Key differentiator:** LangGraph explicitly supports **cyclical graphs** (feedback loops), which other frameworks avoid. This enables iterative refinement patterns (write → review → revise → review → ...) but requires careful termination conditions.

**State checkpointing:** LangGraph supports persisting graph state at each step, enabling interrupted workflows to resume from the last checkpoint.

### 2.4 OpenAI Swarm / Agents SDK — Routines and Handoffs

OpenAI Swarm (now superseded by the **OpenAI Agents SDK**, the production-ready successor) introduced two concepts:

**Routines:** A set of instructions an agent follows to complete a specific workflow. Think of it as a mini-state machine encoded in natural language + tools.

**Handoffs:** The mechanism for transferring control between agents. Implemented as a special function the LLM can call:

```python
def transfer_to_coder():
    """Transfer to the coding specialist agent."""
    return coder_agent

def transfer_to_reviewer():
    """Transfer to the code review agent."""
    return reviewer_agent
```

**Critical design decision:** When a handoff occurs, only the **instructions** (system prompt) change. The **message history is preserved** in full. This means the next agent has complete context but operates under different behavioral guidelines.

**Stateless agents:** Swarm agents are intentionally stateless between turns. All state lives in the message history. This makes them easy to reason about but requires full context window usage.

### 2.5 MetaGPT — Structured Document Passing

MetaGPT takes a radically different approach: **agents communicate via structured documents and diagrams, not dialogue**.

**The MetaGPT insight:** Unstructured natural language between agents introduces noise, ambiguity, and information loss. MetaGPT assigns each role a specific structured output format:

| Role | Output Format |
|---|---|
| Product Manager | PRD document (markdown) |
| Architect | System design document |
| Project Manager | Task list (JSON) |
| Engineer | Source code files |
| QA Engineer | Test cases |

**Communication mechanism:**
- Agents implement a **publish-subscribe mechanism** where roles subscribe to specific document types
- A shared environment (the "blackboard") stores published documents
- Agents pull relevant documents from the environment rather than receiving pushed messages

**Result:** MetaGPT dramatically reduces "hallucination cascade" — the phenomenon where one agent's mistake gets amplified as it propagates through downstream agents. Structured outputs are easier to validate.

### 2.6 ChatDev — ChatChain Sequential Stages

ChatDev uses a **ChatChain** pattern: the software development lifecycle is decomposed into sequential phases, each handled by a different agent pair in a turn-based dialogue.

**ChatChain phases:** Design → Coding → Code Review → Testing → Documentation

Within each phase, two agents (e.g., CTO and Programmer) engage in a structured multi-turn dialogue until the phase completes. The output of each phase becomes the input for the next.

**Key difference from MetaGPT:** ChatDev uses natural language dialogue within phases; MetaGPT uses structured documents between phases.

### 2.7 Agency Swarm — Explicit Communication Flows

Agency Swarm uses **directional communication flow graphs** defined at instantiation:

```python
agency = Agency(
    [
        ceo,                    # CEO can communicate with all
        [ceo, researcher],      # CEO → Researcher allowed
        [ceo, coder],           # CEO → Coder allowed
        [researcher, coder],    # Researcher → Coder allowed
    ]
)
```

The `>` operator defines allowed initiations. Agents communicate via a `send_message` tool. This explicit declaration prevents unauthorized inter-agent communication and makes the system's topology auditable.

---

## 3. Emerging Interoperability Standards (2025)

### 3.1 MCP (Model Context Protocol) — Anthropic

MCP is a **tool and context injection protocol** that defines how a single agent connects to external data sources, APIs, and execution environments.

**Message format:** JSON-RPC 2.0 over stdio or HTTP+SSE

**Core capabilities:**
- **Tools:** LLM-invocable functions (external APIs, file system, etc.)
- **Resources:** Application-controlled context datasets
- **Prompts:** Reusable prompt templates
- **Sampling:** Server-controlled LLM completion delegation

**Discovery:** Manual registration or static URL lookup. No dynamic discovery.

**Scope:** MCP handles agent ↔ tool communication. It is not designed for agent ↔ agent communication.

### 3.2 A2A (Agent-to-Agent Protocol) — Google / Linux Foundation

A2A was announced April 2025, open-sourced, and donated to the Linux Foundation. It is now the emerging standard for agent ↔ agent communication across platforms.

**Agent Card — the discovery primitive:**

Every A2A agent publishes a JSON "business card" at `/.well-known/agent.json`:

```json
{
  "name": "ResearchAgent",
  "description": "Performs deep web research on technical topics",
  "version": "1.0.0",
  "provider": { "organization": "DorkOS Mesh" },
  "capabilities": ["research", "summarization"],
  "authentication": { "schemes": ["bearer"] },
  "skills": [
    {
      "id": "deep-research",
      "name": "Deep Research",
      "inputModes": ["text"],
      "outputModes": ["text", "file"]
    }
  ]
}
```

**Task lifecycle:**

```
Client Agent → POST /tasks           → Creates a task
Server Agent → 202 Accepted          → Task received
Client Agent → GET /tasks/{id}       → Poll for status
Server Agent → SSE stream            → Or push progress events
Server Agent → Task{status:"done"}   → Task complete with Artifacts
```

**Message structure:** JSON-RPC 2.0 over HTTP. Task inputs and outputs are typed "parts" with explicit content-type negotiation.

**Transport:** HTTP + Server-Sent Events for streaming. Designed for synchronous and long-running async workflows.

**Adoption:** 50+ enterprise partners at launch including Atlassian, Salesforce, SAP, Langchain.

### 3.3 ACP (Agent Communication Protocol) — IBM / BeeAI

ACP uses **structured multipart messages with MIME-typed parts** — essentially applying the email multipart pattern to agent messages.

```
Message:
  Part 1: content-type: text/plain, data: "Analyze this codebase"
  Part 2: content-type: application/json, name: "spec", data: {...}
  Part 3: content-type: text/x-python, name: "main.py", data: "..."
```

Discovery: Registry APIs or manifest files at well-known URLs.

### 3.4 ANP (Agent Network Protocol) — Decentralized

ANP uses **Decentralized Identifiers (DIDs)** for agent identity and JSON-LD for capability description. Designed for open internet marketplaces where agents from different organizations need to find and trust each other without a central registry.

**Discovery:** Search engine discovery via `/.well-known/agent-descriptions`

**Relevance to DorkOS Mesh:** Too heavyweight for local-first use. But the DID-based identity model is worth adopting conceptually for agent verification.

### 3.5 Protocol Comparison Table

| Protocol | Scope | Transport | Discovery | Session | Best For |
|---|---|---|---|---|---|
| MCP | Agent ↔ Tool | HTTP/stdio/SSE | Static | Stateless | Tool injection |
| A2A | Agent ↔ Agent | HTTP + SSE | Agent Card | Session-aware | Enterprise delegation |
| ACP | Agent ↔ Agent | HTTP streams | Registry/manifest | Session-aware | Infrastructure agents |
| ANP | Agent ↔ Agent | HTTPS + DID | Search/P2P | DID-authenticated | Open internet |
| FIPA ACL | Agent ↔ Agent | Any | AMS directory | Conversation-tracked | Academic/industrial |

---

## 4. Inter-Process Communication on a Single Machine

DorkOS Mesh is local-first. Here is a comprehensive analysis of IPC options.

### 4.1 Unix Domain Sockets

Unix domain sockets (AF_UNIX) are the gold standard for bidirectional local IPC.

**Characteristics:**
- Full duplex (simultaneous read/write)
- Stream (SOCK_STREAM) or datagram (SOCK_DGRAM) modes
- No network stack overhead — kernel copies directly between process buffers
- Supports passing file descriptors across the socket (fd passing)
- Path: `/tmp/dorkos-mesh.sock` or `/run/dorkos/agent-{id}.sock`

**Performance:**
- Small messages (100-500 bytes): ~30% slower than named pipes
- Large messages (10KB+): ~350% faster than named pipes
- Overall: 15-50% faster than TCP localhost depending on message size

**Node.js example:**

```typescript
// Server (agent mailbox)
import net from 'net';

const server = net.createServer((socket) => {
  socket.on('data', (data) => {
    const msg: MeshMessage = JSON.parse(data.toString());
    handleMessage(msg);
  });
});
server.listen('/tmp/dorkos-agent-researcher.sock');

// Client (sending a message)
const client = net.createConnection('/tmp/dorkos-agent-researcher.sock');
client.write(JSON.stringify(meshMessage));
```

**Tradeoffs:**
- Requires both processes to be running simultaneously
- Connection management complexity (reconnection, backpressure)
- No persistence — messages lost if receiver is down

### 4.2 Named Pipes (FIFOs)

Named pipes are unidirectional channels backed by a kernel buffer.

**Characteristics:**
- Half-duplex (one direction per pipe; need two for bidirectional)
- File-system path: `/tmp/dorkos-to-researcher`
- Blocking by default (writer blocks until reader opens)
- Fastest for small messages (<500 bytes)

**Tradeoffs:**
- Unidirectional — need two pipes per agent pair for full communication
- Blocking semantics complicate async code
- No built-in message framing (stream, not message-oriented)

### 4.3 Shared Memory / Memory-Mapped Files

**Characteristics:**
- Fastest possible IPC — zero copy, no kernel involvement for reads
- Requires explicit locking (mutexes, semaphores) to prevent races
- Node.js: `mmap-io` package or `SharedArrayBuffer` (with limitations)

**Tradeoffs:**
- Significantly higher implementation complexity
- Locking bugs can deadlock the entire system
- No persistence after process death
- Best for high-frequency, small-payload telemetry (not message-passing)

### 4.4 File-Based Message Passing (Maildir Pattern)

**The Maildir pattern** was designed by Daniel J. Bernstein in 1995 for email delivery. It achieves **lock-free, atomic message queuing** using only filesystem primitives.

**Directory structure:**

```
~/.dork/mesh/agents/{agent-id}/
  mailbox/
    tmp/    # Message being written (in-progress)
    new/    # Delivered, not yet read
    cur/    # Read and being processed
  manifest.json  # Agent capability card
```

**Delivery protocol:**
1. Sender writes message to `tmp/{unique-id}` using an atomic write
2. Sender calls `rename(tmp/{id}, new/{id})` — atomic on POSIX filesystems
3. Receiver polls `new/` directory or uses `fs.watch()`
4. Receiver calls `rename(new/{id}, cur/{id})` to claim the message
5. Receiver processes, then deletes `cur/{id}`

**Why rename is atomic:** POSIX guarantees that `rename()` is atomic — either the file appears in the destination or it does not. There is no intermediate state. This is why Maildir needs no locks.

**Advantages for DorkOS Mesh:**
- Works even when agents are offline — messages persist on disk
- No server process required
- Agents can be implemented in any language
- Easy to debug (messages are readable JSON files)
- Git-inspectable history if stored in agent repos
- Zero dependencies

**Node.js implementation sketch:**

```typescript
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { watch } from 'fs';

const MESH_ROOT = path.join(process.env.DORK_HOME!, 'mesh', 'agents');

async function sendMessage(toAgentId: string, msg: MeshMessage): Promise<void> {
  const msgId = `${Date.now()}.${randomUUID()}`;
  const agentMailbox = path.join(MESH_ROOT, toAgentId, 'mailbox');

  const tmpPath = path.join(agentMailbox, 'tmp', msgId);
  const newPath = path.join(agentMailbox, 'new', msgId);

  await fs.writeFile(tmpPath, JSON.stringify(msg, null, 2), 'utf-8');
  await fs.rename(tmpPath, newPath);  // Atomic delivery
}

function watchMailbox(agentId: string, handler: (msg: MeshMessage) => Promise<void>): void {
  const newDir = path.join(MESH_ROOT, agentId, 'mailbox', 'new');

  watch(newDir, async (event, filename) => {
    if (!filename) return;
    const newPath = path.join(newDir, filename);
    const curPath = path.join(MESH_ROOT, agentId, 'mailbox', 'cur', filename);

    try {
      await fs.rename(newPath, curPath);  // Claim the message
      const content = await fs.readFile(curPath, 'utf-8');
      const msg: MeshMessage = JSON.parse(content);
      await handler(msg);
      await fs.unlink(curPath);  // Done
    } catch {
      // Another process claimed it first — that's fine
    }
  });
}
```

### 4.5 SQLite as a Communication Bus

SQLite can serve as a persistent message queue with durable delivery semantics.

**Schema:**

```sql
CREATE TABLE mesh_messages (
  id          TEXT PRIMARY KEY,
  from_agent  TEXT NOT NULL,
  to_agent    TEXT NOT NULL,
  performative TEXT NOT NULL,
  content     TEXT NOT NULL,  -- JSON
  status      TEXT DEFAULT 'pending',  -- pending|processing|done|failed
  ttl         INTEGER,        -- Unix timestamp expiry
  hop_count   INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL,
  claimed_at  INTEGER,
  done_at     INTEGER
);

CREATE INDEX idx_to_agent_status ON mesh_messages(to_agent, status, created_at);
```

**Claim pattern (prevents double-processing):**

```sql
-- Atomic claim using SQLite's row-level locking
UPDATE mesh_messages
SET status = 'processing', claimed_at = unixepoch()
WHERE id = (
  SELECT id FROM mesh_messages
  WHERE to_agent = ? AND status = 'pending' AND (ttl IS NULL OR ttl > unixepoch())
  ORDER BY created_at ASC
  LIMIT 1
)
RETURNING *;
```

**Advantages:**
- Full ACID durability — messages survive crashes
- Easy to query for debugging (`SELECT * FROM mesh_messages WHERE from_agent = 'researcher'`)
- Already a DorkOS dependency (`better-sqlite3` is used by PulseStore)
- Supports expiry via TTL column
- Consumer groups via the claim pattern

**Disadvantages:**
- Not designed for real-time push notification — requires polling or SQLite update hooks
- Write contention under high volume (WAL mode mitigates this)
- Database-as-IPC is considered an anti-pattern at scale, but fine at local agent counts

**Real-time push:** SQLite's [update hooks](https://www.sqlite.org/c3ref/update_hook.html) can trigger callbacks on INSERT, enabling near-real-time delivery without polling.

### 4.6 Local HTTP / gRPC

**Local HTTP (localhost):**
- Each agent runs an HTTP server on a dedicated port
- Agents discover each other via the registry (ports published in manifests)
- High implementation overhead; port management complexity
- Easiest for developers familiar with REST

**gRPC (HTTP/2 over TCP):**
- Strongly typed via Protocol Buffers
- Bidirectional streaming support
- Overkill for a local-first system
- Better suited when Mesh goes cross-machine

### 4.7 IPC Method Comparison for DorkOS Mesh

| Method | Persistence | Push | Lock-Free | Debuggability | Complexity | Recommended |
|---|---|---|---|---|---|---|
| Unix domain sockets | No | Yes | Yes | Low | Medium | For real-time |
| Named pipes | No | Yes (blocking) | No | Low | High | Avoid |
| Shared memory | No | No (poll) | No | Very Low | Very High | Avoid |
| Maildir (files) | Yes | Via fs.watch | Yes | High | Low | **Primary** |
| SQLite | Yes | Via hooks | No (locking) | High | Medium | **Persistent queue** |
| Local HTTP | No | No (poll) | Yes | High | High | For cross-machine |

---

## 5. Message Passing Patterns

### 5.1 Request / Response

The simplest pattern. Agent A sends a message and waits for Agent B to reply.

```
A ──[request]──> B
A <──[response]── B
```

**Implementation:** Caller generates a `reply-to` address (e.g., a unique mailbox path) and a `correlation-id`. Callee sends response to the `reply-to` address with the same `correlation-id`.

**Problem:** If B is slow or down, A is blocked. Solution: timeouts + async.

### 5.2 Pub/Sub (Publish-Subscribe)

Publishers emit events to topics. Subscribers declare interest in topics. No direct coupling between publisher and subscriber.

```
Researcher ──[publish: code-review-needed]──> Topic
Reviewer1  <──[deliver]──────────────────── Topic
Reviewer2  <──[deliver]──────────────────── Topic
```

**Relevant for Mesh:** An agent completing a task could publish to a `mesh.events` topic, allowing interested agents to react without explicit routing.

**SQLite implementation:** `mesh_events` table with subscriber polling or update hooks.

### 5.3 Actor Model / Mailbox Pattern

Each agent is an **actor**: an independent unit with:
1. A private **mailbox** (message queue)
2. Private **state** (not shared)
3. A **behavior** (message handler)

An actor can only affect the world by:
- Sending messages to other actors
- Creating new actors
- Changing its own state for the next message

**Key property:** Actors process **one message at a time** from their mailbox. This eliminates concurrency bugs within an actor. Multiple actors can run in parallel.

**Why this maps perfectly to DorkOS Mesh:** Each Claude Code agent is naturally an actor. It has:
- A mailbox (the agent's `/mailbox/new/` directory)
- Private state (its JSONL transcript, memory files)
- A behavior (its CLAUDE.md rules and system prompt)

The Claude Code agent processes messages sequentially (one session at a time), exactly matching the actor model.

### 5.4 Message Queue (Point-to-Point)

```
Producer ──[enqueue]──> Queue ──[dequeue]──> Consumer
```

Each message is consumed by exactly one consumer. Reliable delivery via acknowledgements. If the consumer crashes before ACK, the message goes back to the queue.

**Relevant queue systems for local use:**
- **Redis Streams:** Durable, supports consumer groups, requires Redis process
- **NATS JetStream:** High-performance, built-in persistence, requires NATS process
- **SQLite queue:** Zero additional dependencies, ACID-safe, good for low-volume

### 5.5 Event-Driven / Event Sourcing

Every state change is recorded as an immutable event. Agents can replay event history to reconstruct state.

**Relevance:** DorkOS Mesh already has an event log (JSONL transcripts). The Mesh could expose this as a stream other agents can subscribe to.

### 5.6 Blackboard Pattern

A shared workspace where agents read and write structured data. Agents subscribe to changes in areas they care about.

This is MetaGPT's approach — agents publish structured documents to a shared environment (the "blackboard") rather than sending messages directly to other agents.

**Relevance:** A shared `~/.dork/mesh/blackboard/` directory with JSON/markdown files could serve as an implicit coordination mechanism for DorkOS agents.

### 5.7 Dead Letter Queue

When a message cannot be delivered (agent offline, TTL expired, repeated failures), it goes to a **Dead Letter Queue (DLQ)**. An operator or supervisor agent can inspect and retry or discard dead letters.

**DorkOS Mesh implementation:**
```
~/.dork/mesh/agents/{agent-id}/mailbox/
  new/     # Delivered
  cur/     # Processing
  failed/  # Dead letters
```

---

## 6. Loop Prevention and Safety

This is the most critical safety concern for autonomous agent networks. Loops manifest as:
- Agent A asks Agent B → Agent B asks Agent A → infinite cycle
- Agent A creates a task → Scheduler runs the task → task spawns Agent A again
- Cascading delegations that explode exponentially

### 6.1 Message Envelope Safety Fields

Every message in DorkOS Mesh should carry these safety fields:

```typescript
interface MeshMessage {
  // Identity
  id: string;              // UUID v4 — globally unique message ID
  conversationId: string;  // Groups all messages in one logical conversation
  correlationId?: string;  // For request/reply matching

  // Routing
  from: string;            // Sending agent ID
  to: string;              // Receiving agent ID
  replyTo?: string;        // Where to send the response

  // Loop prevention
  hopCount: number;        // Incremented at each agent boundary
  maxHops: number;         // Hard limit (default: 5)
  ancestorChain: string[]; // Full path of agent IDs that touched this message
  ttl: number;             // Unix timestamp expiry (default: now + 30 minutes)

  // Content
  performative: MeshPerformative;
  content: unknown;
  contentType: 'application/json' | 'text/plain' | 'text/markdown';

  // Metadata
  createdAt: string;       // ISO 8601
  priority: 'low' | 'normal' | 'high';
}
```

### 6.2 Hop Count

Borrowed from IP networking's TTL field. Each agent that processes and forwards a message increments `hopCount`. If `hopCount >= maxHops`, the message is rejected and sent to the DLQ.

```typescript
function receiveMessage(msg: MeshMessage): void {
  if (msg.hopCount >= msg.maxHops) {
    sendToDeadLetterQueue(msg, 'MAX_HOPS_EXCEEDED');
    return;
  }

  if (msg.ancestorChain.includes(MY_AGENT_ID)) {
    sendToDeadLetterQueue(msg, 'CYCLE_DETECTED');
    return;
  }

  // Process...
  const outgoing = {
    ...msg,
    hopCount: msg.hopCount + 1,
    ancestorChain: [...msg.ancestorChain, MY_AGENT_ID],
  };
}
```

### 6.3 TTL (Time To Live)

Messages expire after a configurable duration. If an agent retrieves a message with `ttl < Date.now()`, it discards it without processing.

**Default TTL recommendations:**
- Simple requests: 5 minutes
- Long-running research tasks: 2 hours
- Background/scheduled tasks: 24 hours

### 6.4 Cycle Detection via Ancestor Chain

The `ancestorChain` field records every agent ID that has touched the message. Before processing, an agent checks if its own ID is already in the chain. If yes, this is a cycle — reject immediately.

This is analogous to BGP's AS_PATH attribute in internet routing, which prevents routing loops between autonomous systems.

### 6.5 Circuit Breaker

A per-agent-pair circuit breaker prevents one misbehaving agent from flooding another.

**States:**
- **CLOSED:** Normal operation. Messages pass through.
- **OPEN:** Failure threshold exceeded. All messages to this agent are rejected immediately.
- **HALF-OPEN:** After cool-down period, let one probe message through. If it succeeds, CLOSE. If it fails, OPEN again.

```typescript
class AgentCircuitBreaker {
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private failures = 0;
  private readonly threshold = 5;
  private readonly cooldown = 60_000; // 1 minute
  private openedAt?: number;

  canSend(): boolean {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') {
      if (Date.now() - (this.openedAt ?? 0) > this.cooldown) {
        this.state = 'HALF_OPEN';
        return true;
      }
      return false;
    }
    return true; // HALF_OPEN — let probe through
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  recordFailure(): void {
    this.failures++;
    if (this.failures >= this.threshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
    }
  }
}
```

### 6.6 Rate Limiting

Agents should have per-sender rate limits. An agent that receives more than N messages from the same sender in a time window should:
1. Queue the excess (if backpressure is acceptable)
2. Reject with a `RATE_LIMITED` response
3. Trigger circuit breaker investigation

### 6.7 Step Budget and Token Budget

Per-conversation limits prevent runaway agent chains:

- **Max steps:** Maximum number of tool calls or reasoning steps per conversation
- **Max tokens:** Total token budget for the conversation
- **Max wall-clock time:** Absolute deadline for task completion
- **Max idle time:** If no progress in N seconds, abort

**Implementation:** Store budgets in the conversation context. Each agent checks remaining budget before initiating new delegations.

### 6.8 Idempotency via Message IDs

Every message has a unique `id`. Agents maintain a deduplication window (e.g., last 1000 message IDs processed). If a duplicate arrives (network retry, delivery reordering), it is discarded.

```typescript
class DeduplicationCache {
  private seen = new Set<string>();
  private queue: string[] = [];
  private readonly maxSize = 1000;

  isDuplicate(msgId: string): boolean {
    return this.seen.has(msgId);
  }

  record(msgId: string): void {
    if (this.queue.length >= this.maxSize) {
      const evicted = this.queue.shift()!;
      this.seen.delete(evicted);
    }
    this.seen.add(msgId);
    this.queue.push(msgId);
  }
}
```

### 6.9 Conversation ID and Correlation ID Tracking

**Correlation ID:** Links a request to its response. Generated by the caller, echoed by the callee.

**Conversation ID:** Groups all messages in a logical conversation (including sub-delegations). Propagated without modification.

**Trace ID:** Follows the full execution path for observability. Use OpenTelemetry's `TraceId` format for compatibility.

```typescript
// Starting a new conversation
const conversationId = `mesh-${randomUUID()}`;

// All derived messages inherit conversationId
const delegatedMsg = {
  ...subTask,
  conversationId,  // Same as parent
  correlationId: randomUUID(),  // New for this specific request/reply pair
};
```

---

## 7. Design Recommendations for DorkOS Mesh

### 7.1 Core Architecture: Hybrid Maildir + SQLite

**Phase 1 (Local, File-Based):**

Use **Maildir** as the primary message delivery mechanism. It requires zero additional infrastructure, works with any language, survives process restarts, and is trivially debuggable.

Use **SQLite** (reusing PulseStore's database) as the durable message log and for structured querying of mesh activity.

```
~/.dork/mesh/
  registry/
    agents.json          # Agent manifest registry
  agents/
    {agent-id}/
      manifest.json      # Agent capability card (like A2A Agent Card)
      mailbox/
        tmp/             # In-flight writes
        new/             # Delivered, unclaimed
        cur/             # Being processed
        failed/          # Dead letter queue
  db/
    mesh.db             # SQLite: message log, circuit breakers, rate limits
```

**Phase 2 (Optional, High Throughput):**

Upgrade to Unix domain sockets for real-time message delivery, keeping Maildir for persistence.

### 7.2 Message Envelope Schema

```typescript
type MeshPerformative =
  | 'request'          // Ask agent to do something
  | 'inform'           // Share information (no response expected)
  | 'query'            // Ask a question, expect an answer
  | 'answer'           // Response to a query
  | 'delegate'         // Contract Net: assign a task
  | 'propose'          // Contract Net: offer to do a task
  | 'accept-proposal'  // Contract Net: award the contract
  | 'reject-proposal'  // Contract Net: decline the bid
  | 'result'           // Deliver completed work
  | 'failure'          // Report that a task failed
  | 'cancel'           // Cancel an in-progress task
  | 'subscribe'        // Subscribe to a topic
  | 'publish'          // Publish an event to a topic
  | 'ping'             // Health check
  | 'pong'             // Health check response

interface MeshMessage {
  // Version
  meshVersion: '1.0';

  // Identity
  id: string;                    // UUID v4
  conversationId: string;        // UUID v4 — groups related messages
  correlationId?: string;        // For request/reply matching

  // Routing
  from: AgentRef;                // { id, manifestPath }
  to: AgentRef;
  replyTo?: AgentRef;            // Where to send response (if different)

  // Loop prevention (required)
  hopCount: number;              // Starts at 0, incremented at each hop
  maxHops: number;               // Default: 5
  ancestorChain: string[];       // Agent IDs that handled this message
  ttl: number;                   // Unix timestamp (ms) expiry
  budget?: {
    maxSteps?: number;
    maxTokens?: number;
    deadline?: number;           // Unix timestamp (ms)
  };

  // Content
  performative: MeshPerformative;
  content: unknown;
  contentType: 'application/json' | 'text/plain' | 'text/markdown';
  artifacts?: MeshArtifact[];    // Output files, structured results

  // Metadata
  createdAt: string;             // ISO 8601
  priority: 'low' | 'normal' | 'high';
  tags?: string[];               // For routing/filtering
}

interface AgentRef {
  id: string;           // Stable agent identifier (e.g., "researcher", "coder")
  manifestPath: string; // Absolute path to agent's manifest.json
}

interface MeshArtifact {
  name: string;
  contentType: string;
  content?: string;    // Inline for small artifacts
  path?: string;       // File path for large artifacts
}
```

### 7.3 Agent Manifest Schema

Each agent publishes a `manifest.json` (inspired by A2A Agent Card and FIPA's AMS):

```json
{
  "meshVersion": "1.0",
  "id": "researcher",
  "name": "Research Agent",
  "description": "Deep research on technical topics using web search",
  "version": "1.0.0",
  "agentType": "claude-code",
  "cwd": "/Users/doriancollier/Keep/projects/researcher",
  "capabilities": ["research", "summarization", "fact-checking"],
  "skills": [
    {
      "id": "deep-research",
      "name": "Deep Research",
      "description": "Conducts thorough research on a topic and produces a report",
      "inputPerformatives": ["request", "delegate"],
      "outputPerformatives": ["result", "failure"],
      "inputSchema": {
        "topic": "string",
        "depth": "quick|focused|deep"
      }
    }
  ],
  "accepts": ["request", "query", "delegate", "ping"],
  "status": "active",
  "lastSeen": "2026-02-24T10:00:00Z",
  "mailboxPath": "~/.dork/mesh/agents/researcher/mailbox",
  "maxConcurrentTasks": 1,
  "rateLimits": {
    "messagesPerMinute": 10
  }
}
```

### 7.4 Agent Discovery: Local Registry

A central `~/.dork/mesh/registry/agents.json` serves as the local agent directory:

```json
{
  "version": "1.0",
  "updatedAt": "2026-02-24T10:00:00Z",
  "agents": {
    "researcher": {
      "manifestPath": "~/.dork/mesh/agents/researcher/manifest.json",
      "registeredAt": "2026-02-24T09:00:00Z",
      "status": "active"
    },
    "coder": {
      "manifestPath": "/Users/doriancollier/Keep/projects/coder/.mesh/manifest.json",
      "registeredAt": "2026-02-24T09:00:00Z",
      "status": "active"
    }
  }
}
```

Agents register on startup via a `dorkos mesh register` CLI command. The DorkOS server can maintain this registry and expose it via `/api/mesh/agents`.

### 7.5 Orchestration Topology Recommendation

For DorkOS Mesh, use a **hybrid topology**:

1. **Supervisor/Hub pattern** for structured workflows: A coordinating agent manages task decomposition and delegation (Contract Net style)
2. **Peer-to-peer** for simple queries: Agents can send `query`/`answer` directly without a coordinator
3. **Pub/sub** for events: Agents publish task completion events to a shared topic; interested agents subscribe

**Avoid:** Full mesh (every agent connected to every other agent) — this creates O(n²) connections and makes loop detection exponentially harder.

### 7.6 Communication Flow Declarations

Inspired by Agency Swarm, each agent manifest declares allowed communication flows:

```json
{
  "communicationFlows": {
    "canInitiate": ["researcher", "planner"],
    "canReceiveFrom": ["*"],
    "canDelegate": ["coder", "reviewer"]
  }
}
```

The DorkOS Mesh router enforces these at message delivery time. Unauthorized messages are rejected before they reach the agent's mailbox.

---

## 8. Worked Example: DorkOS Mesh Message Flow

### Scenario: Planner delegates a research task to Researcher, who sub-delegates fact-checking to a third agent

```
Planner ──[delegate: "Research quantum computing trends"]──> Researcher
         conversationId: "mesh-abc123"
         hopCount: 0, maxHops: 5
         ancestorChain: ["planner"]
         ttl: now + 2h

Researcher receives message:
  - Validates: hopCount(0) < maxHops(5) ✓
  - Validates: ancestorChain does NOT contain "researcher" ✓
  - Validates: ttl > now ✓
  - Begins research...
  - Decides to delegate fact-checking to FactChecker

Researcher ──[delegate: "Verify these 3 claims"]──> FactChecker
             conversationId: "mesh-abc123"  (same!)
             hopCount: 1
             ancestorChain: ["planner", "researcher"]
             ttl: now + 90min  (reduced from remaining time)

FactChecker receives message:
  - Validates: hopCount(1) < maxHops(5) ✓
  - Validates: "factchecker" NOT in ["planner", "researcher"] ✓
  - Processes fact-checking...

FactChecker ──[result: {verified: [...], disputed: [...]}]──> Researcher
              conversationId: "mesh-abc123"
              hopCount: 2
              ancestorChain: ["planner", "researcher", "factchecker"]

Researcher assembles final report, replies to Planner:
Researcher ──[result: {report: "..."}]──> Planner
              conversationId: "mesh-abc123"
              hopCount: 3
              ancestorChain: ["planner", "researcher", "factchecker", "researcher"]

Planner receives result. Conversation complete.
```

**Loop prevention working:** If FactChecker had tried to delegate back to Planner:

```
FactChecker ──[delegate]──> Planner
  Planner mailbox check: "planner" IS in ancestorChain ✓
  → REJECTED: CYCLE_DETECTED
  → Message sent to dead letter queue
```

---

## 9. Research Gaps and Open Questions

1. **Agent identity and authentication:** How do agents verify they are talking to who they think they are? DIDs are the right direction but heavyweight locally. A simpler approach might be filesystem ownership checks (only the agent process owns its mailbox directory).

2. **Multi-machine Mesh:** The file-based approach requires a shared filesystem for cross-machine operation. When DorkOS Mesh goes distributed, the right upgrade path is: local (Maildir) → network (A2A protocol over HTTP) → decentralized (ANP with DIDs).

3. **Supervisor agent implementation:** The "who orchestrates the orchestrators" problem. DorkOS could implement a built-in Planner agent or expose Mesh routing through the existing DorkOS server.

4. **Schema evolution:** How do agents handle messages from agents running older versions of the schema? Versioning via `meshVersion` field handles this but needs a negotiation protocol.

5. **Conflict resolution:** What happens when two agents independently produce conflicting outputs? The research didn't surface a clear pattern — this appears to be an open research problem.

6. **Observability:** The `conversationId` and `hopCount` fields enable distributed tracing. Integration with OpenTelemetry would provide a standard observability story, but no framework surveyed has nailed this for local multi-agent systems.

---

## 10. Sources

### Classical Protocols
- [FIPA ACL Introduction - SmythOS](https://smythos.com/developers/agent-development/fipa-agent-communication-language/)
- [Agent Communications Language - Wikipedia](https://en.wikipedia.org/wiki/Agent_Communications_Language)
- [FIPA ACL JADE Tutorial (PDF)](https://jade.tilab.com/papers/JADETutorialIEEE/JADETutorial_FIPA.pdf)
- [KQML Overview - SmythOS](https://smythos.com/developers/agent-development/kqml/)
- [KQML - Wikipedia](https://en.wikipedia.org/wiki/Knowledge_Query_and_Manipulation_Language)
- [Contract Net Protocol - Wikipedia](https://en.wikipedia.org/wiki/Contract_Net_Protocol)
- [The Contract Net Protocol: High-Level Communication (Smith 1980)](https://www.reidgsmith.com/The_Contract_Net_Protocol_Dec-1980.pdf)

### Modern AI Frameworks
- [AutoGen Microsoft Research](https://www.microsoft.com/en-us/research/project/autogen/)
- [AutoGen Messages Documentation](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/tutorial/messages.html)
- [AutoGen AgentChat Messages API Reference](https://microsoft.github.io/autogen/stable//reference/python/autogen_agentchat.messages.html)
- [CrewAI Collaboration Docs](https://docs.crewai.com/en/concepts/collaboration)
- [CrewAI Framework 2025 Review - Latenode](https://latenode.com/blog/ai-frameworks-technical-infrastructure/crewai-framework/crewai-framework-2025-complete-review-of-the-open-source-multi-agent-ai-platform)
- [LangGraph Multi-Agent Orchestration - Latenode](https://latenode.com/blog/ai-frameworks-technical-infrastructure/langgraph-multi-agent-orchestration/langgraph-multi-agent-orchestration-complete-framework-guide-architecture-analysis-2025)
- [LangGraph Agent Orchestration - bix-tech](https://bix-tech.com/agent-orchestration-and-agenttoagent-communication-with-langgraph-a-practical-guide/)
- [OpenAI Swarm GitHub](https://github.com/openai/swarm)
- [Orchestrating Agents: Routines and Handoffs - OpenAI Cookbook](https://cookbook.openai.com/examples/orchestrating_agents)
- [MetaGPT Paper (ICLR 2024)](https://proceedings.iclr.cc/paper_files/paper/2024/file/6507b115562bb0a305f1958ccc87355a-Paper-Conference.pdf)
- [ChatDev: Communicative Agents for Software Development (ACL 2024)](https://aclanthology.org/2024.acl-long.810.pdf)
- [Agency Swarm GitHub](https://github.com/VRSEN/agency-swarm)

### Interoperability Standards
- [A2A Protocol Announcement - Google Developers Blog](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
- [A2A Protocol Site](https://a2a-protocol.org/latest/)
- [Survey of Agent Interoperability Protocols (MCP, A2A, ACP, ANP) - arxiv](https://arxiv.org/html/2505.02279v1)
- [A2A vs MCP - Gravitee](https://www.gravitee.io/blog/googles-agent-to-agent-a2a-and-anthropics-model-context-protocol-mcp)
- [What is A2A - InfoWorld](https://www.infoworld.com/article/4088217/what-is-a2a-how-the-agent-to-agent-protocol-enables-autonomous-collaboration.html)

### IPC and Message Passing
- [IPC Performance Comparison - Baeldung](https://www.baeldung.com/linux/ipc-performance-comparison)
- [Benchmark TCP/IP, Unix domain socket, Named pipe](https://www.yanxurui.cc/posts/server/2023-11-28-benchmark-tcp-uds-namedpipe/)
- [Maildir - Wikipedia](https://en.wikipedia.org/wiki/Maildir)
- [SQLite as IPC - mike.depalatis.net](https://mike.depalatis.net/blog/ipc-with-sqlite.html)
- [Database-as-IPC - Wikipedia](https://en.wikipedia.org/wiki/Database-as-IPC)
- [LiteQueue - GitHub](https://github.com/litements/litequeue)
- [Actor Model Message Passing](http://dist-prog-book.com/chapter/3/message-passing.html)
- [Erlang Actor Model - Underjord](https://underjord.io/unpacking-elixir-the-actor-model.html)

### Loop Prevention and Safety
- [Prevent Agent Loops - Codieshub](https://codieshub.com/for-ai/prevent-agent-loops-costs)
- [Why Multi-Agent LLM Systems Fail - Galileo](https://galileo.ai/blog/multi-agent-llm-systems-fail)
- [Circuit Breaker Pattern - Aerospike](https://aerospike.com/blog/circuit-breaker-pattern/)
- [Correlation IDs - Enterprise Integration Patterns](https://www.enterpriseintegrationpatterns.com/patterns/messaging/CorrelationIdentifier.html)
- [Correlation and Conversations - Gregor Hohpe](https://www.enterpriseintegrationpatterns.com/ramblings/09_correlation.html)
- [Correlation IDs - Microsoft Engineering Playbook](https://microsoft.github.io/code-with-engineering-playbook/observability/correlation-id/)

### Agent Discovery
- [A2A Agent Discovery](https://a2a-protocol.org/latest/topics/agent-discovery/)
- [Agent Communication Protocol Discovery](https://agentcommunicationprotocol.dev/core-concepts/agent-discovery)
- [Agent Name Service (ANS) - arxiv](https://arxiv.org/html/2505.10609v1)

### Redis / NATS
- [Redis Streams vs Pub/Sub - Redis blog](https://redis.io/blog/what-to-choose-for-your-synchronous-and-asynchronous-communication-needs-redis-streams-redis-pub-sub-kafka-etc-best-approaches-synchronous-asynchronous-communication/)
- [NATS vs Redis - hoop.dev](https://hoop.dev/blog/what-nats-redis-actually-does-and-when-to-use-it/)
