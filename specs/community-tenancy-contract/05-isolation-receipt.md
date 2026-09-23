---
slug: community-tenancy-contract
number: 260920-192428
created: 2026-09-23
status: verified
linear-issue: DOR-2174
project: Multi-Community Hosting
---

# Tenant isolation and upgrade receipt

This receipt maps every row of the specification's **Adversarial verification matrix** (task 4.1) and every acceptance criterion of task 4.2 to the tests that prove it. Each proof names a test file and the exact title of one test in it.

The receipt is checked in two steps, and only the second one decides whether a proof counts.

1. **Structure, on every unit run.** `apps/community/src/__tests__/tenancy-receipt.test.ts` reads the matrix straight out of `02-specification.md` and the 4.2 criteria straight out of `03-tasks.json`. It fails when a row or criterion has no entry here, an entry quotes text that is no longer in the spec, an entry has no proof, a proof names a file that does not exist or that no receipt runner executes (for example `*.s3.test.ts` or `acceptance/`), or the cited title is not declared in that file. This step reads source text only, so it is a fast pre-filter, not proof.
2. **Execution, after the suites run.** `apps/community/scripts/tenancy-receipt.ts` checks each proof against the report its runner wrote, and fails unless the cited file and title appear there as passed. A test in a skipped block, behind a false condition, or commented out never appears as passed, so it fails this step. A title with `${…}` must match at least one reported test, and every test it matches must have passed.
   - Real PostgreSQL proofs (`apps/community/src/**/*.integration.test.ts`): `test:pg` checks `vitest-pg-report.json` last.
   - Browser proofs (`apps/community/browser-tests/*.spec.ts`): `test:browser` checks `browser-report.json` last.
   - Unit proofs (`apps/community/src` and `apps/server/src`): `test:pg` also runs just those files with a JSON reporter and checks that report.

## Adversarial verification matrix (task 4.1)

### M1

> A session on an A path with a B object ID returns `404` and causes no write.

- `apps/community/src/__tests__/administration.integration.test.ts` — rejects foreign objects on every id-taking community route, even for an owner of both
- `apps/community/src/__tests__/tenancy-concurrency.integration.test.ts` — keeps concurrent posts, invites, and cursors of two communities on one host apart, each channel gap-free

### M2

> A host session without membership cannot read A or B content.

- `apps/community/src/__tests__/tenancy-isolation.integration.test.ts` — gives a host operator with no membership host metadata, but no content in either community
- `apps/community/src/__tests__/admission.integration.test.ts` — separates host operations from a pending community owner claim

### M3

> a host operator cannot issue or redeem an owner claim, membership, or content credential for active or suspended A; only pending-owner B accepts its one tenant-bound claim.

- `apps/community/src/__tests__/tenancy-isolation.integration.test.ts` — gives a host operator with no membership host metadata, but no content in either community
- `apps/community/src/__tests__/tenancy-concurrency.integration.test.ts` — settles racing owner claims per community while active tenants are busy and cannot be claimed
- `apps/community/src/__tests__/admission.integration.test.ts` — separates host operations from a pending community owner claim
- `apps/community/src/__tests__/administration.integration.test.ts` — creates a pending tenant idempotently and rotates its private owner claim
- `apps/community/src/__tests__/owner-claim-locks.integration.test.ts` — serializes owner claim with concurrent ${mutation} in community-before-grant order

### M4

> Role and ownership changes in A do not change B.

- `apps/community/src/__tests__/tenancy-isolation.integration.test.ts` — keeps role and ownership changes in A out of B, even when both tenants transfer at once

### M5

> Leaving/removal in A preserves the account session and B membership, but immediately ends A streams and credentials.

- `apps/community/src/__tests__/tenancy-isolation.integration.test.ts` — ends only A streams and credentials when a member is removed from A
- `apps/community/src/__tests__/tenancy-concurrency.integration.test.ts` — removes the shared account from A while it keeps posting in B, without touching its host session
- `apps/community/src/__tests__/admission.integration.test.ts` — removal wins a blocked post and closes the member stream without erasing history

### M6

> Password recovery revokes the account’s sessions and all derived credentials across A and B, with per-community audit evidence.

- `apps/community/src/__tests__/recovery.integration.test.ts` — recovers one host login and revokes derived access across every membership
- `apps/community/src/__tests__/recovery.integration.test.ts` — rolls back a password change if access revocation fails

### M7

> A grants, agents, invites, pairings, cursors, idempotency keys, exports, and download IDs cannot be replayed in B.

- `apps/community/src/__tests__/administration.integration.test.ts` — rejects foreign objects on every id-taking community route, even for an owner of both
- `apps/community/src/__tests__/tenancy-isolation.integration.test.ts` — lands pairing approvals, invite redemptions, and reused idempotency keys sent through both tenants only in their own tenant
- `apps/community/src/__tests__/tenancy-concurrency.integration.test.ts` — keeps concurrent posts, invites, and cursors of two communities on one host apart, each channel gap-free
- `apps/community/src/__tests__/remote-adapter-conformance.integration.test.ts` — rejects a cursor from a different real community with the same channel, epoch, and signing secret

### M8

> a canonical A connection link extracts A's UUID without listing B, while an origin-only request fails once both exist; redirects, DNS changes, encoded-path variants, credentials, and unexpected path segments remain rejected.

- `apps/server/src/services/communities/remote/__tests__/pairing-service.test.ts` — creates distinct local connections for two canonical tenants at one origin
- `apps/server/src/services/communities/remote/__tests__/pairing-service.test.ts` — requires a canonical tenant link when singleton discovery is ambiguous
- `apps/server/src/services/communities/remote/__tests__/pairing-service.test.ts` — rejects private targets and refuses a cross-host redirect without following it
- `apps/server/src/services/communities/remote/__tests__/pairing-service.test.ts` — separates a canonical tenant link from its pinned socket origin
- `apps/server/src/services/communities/remote/__tests__/canonical-link-isolation.test.ts` — extracts the tenant from an exact link and refuses credentials and every other shape
- `apps/server/src/services/communities/remote/__tests__/canonical-link-isolation.test.ts` — opens the socket on the one checked DNS answer, never a second lookup
- `apps/server/src/services/communities/remote/__tests__/canonical-link-isolation.test.ts` — rechecks every resolution, so an answer that changes to a private address is refused

### M9

> an A entry cannot mention a B human or agent, and an A export archive cannot contain a B channel, including through direct SQL writes and migrated array data; human and agent mention order survives migration.

- `apps/community/src/__tests__/tenancy-isolation.integration.test.ts` — refuses an A post that mentions a B person or a B agent, and writes nothing
- `apps/community/src/__tests__/tenant-relations.integration.test.ts` — rejects unresolved export channels and cross-tenant updates without losing prior rows
- `apps/community/src/__tests__/tenant-relations.integration.test.ts` — backfills ordered human, agent, duplicate, and export-channel relations
- `apps/community/src/__tests__/tenant-relations.integration.test.ts` — rejects missing and human-agent-ambiguous mention targets during migration
- `apps/community/src/__tests__/migrate.integration.test.ts` — expands a populated version-four database without changing files or cleanup work

### M10

> concurrent requests cannot approve a pairing, redeem an invite, transfer ownership, or attach a cross-tenant relation after a tenant/credential recheck.

- `apps/community/src/__tests__/tenancy-concurrency.integration.test.ts` — refuses a pairing approval whose member is removed after the request passed its membership check
- `apps/community/src/__tests__/tenancy-isolation.integration.test.ts` — keeps role and ownership changes in A out of B, even when both tenants transfer at once
- `apps/community/src/__tests__/tenancy-concurrency.integration.test.ts` — keeps concurrent posts, invites, and cursors of two communities on one host apart, each channel gap-free
- `apps/community/src/__tests__/admission.integration.test.ts` — admits exactly one contender for the final seat and leaves the other unadmitted
- `apps/community/src/__tests__/admission.integration.test.ts` — does not deadlock owner transfer against a successor ejecting the owner’s agent
- `apps/community/src/__tests__/admission.integration.test.ts` — checks an agent owner’s promoted role after a contended ejection
- `apps/community/src/__tests__/foundation.integration.test.ts` — rejects a channel create if admin authority is removed while the insert waits
- `apps/community/src/__tests__/foundation.integration.test.ts` — refuses a read cursor when membership is revoked before its channel lock

Scope: only pairing approval has a held-lock test that removes the member between the pre-check and the transaction (the first proof above). The other three parts rest on existing tests. Invite redemption relies on the admission test "admits exactly one contender for the final seat and leaves the other unadmitted". Ownership transfer relies on "does not deadlock owner transfer against a successor ejecting the owner’s agent" and the forced-overlap transfer test above. Cross-tenant relations rely on the foundation tests "rejects a channel create if admin authority is removed while the insert waits" and "refuses a read cursor when membership is revoked before its channel lock", plus the hostile requests in the concurrency burst.

### M11

> community switching closes A SSE before B data enters cache; reconnect cursors cannot cross tenants.

- `apps/community/browser-tests/switching.spec.ts` — switching from A to B ends the A event stream before any B request
- `apps/community/src/__tests__/remote-adapter-conformance.integration.test.ts` — rejects a cursor from a different real community with the same channel, epoch, and signing secret
- `apps/community/src/__tests__/tenancy-concurrency.integration.test.ts` — keeps concurrent posts, invites, and cursors of two communities on one host apart, each channel gap-free

Scope: this row covers the Community host's own website switcher. The local DorkOS app's switcher and its cache are proven by DOR-2186. Those proofs run in the app's own suites (the client unit tests and the `chromium-connections` browser project), not in this receipt's runners, so they are listed here rather than above. The guard checks that each one names a real test:

- local app: `apps/e2e/tests/connections/community-switching-proof.spec.ts` — A→B→A→this DorkOS→B with reads and streams in flight never paints A under another context
- local app: `apps/client/src/app/__tests__/community-rapid-switch.test.tsx` — discards every stale read and stream event after A→B→A→this DorkOS→B, and lands on B
- local app: `apps/client/src/app/__tests__/community-rapid-switch.test.tsx` — discards a read that lands after the local owner changed, even back on the same route
- local app: `apps/client/src/layers/entities/community/__tests__/remote-stream.test.tsx` — isolates identical IDs during a route change and ignores late events from the old stream

### M12

> compatibility routes work with one community and fail closed immediately after the second community row is created, including while that row awaits its owner.

- `apps/community/src/__tests__/foundation.integration.test.ts` — uses canonical tenant routes and fails closed when the singleton alias is ambiguous
- `apps/community/src/__tests__/admission.integration.test.ts` — separates host operations from a pending community owner claim
- `apps/community/src/__tests__/tenancy-egress.integration.test.ts` — runs install, chat, files, local pairing, agents, export, a second community, recovery, and every sweep with egress blocked
- `apps/community/src/__tests__/administration.integration.test.ts` — rejects suspended public discovery on qualified and singleton routes

### M13

> migration preserves all IDs, row counts, entry order, file checksums, membership, and the existing public origin.

- `apps/community/src/__tests__/migrate.integration.test.ts` — expands a populated version-four database without changing files or cleanup work
- `apps/community/src/__tests__/migrate.integration.test.ts` — serves a populated version-four community through the current HTTP contract after upgrade
- `apps/community/src/__tests__/migrate.integration.test.ts` — upgrades a populated foundation database without changing human authors
- `apps/community/src/__tests__/tenant-reconciliation.integration.test.ts` — adopts verified singleton references without changing their bytes or identifiers

Scope: the public origin is deployment configuration (`COMMUNITY_PUBLIC_URL`), not a database value, so no migration reads or writes it; the upgraded host above serves its history at the same configured origin.

## Populated upgrade and standalone compatibility (task 4.2)

### U1

> A zero-community database still completes first-install bootstrap after upgrade.

- `apps/community/src/__tests__/first-host-bootstrap.integration.test.ts` — creates the first account, authority, tenant, membership, and channel atomically
- `apps/community/src/__tests__/bootstrap.integration.test.ts` — issues a grant only for a truly empty host
- `apps/community/src/__tests__/tenant-reconciliation.integration.test.ts` — marks a clean zero-community namespace ready without inventing ownership

### U2

> Before/after manifests for the populated fixture match stable IDs, counts, entry order, and file checksums.

- `apps/community/src/__tests__/migrate.integration.test.ts` — expands a populated version-four database without changing files or cleanup work
- `apps/community/src/__tests__/migrate.integration.test.ts` — upgrades a populated foundation database without changing human authors

### U3

> Existing bookmarks and connections follow the documented one-community compatibility path.

- `apps/community/src/__tests__/migrate.integration.test.ts` — serves a populated version-four community through the current HTTP contract after upgrade
- `apps/community/src/__tests__/foundation.integration.test.ts` — uses canonical tenant routes and fails closed when the singleton alias is ambiguous
- `apps/server/src/services/communities/remote/__tests__/pairing-service.test.ts` — requires a canonical tenant link when singleton discovery is ambiguous
- `apps/community/src/browser/api.test.ts` — keeps the singleton compatibility API at the host root

### U4

> The service works with Cloud egress unavailable.

- `apps/community/src/__tests__/tenancy-egress.integration.test.ts` — refuses direct outbound TCP, DNS, and UDP, so the journey below cannot reach anything off the host
- `apps/community/src/__tests__/tenancy-egress.integration.test.ts` — runs install, chat, files, local pairing, agents, export, a second community, recovery, and every sweep with egress blocked

### U5

> Creating the second community row disables ambiguous routes immediately and irreversibly trips the downgrade guard.

- `apps/community/src/__tests__/foundation.integration.test.ts` — uses canonical tenant routes and fails closed when the singleton alias is ambiguous
- `apps/community/src/__tests__/backout.integration.test.ts` — never reopens backout after a second community is removed
- `apps/community/src/__tests__/migrate.integration.test.ts` — serves a populated version-four community through the current HTTP contract after upgrade
