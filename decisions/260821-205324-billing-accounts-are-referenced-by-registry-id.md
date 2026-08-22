---
id: 260821-205324
title: Billing accounts are referenced by registry id, never by path
status: proposed
created: 2026-08-21
spec: billing-account-ladder
superseded-by: null
---

# 260821-205324. Billing accounts are referenced by registry id, never by path

## Status

Proposed (implemented by spec billing-account-ladder, shipped 2026-08-22 in PRs #1166/#1183/#1185)

## Context

Per-agent and per-session billing overrides need a way to name an account. The
registry (`runtimes.claudeCode.accounts[]`) held only `{ path, label }` —
labels are optional and mutable, and absolute paths are machine-local: a path
stored in an agent's `agent.json` would silently break every referencing agent
when a config directory moves or is renamed.

## Decision

Registry entries gain a stable kebab-case `id` (backfilled by config migration
from label or path basename, uniquified). Agent manifests and session launch
hints reference accounts by id only; the server resolves id → path at launch.
A missing or unregistered id degrades to the next ladder tier with a visible
warning (amber "no longer registered" chip in the UI — the same
graceful-breakage pattern as a "no longer offered" model), never a failed
launch. The one exception: `defaultAccount` itself stays a **path**, because a
default may legitimately name an unregistered root (ADR 260801-204126's
"choosing adds it to the read set" semantics), and the rename from
`activeAccount` stays a pure key migration. The agent manifest's `account`
field is operator-only at the API boundary — an agent cannot repoint its own
billing.

## Consequences

- Paths live in exactly one operator-controlled place (the registry).
- Renames and moves are safe: fix the registry entry, every reference follows.
- Wire rows describing unregistered roots carry `id: null` and are
  display-only.
- One registry lookup at launch; no other cost.
