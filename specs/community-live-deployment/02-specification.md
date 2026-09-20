---
slug: community-live-deployment
number: 260920-191500
created: 2026-09-20
status: specified
linear-issue: DOR-2167
project: Community Self-Hosting
---

# Live Community deployment on Fly

**Status:** Approved  
**Author:** Codex, from the operator's deployment decisions  
**Date:** 2026-09-20

## Overview

Deploy the current Community server to a separately owned Fly app, with Neon PostgreSQL and private Tigris file storage, then prove the service works and can be recovered without DorkOS Cloud. The Fly-provided hostname is only a smoke-test origin. `spaces.dorkos.ai` becomes the canonical origin before any owner or member account is created.

Provisioning started before this specification was frozen. The database, app, bucket, staged secrets, public IPs, DNS record, and issued certificate already exist; no application Machine or Community account exists. Execution begins by reconciling that inventory and stops if it differs from this specification.

## Background / Problem Statement

The repository contains a source-checked Fly recipe, but configuration validation cannot prove the real proxy, external database, private object storage, canonical domain, membership rules, local-agent path, restart behavior, or coordinated recovery. DOR-2167 supplies that live proof and is a typed blocker of the future self-hosted launcher.

## Goals

- Run the pinned Community revision on exactly one always-on Fly Machine.
- Use a separate Neon database over TLS and private Tigris storage.
- Verify the Fly hostname before making `spaces.dorkos.ai` canonical.
- Onboard only after the canonical origin is healthy and configured everywhere.
- Prove two-person, local-agent, revocation, restart, upgrade, and recovery behavior.
- Preserve evidence sufficient to reproduce or clean up the deployment without exposing secrets.

## Non-Goals

- Multi-community tenancy, a deployment launcher, or horizontal scaling.
- Changes to Community application code or DorkOS Cloud.
- Public object storage or direct attachment URLs.
- Publishing provider account identifiers, credentials, prices, or commercial terms.
- Treating resource creation, a healthy process, or local config validation as complete acceptance.

## Technical Dependencies

- The current `apps/community` Docker build and `apps/community/FLY.md` recipe.
- One separate Fly app and a private Tigris bucket.
- One separate Neon PostgreSQL database reachable through a direct TLS URL.
- DNS control for `spaces.dorkos.ai`.
- A local DorkOS installation for agent pairing and room participation.

## Detailed Design

### Architecture

```text
people + local DorkOS
          |
          v
  https://spaces.dorkos.ai
          |
      Fly proxy
          |
  one Community Machine
       /          \
Neon PostgreSQL   private Tigris
```

The deployment uses the existing server unchanged. Startup validates configuration, applies migrations, and only then opens the HTTP port. The database URL retains its TLS settings. Tigris remains private; Community mediates every download through membership checks.

### Execution order

1. Reconcile the resources created before this spec against their intended owners, regions, visibility, staged settings, and cleanup boundary. Do not print secret values.
2. Preflight the direct TLS database URL, separate database/role, and expected connection metadata without running migrations separately. Record only redacted facts. The application startup in step 3 is the migration proof.
3. Validate the private bucket settings and runtime Fly configuration, including resolving paths from the private config file's location, then deploy the pinned revision with exactly one always-on Machine.
4. Use the Fly hostname for infrastructure smoke only: health, startup and migration evidence, expected response headers, and public assets. Do not create owner or member accounts.
5. Re-verify the existing DNS and issued certificate for `spaces.dorkos.ai`, set `COMMUNITY_PUBLIC_URL` to that exact origin, update any callbacks, redeploy, and verify HTTPS and canonical-origin behavior.
6. Create the owner on the canonical domain. Add a second person and one local agent, then run the behavior and revocation checks.
7. Verify persistence across a restart and a pinned-revision redeploy.
8. Take a coordinated database and file backup, restore both to an isolated target, and verify history plus attachment bytes.
9. Assemble redacted evidence and record whether every created resource remains in service or is removed.

### Resource ownership and privacy

The app, database, bucket, DNS records, and credentials belong to this standalone deployment. None may reuse a DorkOS Cloud database, bucket, app, credential, or control-plane resource. Provider-internal organization and project identifiers remain in private operational evidence. The public repository may name the public app, bucket, and domain where required to reproduce configuration, but never stores credentials or provider terms.

### Failure handling

- If reconciliation finds a resource in the wrong owner, region, or visibility state, stop before deployment and correct or replace it deliberately.
- If migrations fail, do not start onboarding; capture redacted logs and restore the database to its pre-migration point when needed.
- If the Fly hostname works but the canonical domain does not, keep accounts uncreated and fix DNS, certificate, public-origin, or callback configuration.
- If restart or upgrade loses history or files, the deployment fails acceptance.
- If database and object backups cannot be restored as one matching set, the deployment fails recovery acceptance.

## User Experience

The operator first sees a healthy infrastructure smoke test on the temporary Fly hostname. After the certificate and canonical-origin configuration are verified, the operator opens `spaces.dorkos.ai`, enters the bootstrap secret, and creates the first owner. Invitations and all later sign-ins use only the canonical domain. Members see normal channels, threads, files, live updates, and reconnect behavior; a removed member loses both channel and file access.

## Testing Strategy

- Run `fly config validate --strict` against the private runtime configuration before deployment.
- Confirm one Machine, successful checks, and `/health` on both the temporary and canonical origins at the appropriate stage.
- On the Fly hostname, verify only infrastructure health, startup and migration evidence, expected response headers, and public assets. After canonical-domain owner setup, run the authenticated public-host checklist from `apps/community/FLY.md`: two browser profiles, posts and thread reply, byte-checked upload/download, disconnect/reconnect, local-agent mention/reply, redeploy persistence, and revoked-member refusal.
- Capture exact revision and redacted provider settings for each result.
- Restore a coordinated database and file backup into an isolated target; compare history and attachment bytes.
- Keep DOR-2187's PostgreSQL fixture teardown failure separate. A green CI rerun does not replace live recovery proof.

## Performance Considerations

Keep Fly and Neon regions close where available. Record observed startup, migration, request, stream, reconnect, and file-transfer behavior. One Machine is deliberate; this spec makes no throughput or horizontal-scaling claim.

## Security Considerations

- Import secrets through provider secret stores without putting values in commands, files under the checkout, logs, screenshots, tracker comments, or URLs.
- Keep Tigris private and serve files only through Community authorization.
- Use HTTPS and the exact canonical origin before account creation or invitations.
- Rotate the bootstrap secret after owner creation.
- Verify revoked credentials cannot read channels or files.
- Store operational evidence privately when it contains provider identifiers or resource metadata unsuitable for the public repository.

## Documentation

DOR-2190 owns the source-backed Neon option in `apps/community/FLY.md`. This specification records live acceptance and does not duplicate that guide. Any discrepancy found during execution updates the guide through DOR-2190 or a narrowly scoped follow-up before DOR-2167 closes.

## Implementation Phases

- **Phase 1 — Reconcile and deploy:** audit the pre-created resources, validate database and storage configuration, and deploy one Machine.
- **Phase 2 — Canonicalize and verify:** smoke-test the Fly hostname, establish `spaces.dorkos.ai`, then onboard and test people plus a local agent.
- **Phase 3 — Prove durability and recovery:** restart, redeploy, back up, restore, and assemble redacted evidence.

## Open Questions

- ~~Which database provider and account should own PostgreSQL?~~ **(RESOLVED)** Use a separate Neon project/database in the operator-selected organization. This reuses the chosen provider without sharing DorkOS Cloud resources.
- ~~Which hostname should users keep?~~ **(RESOLVED)** Use the Fly hostname for pre-account smoke testing, then `spaces.dorkos.ai` as the canonical origin before onboarding.
- ~~May provisioning continue from the resources already created?~~ **(RESOLVED)** Yes, after an explicit reconciliation task verifies ownership, isolation, region, privacy, and staged configuration. The out-of-order creation is recorded rather than concealed.

## Related ADRs

No new architecture decision is introduced. This is an operational proof of the architecture already specified by `community-server` and documented in the Fly guide.

## References

- DOR-2167 — Validate Community on Fly.io and rehearse recovery
- DOR-2190 — Document Neon PostgreSQL for Fly-hosted Community
- `apps/community/FLY.md`
- `apps/community/DEPLOYMENT.md`
- `apps/community/OPERATIONS.md`
- `specs/community-server/02-specification.md`
- `plans/community-next-phase.md`
