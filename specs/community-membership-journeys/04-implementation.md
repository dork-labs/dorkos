# Implementation Summary: Community Membership Journeys

**Created:** 2026-09-21
**Last Updated:** 2026-09-21
**Spec:** specs/community-membership-journeys/02-specification.md

## Progress

**Status:** In Progress
**Tasks Completed:** 4 / 10

## Tasks Completed

### Session 1 - 2026-09-21

**Worker:** `/root/flow_close_sol`

- [x] **1.1** Erase invite fragments synchronously, then exchange them for tenant-bound pending admission.
- [x] **1.2** Bind admission to one account and implement atomic, receipt-backed join/reactivation redemption.
- [x] **1.3** Scope leave, removal, sign-out, and tenant-derived revocation.
- [x] **1.4** Complete tenant-bound installation pairing and authoritative disconnect status.

## Files Modified/Created

**Source files:**

- `apps/community/src/browser/index.html` and `invite-fragment.ts` — synchronously capture then remove invitation fragments before module or network work.
- `apps/community/src/browser/CommunityApp.tsx`, `Admission.tsx`, `Manage.tsx`, and `CommunityChooser.tsx` — resume clean-URL admission, tenant-scoped leave, and explicit installation controls.
- `apps/community/src/routes/invites.ts`, `members.ts`, and `pairings.ts` — account-bound admission receipts, atomic join/reactivation, scoped revocation, and current-password confirmation.
- `apps/community/migrations/0011_membership_protocol.sql` and `schema.ts` — durable account binding and short-lived content-free admission receipts after administration migration `0010`.
- `packages/shared/src/community-wire.ts` — strict request and response contracts for admission, leave, and installation disconnect.
- Reviewed access-projection exact head `4b70c1997020ef0102087cee78efc3b31f47cc7c` — authoritative verified/unverified/reconnect-required access and effective capability enforcement for local Community participation.

**Test files:**

- `apps/community/src/__tests__/admission.integration.test.ts` — account switching, final-seat contention, same-account replay settlement, reactivation cleanup, scoped departure, pairing, and tenant isolation.
- `apps/community/src/__tests__/migrate.integration.test.ts` — populated migration and constraint coverage through `0011`.
- `apps/community/browser-tests/community.spec.ts` — clean fragment capture, reload/OAuth continuation, admission, and revocation behavior.
- Shared wire contract and attachment compatibility fixtures were updated for the new request shapes.

## Verification

- Composed `0010` then `0011` against reviewed administration/API and access-projection ancestry.
- Node 24 targeted real-Postgres run: admission plus migration, **25/25 passed**.
- Node 24 follow-up admission run after the repeated-transaction settlement fix: **22/22 passed**.
- Merge commit normal pre-commit gate: **34/34 tasks passed** (format, lint, typecheck); only existing repository warnings.
- Access projection sibling review: exact `4b70c1997020ef0102087cee78efc3b31f47cc7c`, **0 Important / 0 Nit**.

## Remaining Work

- DOR-2181 owns the broader entry experience. Its separately reviewed atomic first-host foundation is at `4f627449f7e1b8a3de64ba2eefdf4f0f0d88e5d3`; this branch does not duplicate that transaction.
- DOR-2182 owns packaged Desktop and cross-device journey proof.
- Before this DOR-2180 batch opens a PR: merge the freshly fetched current `main`, run the bounded full Community Postgres gate and browser admission proof, then obtain an independent full REVIEW.md verdict for the exact pushed head.
