---
id: 260723-013234
title: Status-bar preferences live in server config, not client localStorage
status: accepted
created: 2026-07-23
spec: agents-as-operators
superseded-by: null
---

# 260723-013234. Status-bar preferences live in server config, not client localStorage

## Status

Accepted

## Context

Status-bar visibility booleans lived only in client Zustand persisted to `localStorage`, making them invisible to agents, other devices, and the server. The agents-as-operators program requires every user-reachable setting to be reachable programmatically; settings trapped in a single browser's storage cannot be.

## Decision

We will store status-bar preferences in the Zod-validated server config (`ui.statusBar`, ten booleans defaulting to the old client defaults) with a semver-keyed conf migration, read via TanStack Query on the `['config']` key and written via `PATCH /api/config`. A one-time client migration lifts legacy `localStorage` values (removing keys only after a confirmed PATCH). This sets the precedent: client UI preferences that a user could reasonably ask an agent (or a second device) to change belong in server config, not browser storage.

## Consequences

### Positive

- Agents toggle status-bar items through the existing `config_patch` tool with zero additional server work; settings sync across devices for free.
- The optimistic single-key PATCH composes safely under concurrent toggles because the section holds no arrays (deep-merge is key-wise).

### Negative

- Reads now depend on the server being reachable; embedded/degraded paths must fall back to schema defaults.
- Each future pref promoted out of `localStorage` needs its own migration and query wiring; the pattern is more ceremony than a Zustand boolean.
