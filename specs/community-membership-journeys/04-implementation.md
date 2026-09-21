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

- `apps/community/src/browser/index.html` and `invite-fragment.ts` — synchronously capture invitation fragments before module or network work, then erase the page-memory holder after accepted preflight.
- `apps/community/src/browser/CommunityApp.tsx`, `Admission.tsx`, `Manage.tsx`, and `CommunityChooser.tsx` — resume clean-URL admission, tenant-scoped leave, and explicit installation controls.
- `apps/community/src/routes/invites.ts`, `members.ts`, and `pairings.ts` — account-bound admission receipts, bounded expired-transaction cleanup, atomic join/reactivation, lifecycle-safe scoped revocation, and current-password confirmation.
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
- First full Postgres pass found one stale administration fixture still sending a raw invite to redemption: **155 passed, 16 skipped, 1 fixture setup failure**. The fixture was corrected to bind then redeem; its isolated rerun passed **12/12**.
- Final bounded full Community Postgres gate after the review corrections: **13/13 files, 168 passed, 4 declared skips**. The focused admission fixture passed **23/23**, including locked-row cleanup and archived idempotent disconnect.
- Community browser production build passed. Because this host lacks Playwright's pinned Chromium headless-shell revision `1234`, the same three cases ran against the installed system Chrome through an ignored local config: **3/3 passed**. The main journey proves successful preflight erases both page-memory hooks, browser storage, the URL fragment, and DOM copies before a simulated unmount. Two preceding runs exposed and reproduced a correction-stage rerender that replaced the join form; the stable-ref fix then passed the focused main journey **1/1** and the full browser set **3/3** without changing the 90-second test limit.
- Normal pre-commit gates passed **34/34 tasks** on both composition and correction commits (format, lint, typecheck); only existing repository warnings.
- Access projection sibling review: exact `4b70c1997020ef0102087cee78efc3b31f47cc7c`, **0 Important / 0 Nit**.
- Membership protocol full review of exact `ec7032a6cb32e367caf31d0f3d9e247fee01104d`: **2 Important / 1 Nit**. Corrections remove the module-lifetime invitation copy, sweep expired admissions and their cascading receipts with bounded `SKIP LOCKED` work, and allow password-confirmed bulk grant revocation while archived, suspended, or deleting. A sibling delta review of the corrected exact head remains required.

## Remaining Work

- DOR-2181 owns the broader entry experience. Its separately reviewed atomic first-host foundation is at `4f627449f7e1b8a3de64ba2eefdf4f0f0d88e5d3`; this branch does not duplicate that transaction.
- DOR-2182 owns packaged Desktop and cross-device journey proof.
- Before this DOR-2180 batch opens a PR: obtain an independent delta REVIEW.md verdict for the corrected exact pushed head. The installed-Chrome run supplies behavioral evidence; CI still supplies the repository-pinned browser execution.
