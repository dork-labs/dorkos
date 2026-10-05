---
id: 261005-105213
title: One protocol table, exhaustive by type, carries every ctx member into the real ctx in the host
status: accepted
created: 2026-10-05
spec: isolated-extension-backends
superseded-by: null
amends: null
---

# 261005-105213. One protocol table, exhaustive by type, carries every ctx member into the real ctx in the host

## Status

Accepted

## Context

`DataProviderContext` mixes async calls, fire-and-forget emits, listener registrations, host-called callbacks that return values (the account advisor, `inbox.onAction`, DOR-2685 tool handlers), constants and Express middleware, and it keeps growing. A member that silently failed to cross the boundary would ship broken, and a second implementation of ctx in the child would drift from the in-process one.

## Decision

The host builds the extension's real ctx with `createDataProviderContext`, exactly as in-process, and dispatches every child message into it. `CTX_PROTOCOL` declares each member's kind (`const`, `call`, `emit`, `subscribe`, `reverse`, `local`, `refused`) and `satisfies ProtocolFor<DataProviderContext>`, so a new member without an entry is a type error; a runtime walk of a real ctx backs it, and every `reverse` entry needs a host binder. Tool handlers are `reverse` with no bound of their own: the host binds a stub through the real `ctx.tools.handle`, so the registry's gate, the per-tool deadline, the result cap and path redaction stay in the host wrapper. For isolated extensions only, `agent.send`, `agent.subscribe` and `sessions.start` require `allow.agents: true`, checked by the host.

## Consequences

### Positive

- Behaviour parity by construction: validation, tracking, release and dispose are the same code in both runtimes.
- Every new ctx member is a forced, reviewable decision.
- A hung or dead child can never leave a tool callable: its tools leave the registry before its waiting calls are rejected.

### Negative

- Reverses DOR-2683's "no manifest gate" on agent messaging, for isolated extensions only.
- Every call is an IPC round trip; arguments and results must be structured-clone plain data, and a child cannot send binary data back.
