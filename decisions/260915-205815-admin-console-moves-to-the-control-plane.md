---
id: 260915-205815
title: The admin console and the account surface move to the control plane
status: accepted
created: 2026-09-15
spec: null
superseded-by: null
---

# 260915-205815. The admin console and the account surface move to the control plane

## Status

Accepted. **Supersedes [260707-122350](260707-122350-admin-console-lives-in-site.md)** (The admin console lives in `apps/site` now, extracted to its own app only on a trigger).

## Context

`260707-122350` kept the admin console as a guarded route group inside `apps/site`, extracting it only when a concrete trigger fired — non-founder staff needing admin access, dashboards outgrowing the marketing app, or a compliance need to move admin off the public domain. As documented in `AGENTS.md`'s "DorkOS Cloud" section, the hosted, paid layer's control plane is a separate, closed-source service that the public app talks to only through the public wire-contract package, `packages/cloud-api`. Building out that hosted layer is now moving account management, device link, the instance registry, and managed connections into the control plane as a unit, so the admin console that sits on top of them moves with them rather than staying stranded on the public site.

## Decision

The admin console no longer lives in `apps/site`. It moves to the control plane — the service behind DorkOS Cloud — alongside the rest of the account surface (accounts, device link, the instance registry, managed connections). The public `dorkos` app reaches that surface only through the public wire contract in `packages/cloud-api`, never by depending on the control plane's internals directly. `apps/site` keeps everything that is not account/operator surface: marketing, docs, the blog, the pricing page, the newsletter, and feedback and telemetry intake.

## Consequences

### Positive

- The extraction triggers `260707-122350` listed (non-founder staff access, dashboard growth, compliance-driven isolation) are moot — the console is already off the public site and its blast radius no longer needs bounding in place.
- The public/private boundary is explicit and enforceable: everything `apps/site` needs to talk to the account surface is the public `packages/cloud-api` contract, so the open-source app stays complete to clone, build, test, and run without the control plane.

### Negative

- The identity core (Better Auth instance, session cookie, `db:migrate` ownership) that `260707-122350` deliberately kept single-instance and app-agnostic now has to be re-homed behind the control plane rather than reused in place inside `apps/site`.
- Any admin-facing code that was written against `apps/site`'s in-process assumptions needs to be rebuilt against the wire contract instead of a local import.
