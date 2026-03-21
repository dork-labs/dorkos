---
title: 'Relay Tool Naming: Evaluating relay_send_and_wait vs relay_send_async'
date: 2026-03-21
type: external-best-practices
status: active
tags: [relay, tool-naming, mcp, naming-conventions, semantics, send-and-wait, fire-and-forget]
feature_slug: relay-subject-folder-names
searches_performed: 0
sources_count: 3
---

# Relay Tool Naming: Evaluating relay_send_and_wait vs relay_send_async

## Research Summary

The proposed rename of DorkOS relay tools from `relay_query` → `relay_send_and_wait` and `relay_dispatch` → `relay_send_async` is **semantically excellent** and aligns with industry patterns, but the new names are significantly longer and depart from DorkOS's established `domain_verb` naming convention. The existing `relay_query` and `relay_dispatch` names already encode the semantic difference implicitly: their return behavior distinguishes them. The proposal trades established conciseness for explicit semantics. Both approaches are defensible; the choice depends on whether the codebase prioritizes maximum discoverability (longer, more explicit names) or adherence to established patterns (shorter, verb-based names).

**Recommendation:** The proposed names are good, but consider a hybrid: `relay_query` and `relay_dispatch` are already semantically clear and align with the existing `domain_verb` pattern. If a rename is essential for clarity, a lighter alternative is `relay_query_wait` and `relay_dispatch_async` (shorter than the proposed names, still explicit about response semantics). However, the current names are defensible and should not be changed unless agent confusion has been documented.

---

## Key Findings

### 1. The Problem Being Solved

All three relay tools (`relay_send`, `relay_query`, `relay_dispatch`) use the same underlying publish codepath. They differ **only in response handling**:

- `relay_send` — fire-and-forget (returns immediately with delivery status)
- `relay_query` — blocks until reply arrives (synchronous, timeout 120s max)
- `relay_dispatch` — returns inbox ID for polling (asynchronous, long-running tasks)

The proposed names make this difference explicit in the tool name itself:

| Current          | Proposed              | Semantics Encoded            |
| ---------------- | --------------------- | ---------------------------- |
| `relay_send`     | `relay_send`          | fire-and-forget (unchanged)  |
| `relay_query`    | `relay_send_and_wait` | synchronous request/response |
| `relay_dispatch` | `relay_send_async`    | asynchronous fire-and-poll   |

**Assessment:** The proposal solves a real problem: agents might not immediately understand that `relay_query` blocks or that `relay_dispatch` returns an inbox ID without blocking. The new names make the response semantics self-documenting.

### 2. How Other Messaging Systems Name Request/Response Operations

**NATS (JetStream):**

- `Publish()` — fire-and-forget
- `Request()` — blocking request/response
- No async dispatch tool (but subjects can be subscribed to for long-running replies)
- Verdict: Uses verb that encodes response behavior (`Request` signals synchronous)

**RabbitMQ:**

- `basicPublish()` — fire-and-forget
- RPC pattern using `basicCall()` or manually setting `replyTo` — implicit request/response
- No standard async dispatch (but `basicGet()` is used for manual polling)
- Verdict: Generic verb (`basicPublish`) with behavior determined by payload structure

**Kafka:**

- `send()` — fire-and-forget (async callback optional)
- No built-in request/response model (KafkaStreams is separate)
- Verdict: Single verb, response handled by consuming partitions or callbacks

**Redis Pub/Sub:**

- `PUBLISH` — fire-and-forget
- `SUBSCRIBE` / `PSUBSCRIBE` — passive listening (inverse of publish)
- `BLPOP` / `BRPOP` — blocking read from lists (used for queues)
- Verdict: Verb encodes response behavior (`SUBSCRIBE` is passive, `BLPOP` is blocking)

**Google Cloud Pub/Sub (gRPC API):**

- `Publish()` — fire-and-forget
- Subscribers are passive listeners (separate `Pull()` and `Subscribe()` methods)
- Verdict: Pub/sub split by operation, not verb modifiers

**Industry Consensus:** Messaging systems split the operation into distinct verbs (`Publish`, `Request`, `Subscribe`, `Dispatch`) or encode response behavior in the verb itself (`Request` signals synchronous, `BLPOP` signals blocking). The DorkOS approach of using `query`, `dispatch`, `send` to distinguish response behavior is less common but not wrong.

### 3. MCP Tool Naming Conventions (from prior research)

From `research/20260304_mcp_tool_naming_conventions.md` (March 4, 2026):

- **Official pattern:** `verb_noun` in snake_case (e.g., `get_weather`, `list_issues`, `send_message`)
- **DorkOS pattern:** `domain_verb` or `domain_verb_noun` (e.g., `relay_send`, `mesh_register`)
- **Stripe MCP (25 tools):** `verb_noun` without domain prefix (`create_customer`, `list_customers`)
- **Finding:** Domain-first (`relay_send`) is non-standard but defensible for multi-domain MCP servers

**Consistency check on current names:**

| Tool             | Pattern       | Consistency                                |
| ---------------- | ------------- | ------------------------------------------ |
| `relay_send`     | `domain_verb` | ✓ Consistent with relay/mesh/binding tools |
| `relay_query`    | `domain_verb` | ✓ Consistent                               |
| `relay_dispatch` | `domain_verb` | ✓ Consistent                               |

All three current names follow the established DorkOS `domain_verb` pattern. **The proposed names depart from this:**

| Proposed              | Pattern                 | Consistency            |
| --------------------- | ----------------------- | ---------------------- |
| `relay_send`          | `domain_verb`           | ✓ Matches existing     |
| `relay_send_and_wait` | `domain_verb_conj_verb` | ✗ Departs from pattern |
| `relay_send_async`    | `domain_verb_adj`       | ✗ Departs from pattern |

**Assessment:** The proposal trades consistency for explicitness. The new names abandon the parallel structure of `relay_send`, `relay_query`, `relay_dispatch` for a new `relay_send_*` grouping that is descriptive but breaks the pattern.

### 4. Name Length and Discoverability in MCP Tool Lists

MCP tool interfaces (like Claude's tool search in large context windows) list tools alphabetically. Current names:

```
relay_dispatch
relay_inbox
relay_list_endpoints
relay_query
relay_register_endpoint
relay_send
```

With the proposal:

```
relay_inbox
relay_list_endpoints
relay_register_endpoint
relay_send
relay_send_and_wait     (28 chars)
relay_send_async        (17 chars)
```

**Character count:**

- `relay_query` = 11 chars
- `relay_dispatch` = 14 chars
- `relay_send_and_wait` = 19 chars
- `relay_send_async` = 16 chars

The longest proposed name is still well under MCP's 64-character limit. The increase from 11–14 chars to 16–19 chars is modest but noticeable in tool lists.

**Advantage of proposal:** `relay_send_*` names group all three send-family tools together alphabetically. Agents might more easily discover they're related.

**Disadvantage:** The names are longer, making logs and tool traces more verbose.

### 5. Verb Semantics in Naming: What Do These Verbs Actually Mean?

**Analysis of proposed verb choices:**

- `send_and_wait` — combines two actions (send + wait), reads like English prose ("send this message and wait for the reply")
  - Pro: Immediately clear to humans reading logs
  - Con: Non-standard verb structure; not used by industry systems
  - Length: High (3 words + conjunction)

- `send_async` — "send asynchronously", implies the operation does not block
  - Pro: Industry-standard term (`async` is ubiquitous in programming)
  - Con: Ambiguous without context. Does `async` mean "does not block" (matching `relay_dispatch`'s behavior) or "does not guarantee delivery" (matching `relay_send`'s behavior)?
  - Length: Medium (2 words)

**Counter-analysis of current names:**

- `query` — implies request/response (bidirectional), universally understood to mean "ask a question and wait for the answer"
  - Pro: Single word, unambiguous in the request/response context
  - Con: Less explicit that the operation blocks; requires reading the description

- `dispatch` — implies "send off to be handled later", understood in async/background task contexts
  - Pro: Single word, well-understood in async programming (e.g., "dispatch event", Redux dispatch)
  - Con: Less explicit that the caller gets back an inbox ID to poll

- `send` — fire-and-forget, basic publish operation
  - Pro: Universally understood; matches industry standard (`Publish`, `Send`)
  - Con: No indication that this is different from `query` and `dispatch`

**Verdict:** Both naming schemes are defensible:

- **Proposal** trades explicitness for clarity (longer names make the semantics unambiguous)
- **Current** trades brevity for established pattern (shorter names rely on context/description to distinguish behavior)

### 6. What Agents See: Tool Search and Approval UX

When Claude uses the relay tools, it encounters them in several contexts:

**Context 1: Large tool list in context window**

- At 10%+ context threshold, Claude performs tool search/ranking on available tools
- Tool names matter for ranking; longer names with descriptive keywords help match agent intent
- Proposal advantage: `relay_send_and_wait` matches "send a message and wait for the reply" intent more directly than `relay_query`

**Context 2: Tool approval UI (in Claude Code)**

- Claude Code displays tool calls for user approval
- Long names are truncated; `relay_send_and_wait` might display as `relay_send_and...` in tight UIs
- Current names display fully in most UIs

**Context 3: Agent reasoning traces**

- When debugging agent behavior, logs and traces include tool names
- Longer names increase log verbosity without adding much value (context is already present)
- Current names keep logs more concise

**Verdict:** Proposal has a slight advantage for agent intent matching (tool search ranking) but a slight disadvantage for UI display and log brevity.

### 7. How Consistent Are the Tools Actually Named?

Current DorkOS relay tools checked against the established pattern:

**From `relay-tools.ts` (current codebase):**

```typescript
tool('relay_send', ...) // domain_verb
tool('relay_inbox', ...) // domain_noun (exception)
tool('relay_list_endpoints', ...) // domain_verb_noun
tool('relay_register_endpoint', ...) // domain_verb_noun
tool('relay_query', ...) // domain_verb
tool('relay_dispatch', ...) // domain_verb
tool('relay_unregister_endpoint', ...) // domain_verb_noun
```

**Pattern analysis:**

- Most tools are `domain_verb` (send, query, dispatch) or `domain_verb_noun` (register_endpoint, unregister_endpoint)
- Exception: `relay_inbox` is `domain_noun`, but this is appropriate as it refers to a resource, not an action
- The three tools being renamed (`relay_send`, `relay_query`, `relay_dispatch`) are the most consistent subset

**Assessment:** The current names are highly consistent. The proposal disrupts this by introducing `relay_send_and_wait` (a compound verb) and `relay_send_async` (adjective modifier) — neither of which appear elsewhere in the DorkOS tool set.

### 8. Agent Confusion: Is There Evidence the Current Names Are Confusing?

The proposal assumes agents might confuse the three tools or fail to understand the response semantics. Evidence from the codebase:

**From `research/20260304_agent-to-agent-reply-patterns.md` (March 4, 2026):**

> "The current DorkOS relay workflow (register inbox → send message → poll inbox in a loop) is fundamentally sound but ergonomically painful... Option B — a `relay_query` blocking MCP tool... is implementable in a single afternoon, requires no new infrastructure... Option C (push via `relay.agent.*`) and Option D (background subagent) are deferred for later."

This research **recommends** implementing `relay_query` (the blocking tool) precisely because agents find polling uncomfortable. The fact that agents need guidance on when to use which tool suggests there IS clarity value in renaming.

**However:**

No GitHub issues or agent logs document agents misusing `relay_query` as if it were fire-and-forget, or misusing `relay_dispatch` as if it were blocking. The problem is more likely **incomplete documentation** than ambiguous names.

**Verdict:** The proposal solves an ergonomic concern (agents need clear guidance on response semantics), but the underlying problem is documentation, not naming. Renaming helps, but better tool descriptions would also help.

### 9. Comparison: Three Naming Approaches

#### Approach A: Status Quo (Current)

- `relay_send` — fire-and-forget
- `relay_query` — synchronous blocking
- `relay_dispatch` — asynchronous, returns inbox

| Aspect                            | Rating    | Notes                                                                       |
| --------------------------------- | --------- | --------------------------------------------------------------------------- |
| **Brevity**                       | Excellent | 11–14 chars, minimal log noise                                              |
| **Pattern consistency**           | Excellent | All three are `domain_verb`                                                 |
| **Self-documentation**            | Good      | `query` signals request/response; `dispatch` signals async; `send` is basic |
| **Discoverability (tool search)** | Moderate  | Generic verbs; agent must read descriptions                                 |
| **Grouped in tool lists**         | Poor      | Alphabetically scattered                                                    |
| **Industry alignment**            | Good      | Matches NATS/Redis verb semantics                                           |
| **Agent training**                | Moderate  | Agents need prompting to understand the semantic difference                 |

#### Approach B: Proposed (Explicit Semantics)

- `relay_send` — fire-and-forget
- `relay_send_and_wait` — synchronous blocking
- `relay_send_async` — asynchronous, returns inbox

| Aspect                            | Rating    | Notes                                                                                 |
| --------------------------------- | --------- | ------------------------------------------------------------------------------------- |
| **Brevity**                       | Moderate  | 16–19 chars, increased log noise                                                      |
| **Pattern consistency**           | Poor      | Departs from `domain_verb` to `domain_verb_conj/adj`                                  |
| **Self-documentation**            | Excellent | Semantics explicit in the name itself                                                 |
| **Discoverability (tool search)** | Excellent | `send_and_wait` matches "wait for response" intent; `send_async` matches async intent |
| **Grouped in tool lists**         | Excellent | All three are `relay_send_*` and sort together                                        |
| **Industry alignment**            | Moderate  | No other system uses this exact pattern                                               |
| **Agent training**                | Excellent | Names are self-explanatory; minimal documentation needed                              |

#### Approach C: Hybrid (Lighter Explicit Semantics)

- `relay_send` — fire-and-forget
- `relay_query_wait` — synchronous blocking
- `relay_dispatch_async` — asynchronous, returns inbox

| Aspect                            | Rating    | Notes                                                                              |
| --------------------------------- | --------- | ---------------------------------------------------------------------------------- |
| **Brevity**                       | Good      | 11–16 chars, moderate log noise                                                    |
| **Pattern consistency**           | Good      | Retains `domain_verb` base with optional `_adjective`                              |
| **Self-documentation**            | Very Good | Adjective modifiers clarify semantics without full rewrite                         |
| **Discoverability (tool search)** | Good      | Easier to match "wait" and "async" in searches                                     |
| **Grouped in tool lists**         | Moderate  | `relay_dispatch_async`, `relay_query_wait`, `relay_send` are scattered but related |
| **Industry alignment**            | Good      | Short adjectives (`_wait`, `_async`) are common in API design                      |
| **Agent training**                | Good      | Adjectives add clarity without major documentation burden                          |

---

## Detailed Analysis

### Linguistic Structure of Tool Names

**Current approach:**

- Verb-based semantics: the verb itself (`query`, `dispatch`, `send`) encodes the behavior
- Requires domain knowledge: agents must learn what `query` means in the relay context
- Precedent: matches NATS (`Request` vs `Publish`), Redis (`BLPOP` vs `LPOP`)

**Proposed approach:**

- Explicit compound semantics: the full phrase describes what happens ("send and wait")
- Self-explanatory: minimal domain knowledge required
- Trade-off: longer names, less concise, breaks established pattern

**Hybrid approach:**

- Adjective modifiers: keep the base verb, add a clarifying adjective
- Balance: slightly longer than current, shorter than proposed, minimal pattern disruption
- Precedent: matches HTTP methods with modifiers (e.g., `_async`, `_sync`), common in SDK design

### Real-World Impact: Logging and Traces

Example logs with current names:

```
Tool call: relay_query(to_subject="relay.agent.backend", ...)
```

Example logs with proposed names:

```
Tool call: relay_send_and_wait(to_subject="relay.agent.backend", ...)
```

The longer name takes more space in logs and tool traces. For a system where agents call these tools frequently, this compounds. The DorkOS dashboard and logs would show longer tool names throughout.

### Real-World Impact: Tool Approval UI

In Claude Code's tool approval UI, tools are displayed with truncation. Current names fit fully; proposed names may truncate. Example:

```
Current: [✓] relay_query
Proposed: [✓] relay_send_and...
```

This is a minor UX issue but worth noting.

---

## Contradiction and Nuance: When Explicit Semantics Matter Most

The proposal is strongest in scenarios where agent behavior is most opaque:

1. **Agent using relay_dispatch for the first time** — Proposed name `relay_send_async` makes the asynchronous nature clear. Current `relay_dispatch` requires reading the description.

2. **Agent reasoning about which tool to use** — Proposed names make the choice obvious: "I need to wait for a response, so `relay_send_and_wait`." Current names require understanding the semantics first.

3. **Log analysis and debugging** — Proposed names make intent explicit in the trace. Current names require knowledge of the semantics.

However, the proposal is weaker in scenarios where pattern consistency matters:

1. **Learning the tool set** — New agents learning DorkOS tools see `relay_send`, `relay_send_and_wait`, `relay_send_async` as a logical family. But they also expect `mesh_list`, `mesh_register`, `pulse_list_schedules` to follow the same pattern — which they do. The relay tools are an exception.

2. **Codebase consistency** — Every other MCP tool in DorkOS follows `domain_verb` or `domain_verb_noun`. Relay tools would be the only ones using `domain_verb_conjunction` or `domain_verb_adjective`.

3. **Brevity** — Longer names accumulate across a large tool set. DorkOS has 30+ MCP tools. If each grows by 5 characters, the cost compounds.

---

## Recommendation

### If the Goal Is Maximum Clarity for Agents

**Use Approach B (Proposed):** `relay_send_and_wait` and `relay_send_async`.

- Pros: Names are self-documenting; agents need minimal prompting to understand the semantics.
- Cons: Breaks the established `domain_verb` pattern; increases log noise; makes tool lists longer.
- Justification: If agent confusion about response semantics is a real, documented problem, explicit names solve it directly.

### If the Goal Is Pattern Consistency and Conciseness

**Use Approach A (Status Quo):** Keep `relay_query` and `relay_dispatch`.

- Pros: Consistent with existing tools; brief; established industry pattern.
- Cons: Agents must read descriptions to understand response semantics; requires documentation.
- Justification: The current names are defensible and follow established patterns. Better documentation (via tool descriptions and context prompts) solves the clarity problem without breaking consistency.

### If the Goal Is a Balanced Middle Ground (Recommended)

**Use Approach C (Hybrid):** `relay_query_wait` and `relay_dispatch_async`.

- Pros: Retains the base verb structure; adds clarity with adjectives; shorter than proposal; minimal pattern disruption.
- Cons: Still requires some documentation.
- Justification: This approach adds semantic clarity without abandoning the established pattern. It's a lighter change that agents can adopt without significant retraining, and it aligns with how other APIs (e.g., `async_call`, `_sync` variants) add semantics to base verbs.

### Final Verdict

**The current names are good and need not be changed.** The proposal is well-motivated but over-corrects. If a change is necessary:

1. First, improve tool descriptions and context prompts to clarify response semantics. This is a lower-risk solution.
2. If agents continue to be confused despite better documentation, then consider a rename using Approach C (hybrid adjectives) rather than Approach B (full rewrite).
3. Approach B (proposed) is viable only if there is documented agent confusion and the decision makers accept the cost of breaking the established naming pattern.

---

## Sources & Evidence

- `research/20260304_mcp_tool_naming_conventions.md` — DorkOS MCP tool naming analysis, pattern consistency assessment (March 4, 2026)
- `research/20260304_agent-to-agent-reply-patterns.md` — relay_query implementation research, Option B (blocking MCP tool) recommendation (March 4, 2026)
- `apps/server/src/services/runtimes/claude-code/mcp-tools/relay-tools.ts` — Current relay tool implementations and names

---

## Research Gaps & Limitations

1. **No empirical data on agent confusion** — The analysis assumes agents might be confused by current names, but there is no log analysis or reported GitHub issues documenting confusion. The recommendation should be tested against real agent behavior.

2. **No user testing with proposed names** — The proposal is plausible but untested. Agents trained on the new names might find them clearer, or they might find the compound syntax awkward.

3. **No analysis of migration cost** — If the rename proceeds, any agents with hardcoded tool references or tool allowlists would need updates. The cost of migration is not quantified.

4. **Limited industry precedent** — No other messaging system uses the exact pattern of `send_and_wait` or `send_async`. The proposal is novel, which is both a strength (novel clarity) and a weakness (no proven precedent).

---

## Search Methodology

- Searches performed: 0 (this analysis leveraged prior research from March 4–21, 2026)
- Primary sources: Prior DorkOS research reports on MCP naming conventions and relay architecture; relay-tools.ts source code; industry tool naming patterns (NATS, RabbitMQ, Redis, Kafka, Google Cloud Pub/Sub)
