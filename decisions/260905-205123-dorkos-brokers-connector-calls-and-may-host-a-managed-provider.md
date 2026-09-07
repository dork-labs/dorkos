---
id: 260905-205123
title: DorkOS brokers connector calls and may host a tenant-scoped managed provider
status: accepted
created: 2026-09-05
spec: white-label-connections
superseded-by: null
amends:
  - 260729-234626
  - 260718-045630
provenance: { tracker: linear, issue: DOR-1792 }
---

# 260905-205123. DorkOS brokers connector calls and may host a tenant-scoped managed provider

## Status

Accepted (2026-09-07).

This amends ADR 260729-234626 by retiring “Direct connection is the default lane” and “No DorkOS-held platform key.” It also amends ADR 260718-045630 by retiring the assumption that connector execution reaches an agent through a provider MCP server. Both parents remain accepted for their direct/BYO routes, provider abstraction, custody disclosure, Slack/Relay boundary, and provider choices.

## Context

Provider MCP sessions let a runtime call an account without a fresh DorkOS authorization or usage check, so revocation and exact operation grants cannot be enforced at the decisive boundary. The requested product also needs an optional DorkOS-managed route while retaining local and self-hosted providers, with tenant ownership derived from existing account and linked-instance identity.

## Decision

We will route every connector operation through one DorkOS authorization, execution, and accounting service; a grant references an immutable reviewed operation revision containing the provider version, schema hash/input schema, and classification, and usage references the executed revision. Provider adapters call their SDK or API with the exact connected account and granted revision, and agents receive no provider MCP credential or URL. We will model managed and BYO configurations as coexisting provider instances and recommend managed only for capabilities whose production configuration is healthy. The managed Composio adapter will run in tenant-scoped Node.js routes in `apps/site`, derive ownership from Better Auth and verified linked-instance keys, and use a DorkOS-held project key plus server-derived provider user identities; every connect flow discloses custody and payer before redirect.

## Consequences

### Positive

- Revocation, operation policy, approval, and usage accounting apply to the next call across MCP, REST, and CLI.
- Managed and BYO accounts can coexist behind stable DorkOS connection IDs without vendor identifiers entering public authorization contracts.
- Existing cloud identity and instance revocation become the hosted tenant boundary; no second account system is introduced.

### Negative

- DorkOS assumes operational responsibility for a hosted provider project, tenant isolation, callback verification, usage records, and event delivery.
- Direct SDK/API adapters and immutable operation revisions replace the simpler provider-MCP handoff; every new or reclassified provider revision requires user review.
- Managed availability depends on real project credentials, custom OAuth configuration, provider verification, and deployed webhook configuration; each unavailable capability must say so honestly.
