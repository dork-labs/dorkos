# Implementation: A self-hosted community for people and their agents

**Updated:** 2026-09-16

**Specification:** [Community server](02-specification.md)

**Acceptance tasks:** [Frozen task breakdown](03-tasks.json)

**Status:** Implemented and verified. Release closeout will be recorded on the linked work items after the remaining gates.

## Delivered behavior

`apps/community` is an MIT-licensed Hono service with a React browser client, PostgreSQL storage and persistent SSE. It runs independently of DorkOS Cloud. Docker Compose is the primary self-hosting path; the deployment guide also covers a persistent managed service and optional external object storage. The local DorkOS server remains Express and single-owner.

A community issues its own accounts, invitations and agent credentials. People can join channels, reply in threads, share files, track unread messages, manage members and export their data. A server operator can recover an account without email; recovery revokes sessions and connected installation/agent credentials. Files use filesystem or S3 storage behind one contract, with durable, non-starving cleanup retries.

People approve their local DorkOS installation in the community browser, then enroll their own local agents. The DorkOS app presents remote channels through `Transport` and the native `CommunityAdapter`; credentials stay on the local server. Agents execute on their owners' machines. Only a fresh, authorized external human mention can start a remote-room turn; history, replay and mirrored agent output do not recursively dispatch work.

Agent replies enter a transactional outbox. A stable idempotency key, authenticated receipt/echo correlation and durable pending state retain one confirmed message across retries, held responses, reloads and restarts. Every delivery rechecks the current local agent manifest. Stop, room Leave, removal and Mesh unregister revoke local execution and delivery authority before remote cleanup can finish. Room-scoped controls preserve other rooms and agents.

## Delivery and independent review

Planning merged in [#1911](https://github.com/dork-labs/dorkos/pull/1911), foundation in [#1912](https://github.com/dork-labs/dorkos/pull/1912), admission in [#1913](https://github.com/dork-labs/dorkos/pull/1913), and browser chat/files/exports in [#1914](https://github.com/dork-labs/dorkos/pull/1914). The participation changes build on merged main `9688d2db0616efb03d503bc105ef40b7541dc30e`.

Authors worked in isolated worktrees. Separate reviewers applied `REVIEW.md` to each implementation and the combined source, including real boundary and mutation checks. The final production composition was accepted at tree `10cac1ab971d9a72bf5b7a60dbf113c12fd904d4`; subsequent bounded changes received separate acceptance: exact numeric Stop assertion, routed-content ARIA capture, responsive attachment filename rendering, the measured overall test timeout, and invitation manifest status. The release record also passed independent review.

Review corrections include private-channel visibility, admission and role races, stream revocation, exact authenticated delivery correlation, live Stop/ejection ordering, stale local-manifest authority, raw attachment HTTP envelopes, and confirmed own-message visibility. The responsive attachment fix preserves the full accessible/download name while containing a legal 233-character filename within a 292-pixel mobile message column.

## Verification evidence

### Complete packaged participation

The final packaged journey exited successfully on 2026-09-16 in **101.909 seconds**: one expected test, no skips, no unexpected failures, no retries and no report errors.

The real production apps were built from clean source into `dorkos-community-acceptance:reviewed-final`, manifest `sha256:3aa6dfe659958f65b7f7fb64fe56b31bb63844411a7d381adc970c3350458e9b`. The proof image adds only the independently accepted 180-second Playwright configuration. Source hashes for the driver, configuration, attachment component, timeline surface and qualified routes match the proof image.

The journey covers:

- Two independent communities, human admission and browser-approved local connections.
- Local-agent enrollment and channel Join/Leave/rejoin.
- A fresh mention dispatched through the installed CLI's deterministic test runtime, producing exactly one confirmed agent reply and the expected PNG bytes.
- Community and local restarts, retained messages/files, and no dispatch of historical mentions.
- Two-community isolation, offline/reconnect and manual retry under the original delivery key.
- Confirmation before a held receipt, reload without duplicate history, live and held Stop, and agent ejection.
- Human posting and PNG upload/download after agent removal.
- Unread navigation, local thread reply identity, mobile keyboard return to the channel and no horizontal page overflow.

No live inference service or paid model credential enters this runtime. The sealed-network proof records `postgresReachable: true`, `publicIpReachable: false` and `dorkosReachable: false`.

The successful bundle is `.temp/community-acceptance/run.WW3ZPH` in the final integration worktree: seven screenshots, an attached mobile ARIA snapshot, three recorded browser pages, the JSON report and network proof. Preserve it in the private programme archive before worktree removal. Earlier failed diagnostics are retained as diagnostic history, not substituted for this successful result.

The 180-second overall timeout follows a measured run whose last behavior assertion completed around 114 seconds before the prior 120-second budget expired during browser/video context cleanup. Individual assertion and helper deadlines remain unchanged.

### Service, contract and browser checks

- Real PostgreSQL and native HTTP conformance: 100 passing tests with four declared capability exclusions.
- Standalone community browser: three passing cases across two files against real PostgreSQL.
- Current focused participation checks: 54 passing tests across qualified routes, mirrored lifecycle, client transport and the remote community surface.
- Combined typecheck/lint: 33 successful tasks; existing warnings remain.
- Fresh full repository verification: all 35 tasks passed in 25m27.068s, with 26 cached. The server passed 1,117 files and 19,070 tests, with two declared skipped files and 55 skipped tests. The client passed all 1,240 files and 15,507 tests.
- Regenerating OpenAPI produces no change.

Guard mutation checks demonstrated failure when live/read-only dispatch protection, external-author permission confinement or mirrored-output recursion suppression was removed, with green baselines restored afterward. The recursion case uses the same mention-only engagement policy in local and remote positive controls. Reintroducing the old ejection ordering caused two unauthorized turns instead of zero. Replacing numeric Stop with a boolean fails the response-schema assertion; weakening the raw upload envelope fails the real HTTP attachment test.

Desktop, dark tablet and mobile captures have been inspected. The earlier theme-transition capture issue is corrected by finishing animations before the relevant screenshots. The successful final bundle passed a separate visual, ARIA and video inspection: named controls and feed content are present, all seven screenshots are readable, and all three recorded pages have normal metadata and valid rendered frames.

### Dependencies and packaging

The production license inventory was independently revalidated against lockfile SHA-256 `cae609e4f4d877bcfed47430e5193a4b47079aed528611e26b0abb4542e66f35`. All 80 records match installed package names, versions and license metadata; the shared workspace package resolves to the repository MIT license. This is metadata evidence for the pinned dependency closure, not a legal certification or a future-dependency check.

The public build includes `packages/cloud-api` as a public package, without requiring the private Cloud service. The community uses its own Better Auth instance; existing local server, site and CLI authentication remain independent.

## Release closeout

The release must pass review of the exact pushed branch and the required merge-queue checks. Close DOR-589, DOR-594, DOR-595 and DOR-596 together only after those gates finish. Their completion record retains the final PR/merge result and archive location. Preserve every unique commit and evidence bundle before removing owned programme worktrees and test resources; implementation verification alone is not programme closeout.
