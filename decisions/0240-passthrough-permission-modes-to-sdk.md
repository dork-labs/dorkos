---
number: 240
title: Passthrough Permission Modes to SDK Without Allowlist
status: proposed
created: 2026-04-10
spec: permission-mode-management
superseded-by: null
---

# 240. Passthrough Permission Modes to SDK Without Allowlist

## Status

Proposed

## Context

The `message-sender.ts` had a hardcoded 3-value allowlist that silently fell back to `default` for any permission mode not in `['bypassPermissions', 'plan', 'acceptEdits']`. This meant that adding new modes to the schema (e.g., `dontAsk`, `auto`) would be silently dropped at query time. The Zod schema already validates all values at the API boundary, making the redundant allowlist a maintenance bottleneck.

## Decision

Replace the `message-sender.ts` permission mode allowlist with a direct passthrough: `sdkOptions.permissionMode = session.permissionMode`. Trust the upstream Zod schema validation to ensure only valid `PermissionMode` values reach the message sender. Retain the special-case handling for `bypassPermissions` (which requires `allowDangerouslySkipPermissions: true`).

## Consequences

### Positive

- New permission modes added to `PermissionModeSchema` automatically flow through to the SDK without code changes in the message sender
- Eliminates a class of silent bugs where valid modes are silently downgraded to `default`
- Reduces maintenance burden — one source of truth (the Zod schema) instead of two (schema + allowlist)

### Negative

- Relies on upstream validation being correct — if an invalid value bypasses schema validation, it reaches the SDK directly
- The `bypassPermissions` special case still requires per-mode handling (cannot be fully generic)
