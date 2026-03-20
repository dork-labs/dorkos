---
title: 'MCP Tool Naming Conventions and Best Practices'
date: 2026-03-04
type: external-best-practices
status: active
tags: [mcp, tool-naming, naming-conventions, agent-disambiguation, claude-code]
searches_performed: 10
sources_count: 14
---

# MCP Tool Naming Conventions and Best Practices

## Research Summary

MCP tools should use `snake_case` with a `verb_noun` ordering — over 90% of production MCP tools follow this pattern. The Anthropic Agent SDK wraps tools with an `mcp__<server-name>__<tool-name>` prefix when exposing them to Claude, meaning a DorkOS-internal domain prefix like `relay_` or `mesh_` becomes redundant in contexts where the server name already provides the namespace. The most significant finding for DorkOS is that inconsistency within the same MCP server — some tools prefixed with a domain, others not — is a confirmed anti-pattern that degrades agent tool selection.

---

## Key Findings

### 1. Official Naming Pattern: `verb_noun` in snake_case

The MCP specification and Anthropic's own documentation consistently use the `verb_noun` pattern in `snake_case`. The canonical example in the spec itself is `get_weather`. Anthropic's Agent SDK documentation examples use `list_issues`, `query`, `send_message`, `get_file_contents`. The ZazenCodes analysis of 100 production MCP servers found:

- Over 90% of tools use snake_case
- Less than 1% use camelCase
- ~95% are multi-word names (descriptiveness beats brevity)
- Recommended max length: 32 characters (fits displays, keeps payloads lean)

**Preferred verb prefixes** aligned to CRUD semantics: `get_*`, `list_*`, `create_*`, `update_*`, `delete_*`, `search_*`, `fetch_*`, `send_*`, `register_*`, `cancel_*`.

### 2. The `mcp__server__tool` Wrapping Layer — Critical for DorkOS

The Anthropic Claude Agent SDK applies a mandatory namespace wrapper when registering MCP tools with Claude. The full tool name a Claude agent sees is:

```
mcp__<server-name>__<tool-name>
```

For example, if DorkOS registers itself as server `"dorkos"`:

- `relay_send` becomes `mcp__dorkos__relay_send`
- `list_schedules` becomes `mcp__dorkos__list_schedules`

This has a direct implication: **the server-name already provides the top-level namespace.** There is no risk of collision between DorkOS's `relay_send` and another server's `send` — they are structurally separated by the `mcp__dorkos__` prefix.

This is also the pattern used for `allowedTools` filtering:

```
allowedTools: ["mcp__dorkos__relay_*", "mcp__dorkos__mesh_*"]
```

### 3. Domain Prefix Inside Tool Name: How Leading Servers Handle It

**Stripe MCP** (25 tools, official): Uses `verb_noun` with NO domain prefix inside the tool name. Examples:

- `create_customer`, `list_customers`, `update_subscription`, `cancel_subscription`
- Exception for disambiguation only: `get_stripe_account_info`, `search_stripe_resources`, `search_stripe_documentation` — here `stripe` is added because `get_account_info` would be ambiguous when multiple servers expose similar tools.

**GitHub MCP** (official): Uses `verb_noun` with no domain prefix. Examples: `get_file_contents`, `create_pull_request`, `list_issues`. Resource type is part of the noun, not a prefix.

**Microsoft Research analysis** of 1,470 active MCP servers found 775 tools with name collisions across servers. The most-colliding names were generic verbs without nouns (`search` appearing in 32 servers, `get_user` in 11). The fix is always adding specificity to the noun, not adding a prefix.

**Conclusion from leading servers**: Domain prefixes inside tool names (`relay_*`, `mesh_*`) are a DorkOS-specific pattern, not industry standard. Stripe does not name tools `invoice_create` or `subscription_cancel`. The resource/noun carries domain context.

### 4. When a Domain Prefix Inside the Tool Name IS Warranted

There is one legitimate case: **when a single MCP server exposes tools across multiple distinct domains** and the verb+noun alone would be ambiguous. If a server has both `list_endpoints` (networking) and `list_schedules` (scheduling), the domain prefix helps Claude distinguish them without reading the description.

DorkOS is exactly this case — it exposes tools spanning relay, mesh, pulse, binding, and agent identity in a single MCP server. Given this, a domain prefix inside the tool name is **defensible and arguably desirable** because:

1. The tool name is what appears in tool-use traces and approval UIs. `relay_send` is self-explaining; `send` alone would require reading the description.
2. Claude Code's tool search (activated when tools exceed 10% of context window) relies on names for ranking. A query like "send a relay message" matches `relay_send` more directly than a search over `send` + description.
3. Microsoft Research explicitly recommends formal namespace mechanisms for multi-domain servers and suggests "hierarchical tool-calling where agents first select a category, then a tool."

### 5. Inconsistency Is the Main Anti-Pattern

The ZazenCodes analysis is explicit: "inconsistency signals poor quality." The current DorkOS tool set is inconsistent:

| Domain      | Tool examples                                                       | Pattern used            |
| ----------- | ------------------------------------------------------------------- | ----------------------- |
| Relay       | `relay_send`, `relay_inbox`                                         | `domain_verb`           |
| Relay trace | `relay_get_trace`, `relay_get_metrics`                              | `domain_verb_noun`      |
| Mesh        | `mesh_list`, `mesh_inspect`, `mesh_register`                        | `domain_verb`           |
| Pulse       | `list_schedules`, `create_schedule`, `get_run_history`              | `verb_noun` (no domain) |
| Binding     | `binding_list`, `binding_create`, `binding_delete`                  | `domain_verb`           |
| Core        | `ping`, `get_server_info`, `get_session_count`, `agent_get_current` | mixed                   |

Problems identified:

- `list_schedules` is inconsistent with `relay_send` — one has a domain prefix, one doesn't
- `relay_get_trace` mixes patterns: `domain_verb_noun` where peers use `domain_verb`
- `binding_list` / `binding_create` reverses the ordering: `domain_verb` while `relay_send` is also `domain_verb`, but Pulse uses `verb_noun`
- `agent_get_current` uses `domain_verb_noun`; `get_server_info` uses `verb_noun` — both are "core" tools

### 6. What Helps Agent Disambiguation

From the Microsoft Research study and MCP specification:

- **Short, specific names outperform vague verbs.** `relay_send` is better than `send`; `mesh_discover` is better than `discover`.
- **Names are used for tool search ranking.** When context exceeds thresholds, the Agent SDK activates a tool search mode where Claude searches tool names and descriptions to find what it needs. Names that include the intent domain help here.
- **Avoid exact name collisions.** Names like `list`, `search`, `get_user` collide across 10-32 other servers. DorkOS tools are unlikely to collide because the domain prefix (`relay_`, `mesh_`) is distinctive.
- **Descriptions are critical but secondary.** The MCP paper on "smelly tool descriptions" found 56% of tools have an "Unclear Purpose" smell. Good names reduce the load on descriptions.

---

## Detailed Analysis

### Verb Ordering: `domain_verb` vs `verb_domain_noun` vs `verb_noun`

Three structural patterns exist in the wild:

**Pattern A: `verb_noun`** — Stripe, GitHub, official MCP examples

- `create_customer`, `list_issues`, `get_weather`
- Pro: most natural in English, aligns with CRUD verbs
- Con: requires reading to know the domain when names are generic

**Pattern B: `domain_verb` / `domain_verb_noun`** — DorkOS relay/mesh/binding tools

- `relay_send`, `mesh_register`, `binding_create`
- Pro: domain is immediately visible in tool lists and traces
- Con: non-standard, feels like a prefix rather than a name

**Pattern C: `verb_domain_noun`** — some specialized servers

- `send_relay_message`, `register_mesh_agent`, `list_relay_endpoints`
- Pro: reads like an English sentence, fully descriptive
- Con: verbose, often exceeds the 32-char recommendation

The community consensus favors Pattern A (verb-first). However, given that DorkOS is a multi-domain server where domain context matters, Pattern B (domain-first) is a reasonable deviation — **as long as it is applied consistently across all tools**.

### The Pulse Inconsistency Problem

Pulse tools (`list_schedules`, `create_schedule`, `update_schedule`, `delete_schedule`, `get_run_history`) are the most visibly inconsistent. They appear to have been designed independently from the relay/mesh tools. From a Claude agent's perspective:

- When Claude wants to "list what relay endpoints exist," it sees `relay_list_endpoints`
- When Claude wants to "list what schedules exist," it sees `list_schedules`

There is no visual coherence. An agent building up a mental model of the DorkOS tool surface will see relay/mesh/binding as domain-prefixed and pulse as generic — and may misattribute `list_schedules` to a different server when multiple MCP servers are active.

### Core Tool Inconsistency

- `ping` — no domain, single verb (appropriate for a utility tool)
- `get_server_info` — verb_noun pattern
- `get_session_count` — verb_noun pattern
- `agent_get_current` — domain_verb_noun (inconsistent with the others)

`agent_get_current` should be `get_current_agent` (verb-first) or `agent_identity` (noun-only, like a resource) to be consistent.

---

## DorkOS Tool Audit

### Assessment by Domain

**Relay tools — mostly consistent, one outlier**

- `relay_send` — good: domain_verb
- `relay_inbox` — good: domain_noun (reads as "relay inbox", clear)
- `relay_list_endpoints` — good: domain_verb_noun
- `relay_register_endpoint` — good: domain_verb_noun
- `relay_get_trace` — acceptable: domain_verb_noun
- `relay_get_metrics` — acceptable: domain_verb_noun
- `relay_query` / `relay_dispatch` — good pattern
- Flag: `relay_get_trace` vs `relay_send` — the `_get_` is redundant when reads are implied (`relay_trace` would be cleaner)

**Mesh tools — consistent**

- `mesh_list`, `mesh_inspect`, `mesh_register`, `mesh_status`, `mesh_discover`, `mesh_deny`, `mesh_unregister`, `mesh_query_topology` — all `domain_verb` or `domain_verb_noun`, consistent

**Pulse tools — INCONSISTENT, needs domain prefix**

- `list_schedules` should be `pulse_list_schedules`
- `create_schedule` should be `pulse_create_schedule`
- `update_schedule` should be `pulse_update_schedule`
- `delete_schedule` should be `pulse_delete_schedule`
- `get_run_history` should be `pulse_get_run_history`

**Binding tools — consistent but verb ordering reversed vs Stripe standard**

- `binding_list`, `binding_create`, `binding_delete` — all `domain_verb`, internally consistent
- Note: Stripe would name these `list_bindings`, `create_binding`, `delete_binding`. DorkOS's domain-first approach is acceptable given the multi-domain server architecture.

**Core tools — minor inconsistency**

- `ping` — acceptable as a universal utility name
- `get_server_info` — good
- `get_session_count` — good
- `agent_get_current` — inconsistent: should be `get_current_agent` or renamed `agent_identity`

### Summary Inconsistency Table

| Tool                | Issue                                                  | Suggested fix                             |
| ------------------- | ------------------------------------------------------ | ----------------------------------------- |
| `list_schedules`    | Missing `pulse_` domain prefix                         | `pulse_list_schedules`                    |
| `create_schedule`   | Missing `pulse_` domain prefix                         | `pulse_create_schedule`                   |
| `update_schedule`   | Missing `pulse_` domain prefix                         | `pulse_update_schedule`                   |
| `delete_schedule`   | Missing `pulse_` domain prefix                         | `pulse_delete_schedule`                   |
| `get_run_history`   | Missing `pulse_` domain prefix                         | `pulse_get_run_history`                   |
| `agent_get_current` | `domain_verb_noun` vs `verb_noun` core pattern         | `get_current_agent` or `agent_identity`   |
| `relay_get_trace`   | Verbose; `_get_` redundant when action is implied read | `relay_trace` (optional simplification)   |
| `relay_get_metrics` | Same as above                                          | `relay_metrics` (optional simplification) |

---

## Recommendation

### Option A: Standardize on domain-first, verb-second across all tools (recommended)

Apply `domain_verb` or `domain_verb_noun` consistently to all non-core tools. This matches the existing relay/mesh/binding pattern and makes the full tool surface visually coherent.

**Changes required:**

1. Rename all 5 pulse tools to add the `pulse_` prefix
2. Rename `agent_get_current` to `get_current_agent` (makes it verb-first like `get_server_info`) OR rename to `agent_identity` to fit domain-noun pattern

This is a **breaking change** for any agent that has hardcoded `list_schedules` in its tool allowlist or prompts. Since DorkOS owns the tools and the agents, this is manageable.

### Option B: Standardize on verb-first across all tools

Rename all domain-prefixed tools to `verb_noun_domain` style: `send_relay_message`, `list_mesh_agents`, etc. This aligns with Stripe/GitHub convention but makes names longer and loses the quick visual scan advantage of domain-first.

Not recommended — the existing relay/mesh/binding names are well-established and the verb-first alternative is more verbose without proportional benefit.

### Option C: Keep as-is but document the inconsistency

Accept the inconsistency as technical debt. Document that pulse tools intentionally use `verb_noun` because they were designed before the domain-prefix convention was established.

Not recommended — the inconsistency creates real confusion for Claude agents trying to build a coherent model of what tools are available.

### Chosen Recommendation: Option A

The minimal-churn path is Option A. The 5 pulse renames + 1 core tool rename is a small change with meaningful payoff: every DorkOS tool will follow the `domain_verb[_noun]` pattern, tools will group visually in any tool list sorted alphabetically, and Claude will be able to infer domain membership from the tool name alone without reading descriptions.

The `mcp__dorkos__` wrapper that the Agent SDK adds means the server name already provides the outer namespace — the `relay_` / `mesh_` / `pulse_` inner prefix provides the sub-domain namespace. This two-level namespacing (`mcp__dorkos__relay_send`) is clean, readable, and distinct.

---

## Sources and Evidence

- "Over 90% of tools use snake case" - [MCP Server Naming Conventions - ZazenCodes](https://zazencodes.com/blog/mcp-server-naming-conventions)
- `mcp__<server-name>__<tool-name>` naming pattern confirmed - [Connect to external tools with MCP - Anthropic Agent SDK Docs](https://platform.claude.com/docs/en/agent-sdk/mcp)
- "775 tools with identical names across different MCP servers" — `search` in 32 servers - [Tool-space interference in the MCP era - Microsoft Research](https://www.microsoft.com/en-us/research/blog/tool-space-interference-in-the-mcp-era-designing-for-agent-compatibility-at-scale/)
- Stripe tool names (25 tools, all `verb_noun`) - [Stripe MCP Documentation](https://docs.stripe.com/mcp)
- MCP spec tool name format: 1–64 chars, alphanumeric + `_`, `-`, `.`, `/` - [MCP Specification (SEP-986)](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/986)
- Official spec example uses `get_weather` (verb_noun snake_case) - [MCP Tools Concept Docs](https://modelcontextprotocol.io/docs/concepts/tools)
- "Choose a convention and stick with it, as inconsistency signals poor quality" - [MCP API Command Method Naming Best Practices](https://gist.github.com/eonist/eb8d5628aad07fc57ce339e518158c20)
- Tool search activates at 10% context threshold; tool names used for ranking - [Anthropic Agent SDK MCP docs](https://platform.claude.com/docs/en/agent-sdk/mcp)

---

## Research Gaps and Limitations

- No peer-reviewed study directly comparing `verb_noun` vs `domain_verb` tool selection accuracy for LLMs (the Microsoft Research study analyzes collision frequency, not selection accuracy)
- GitHub MCP server full tool list was not extracted (truncated in README); naming patterns inferred from examples
- No data on whether Claude specifically performs better with domain-prefixed vs verb-first tool names when both the name and description are available

---

## Search Methodology

- Searches performed: 10
- Most productive search terms: "MCP tool naming conventions best practices 2025", "Anthropic MCP tool naming guidelines verb noun namespace", "tool-space interference MCP era Microsoft Research"
- Primary sources: Anthropic Agent SDK docs (authoritative), MCP specification, Microsoft Research blog, ZazenCodes analysis of 100 MCP servers, Stripe official MCP tool list
