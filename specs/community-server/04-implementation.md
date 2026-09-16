# Implementation Summary: A self-hosted community for people and their agents

**Created:** 2026-09-16  
**Last Updated:** 2026-09-16  
**Spec:** specs/community-server/02-specification.md

## Progress

**Status:** In Progress  
**Tasks Checkpointed:** 2 / 25

## Tasks Completed

### Session 1 - 2026-09-16

**Workers:** `finish_community_browser` (takeover, `codex-community-browser` worktree)

### Browser checkpoint — tasks 3.3 and 3.4

- Added the same-origin React/Vite/Tailwind community browser. It covers guarded owner setup, signed-in and invite admission, configured OAuth choices, channel navigation, history, threads, SSE updates, read state, and responsive navigation.
- Added member, channel, agent, local-install grant, export, leave, and ownership-transfer controls. The browser never renders connection or agent credentials.
- Added an isolated real-Postgres Playwright scenario with three browser contexts. It covers owner setup, invite redemption, chat, a thread, live delivery, file upload/download, blocked attachment access before channel admission, member administration, rejected-file recovery, export, leave, keyboard navigation, pairing approval and decline.
- The rejected-upload recovery path now clears completed progress and offers **Retry sending**, preserving the pending idempotency key.

## Files Modified/Created

**Source files:**

- `apps/community/src/browser/` — browser shell, admission, channel, management, pairing, API helpers, styles and browser entry point
- `apps/community/src/app.ts`, `apps/community/src/main.ts`, `apps/community/vite.config.ts` — browser asset and entry routing
- `apps/community/src/routes/channels.ts` — roster agent owner display name
- `apps/community/src/config.ts` — strict public-origin validation
- `packages/shared/src/community-wire.ts`, `packages/shared/src/community-adapter.ts` — browser-safe OAuth availability and agent roster fields

**Test files:**

- `apps/community/browser-tests/community.spec.ts` — isolated owner/member/observer browser flow
- `apps/community/browser-tests/pairing.spec.ts` — approval and narrow-viewport decline flow
- `apps/community/src/__tests__/admission.integration.test.ts`, `apps/community/src/__tests__/config.test.ts`, `packages/shared/src/__tests__/community-server-contract.test.ts`

## Known Issues

- This is a browser-scope checkpoint, not programme completion. It still needs combined-tree integration, the required independent review, and the later native connection/dispatch and deployment acceptance work.
- The browser acceptance is Playwright coverage against real Postgres. Dedicated RTL component tests have not been added in this checkpoint.

## Implementation Notes

### Session 1

Canonical tasks are in `specs/community-server/03-tasks.json`; `03-tasks.md` is the readable projection. The six phases are planned as six coherent PR batches. In the first batch, task 1.1 owns `packages/shared` and `packages/test-utils` in branch `codex/community-contract` at `/Users/doriancollier/.dork/workspaces/dorkos/codex-community-contract`; task 1.2 owns `apps/community` in branch `codex/community-server` at `/Users/doriancollier/.dork/workspaces/dorkos/codex-community-server`. Both began from `36381b3ea`. They are the only parallel first-batch tasks because their files are disjoint. Integrate the contract into the server branch before tasks 1.3–1.6; the first PR must serve owner bootstrap, channel creation and posting over built HTTP with real Postgres. Task 1.6 owns shared/root manifest, lockfile, Vitest/Turbo and index registration after the parallel edits converge; reconcile active #1908 and #1906 changes in the combined tree. Later batches follow the dependency graph and assign one writer per checkout.

The browser checkpoint was exercised with `COMMUNITY_TEST_DATABASE_URL=postgres://postgres:community-test-only@127.0.0.1:55439/community pnpm --filter @dorkos/community test:browser` on 2026-09-16. The three Playwright tests passed against isolated migrated databases. Visual review artifacts are `/tmp/community-owner-desktop.png`, `/tmp/community-join-mobile.png`, `/tmp/community-member-mobile.png`, `/tmp/community-thread-desktop.png`, `/tmp/community-chat-tablet-dark.png`, `/tmp/community-members-desktop.png`, `/tmp/community-file-error-mobile.png`, and `/tmp/community-pairing-approval-mobile.png`.
