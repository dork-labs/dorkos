---
number: 268
title: Portable Skill Twins Defer to Their Slash Command in Claude Code
status: proposed
created: 2026-06-13
spec: null
superseded-by: null
---

# 268. Portable Skill Twins Defer to Their Slash Command in Claude Code

## Status

Proposed

## Context

DorkOS runs a dual-harness model (Claude Code + Codex). Several rich workflows exist as both a Claude slash command (`/spec:execute`, `/debug:test`, `/debug:types`, `/pm`, `/ideate`, `/linear:idea`, `/linear:done`) and a portable shared skill in `.agents/skills/` (`implementing-specifications`, `debugging-test-failures`, `running-product-loop`, etc.), symlinked into `.claude/skills/` per `.agents/skills/syncing-agent-skills/references/sync-harnesses-spec.md`. Because the portable twins are model-invocable in Claude, natural-language phrasing ("execute this spec") can auto-route to the lighter portable skill while the slash command invokes the richer, Claude-specific path — so which experience a user gets depends on phrasing, not intent. The sync spec reserves real wrapper directories for _renames_ and does not contemplate `disable-model-invocation`, so suppressing the twins outright would diverge from the documented projection strategy. A `/system:review` on 2026-06-13 surfaced this as "defect B"; the immediate, spec-aligned fixes (capability-language descriptions, a two-tier README section) shipped, but the path-selection question was deferred to this ADR.

## Decision

We will keep the shared portable skills model-invocable (symlinked, per the spec) and add a short, harness-neutral deferral note to each command-backed portable twin's body: when a richer equivalent command exists in the current harness (e.g. Claude Code's `/X`), prefer it for the full workflow. This preserves cross-tool portability and the spec's symlink strategy while removing the silent quality gap — the twin still serves as a natural-language entry point but actively points to the canonical Claude path. We explicitly reject, for now, converting the twins to `disable-model-invocation` wrapper directories, which would require amending the sync spec's projection strategy and rewriting seven manifest entries for marginal benefit.

## Consequences

### Positive

- Removes the phrasing-dependent quality gap without diverging from `sync-harnesses-spec.md` — symlinks stay symlinks.
- Codex is unaffected: the deferral note is a no-op there (no slash commands), and capability language still describes the workflow.
- Reversible and cheap — a one-line addition per skill body, no structural or manifest change.

### Negative

- The deferral note is harness-aware wording living in a shared skill body; it must be phrased so it reads as a no-op when no such command exists (Codex), not as a hard dependency on Claude slash commands.
- It nudges rather than enforces — Claude can still run the portable twin if the user declines the command, so dual invocation is reduced, not eliminated.
- If natural-language mis-routing later proves materially harmful, the heavier fix (Claude wrapper directories with `disable-model-invocation`, requiring a sync-spec amendment and manifest changes) remains available, and this ADR would then be superseded.
