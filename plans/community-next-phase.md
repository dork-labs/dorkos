# Community hosting and workspace experience

Date: 2026-09-20. Baseline: `dfcb858cce88c27ccc2ba7c7b09465cd4ff421c0`.

## Intent and scope

Follow-on programme to the completed Multi-User Communities project. The operator requests five separate Linear projects: easy self-hosted deployment, several communities per server, community administration, membership journeys, and community switching. Fly.io is the preferred hosting target. Slack is the interaction reference; DorkOS retains its Calm Tech design language and standalone local identity.

This document is a Flow TRIAGE result and discovery brief, not a frozen implementation specification. Complex issues advance through IDEATE, SPECIFY, DECOMPOSE, EXECUTE and independent REVIEW. The Fly recipe is a small documentation delivery now; live Fly acceptance and the launcher remain tracked work. The operator explicitly authorized project creation and autonomous decomposition. No new approval is needed to record these five projects.

The existing Community delivery remains complete. Do not reopen its project or claim these new capabilities already shipped. Do not change the separate Cloud implementation, pricing, or its deployment resources. Self-hosting must keep working without a DorkOS account or any DorkOS host reachable.

## What exists today

| Concern        | Evidence at the baseline                                                                                               | Gap                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Hosting        | Hono, PostgreSQL, filesystem/S3 storage, Docker image, Compose and Render recipes                                      | Fly recipe and real-host proof; repeatable guided deployment                                  |
| Tenant model   | `apps/community/src/schema.ts`: singleton community, globally unique `members.user_id`                                 | Several isolated communities in one process/database                                          |
| Administration | `browser/components/Manage.tsx`: channels, invites, members, roles, agents, export, transfer, leave                    | Host-level community list/create/edit/archive/delete and scoped settings                      |
| Membership     | Community browser bootstrap, signed invite signup, `/me/leave`; DorkOS connection pairing and room join/leave          | One coherent create/join/invite/leave journey in DorkOS                                       |
| Navigation     | Many owner-qualified connections; `CommunityChannelGroups.tsx` groups remote rooms; qualified routes and unread states | Active-community switcher, durable per-community navigation/drafts and keyboard/mobile parity |

One deployment currently means one community. A DorkOS user can already connect to several deployments. A community, a host deployment, a local connection, an account, and channel membership are separate concepts.

## Five projects and their issue boundaries

Issue codes below are planning aliases. The tracker section records durable Linear identifiers after creation. Each project gets a clear outcome; future implementation issues remain blocked by their design/contract prerequisites. Dependencies below must become typed tracker relations, not just description text. No dates or firm estimates are implied for unscoped implementation.

### A. Community Self-Hosting

**Outcome:** a person can deploy an ordinary, independently owned Community in their own Fly organization, then safely operate and recover it.

- **A1: Document Fly.io deployment for the current Community server.** Deliver the guide and editable example config, source-checked commands, local Fly config validation, explicit single-process limit, private storage, secrets, and acceptance procedure. This task does not claim a live Fly deployment. Simple task, EXECUTE now.
- **A2: Validate Community on Fly.io and rehearse recovery.** Use a designated test organization and explicit resource budget before provisioning. Verify direct PostgreSQL, private Tigris uploads/downloads, proxy streaming/reconnect, restart and upgrade persistence, revoked membership, local-agent pairing, and coordinated database/file restoration. Record configuration/revision/results and resource cleanup. Blocked by A1; no credential reuse or paid provisioning inferred from Cloud access.
- **A3: Specify the self-hosted launch experience and prove Fly provisioning feasibility.** Compare Fly Launch UI/deep-link support with a local CLI launcher and a delegated web flow. Prove required API/auth/organization/database/storage capabilities in a bounded spike. Define explicit resource consent, ownership, least-privilege credentials, one-time owner setup handoff, resumable partial failure, progress, and cancellation. A click may start setup; account sign-in and resource approval must remain honest steps. Do not advertise an unsupported deploy-button URL. Research/IDEATE, independently actionable.
- **A4: Build the approved self-hosted launcher with failure recovery.** Provision the app, database and private storage, generate secrets, pin a release, apply settings, wait for meaningful readiness, and hand off owner setup without secrets in URLs, analytics or logs. Retry without duplicate resources; clean up only resources created by the run. Blocked by A3's approved spec and A2's verified recipe.
- **A5: Verify launch-to-first-conversation and publish the entry point.** Test a fresh account path, interruption/resume, failed provisioning, non-admin credentials, first two people and one local agent, and backup/upgrade guidance. Verify keyboard/mobile use and a standalone account path without DorkOS Cloud. Publish the launch action only after this passes. Blocked by A4.

Fly is a good architectural fit for a persistent Node service. Start with one always-on Machine, dedicated PostgreSQL and a private S3-compatible bucket. Fly's volumes are local to a Machine; object storage avoids treating them as a shared filesystem. Multiple app replicas are a separate consistency project, not an automatic benefit of object storage. A one-click launch should produce the same portable open-source server as a manual deployment.

### B. Multi-Community Hosting

**Outcome:** one server can host communities A and B without one community accessing or disturbing the other's data, memberships or agents.

- **B1: Specify tenant identity, authorization and migration contracts.** Decide shared-database row scoping versus isolated databases, account-versus-membership identity, host-operator authority, canonical tenant addresses and backwards compatibility. Inventory every singleton assumption. Produce an ADR, migration/backout plan and adversarial acceptance matrix before implementation. Complex task, IDEATE; high priority.
- **B2: Implement tenant-scoped persistence and authorization.** Replace the singleton and global member uniqueness safely; qualify queries, constraints, caches, events, files, exports, invites, rate limits, quotas, handles and agent credentials. Preserve existing community/member/channel IDs and history. Tenant departure revokes only that membership; password recovery revokes all affected account credentials. Blocked by B1.
- **B3: Add tenant-qualified discovery, pairing and DorkOS connections.** Represent origin and immutable community ID separately; preserve pinned DNS/SSRF controls. Bind approvals and grants to the intended tenant, not browser selection. Support two communities at one origin and communities on independent origins. Migrate existing stored connections and retain the old single-community discovery path as specified. Blocked by B1 and B2.
- **B4: Prove tenant isolation and upgrade compatibility end to end.** Exercise two tenants, overlapping account emails/handles, private channels, SSE replay/revocation, attachment/export access, agents, quotas, invites, deletion, and recovery. Tamper with tenant/object IDs and race membership changes. Upgrade a populated single-community database without data or credential misbinding. Blocked by B2 and B3. This is the release gate for tenant-dependent projects.

Important findings: `data.ts` resolves browser membership by user alone; `routes/invites.ts` does too. `routes/members.ts` deletes all account sessions on membership removal. `recover-password.ts` takes the first membership. Simply removing the singleton constraint would be unsafe. Existing community-qualified queries are useful groundwork, not proof of complete isolation.

### C. Community Administration

**Outcome:** host operators and community owners can manage communities through a clear, permission-scoped interface.

- **C1: Specify host and community settings with lifecycle semantics.** Separate host operator privileges from owner/admin/member privileges. Define create, list, rename, description/icon, access policy, transfer, archive/restore and permanent deletion. Decide retention, exports, confirmation, audit history, agent teardown, default-community behavior and bootstrap recovery. Keep permissions at least as strict as today. Complex task, IDEATE; depends on B1's authority contract.
- **C2: Implement community lifecycle and settings APIs.** Enforce permissions server-side; make creation and deletion retry-safe. Model deletion progress through database and blob cleanup; stop agent grants and streams immediately when access ends. Prevent deletion of unrelated tenants or stranding the only host operator. Blocked by C1 and B2.
- **C3: Build the community management interface.** Provide community list/create/edit/settings, appropriate owner/admin actions and lifecycle progress/error recovery. Identify the current community in every destructive action; support keyboard, mobile and empty/error states. Reuse the current member/channel controls. Blocked by C1 and C2.
- **C4: Verify administration, deletion and recovery across tenants.** Test permission matrix, two browser profiles, concurrent changes, abandoned deletion, retained/audited history, exact blob cleanup, archive/restore, and unaffected tenant B. Blocked by C3 and B4.

### D. Community Membership Journeys

**Outcome:** people can create, join, invite others to, and leave communities from DorkOS without having to understand connection plumbing.

- **D1: Design create/join/invite/leave journeys and handoff contracts.** Map a new operator, invited person, returning member, person on another device, expired/revoked invitation, and an owner leaving. Distinguish Create community on a host from Deploy a new host. Distinguish joining a community, connecting this installation, joining a channel, disconnecting, signing out and leaving. Decide safe web/desktop link handoff without tokens in query strings. Complex task, IDEATE; depends on B1's address/membership contract.
- **D2: Implement tenant-bound invitation and membership lifecycle handoffs.** Preserve existing signed invitation admission; add safe continuation through sign-in, browser consent and DorkOS pairing. Support revoked/used/expired invitations, same person on several hosts, scoped leave, transfer-before-owner-leave and revocation of that membership's agent access. Blocked by D1 and B3.
- **D3: Build the DorkOS membership entry points.** Add clear Create/Join/Invite/Leave actions using the approved contracts, setup handoff, return-to-app navigation and actionable errors. Joining a community must not silently enroll all local agents. Creation must explain whether it needs permission on a host or new hosting resources. Blocked by D2 and C2 for community creation.
- **D4: Verify the full member journey across devices and hosts.** Cover invite recipient without an account, existing member, two tenants on one host, two independent hosts, revoked/expired invite, owner transfer, leave versus disconnect, and local agents losing access. Test keyboard/mobile and blocked DorkOS-host egress. Blocked by D3 and B4.

### E. Community Navigation

**Outcome:** people in several communities always know where they are and can switch without losing their place or draft.

- **E1: Design a Slack-inspired community switcher and navigation model.** Prototype an accessible switcher/menu, community identity, contextual channels/settings, Add community entry point, keyboard switching, manual order, mobile drawer and per-community offline state. Distinguish activity from mentions directed at you. Resolve whether Local remains a separate destination. Work against existing multi-host connections now; do not block design on tenancy. Complex task, IDEATE.
- **E2: Implement switching and per-community view state.** Preserve selected channel, scroll position and unsent drafts under owner + community ref + room ID keys. Explicitly bind send actions to their destination during rapid switching. Scope unread/notification/query caches and handle removed or unavailable communities without exposing another user's state. Blocked by E1.
- **E3: Connect switcher actions to membership and tenant-aware settings.** Route Add/Create/Join/Invite/Leave to project D, settings to C, and use B's stable same-host tenant identities. Retain switching across existing independent hosts. Blocked by E2, B3, C3 and D3.
- **E4: Verify switching, accessibility and cross-community isolation.** Test keyboard/screen reader, narrow touch layout, same-named channels, offline host, stale/deleted membership, reload/deep links, rapid-switch send race, drafts and unread counts. Verify both independent hosts and same-host tenants. Blocked by E3 and B4.

## Shared experience rules

Use Slack's recognizable model: a stable community identity, a switcher, contextual channels, and a community menu for invitations/settings. Keep DorkOS's subdued visual style; do not clone branding or import unrelated Slack features.

- Identity and the destination of every message must be clear before Send.
- Switching is navigation, never implicit sign-in, admission, agent enrollment or consent.
- Disconnection affects this installation; leaving changes remote membership; deleting a community is a separate privileged action.
- Preserve independent hosts and local accounts. A portable Cloud identity may be linked later, but must not become a prerequisite.
- Use immutable tenant IDs; names and icons can change. Do not use a renamed community slug as an authorization boundary.
- Screen reader, keyboard and mobile paths are acceptance criteria, not later polish.

## Sequencing and verification

A1/A3, B1 and E1 can start independently. A2 follows the documented recipe; only the bounded live-host validation needs designated resources. Tenant-dependent implementation follows B1, and tenant releases require B4. C and D can design in parallel after B1; E2 can ship useful multi-host switching before same-host tenancy, with E3 completing that bridge later.

Reuse **DOR-2164**, the existing Community packaged-CI flake issue. Link it to release validation; do not duplicate it or claim one green run fixes it. It is not a dependency for writing the Fly guide or beginning design. Before a release, require meaningful positive coverage and investigate actual failures rather than extending retry budgets.

Each implementation runs in an isolated worktree, follows the repository's verification gates, and receives separate `REVIEW.md` adversarial review. Live Fly checks and one-click success must be recorded separately from local Docker acceptance. Do not create a deployment-success claim from config validation alone.

## Source references

- Shipped design and evidence: `specs/community-server/02-specification.md`, `04-implementation.md`; `apps/community/README.md`, `OPERATIONS.md`.
- Code audit: `apps/community/src/{schema,data,app,recover-password}.ts`, `routes/{invites,members}.ts`; `apps/server/src/services/communities/remote/{pairing-service,pinned-origin,connection-store}.ts`; `CommunityConnectionRow.tsx`, `CommunityChannelGroups.tsx`, `RemoteCommunitySurface.tsx`.
- [Fly Launch](https://fly.io/docs/reference/fly-launch/) and [Launch UI limitations](https://fly.io/speedrun/): discovery supports guided provisioning; it does not establish a working Community one-click button.
- [Fly Managed Postgres](https://fly.io/docs/mpg/client-configuration/), [Tigris](https://fly.io/docs/tigris/), [Volumes](https://fly.io/docs/volumes/overview/), [deployment behavior](https://fly.io/docs/launch/deploy/).
- [Slack workspace switching](https://slack.com/help/articles/1500002200741-Switch-between-workspaces): desktop switcher and mobile workspace navigation.
- [Slack joining](https://slack.com/help/articles/212675257-Join-a-Slack-workspace): invitation admission and per-workspace accounts. Do not equate an email address with membership everywhere.
- [Slack Enterprise workspace lifecycle](https://slack.com/help/articles/220266727-Join-or-leave-workspaces-in-an-Enterprise-organization): a useful distinction between host/organization administration and community membership, not a requirement to copy its plan restrictions.

## Tracker

Recorded through the Flow Linear adapter on 2026-09-20. Five projects, 21 issues, 30 blocking dependencies and two related links to the existing packaged-CI reliability issue. Future implementation remains at IDEATE until specifications and decomposition are complete.

### A. [Community Self-Hosting](https://linear.app/dorkspace/project/community-self-hosting-57a7b49967cf)

- A1: [DOR-2166 — Document Fly.io deployment for the current Community server](https://linear.app/dorkspace/issue/DOR-2166/document-flyio-deployment-for-the-current-community-server)
- A2: [DOR-2167 — Validate Community on Fly.io and rehearse recovery](https://linear.app/dorkspace/issue/DOR-2167/validate-community-on-flyio-and-rehearse-recovery)
- A3: [DOR-2168 — Specify the self-hosted launch experience and prove Fly provisioning feasibility](https://linear.app/dorkspace/issue/DOR-2168/specify-the-self-hosted-launch-experience-and-prove-fly-provisioning)
- A4: [DOR-2169 — Build the approved self-hosted launcher with failure recovery](https://linear.app/dorkspace/issue/DOR-2169/build-the-approved-self-hosted-launcher-with-failure-recovery)
- A5: [DOR-2170 — Verify launch-to-first-conversation and publish the entry point](https://linear.app/dorkspace/issue/DOR-2170/verify-launch-to-first-conversation-and-publish-the-entry-point)

### B. [Multi-Community Hosting](https://linear.app/dorkspace/project/multi-community-hosting-8dfffbc25a30)

- B1: [DOR-2171 — Specify tenant identity, authorization and migration contracts](https://linear.app/dorkspace/issue/DOR-2171/specify-tenant-identity-authorization-and-migration-contracts)
- B2: [DOR-2172 — Implement tenant-scoped persistence and authorization](https://linear.app/dorkspace/issue/DOR-2172/implement-tenant-scoped-persistence-and-authorization)
- B3: [DOR-2173 — Add tenant-qualified discovery, pairing and DorkOS connections](https://linear.app/dorkspace/issue/DOR-2173/add-tenant-qualified-discovery-pairing-and-dorkos-connections)
- B4: [DOR-2174 — Prove tenant isolation and upgrade compatibility end to end](https://linear.app/dorkspace/issue/DOR-2174/prove-tenant-isolation-and-upgrade-compatibility-end-to-end)

### C. [Community Administration](https://linear.app/dorkspace/project/community-administration-96fb772eabce)

- C1: [DOR-2175 — Specify host and community settings with lifecycle semantics](https://linear.app/dorkspace/issue/DOR-2175/specify-host-and-community-settings-with-lifecycle-semantics)
- C2: [DOR-2176 — Implement community lifecycle and settings APIs](https://linear.app/dorkspace/issue/DOR-2176/implement-community-lifecycle-and-settings-apis)
- C3: [DOR-2177 — Build the community management interface](https://linear.app/dorkspace/issue/DOR-2177/build-the-community-management-interface)
- C4: [DOR-2178 — Verify administration, deletion and recovery across tenants](https://linear.app/dorkspace/issue/DOR-2178/verify-administration-deletion-and-recovery-across-tenants)

### D. [Community Membership Journeys](https://linear.app/dorkspace/project/community-membership-journeys-38e267557af5)

- D1: [DOR-2179 — Design create/join/invite/leave journeys and handoff contracts](https://linear.app/dorkspace/issue/DOR-2179/design-createjoininviteleave-journeys-and-handoff-contracts)
- D2: [DOR-2180 — Implement tenant-bound invitation and membership lifecycle handoffs](https://linear.app/dorkspace/issue/DOR-2180/implement-tenant-bound-invitation-and-membership-lifecycle-handoffs)
- D3: [DOR-2181 — Build the DorkOS membership entry points](https://linear.app/dorkspace/issue/DOR-2181/build-the-dorkos-membership-entry-points)
- D4: [DOR-2182 — Verify the full member journey across devices and hosts](https://linear.app/dorkspace/issue/DOR-2182/verify-the-full-member-journey-across-devices-and-hosts)

### E. [Community Navigation](https://linear.app/dorkspace/project/community-navigation-5e6a5e08d9e7)

- E1: [DOR-2183 — Design a Slack-inspired community switcher and navigation model](https://linear.app/dorkspace/issue/DOR-2183/design-a-slack-inspired-community-switcher-and-navigation-model)
- E2: [DOR-2184 — Implement switching and per-community view state](https://linear.app/dorkspace/issue/DOR-2184/implement-switching-and-per-community-view-state)
- E3: [DOR-2185 — Connect switcher actions to membership and tenant-aware settings](https://linear.app/dorkspace/issue/DOR-2185/connect-switcher-actions-to-membership-and-tenant-aware-settings)
- E4: [DOR-2186 — Verify switching, accessibility and cross-community isolation](https://linear.app/dorkspace/issue/DOR-2186/verify-switching-accessibility-and-cross-community-isolation)
