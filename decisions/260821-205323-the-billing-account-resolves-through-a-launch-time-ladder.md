---
id: 260821-205323
title: The billing account resolves through a launch-time ladder; disk stays per-session truth
status: proposed
created: 2026-08-21
spec: billing-account-ladder
superseded-by: null
---

# 260821-205323. The billing account resolves through a launch-time ladder; disk stays per-session truth

## Status

Proposed (implemented by spec billing-account-ladder, shipped 2026-08-22 in PRs #1166/#1183/#1185)

## Context

The Claude Code billing account (the `CLAUDE_CONFIG_DIR` a session's SDK
subprocess points at) was global-only: `runtimes.claudeCode.activeAccount`
governed every new session, and the status-bar account picker silently mutated
that global value. Operators could not pin an agent to an account or pick one
for a single session. Meanwhile, ADR 260801-204127 established that a session's
account is derived from its transcript's on-disk root and never stored.

## Decision

Resolve the launch account through a ladder evaluated once, at the
session-creating first message: session launch hint (`account` id on the first
`POST /messages`, mirroring the `runtime` hint) → agent manifest `account` id →
`runtimes.claudeCode.defaultAccount` (renamed from `activeAccount`) →
`$CLAUDE_CONFIG_DIR` / `~/.claude`. The result terminates in the spawn env; no
new per-session storage is introduced. After launch, the account remains
derived from disk (ADR 260801-204127 unchanged), making it immutable the same
way the runtime binding is (ADR-0255) — enforced by the filesystem instead of a
DB column. An unresolvable tier falls through with a warning; a launch never
fails on a bad account reference. The pre-launch picker becomes session-scoped;
the global default changes only in Settings.

## Consequences

- One mental model for runtime, model, and billing account.
- No drift risk: the ladder writes nothing; disk stays the single source of
  per-session truth, so resume/retry paths are untouched.
- The named-by-absence rule (ADR 260801-204128) must hold for every tier's
  result, not just the default's.
- The old behavior — the status-bar picker repointing global billing — is
  deliberately removed.
