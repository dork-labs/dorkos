---
id: 260923-223910
title: Destructive actions ask unless allowed one by one, and three floor areas are never Allowed
status: accepted
created: 2026-09-23
spec: agent-permissions
superseded-by: null
---

# 260923-223910. Destructive actions ask unless allowed one by one, and three floor areas are never Allowed

## Status

Accepted (extracted from spec: agent-permissions).

## Context

The operator asked for far more agent autonomy by default, with one exception: an agent must not be able to "nuke our entire system with a single mistake". Today "destructive means a person says yes first" holds on every setting (`capability-definition.ts`). An area set to Allowed, by a preset or a person, would otherwise quietly extend to every delete in it, and nothing stopped an agent from being allowed to change its own permissions, its safety limits, or what the machine exposes.

## Decision

We will apply two rules in the resolver, after precedence. **The destructive rule:** a `destructive` action whose Allowed comes from an area-level setting (preset, area default, or an agent's area override) reads as Ask; only an explicit action-level Allowed, from Always allow or a person setting that one action, lets it run without asking. **The floor:** Safety limits, Permissions and Reach & secrets can be Blocked or Ask, never Allowed, at every layer. The write paths refuse a floor Allowed (400 `FLOOR_NEVER_ALLOWED`), the resolver clamps a stored one to Ask as a second line, and Always allow is never offered for a floor action. `operator.config_patch` escalates by input into the floor area of any operator-only path it touches.

## Consequences

### Positive

- Today's destructive guarantee holds on every preset, expressed as one rule instead of a per-area list of exceptions.
- An agent's route to changing permissions, safety limits or reach is always a person's yes.
- Full power can be generous everywhere else without a single mistake being catastrophic.

### Negative

- Floor actions always raise a card, even for a person who would prefer otherwise.
- The rules are applied after precedence, so a "why?" line must explain a clamp as well as a source.
