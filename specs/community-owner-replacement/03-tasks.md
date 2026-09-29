---
slug: community-owner-replacement
number: 260929-012842
created: 2026-09-28
status: specified
linear-issue: DOR-2252
project: Cloud-Hosted Communities
---

# Owner replacement implementation plan

Seven tasks in three phases. The canonical machine-readable plan, with the full self-contained task descriptions and acceptance criteria, is `03-tasks.json`. Nothing here blocks the hosted launch. Tasks 1.1 and 2.1 can be built in parallel but each adds a migration, so they land one after the other and the second takes the next free number.

## Phase 1 — Optional outbound mail

- [ ] **1.1 Let a Community host send notices by email through its own SMTP server** (large). Mail configuration (off by default), the four new keys, `nodemailer` transport, the `notice_outbox` table that stores no address, the delivery worker (accepted, failed at once on `5xx`, failed after 72 hours of `4xx`), `GET /host/capabilities`, docs. AC-5 plus the worker and privacy tests.

## Phase 2 — The replacement contract on the Community server

- [ ] **2.1 Add the owner-replacement schemas, scope, and migration** (medium). Host and tenant wire schemas, the `communities:ownership` scope, the `owner_replacements` table and its checks, the `system` host audit actor and the `host` tenant audit actor, row deletion with the tenant.
- [ ] **2.2 Let a host request, list, cancel, and reissue an owner replacement** (large; after 1.1 and 2.1). Host routes with password for people, mail required, idempotency, one open per community, lifecycle gates, audits, projection. AC-1, AC-2, AC-3, AC-10 (request), AC-13, AC-14.
- [ ] **2.3 Run the owner-replacement timeline and end it when the owner or host acts** (large; after 2.2). Notice resolution and the clock, reminder, claimable, expiry; transfer, deletion, suspension, host deletion, and cancel end it; the email copy. AC-4, AC-9 (host and owner actions), AC-11, AC-15, AC-16.
- [ ] **2.4 Let the owner object and the named person take ownership** (large; after 2.3). Notice read, objection with no password, preflight and claim with OIDC binding, completion equal to a transfer. AC-6, AC-7, AC-8, AC-9 (objection), AC-10, AC-12, AC-17, AC-18.

## Phase 3 — What people see

- [ ] **3.1 Show the owner replacement in the Community browser app** (large; after 2.4, beside 3.2). Host section, owner and admin banners, the claim page, the member notice; browser and axe tests; eyeballed screenshots.
- [ ] **3.2 Tell the owner on their DorkOS connection** (medium; after 2.4, beside 3.1). The notice on the owner's community row and header, one notification per request, the owner guide in `docs/`.
