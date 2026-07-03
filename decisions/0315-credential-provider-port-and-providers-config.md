---
number: 315
title: CredentialProvider port and providers config block
status: accepted
created: 2026-07-03
spec: effortless-runtime-switching
superseded-by: null
---

# 0315. CredentialProvider port and providers config block

## Status

Accepted (implemented in spec: effortless-runtime-switching)

## Context

Connecting Codex and OpenCode to model providers requires credentials, but storing provider keys as plaintext in the human-edited `~/.dork/config.json` is unsafe and leaks secrets into backups and version control. The agent-auth research (`research/20260625_agent_auth_patterns_meta_harnesses.md`) proposes a narrow `CredentialProvider` port plus a `providers` config block and a reference scheme reusable near the runtime env-injection seam.

## Decision

Introduce a narrow `CredentialProvider` port that resolves a credential _reference_ to a secret at the runtime env-injection point (near the Claude env injection in `message-sender.ts`). Add a top-level `providers` config block whose values are references using a `keychain:` / `env:` / `file:` scheme, never inline plaintext. The schema change ships with a semver-keyed `conf` migration.

## Consequences

### Positive

- Secrets stay out of human-edited config; only references are persisted.
- One reusable, testable seam serves every runtime (present and future) and both cloud keys and local no-auth paths.
- Reference indirection lets the same config point at an OS keychain, an env var, or a file without schema churn.

### Negative

- A new port plus a config migration to maintain and keep backward-compatible.
- Reference indirection adds a resolution step and a new failure mode (a dangling reference) that the Connect UX must surface honestly.
