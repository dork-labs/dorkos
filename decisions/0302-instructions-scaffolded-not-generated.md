---
number: 302
title: Scaffold agent instruction files, never generate them
status: accepted
created: 2026-06-29
spec: harness-sync
superseded-by: null
---

# 302. Scaffold agent instruction files, never generate them

## Status

Accepted (implemented in spec: harness-sync, `packages/harness/src/scaffold/instructions.ts`)

## Context

`AGENTS.md` is the cross-tool instruction standard (read natively by Codex and Cursor), while Claude Code reads `CLAUDE.md` and supports `@path` imports — this repo already uses the zero-duplication pattern `.claude/CLAUDE.md = @../AGENTS.md`. Content-generating sync tools (rulesync) _inline_ instruction text into each tool's file, which duplicates the content and destroys the `@import`, regressing the recommended setup. The Harness Sync engine must project instructions across harnesses without falling into that trap.

## Decision

We will treat `AGENTS.md` as hand-authored and canonical, and have the projector **scaffold per-harness pointers only** — `CLAUDE.md = @../AGENTS.md`, a Gemini `GEMINI.md` pointer, a Copilot `.github/copilot-instructions.md` pointer — while Codex/Cursor read `AGENTS.md` directly (no-op). The generator **excludes** the `agentsmd`/`claudecode` instruction targets from content generation by default, and **never overwrites a hand-authored instruction file's body**: on divergence it stops and surfaces the conflict for human review. The same scaffolding runs in `createAgentWorkspace`, so every new and templated agent inherits the pattern.

## Consequences

### Positive

- Zero instruction duplication; preserves Anthropic's recommended `@import` setup.
- Every DorkOS repo and every created/templated agent inherits the best-practice instruction layout.
- Instruction content has exactly one source of truth (`AGENTS.md`), so it cannot drift across harnesses.

### Negative

- One more scaffolding responsibility in agent creation.
- The engine must implement conflict detection (stop-on-divergence) rather than blind overwrite.
