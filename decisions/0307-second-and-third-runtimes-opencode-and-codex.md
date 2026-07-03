---
number: 307
title: 'Second and Third Agent Runtimes: OpenCode and Codex'
status: accepted
created: 2026-07-02
spec: additional-agent-runtimes
superseded-by: null
---

# 307. Second and Third Agent Runtimes: OpenCode and Codex

## Status

Accepted (implemented in spec: additional-agent-runtimes)

## Context

DorkOS has one production agent runtime (Claude Code) behind the `AgentRuntime` interface (ADR-0086 registry, ADR-0255 per-session persistence). The product thesis — coordination layer for autonomous agents, not a Claude wrapper — requires real multi-runtime support. The brief (DOR-180) mandates two new runtimes, at least one supporting open-source models. Candidate analysis (research 20260405 x2, re-verified July 2026): OpenCode (MIT, `@opencode-ai/sdk`, headless REST+SSE server, 75+ providers incl. Ollama, ~178K stars), Codex (`@openai/codex-sdk`, Apache-2.0, official OpenAI SDK, thread persistence, no local models), Pi (`@earendil-works/pi-agent-core`, MIT core post-Earendil-acquisition, embedded in-process), Cline (Apache-2.0, CLI newly GA), Gemini CLI (discontinued June 2026; closed-source successor).

## Decision

Add **OpenCode** and **Codex** as the second and third runtimes. OpenCode satisfies the open-source-model constraint with the strongest SDK, community, and architecture fit; Codex covers the OpenAI ecosystem, making DorkOS the control panel for the three most-used coding agents. **Pi is deferred, not rejected** — it is the leading candidate for a future embedded/native runtime (e.g. powering DorkBot). A generic ACP adapter is likewise deferred until two concrete adapters reveal what the abstraction must cover.

## Consequences

### Positive

- Both picks have official TypeScript SDKs — adapters stay thin and supported.
- Full coverage: open-source/local models (OpenCode) + the two largest proprietary ecosystems (Claude, OpenAI).
- Deferring Pi/ACP avoids premature abstraction while keeping the path open.

### Negative

- Codex contributes nothing to the local-model story (accepted; OpenCode covers it).
- OpenCode's session store recently migrated to SQLite with open reliability issues (growth #22110, NFS corruption #14970) — mitigated by integrating via its server/SDK rather than its DB files.
- Two new external dependencies to track for breaking changes (Codex SDK releases near-continuously).
