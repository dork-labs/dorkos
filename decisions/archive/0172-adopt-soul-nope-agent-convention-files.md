---
number: 172
title: Adopt SOUL.md and NOPE.md as Agent Convention Files
status: proposed
created: 2026-03-22
spec: agent-personality-convention-files
superseded-by: null
---

# 172. Adopt SOUL.md and NOPE.md as Agent Convention Files

## Status

Proposed

## Context

DorkOS agents need a personality and safety boundary layer. The ecosystem has multiple convention file standards available:

- **SOUL.md** — Personality and values directives (OpenClaw convention)
- **NOPE.md** — Safety boundaries and hard constraints (emerging standard)
- **AGENTS.md** — Agent metadata (Anthropic SDK convention)
- **IDENTITY.md** — Identity attributes
- **MEMORY.md** — Long-term memory directives

We evaluated which standards to adopt for the DorkOS agent personality system.

## Decision

Adopt **SOUL.md** (personality) and **NOPE.md** (safety boundaries). Do not adopt AGENTS.md, IDENTITY.md, or MEMORY.md.

### Rationale

**SOUL.md adopted because:**

- Portable convention familiar to users from OpenClaw ecosystem
- Designed specifically for agent personality injection
- Complements the trait-slider system

**NOPE.md adopted because:**

- Emerging standard for safety boundaries
- Clear separation of concerns: what the agent should NOT do
- Advisory layer that complements structured permissions

**AGENTS.md rejected because:**

- Claude Code uses CLAUDE.md for agent configuration
- Would duplicate functionality with agent.json
- Not aligned with DorkOS agent manifest conventions

**IDENTITY.md rejected because:**

- Functionality covered by structured fields in agent.json
- Redundant with SOUL.md personality injection

**MEMORY.md rejected because:**

- Claude Code uses .claude/memory/ directory for per-project memory
- Different semantic meaning in DorkOS context

## Consequences

### Positive

- Follows emerging convention standards, increasing portability
- Familiar to users who've encountered OpenClaw ecosystem
- Clear separation: SOUL.md (who you are), NOPE.md (what you won't do)
- Lightweight files requiring no DSL or complex syntax
- Both files are optional; simple fallback behavior if missing

### Negative

- Two more files to manage per agent (alongside agent.json)
- NOPE.md is advisory only—not enforced by system permissions (enforcement comes from allowedTools)
- Users must learn two separate convention file formats
- File-based approach (not schema-validated) requires careful documentation
