---
slug: community-owner-replacement
number: 260929-012842
created: 2026-09-28
status: specified
linear-issue: DOR-2252
project: Cloud-Hosted Communities
---

# Owner replacement implementation plan

Seven tasks in three phases. The canonical machine-readable plan, with the full self-contained task descriptions and acceptance criteria, is `03-tasks.json`. Nothing here blocks the hosted launch. Everything lands after the import migration (`0019`) and the takedown migration (`0020`); tasks 1.1 and 2.1 can be built in parallel but each adds a migration, so they land one after the other and each takes the next free number.

## Phase 1 — Optional outbound mail

- [ ] **1.1 Let a Community host send notices by email through its own SMTP server** (large). Mail configuration (off by default) and the five new keys, `nodemailer` transport, the `notice_outbox` table that stores no address, the delivery worker (accepted; `SMTP_REJECTED`; `SMTP_UNAVAILABLE` after 72 hours; `RECIPIENT_UNAVAILABLE` for a missing or erased account), a per-send hook for object-only tokens, `GET /host/capabilities`, generic deliverability docs. AC-5 plus the worker and privacy tests.

## Phase 2 — The replacement contract on the Community server

- [ ] **2.1 Add the owner-replacement schemas, scope, and migration** (medium). Host and tenant wire schemas, `communities:ownership` (one more scope than main at build time), `owner_replacements` with the issuer stored beside the subject and idempotency scoped to the community, object-token table. Adds no audit actor kinds (the takedown migration does).
- [ ] **2.2 Let a host request, list, cancel, and reissue an owner replacement** (large; after 1.1 and 2.1). Password for people and keys for SSO-only operators, mail required, a named identity required on SSO hosts, the cooling-off, reissue that tells the owner. AC-1, AC-2, AC-3, AC-7 (request), AC-10 (request), AC-13, AC-14, AC-20 (request), AC-21.
- [ ] **2.3 Run the owner-replacement timeline, send the notices, and end it when the owner or host acts** (large; after 2.2). The wait rule (the long wait for unverified addresses, failed mail, and repeat requests), object-only tokens in the notice, reminder, and reissue mails, owner options in the copy, and every ending. AC-4, AC-9 (host and owner actions), AC-11, AC-15, AC-16, AC-19 (tokens). The end helper re-reads the replacement under the community lock: the owner_replacements row joined into `hostProjectionSql` by a `FOR UPDATE OF c` read (host-lifecycle.ts, owner-claims.ts) may be stale once the lock is granted. It also sets `withdrawn_cause` on a withdrawal and clears `claimant_oidc_issuer` and `claimant_oidc_subject` whenever a request closes (`claimant_named` stays).
- [ ] **2.4 Let the owner object and the named account take ownership, signing up if needed** (large; after 2.3). Notice read, objection in the product and by link, admission for a named person without an account, claim with issuer and exactly-one-account checks, completion equal to a transfer. AC-6, AC-7 (claim), AC-8, AC-9 (objection), AC-10, AC-12, AC-17, AC-18, AC-19 (routes), AC-22.

## Phase 3 — What people see

- [ ] **3.1 Show the owner replacement in the Community browser app** (large; after 2.4, beside 3.2). Host section with every row state, the object-link page, owner banner with only this owner's options, admin banner, the claim page, the member notice; browser and axe tests; eyeballed screenshots.
- [ ] **3.2 Tell the owner on their DorkOS connection** (medium; after 2.4, beside 3.1). The notice on the owner's community row and header, one notification per request, the owner guide in `docs/`.
