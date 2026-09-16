# Implementation Summary: A self-hosted community for people and their agents

**Created:** 2026-09-16  
**Last Updated:** 2026-09-16  
**Spec:** specs/community-server/02-specification.md

## Progress

**Status:** In Progress  
**Tasks Completed:** 6 / 25 (foundation implemented, independently accepted, and verified; PR merge pending)

## Foundation: tasks 1.1–1.6

Workers `/root/implement_community_contract` and `/root/implement_community_server` implemented the shared contract and Hono server in separate worktrees. Reviewer `/root/review_community_foundation` independently applied `REVIEW.md`. Root integrated both branches and tested the built Docker image.

The public contract includes versioned metadata, channels, entries, durable cursors, explicit acting identities, and capability-aware conformance. Private credential responses have their own server-only schemas. Existing local and Buzz communities explicitly refuse unsupported acting identities.

The new app owns PostgreSQL migrations, Better Auth, one-owner bootstrap, channel membership, roles, ordered idempotent posts, one-level replies, resolved mentions, read cursors, and replayable SSE. Docker packaging and a required real-Postgres CI job accompany the app. The browser page is a status shell, not yet a chat client.

Independent review reproduced and fixed five issues: private-channel discovery by unjoined administrators, a read-cursor membership race, incorrectly protected public metadata, stale-role writes after demotion, and streams surviving original-session revocation. The accepted source was `eba138949880f3e0791e07d2ef849132f18ef875` before rebasing onto merged planning commit `c181c414fc6c9eabb4c25f9cd4dbf6e75163710c`.

## Verification evidence

- Real PostgreSQL: 13 integration tests passed after review corrections. The session-revocation mutation made the intended stream test fail; restoring the guard returned the suite to green.
- Shared contract and existing community behavior: 436 tests passed, with 55 declared capability skips. Removing actor-read isolation made the intended conformance test fail.
- Normal pre-push verification on the accepted source: 36 tasks passed. Node 24.14.1 was used; the machine's Node 22.22.2 is below the repo's minimum and changes Unicode readline behavior in an existing search test.
- Built image `sha256:5bbc5dea43e504075f619560023a480fb46654d3977be9dc50c8e567d8975321`: fresh-database bootstrap, public metadata, owner signup, channel creation, and exactly one post passed. Restart retained the account session and history; an idempotent retry returned the same entry. Upgrading an earlier foundation database also passed.
- The running image remained on an internal Docker network with PostgreSQL reachable and outbound access to DorkOS hosts blocked. These checks cover the foundation only, not the final two-human/local-agent acceptance journey.

## Integration notes

The planning PR #1911 is merged. The foundation was rebased onto that merged main, including Cloud PR #1908, without textual conflicts. Combined-tree lint passed 24 tasks and typecheck passed 38. Real PostgreSQL passed 13/13 again. The full combined suite passed 37/37 tasks with `VITEST_MAX_WORKERS=2` and package concurrency limited to one. The client contributed 1,231 files and 15,458 passing tests; the server contributed 1,107 passing files and one explicit skip. Earlier high-contention runs timed out in existing memory/client tests; the exact affected files passed in isolation before the full rerun. Repository script checks passed, including 595 script Vitest cases; regenerating OpenAPI produced no change. The clean combined Docker build exposed the newly required public `packages/cloud-api` dependency. The Docker context now includes and builds it before shared. Independent review accepted the packaging fix, and image `sha256:1125ec2273327e9f2c466fecb8aaac20db6bd09b41ec87f394fc23e3e553ecf8` passed persisted-session/history/idempotency HTTP checks and blocked DorkOS-host egress. No private Cloud service is required.

Existing site, local server, and CLI retain Better Auth 1.7.2 with explicit compatible core/fetch peers; the independent app uses 1.7.5.

## Remaining work

Tasks 2.1–2.4 are assigned to `/root/implement_community_server` in `codex/community-admission`. Task 3.1 storage is assigned to `/root/implement_community_contract` in `codex/community-storage` and is undergoing independent review. Storage is preparatory until real upload/download/export routes consume it. Invitations, moderation, pairing, agent credentials, files, browser chat, local community connections, real agent dispatch, and the final packaged acceptance journey remain unfinished. Canonical requirements and dependencies remain in `03-tasks.json`; the six phases remain six coherent PR batches.
