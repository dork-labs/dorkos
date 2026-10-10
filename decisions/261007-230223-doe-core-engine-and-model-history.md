---
id: 261007-230223
title: Doe uses Pi core behind an engine port and owns its complete model history
status: accepted
created: 2026-10-07
spec: doe-engine
superseded-by: null
---

# 261007-230223. Doe uses Pi core behind an engine port and owns its complete model history

## Status

Accepted, implemented by [doe-engine](../specs/doe-engine/02-specification.md).

## Context

DorkOS needs an in-process business agent with a prompt and tool set it owns. Its display event log is bounded and omits model-specific reasoning data, so it cannot restore the model's complete context. Pi's full product can replace its coding defaults, but also owns settings, authentication, extension lifecycle and session projection. Using those alongside DorkOS and a separate durable model store would duplicate state.

## Decision

We will build Doe on pinned Pi core libraries behind an internal engine port, with an owned business prompt and a separate coding builder. Doe will keep complete model messages in an append-only SQLite store and persist compaction as context checkpoints without deleting original messages. We will reuse standalone permissive libraries and lift independent Pi utilities with attribution where the full-product dependency would introduce unrelated lifecycle or state. The DorkOS host will supply credentials, context, permissions and tools through public package APIs.

## Consequences

### Positive

- Business conversations acquire no coding persona or vendor credential defaults.
- Opaque reasoning fields survive restarts and compaction; display history remains independent.
- Replacing the model/loop implementation stays inside one module.
- The package can run outside DorkOS without product imports.

### Negative

- Doe must maintain its own persistence, compaction and host resource-loading code.
- Lifted utilities need licence notices and deliberate upstream update reviews.
- Full-product extensions cannot run directly without an additional lifecycle bridge.
