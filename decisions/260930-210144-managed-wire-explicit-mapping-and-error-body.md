---
id: 260930-210144
title: Build managed wire responses by explicit mapping and share one legacy error body
status: draft
created: 2026-09-30
spec: managed-cloud-error-honesty
superseded-by: null
amends: null
---

# 260930-210144. Build managed wire responses by explicit mapping and share one legacy error body

## Status

Draft (extracted from `managed-cloud-error-honesty`).

## Context

A provider started returning two extra fields per action. The server spread provider objects into a strict wire schema, so every operations page failed. The route reported that as the caller's 400, and nothing was logged. On the app side, the parser read `code` where the server sends `error`, and tests mirrored the wrong field.

## Decision

- Managed wire responses are built by explicit per-shape mappers. No spread of a provider or database object may feed a wire parse.
- Request-parse failures are 400. Any other validation failure is the server's own bug: 500, logged by class and route.
- The legacy managed error body `{error, reason?}` is one tolerant shared schema in `@dorkos/shared/connector-managed-schemas`, vendored by the control plane. Both sides read and write through it until `/v1/connections` and the Problem envelope replace it.
- A new optional wire field is accepted by the app before any server sends it.

## Consequences

- A new provider field can no longer break a response.
- The error body has one definition, and tests use the real shape.
- Adding a wire field is two steps: accept it in the app, then send it once the app floor moves.
