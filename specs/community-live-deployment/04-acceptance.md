# Live deployment acceptance

Work item: DOR-2167. Source revision: `c4556d86d674f2049c03840080b09a87ca790b9f`.

Status: **operational acceptance checks passed**. Review and merge are tracked in DOR-2167.

## Deployment

The independent Community service runs at <https://spaces.dorkos.ai> on one always-on Fly Machine in Virginia, with a separate Neon PostgreSQL 17 database in US East and private Tigris file storage. It does not use the Cloud control plane, Cloud credentials, or Cloud database. The database connection verifies the TLS certificate. Startup applied migrations 1–4 before readiness passed.

The operator created **Founding Community** and its owner account through the canonical HTTPS site. The bootstrap secret was rotated afterward. The temporary Fly hostname was used only for unauthenticated infrastructure checks. Authenticated streaming and reconnect checks followed owner creation on the canonical domain. Wrong-origin writes from the temporary hostname returned 403.

Provider identifiers, secrets, database dumps, and raw operational logs remain in a private directory outside the repository. The deployment retains one Fly Machine, its domain/certificate, the separate Neon project, and the private Tigris bucket; these are the intended live resources, not temporary test resources. The public deployment guide is maintained separately in DOR-2190.

## Verified on September 20, 2026

| Check                    | Evidence                                                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private file storage     | A checksum-verified storage canary round-tripped; anonymous access returned 403; the canary was removed.                                                                     |
| Two people               | Owner browser plus a separate Chrome incognito session signed in as the temporary invited member. Both posted in #general.                                                   |
| Threads                  | The owner replied to the test member’s post in a thread.                                                                                                                     |
| Attachments              | The test member uploaded a text file; authenticated download matched its SHA-256.                                                                                            |
| Idempotency              | Repeating the same post request returned the same entry without another post.                                                                                                |
| Live stream              | One new post arrived once on the open SSE stream.                                                                                                                            |
| Reconnect                | Resuming from a saved cursor returned the post exactly once, with no duplicate replay entries. Resume history arrives in the initial snapshot as well as later entry events. |
| Local app                | A separately built DorkOS CLI 0.75.1 connected through the actual approval flow and displayed #general and its messages.                                                     |
| Agent                    | One explicit mention triggered one deterministic local agent reply and one PNG attachment. Remote and local download bytes matched. No paid inference was used.              |
| Restart                  | After restarting the single Machine, the member session, original owner post, test history, unique agent reply, and file checksum remained valid.                            |
| Redeploy                 | Redeploying the same pinned image preserved those results. The owner browser remained signed in.                                                                             |
| Agent reconnect          | The local subscription completed snapshot and replay after redeploy; its dispatch count remained one.                                                                        |
| Member revocation        | Owner removal returned the separate browser to sign-in. The old API session received 401 for member identity, history, attachment download, and SSE.                         |
| Temporary access cleanup | The temporary member, test agent, and acceptance installation grant were removed. The user’s community, owner, and posts remain.                                             |

The restart and rolling redeploy caused a brief interruption. One browser navigation during redeployment failed and succeeded after the service recovered; this is not a zero-downtime deployment claim.

## Recovery rehearsal

Writes were paused by disabling Fly proxy autostart and stopping the single Machine. An external health request could not restart it. A PostgreSQL 17 custom-format dump and all private bucket objects were captured together; the live service was then resumed and its health verified.

The backup restored into a private Docker network using PostgreSQL 17 and the exact deployed application image. Its filesystem storage held the copied objects. Source and restored digests matched for user/account identity and password state, member roles and activity, channel membership, ordered history, and attachment metadata. The snapshot contained one community, two accounts, one active member, ten entries, and two attachments; migrations 1–4 matched. Every restored attachment matched its recorded byte count and SHA-256.

The original owner password was not available to the test runner. After the unchanged restore had passed the digest comparison, the product’s offline recovery command changed only the isolated owner password. HTTP checks inside that container then proved owner sign-in and role, preserved history, both attachment downloads, and rejection of the removed member: old-session file access returned 401 and a new sign-in could not restore membership (403). The live owner password and session were untouched.

The first host-side health probe could not reach the app because Docker’s internal network did not publish the port. A direct in-container HTTP probe proved the same image healthy. The repeatable rehearsal script now uses that private HTTP path. No alternate application image or weakened network isolation was needed. The isolated containers, network, and volumes were removed; the private matching backup pair remains outside the repository.

## Findings and limits

- After remote installation revocation, the local app denies the attachment but reports 502 “Community unavailable.” and still lists the connection as connected. DOR-2191 tracks the status/error handling fix; no file bytes were returned.
- The local proof app is an isolated test installation. The operator’s regular DorkOS app has not been configured by this acceptance run.

## Connect an existing DorkOS app

1. Open **Connections**, then **Messaging**, then **Communities**.
2. Add `https://spaces.dorkos.ai` and follow the approval link.
3. Sign in to Founding Community and approve the installation you just started.
4. Return to DorkOS and open **#general** under Founding Community.
5. To let an agent participate, add it from the channel’s member panel and join it to the channel. Mention its community handle when you want a reply.

A community account and a local DorkOS installation are separate. Removing an installation’s access does not remove the person’s community account.
