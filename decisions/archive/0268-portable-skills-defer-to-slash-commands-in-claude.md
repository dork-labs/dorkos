---
number: 268
title: Portable Skill Twins Defer to Their Slash Command in Claude Code
status: rejected
created: 2026-06-13
spec: null
superseded-by: null
---

# 268. Portable Skill Twins Defer to Their Slash Command in Claude Code

## Status

Rejected (2026-06-13)

The two real defects this ADR set out to address were already fixed by the shipped `/system:review` changes (capability-language descriptions + the "Two-tier commands & portable skills" README section). The remaining deferral-note proposal was judged unnecessary and a portability regression. See Decision.

## Context

DorkOS runs a dual-harness model (Claude Code + Codex). Several rich workflows exist as both a Claude slash command (`/spec:execute`, `/debug:test`, `/debug:types`, `/pm`, `/ideate`, `/linear:idea`, `/linear:done`) and a portable shared skill in `.agents/skills/` (`implementing-specifications`, `debugging-test-failures`, `running-product-loop`, etc.), symlinked into `.claude/skills/` per `.agents/skills/syncing-agent-skills/references/sync-harnesses-spec.md`. Because the portable twins are model-invocable in Claude, natural-language phrasing ("execute this spec") can auto-route to the lighter portable skill while the slash command invokes the richer, Claude-specific path — so which experience a user gets depends on phrasing, not intent. The sync spec reserves real wrapper directories for _renames_ and does not contemplate `disable-model-invocation`, so suppressing the twins outright would diverge from the documented projection strategy. A `/system:review` on 2026-06-13 surfaced this as "defect B"; the immediate, spec-aligned fixes (capability-language descriptions, a two-tier README section) shipped, but the path-selection question was deferred to this ADR.

## Decision

~~Keep the shared portable skills model-invocable (symlinked, per the spec) and add a short, harness-neutral deferral note to each command-backed portable twin's body, steering users to the richer slash command when one exists.~~

**Rejected.** No code change is warranted; the documentation and description fixes already shipped are the resolution. Reasons:

1. **The residual behavior is sound by design, not a defect.** Lightweight model-invoked skills are a reasonable default for natural-language requests; the heavyweight slash commands are deliberately explicit. `executing-specs` is already `disable-model-invocation: true` _specifically so_ parallel orchestration never auto-fires from vague phrasing — nudging users toward that heavy path works against that existing guard.
2. **It regresses portability.** Deferral notes re-introduce harness-command coupling into the vendor-neutral shared skills — the exact coupling just removed from their descriptions to satisfy the sync spec's portability rule.
3. **Less, but better.** The cheapest correct fix (documentation) already shipped; seven maintained nudge-only notes do not justify their existence.

If natural-language mis-routing is later shown to cause real harm for the genuinely heavier pairs (`/spec:execute`, `/pm`), a narrowly-scoped nudge on just those two can be reconsidered in a new ADR.

## Consequences

_These describe the consequences of the decision to reject._

### Positive

- The shared portable skills stay vendor-neutral — no harness-command coupling is re-introduced after just removing it from their descriptions.
- No new per-skill content to maintain; the two-tier design stays documented (README) rather than enforced in seven skill bodies.
- Honors the existing `disable-model-invocation` guard that deliberately keeps heavyweight orchestration off the auto-invoke path.

### Negative

- The lighter portable twin can still be auto-selected by natural-language phrasing in Claude; a user who wants the richer slash command must know to invoke it (mitigated by the "Two-tier commands & portable skills" README section).
- If mis-routing later proves materially harmful for the genuinely heavier pairs (`/spec:execute`, `/pm`), a narrowly-scoped nudge would require a new ADR rather than building on this one.
