---
number: 214
title: AES-256-GCM Encrypted Per-Extension Secret Storage
status: accepted
created: 2026-03-29
spec: linear-issue-status-extension
superseded-by: null
---

# 0214. AES-256-GCM Encrypted Per-Extension Secret Storage

## Status

Accepted

## Context

Extensions need to store API keys and tokens securely. ADR 203 deferred secrets to v2. Options evaluated: OS keychain (VS Code model), encrypted local file (Raycast model), plaintext in data.json (Obsidian pre-1.11 anti-pattern), and environment variables (Directus model). DorkOS is single-user and local — the threat model is preventing accidental exposure (devtools, git commits), not targeted attacks from same-process code.

## Decision

Store secrets in per-extension encrypted files at `{dorkHome}/extension-secrets/{ext-id}.json` using AES-256-GCM. A host key at `{dorkHome}/host.key` (random 32 bytes, mode 0600, generated on first access) provides the encryption entropy. The derived key uses scrypt for key derivation. Secrets are write-only from the browser's perspective (Grafana's secureJsonData pattern): the settings UI accepts input but only displays `••••••••` after save.

## Consequences

### Positive

- Secrets never traverse the browser — only derived data (API responses) crosses to the client
- Per-extension file isolation — extension A cannot read extension B's secrets
- Encrypted at rest — secrets not exposed if `~/.dork/` is accidentally committed or shared
- Write-only settings UI follows Grafana's battle-tested pattern
- No external dependencies (Node.js built-in crypto module)

### Negative

- Not hardware-backed (unlike OS keychain) — if an attacker has filesystem access, they also have `host.key`
- scrypt key derivation adds ~50ms CPU cost on first access (cached for process lifetime)
- File-based storage doesn't support multi-machine sync (acceptable: secrets are machine-local)
