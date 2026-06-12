---
number: 216
title: Plaintext Settings Alongside Encrypted Secrets
status: accepted
created: 2026-03-29
spec: extension-manifest-settings
superseded-by: null
---

# 0216. Plaintext Settings Alongside Encrypted Secrets

## Status

Accepted

## Context

The DorkOS extension system already provides encrypted per-extension secret storage (AES-256-GCM) for API keys and credentials. Extensions also need non-sensitive configuration — refresh intervals, display toggles, filter selections, label prefixes. Storing non-sensitive config in the same encrypted store would add unnecessary complexity and make values unreadable for debugging. Storing everything unencrypted would expose credentials.

## Decision

Non-secret extension configuration (`settings`) is stored as plaintext JSON at `{dorkHome}/extension-settings/{extensionId}.json`, completely separate from the encrypted secret store at `{dorkHome}/extension-secrets/{extensionId}.json`. The manifest schema enforces the boundary: `secrets` array for credentials (encrypted, write-only UI), `settings` array for configuration (plaintext, readable UI). This follows Grafana's `jsonData`/`secureJsonData` separation principle.

## Consequences

### Positive

- Extension authors have a clear mental model: secrets = credentials, settings = config
- Settings values are human-readable on disk for debugging
- No encryption overhead for non-sensitive data
- Settings can be displayed in the UI (current values shown), unlike secrets (write-only)

### Negative

- Extension authors must correctly categorize each field — putting a password in `settings` would store it in plaintext
- Two separate storage systems to maintain (though both are simple JSON files)
- If an extension mixes secret and non-secret fields in the same `group`, the UI must handle both storage backends transparently
