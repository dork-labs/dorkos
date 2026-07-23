---
id: 260723-013236
title: Sensitive config keys are redacted from every agent-facing tool result
status: accepted
created: 2026-07-23
spec: agents-as-operators
superseded-by: null
---

# 260723-013236. Sensitive config keys are redacted from every agent-facing tool result

## Status

Accepted

## Context

The first cut of `config_get` returned `configManager.getAll()` verbatim. Because `config_get` sits in the tokenless read-only carve-out of the external `/mcp` surface, an unauthenticated local caller could read `mcp.apiKey` (which unlocks the entire mutating MCP surface), `cloud.instanceToken`, and `tunnel.authtoken`. Independently, `config_patch`'s success echo piped the same raw secrets into the model's context and the persisted transcript on every patch. The pre-existing `GET /api/config` route already hand-built a redacted DTO; the tool path bypassed it.

## Decision

We will never return a raw config snapshot through an agent-facing tool. `sanitizedConfigSnapshot()` deep-clones the store and strips every dot-path in the canonical `SENSITIVE_CONFIG_KEYS` constant (iterated from the exported list, never hand-copied, so new sensitive keys redact automatically); both `config_get` and `config_patch`'s success echo use it on both MCP servers. Redaction at the content level was chosen over de-listing `config_get` from the read-only carve-out because token-holders and the model context should not see raw secrets either. Tests seed real sensitive values and assert their absence from both payloads.

## Consequences

### Positive

- The tokenless carve-out stays useful (agents can read config) without becoming a privilege-escalation path.
- Secrets never enter model context or transcripts via config tools, and the invariant is drift-proof against new sensitive keys.

### Negative

- Agents cannot read secret values even when legitimately asked to debug them; the user must use the cockpit's explicit reveal flows.
- The authenticated HTTP `PATCH /api/config` still echoes the raw config to the cockpit (pre-existing behavior, out of scope here); the asymmetry must be remembered when touching that route.
