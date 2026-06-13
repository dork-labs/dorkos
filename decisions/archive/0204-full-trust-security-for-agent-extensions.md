---
number: 204
title: Full-Trust Security Model for Agent-Written Extensions
status: draft
created: 2026-03-26
spec: ext-platform-04-agent-extensions
superseded-by: null
---

# 0204. Full-Trust Security Model for Agent-Written Extensions

## Status

Draft (auto-extracted from spec: ext-platform-04-agent-extensions)

## Context

Phase 4 enables AI agents to write TypeScript extensions that run in the DorkOS host process. This creates a security question: should agent-written code be sandboxed, require user confirmation, or run with full trust?

Research evaluated four industry models: Obsidian (full trust), VS Code (Extension Host process isolation), Figma (Realms-based sandbox with 100-300ms overhead), and Grafana (proxy-membrane sandbox, public preview). The v1 audience is developers (Kai persona) running their own agents on their own machines — the same trust model as running `npm install` or executing code from a git clone.

## Decision

Use the Obsidian-style full-trust model. Agent-written extensions run in the browser context with no sandbox, no confirmation prompt, and no capability restrictions. Extensions have the same privileges as any other Phase 3 extension.

## Consequences

### Positive

- Zero rendering overhead — no sandbox message-passing latency (Figma's approach adds 100-300ms per render cycle)
- Simpler implementation — no Extension Host process, no IPC protocol, no capability system
- Faster agent iteration — no confirmation dialogs interrupting the write → compile → reload loop
- Consistent with Phase 3 — agent-created extensions behave identically to manually-created ones

### Negative

- A compromised or malicious agent could write extensions that exfiltrate data or modify the host application
- No isolation between extensions — one bad extension can crash others
- If DorkOS later adds a marketplace for sharing extensions, a sandbox will need to be retrofitted
- Users must trust their agent tooling (Claude Code, Cursor, etc.) as much as they trust their own code
