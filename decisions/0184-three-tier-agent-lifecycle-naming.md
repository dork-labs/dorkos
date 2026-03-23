---
number: 184
title: Three-Tier Agent Lifecycle Naming (Create > Init > Register)
status: draft
created: 2026-03-23
spec: agent-creation-and-templates
superseded-by: null
---

# 0184. Three-Tier Agent Lifecycle Naming (Create > Init > Register)

## Status

Draft (auto-extracted from spec: agent-creation-and-templates)

## Context

The codebase has overlapping names for different agent operations. The current `transport.createAgent()` only writes config to an existing directory (like `git init`), but the name implies full creation. A new full-pipeline operation needs to coexist alongside the existing init behavior. Clear naming prevents confusion as the agent lifecycle grows more complex.

## Decision

Establish a 3-tier naming convention: **create** (full pipeline: mkdir + scaffold + template + register), **init** (write config to existing directory, like `git init`), **register** (add to mesh DB cache). The existing `createAgent()` is renamed to `initAgent()`. The new `createAgent()` wraps the full pipeline. The hierarchy is: create calls init, which may call register.

## Consequences

### Positive

- Clear semantic meaning for each operation — developers instantly understand the scope
- Follows established developer conventions (`git init`, `npm init`)
- Enables the full creation pipeline without ambiguity about what "create" means

### Negative

- Breaking rename: all callers of `transport.createAgent()` must update to `initAgent()`
- Three tiers to maintain instead of two — slightly more API surface
