---
slug: community-live-deployment
number: 260920-191500
created: 2026-09-20
status: specified
linear-issue: DOR-2167
---

# Prove a live Community deployment on Fly

**Slug:** community-live-deployment  
**Author:** Codex, from the operator's deployment decisions  
**Date:** 2026-09-20

## 1) Intent & Assumptions

- **Task brief:** Deploy the current single-community server in resources owned by the operator, use Neon for PostgreSQL and private Tigris for files, move from the initial Fly hostname to `spaces.dorkos.ai` before onboarding, and prove operation and recovery end to end.
- **Assumptions:** One always-on Fly Machine is the only supported topology; the current Community server and migrations are deployed unchanged; provider secrets stay outside the repository; the deployment remains independent of DorkOS Cloud.
- **Out of scope:** Multi-community tenancy, the self-hosted launcher, horizontal scaling, public object storage, provider pricing, and any change to DorkOS Cloud.

Provisioning began before this stage was frozen. A separate Neon project, database, and role exist in the operator-selected organization. The Fly app `dorkos-community` and private Tigris bucket `dorkos-community-files` exist; secrets are staged and public IPs are allocated. DNS for `spaces.dorkos.ai` points to the Fly app and its certificate is issued. No application Machine has been deployed and no Community account has been created. The first execution task reconciles these resources against this specification before any further mutation.

## 2) Pre-reading Log

- `apps/community/FLY.md`: canonical Fly recipe, one-Machine constraint, staged-secret flow, public-host acceptance, and coordinated recovery guidance.
- `apps/community/fly.toml.example`: editable Fly configuration template; runtime copy remains outside the checkout.
- `apps/community/DEPLOYMENT.md`: required environment, exact public-origin behavior, S3 settings, and optional sign-in callbacks.
- `apps/community/OPERATIONS.md`: backup, restore, upgrade, and account-recovery boundaries.
- `apps/community/src/config.ts`: startup validation for PostgreSQL, HTTPS public origin, and private S3-compatible storage.
- `apps/community/src/main.ts`: migrations run before the HTTP listener starts.
- `specs/community-server/02-specification.md`: single-community authority, independent accounts, and no DorkOS Cloud dependency.
- `plans/community-next-phase.md`: programme boundary and DOR-2167 provenance.

## 3) Codebase Map

- **Primary components:** `apps/community` server/browser bundle, the Docker image, Fly configuration, PostgreSQL migrations, and S3-compatible blob storage.
- **Data flow:** browser and local DorkOS clients → Fly HTTPS/proxy → one Community process → Neon PostgreSQL plus private Tigris objects.
- **Configuration:** provider-managed secrets supply database, auth, invite, bootstrap, and storage credentials; `COMMUNITY_PUBLIC_URL` is the exact canonical HTTPS origin.
- **Blast radius:** external resources, DNS, account bootstrap, deployment evidence, and recovery rehearsal. No production code change is required by this spec.

## 4) Research

The checked-in Fly guide already defines the deployment mechanism. The remaining work is live execution and proof, so the shortest safe route is to use that guide, reconcile the resources already created, and collect evidence at each irreversible boundary. Replacing the recipe or building the launcher here would widen scope and delay the proof DOR-2169 depends on.

## 5) Decisions

| #   | Decision         | Choice                                                                                | Rationale                                                                       |
| --- | ---------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | Application host | Separate Fly app                                                                      | Keeps this deployment independently owned and isolated from DorkOS Cloud.       |
| 2   | Database         | Separate Neon project/database in the operator-selected organization                  | Reuses an existing provider account while preserving data isolation.            |
| 3   | File storage     | Private Tigris bucket                                                                 | Matches the existing S3-compatible implementation without exposing object URLs. |
| 4   | Topology         | One always-on Machine                                                                 | Matches the only topology the current server and guide support.                 |
| 5   | Domain sequence  | Smoke test the Fly hostname, then make `spaces.dorkos.ai` canonical before onboarding | Separates infrastructure smoke from permanent account and invitation origins.   |
| 6   | Recovery         | Restore PostgreSQL and object storage as one recovery point                           | Database records and attachment objects must remain mutually consistent.        |

No unresolved product decision remains. Provider identifiers, credentials, and commercial terms belong in private operational evidence, not this repository.
