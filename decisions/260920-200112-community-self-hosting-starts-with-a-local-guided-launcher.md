---
id: 260920-200112
title: Community self-hosting starts with a local guided launcher
status: accepted
created: 2026-09-20
spec: community-self-host-launcher
superseded-by: null
---

# 260920-200112. Community self-hosting starts with a local guided launcher

## Status

Accepted (extracted from `community-self-host-launcher`)

## Context

A Community launch must create resources in an operator's Fly and Neon accounts, make billing ownership visible, install runtime secrets, and preserve Community's standalone identity. Fly's documented launch surface does not cover a separate Neon account, while a DorkOS-hosted flow would need broad credentials before it could create narrower app- or project-scoped access.

## Decision

The first guided launch is `dorkos community deploy`, running on the operator's machine. Provider browser sign-in and organization selection stay with Fly and Neon, and a typed consent gate precedes every resource write. The command deploys an immutable Community image to one Fly Machine, creates a separate Neon project and private Tigris bucket, journals non-secret creation intent and provider-issued identities, and hands owner setup to Community's existing same-origin flow. Interrupted creation resumes automatically only when provider evidence proves the exact resource belongs to that run; otherwise the launcher stops for manual reconciliation without adopting or creating anything else.

Do not advertise a public one-click deploy button or make DorkOS Cloud part of launch, identity, or recovery. Reconsider a hosted flow only after both providers offer an approved delegated authorization path with adequate organization selection, billing consent, revocation, and least-privilege scopes.

## Consequences

### Positive

- Provider credentials stay on the operator's machine and resources remain in accounts they select.
- The launcher can coordinate two providers, resume partial work whose resource identity is proven, and preserve the manual recipe as an audit and recovery path.
- Fly and Neon accounts do not become Community identities; the first owner still claims the deployed Community directly.

### Negative

- Setup requires local Node, `flyctl`, the Neon CLI, and two browser sign-ins.
- Release engineering must publish and attest an immutable Community image.
- Initial provisioning uses organization-capable local sessions because narrower app/project credentials do not exist until after their resources are created.
- An interrupted provider create may require manual reconciliation when the provider cannot prove which run created the resulting resource.
