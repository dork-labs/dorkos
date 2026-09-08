---
id: 260908-151634
title: Project runtime environments before spawning
status: accepted
created: 2026-09-08
spec: runtime-subprocess-environment
superseded-by: null
amends: null
---

# 260908-151634. Project runtime environments before spawning

## Status

Accepted on 2026-09-08 after independent design review and operator freeze. DOR-1904 records implementation and verification. This does not alter the selected model credential-reference architecture or the Connections grant boundary.

## Context

DorkOS currently copies its server environment into agent runtimes and several runtime probes. That exposes unrelated credentials, including a supported Nango server encryption key, to a runtime that does not need them. Removing a few secret-looking names would still forward unknown secrets, while removing every credential would break model authentication and ordinary operator tooling.

## Decision

We will supply an explicit complete environment to every owned runtime launch, combining a reviewed OS/CLI baseline, runtime-specific authentication/configuration, and selected credential fragments. Unknown variables will be withheld by default; an operator-only exact-name list can deliberately pass custom variables, but cannot restore reserved server-only credentials. Fresh agent/turn credentials remain explicit internal overrides and never enter argv or configuration values. The shared projection is a credential-exposure control, not a sandbox against code running as the same OS user.

## Consequences

- Server-only secrets are no longer inherited just because a runtime shares the server's parent environment.
- New SDK/query/probe launch paths must use the projection and carry positive compatibility plus negative secret-sentinel tests.
- Operators relying on unknown ambient variables must name them explicitly after migration; no automatic grandfathering preserves the old exposure.
- Runtime-owned files, permitted proxy/SSH access and deliberately passed custom secrets still carry operator authority. Strong isolation needs a separate OS or container boundary.

## Alternatives Considered

A denylist with unrestricted unknown inheritance misses arbitrary secret names. A blanket empty environment breaks login, PATH, Git and proxies. Temporarily editing process.env creates cross-session races. None meets the boundary and compatibility requirements together.

## References

- [Specification](../specs/runtime-subprocess-environment/02-specification.md)
- [DOR-1904](https://linear.app/dorkspace/issue/DOR-1904/filter-server-secrets-from-runtime-subprocess-environments)
