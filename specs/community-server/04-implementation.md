# Implementation Summary: A self-hosted community for people and their agents

**Created:** 2026-09-16  
**Last Updated:** 2026-09-16  
**Spec:** specs/community-server/02-specification.md

## Progress

**Status:** In Progress  
**Tasks Completed:** 15 / 25 (foundation, admission, files/exports and browser independently accepted; later local integration and remaining PR merges pending)

## Foundation: tasks 1.1–1.6

Workers `/root/implement_community_contract` and `/root/implement_community_server` implemented the shared contract and Hono server in separate worktrees. Reviewer `/root/review_community_foundation` independently applied `REVIEW.md`. Root integrated both branches and tested the built Docker image.

The public contract includes versioned metadata, channels, entries, durable cursors, explicit acting identities, and capability-aware conformance. Private credential responses have their own server-only schemas. Existing local and Buzz communities explicitly refuse unsupported acting identities.

The new app owns PostgreSQL migrations, Better Auth, one-owner bootstrap, channel membership, roles, ordered idempotent posts, one-level replies, resolved mentions, read cursors, and replayable SSE. Docker packaging and a required real-Postgres CI job accompany the app. The first batch supplied a status shell; the chat browser is part of the later phase 3 checkpoint.

Independent review reproduced and fixed five issues: private-channel discovery by unjoined administrators, a read-cursor membership race, incorrectly protected public metadata, stale-role writes after demotion, and streams surviving original-session revocation. The accepted source was `eba138949880f3e0791e07d2ef849132f18ef875` before rebasing onto merged planning commit `c181c414fc6c9eabb4c25f9cd4dbf6e75163710c`.

## Verification evidence

- Real PostgreSQL: 13 integration tests passed after review corrections. The session-revocation mutation made the intended stream test fail; restoring the guard returned the suite to green.
- Shared contract and existing community behavior: 436 tests passed, with 55 declared capability skips. Removing actor-read isolation made the intended conformance test fail.
- Normal pre-push verification on the accepted source: 36 tasks passed. Node 24.14.1 was used; the machine's Node 22.22.2 is below the repo's minimum and changes Unicode readline behavior in an existing search test.
- Built image `sha256:5bbc5dea43e504075f619560023a480fb46654d3977be9dc50c8e567d8975321`: fresh-database bootstrap, public metadata, owner signup, channel creation, and exactly one post passed. Restart retained the account session and history; an idempotent retry returned the same entry. Upgrading an earlier foundation database also passed.
- The running image remained on an internal Docker network with PostgreSQL reachable and outbound access to DorkOS hosts blocked. These checks cover the foundation only, not the final two-human/local-agent acceptance journey.

## Integration notes

The planning PR #1911 and foundation PR #1912 are merged. The foundation was rebased onto that merged main, including Cloud PR #1908, without textual conflicts. Combined-tree lint passed 24 tasks and typecheck passed 38. Real PostgreSQL passed 13/13 again. The full combined suite passed 37/37 tasks with `VITEST_MAX_WORKERS=2` and package concurrency limited to one. The client contributed 1,231 files and 15,458 passing tests; the server contributed 1,107 passing files and one explicit skip. Earlier high-contention runs timed out in existing memory/client tests; the exact affected files passed in isolation before the full rerun. Repository script checks passed, including 595 script Vitest cases; regenerating OpenAPI produced no change. The clean combined Docker build exposed the newly required public `packages/cloud-api` dependency. The Docker context now includes and builds it before shared. Independent review accepted the packaging fix, and image `sha256:1125ec2273327e9f2c466fecb8aaac20db6bd09b41ec87f394fc23e3e553ecf8` passed persisted-session/history/idempotency HTTP checks and blocked DorkOS-host egress. No private Cloud service is required.

Existing site, local server, and CLI retain Better Auth 1.7.2 with explicit compatible core/fetch peers; the independent app uses 1.7.5.

## Admission: tasks 2.1–2.4

Worker `/root/implement_community_server` implemented invitations, membership changes, installation pairing, and agent credentials in an isolated worktree. Reviewer `/root/review_community_foundation` independently applied `REVIEW.md`; root integrated the accepted changes onto the foundation.

Signed invitations have server-side records, bounded seats and expiry, a short-lived signup grant, and transactional redemption. Members can be removed, leave, or transfer ownership. Pairing requires a private verifier and browser approval; approval and decline never expose personal or agent credentials to the browser. Agent enrollment, channel membership, token rotation and removal retain the human owner's authority and shared quotas.

Independent review exercised concurrent promotion/removal, credential revocation during a database wait, ownership transfer against agent ejection, and one-connection database pools. Corrections recheck authority after locks, use the held transaction client, and lock the member before the original cookie session. The final ordered-lock mutation reproduced the intended deadlock failure; restoring the correction returned all 27 PostgreSQL tests to green. The accepted source is `48191843285d903d7e8647ce0ab950d6aec4ad44` before consolidation.

Normal pre-push validation passed all 37 tasks on the accepted source, including 1,231 client files and 1,107 server files (one explicit server skip). Admission validation: PostgreSQL 27/27, unit tests 7/7, Chromium pairing tests 2/2, build, typecheck, lint, and normal repository hooks. The browser proof covers mobile keyboard focus, literal installation names, approval, decline, and secret-free responses. These changes also address the two SSE/history review nits on foundation PR #1912.

## Files and browser: phase 3

Workers `/root/implement_community_contract` and `/root/implement_community_server` implemented the storage backend and browser in separate worktrees. `/root/finish_community_browser` took over the browser checkpoint. The backend tasks 3.1, 3.2 and 3.5 have independent `REVIEW.md` acceptance at `5291f11b6`, integrated with the final admission fixes at `4bcffb774`. Browser tasks 3.3–3.4 were independently accepted by `/root/review_community_delivery` at `4105fa3fb1174ff8f1cedb1957ba59670b4f24af`, following review corrections.

The backend includes bounded filesystem/S3 storage, verified file types and checksums, idempotent uploads, membership-checked streaming downloads, transactional entry binding, owner quotas, unused-file cleanup, and private personal/owner ZIP exports. Review corrected upload-finalization pool exhaustion, missing owned-agent channels in personal exports, and a stream revocation race during attachment lookup. Integrated checks passed PostgreSQL 39/39, real MinIO 1/1, unit 18/18, build, lint and typecheck. A Docker image passed invitations, private pairing, an agent-attributed threaded reply with a file, exact download and export boundaries, then restart persistence. This does not yet prove dispatch through a local runtime.

The same-origin browser covers owner setup, sign-in, invitation admission, configured OAuth choices, channels, history, threads, live updates, read cursors, files, member/agent/grant controls, exports, leaving and ownership transfer. Its support endpoints return only public identity, member and sign-in-availability data. Agent roster entries can name their human owner without exposing email or credentials.

Author verification passed PostgreSQL 41/41 and three real-Postgres Playwright tests. The browser scenario uses separate owner/member/observer contexts. Root inspected populated mobile, desktop thread/composer, dark tablet, admission, member administration and file-rejection screenshots. Review led to a corrected thread/composer layout, a confirmed zero read count after the final file post, and a repair action for unsupported files while preserving the draft. Transient errors alone offer retry. Independent review fixed delayed history overwriting live entries, cross-channel response races, reconnect error recovery, stale ownership controls, the documented invitation fragment, and agent removal routing. The reviewer and root each ran all three real-Postgres browser tests successfully. Required CI now runs the browser tests and rejects skipped, empty, incomplete or retried reports. No dedicated React Testing Library component suite is claimed.

Root combined validation passed PostgreSQL 41/41, Chromium 3/3 with the nonzero browser census, and typecheck. Two earlier runs hit the unchanged 30-second backlog replay deadline. Replacing repeated per-entry authentication hydration with fresh exact-credential SQL checks retained post-enrichment authorization and reduced the 269-entry replay to 6.2 seconds in the successful combined run. A personal-grant revocation regression checks that a later committed post is not delivered to the revoked stream. Independent review of this final stream delta is in progress.

## Remaining work

Root integrated the accepted phase 3 browser and storage backend in `codex/community-storage`. Worker `/root/remote_conformance_delivery` owns native HTTP conformance after accepted connection setup task 4.1; `/root/finish_community_browser` proceeds to authorized mirrors in its own worktree. Authorized mirrors, local routing, real agent dispatch and reliable outgoing delivery, local app surfaces, and the final packaged acceptance journey remain unfinished. Privileged offline password recovery and browser CI enforcement have independently accepted preparatory commits for phase 6, but that phase is not complete. Canonical requirements and dependencies remain in `03-tasks.json`; the six phases remain six coherent PR batches.
