---
number: 316
title: SDK-vendored binary resolution across runtime adapters
status: draft
created: 2026-07-03
spec: effortless-runtime-switching
superseded-by: null
---

# 0316. SDK-vendored binary resolution across runtime adapters

## Status

Draft (auto-extracted from spec: effortless-runtime-switching)

## Context

Codex's executable is vendored by `@openai/codex-sdk` as a per-platform optional dependency (present under `node_modules/.pnpm/@openai+codex@.../vendor/<triple>/bin/codex`), exactly as `@anthropic-ai/claude-agent-sdk` bundles Claude Code. But the Codex `checkDependencies` probe only inspects `PATH`, so it falsely reports "needs setup" for a binary that is physically present. Claude already resolves its vendored path via `resolveClaudeCliPath`.

## Decision

Resolve the SDK-vendored binary path (mirroring `resolveClaudeCliPath`) before falling back to `PATH`, and factor a shared resolver with a single precedence: **SDK-vendored path, else a configured `binaryPath`, else `PATH`**. Every adapter (Codex now, future runtimes later) uses it. Each candidate is existence-checked so a changed vendor layout degrades to the next source rather than crashing.

## Consequences

### Positive

- Codex reports **Ready** out of the box; the false "needs setup" bug is gone.
- One uniform resolution rule for all runtimes makes runtime #4 inherit correct behavior for free.
- Removes a whole class of "binary present but not on PATH" false negatives.

### Negative

- Couples resolution to the SDK's vendor directory layout; mitigated by existence checks and the ordered fallback.
