---
id: 261006-235242
title: Everything is a plugin; the marketplace has one package type that lists what it contains
status: accepted
created: 2026-10-06
spec: null
superseded-by: null
supersedes: 260721-221810
amends: 0230
---

# 261006-235242. Everything is a plugin; the marketplace has one package type that lists what it contains

## Status

Accepted (operator decision, 2026-10-06; Linear DOR-2735). Direction: one package type is after-launch work; the five types still ship today.

**Supersedes** [260721-221810](260721-221810-shape-is-fifth-package-type-composition-manifest-affinity-not-ownership.md) whole: there is no fifth type, and "Shapes" are now **mini apps**, one kind of thing a plugin can contain.

**Amends** [0230](0230-marketplace-package-type-agent-naming.md) (stays Accepted): retires `agent` as a separate registry type value. "Agents" stays as a filter label, now meaning "plugins that contain an agent".

## Context

The marketplace has five package types: `agent`, `plugin`, `skill-pack`, `adapter` and `shape`. Real packages blur them: an agent ships skills, a plugin ships an agent, a shape activates all of them. Authors pick a type that half fits, and people browsing have to guess which type holds what they want.

## Decision

We will ship **one package type, the plugin**. A plugin lists what it contains (skills, agents, mini apps, connections, hooks, CLI commands, schedules and the rest), and browsing filters by contents, not by type. **Mini apps**, apps that live inside DorkOS in the side panel or on their own web address, replace the names "shapes" and "generative UI"; building one is a core skill every agent has. Consent and isolation for third-party code stay per content kind (hooks and extensions still need a yes, per [261006-225605](261006-225605-agents-are-trusted-by-default-outsiders-and-third-party-code-are-not.md)).

## Consequences

### Positive

- Authors describe what they built instead of choosing a category.
- One install path, one update path and one validator.
- People find packages by what they do.

### Negative

- Existing packages, manifests and the `type` field need a migration, and the marketplace repo moves with it.
- A single type with many content kinds needs a clear preview of everything a plugin will add before it installs.
