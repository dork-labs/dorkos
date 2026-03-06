---
number: 89
title: Confine SDK Imports to Runtime Implementation via Lint Rule
status: proposed
created: 2026-03-06
spec: eslint-per-package-config
superseded-by: null
---

# 89. Confine SDK Imports to Runtime Implementation via Lint Rule

## Status

Proposed

## Context

ADR-0085 establishes the `AgentRuntime` interface as the universal abstraction for agent backends, with `ClaudeCodeRuntime` encapsulating all Claude Agent SDK interactions inside `services/runtimes/claude-code/`. However, there is no automated enforcement preventing SDK imports from leaking outside this boundary. Developers (human or AI) could accidentally import `@anthropic-ai/claude-agent-sdk` directly in routes, services, or other packages, silently coupling them to a specific runtime implementation. The `sdk-utils.ts` file in `lib/` is the sole remaining SDK import outside the boundary.

## Decision

Add a `no-restricted-imports` error-level lint rule in `apps/server/eslint.config.js` that bans `@anthropic-ai/claude-agent-sdk` and `@anthropic-ai/claude-agent-sdk/*` imports in all server source files except `services/runtimes/claude-code/**` and test files (`**/__tests__/**`). Move `sdk-utils.ts` from `lib/` into `runtimes/claude-code/` so the confinement rule has zero carve-outs. The SDK ban and existing `os.homedir()` ban are combined into a single `no-restricted-imports` config object to avoid the flat config overwrite problem.

## Consequences

### Positive

- Automated enforcement of the AgentRuntime boundary — violations caught at lint time, not code review
- Zero carve-outs needed after moving `sdk-utils.ts`
- Supports future multi-runtime scenarios (adding OpenCode, Aider, etc.) by ensuring no hidden SDK coupling
- Error-level severity prevents accidental merges of violations

### Negative

- Test files are exempt (they mock SDK types) — violations in tests won't be caught
- The `packages/cli/scripts/build.ts` references the SDK package name in esbuild externals — this is a string reference in build config, not a runtime import, so it's unaffected
