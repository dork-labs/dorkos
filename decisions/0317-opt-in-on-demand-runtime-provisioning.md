---
number: 317
title: Opt-in, on-demand runtime provisioning
status: accepted
created: 2026-07-03
spec: effortless-runtime-switching
superseded-by: null
---

# 0317. Opt-in, on-demand runtime provisioning

## Status

Accepted (auto-extracted from spec: effortless-runtime-switching)

## Context

OpenCode's binary is not vendored by its SDK. Bundling every runtime binary into the base DorkOS install would violate the local-first "lean base install" Non-Goal carried from DOR-180, while requiring `npm i -g opencode-ai` forces a terminal round-trip. The `opencode-ai` npm package declares per-platform `optionalDependencies` with `os`/`cpu` gating, so installing it pulls only the current platform's binary.

## Decision

Add `opencode-ai` as an **opt-in / on-demand** install rather than a bundled dependency: a single in-app action installs it (pulling only the current platform's binary) and reports progress, after which OpenCode resolves **Ready**. Runtime binaries are never bundled into the base install by default. Version-match the `@opencode-ai/sdk` already in use.

## Consequences

### Positive

- The base install stays lean; users pay for only the runtimes they connect.
- One-click, terminal-free provisioning replaces `npm i -g`.
- The installed binary version matches the SDK, avoiding drift.

### Negative

- Introduces an install-at-connect-time step with its own progress/error UX and a network dependency at that moment.
- The install path must handle partial/failed installs and resolve cleanly back to a single Connect action.
