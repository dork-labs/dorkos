---
id: 260916-210001
title: A community is an independent Hono service on persistent Node
status: accepted
created: 2026-09-16
spec: community-server
superseded-by: null
---

# 260916-210001. A community is an independent Hono service on persistent Node

## Status

Accepted.

## Context

A community needs account sessions, channel history, membership checks, ordered writes, long-lived SSE, and durable attachments. It must be deployable by someone who does not operate DorkOS Cloud. The local server is an Express app with SQLite and single-owner trust rules; `apps/site` is a Next app tied to Cloud accounts. Neither is the shared community's trust or deployment boundary.

## Decision

Build `apps/community` as a Hono HTTP service on a persistent Node process with a same-origin React/Vite/Tailwind browser app, Better Auth, Drizzle/Postgres, and a used `BlobStore` for message attachments. Docker Compose with Postgres and a persistent filesystem blob volume is the reference self-host deployment. A Render paid web service with managed Postgres and S3-compatible blobs is an optional hosted recipe; the domain code remains vendor-neutral. Use `COMMUNITY_*` settings and fail clearly at runtime when required settings are absent. Keep Cloud account hosts, databases, keypairs, and the closed-source control plane outside this app. Do not migrate the local Express server as part of this decision.

## Consequences

### Positive

- A clean deployment can run with Cloud egress blocked and still serve two people and their locally run agents.
- Persistent Node makes SSE and post-commit event delivery straightforward without claiming unsupported serverless stream lifetimes.
- The two blob implementations make attachments durable in both documented deployment modes.

### Negative

- A separate app owns its own migrations, auth configuration, build, CI, Docker image, and deployment documentation.
- Multiple Node replicas need a durable fan-out mechanism before horizontal scaling is claimed; v1 documents a single persistent process.
