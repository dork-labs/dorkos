# Connections Security Verification

## Overview

Use this guide to verify the security claims made by Connections before changing managed availability. It separates reviewed source behavior from fixture results and live service evidence, so a passing test cannot be mistaken for a successful production rollout.

DOR-1905 owns the final live acceptance verdict. Runtime renewal, environment filtering and hosted capacity are merged; the recorded capacity rollout passed its production migration and SQL checks. This guide can ship with live acceptance still pending. Use the tracker’s latest deployment record for a new window; the deployment IDs below are dated evidence, not current routing targets.

## Key Files

| Concern                                       | Location                                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Local connection, grant and request authority | `apps/server/src/services/connectors/`                                                                                         |
| Public REST authority checks                  | `apps/server/src/routes/connector-{management,execution,events}.ts`                                                            |
| Runtime turn identity                         | `apps/server/src/services/connectors/principal/`, `apps/server/src/services/connectors/runtime-principal-port.ts`              |
| Runtime launch seams                          | `apps/server/src/services/runtimes/{claude-code,codex,opencode}/`                                                              |
| Hosted tenant, instance and account authority | `apps/site/src/lib/connectors/managed/`, `apps/site/src/app/api/instances/connectors/`                                         |
| Hosted event intake and delivery              | `apps/site/src/lib/connectors/managed/{event-ingress-service,event-delivery-service,event-protection}.ts`                      |
| Public connector schemas                      | `packages/shared/src/connector-*.ts`                                                                                           |
| Provider SDK boundary                         | `packages/connector-providers/src/`                                                                                            |
| Hosted capacity ledger and cutover            | `apps/site/src/lib/connectors/managed/event-capacity-service.ts`, `apps/site/scripts/verify-managed-event-capacity-cutover.ts` |
| Production rollout procedure                  | `contributing/managed-connections-operations.md`                                                                               |
| User-facing trust boundary                    | `docs/self-hosting/threat-model.mdx`, `docs/connections/index.mdx`                                                             |

## When to Use What

| Question                                                                 | Evidence to use                                                                   | Why                                                                                  |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Does an authorization rule exist in the shipped source?                  | A focused public-seam test, its meaningful guard mutation, and independent review | An internal unit test can bypass the caller identity that matters.                   |
| Does the complete UI and server flow work without a vendor account?      | The registered offline provider fixture and browser suite                         | This proves DorkOS behavior while keeping credentials and outside effects out of CI. |
| Does a managed service work in one deployed environment?                 | A controlled live window against the exact deployed source                        | A fixture cannot prove OAuth, vendor custody, webhook delivery, or hosted usage.     |
| Has a vendor event definition changed?                                   | Read-only live discovery before consent                                           | The live catalog can change without a DorkOS release.                                |
| Did verification expose a defect?                                        | A separate linked signal or task with a minimal reproducer                        | A broad verification item should not hide implementation work.                       |
| Is reviewed implementation still unmerged or a deployment check missing? | Mark the claim pending and retain its exact candidate evidence                    | Source review cannot substitute for merged-source, build or live proof.              |

## Core Patterns

### Evidence States

Use one of these labels for every matrix row and recorded result:

- **Candidate-reviewed:** an exact unmerged source checkpoint passed independent review. Record remaining tests, composition and publication gates; this is not a shipped-source claim.
- **Source-proven:** the exact merged source passed a focused public-seam test, a falsification check, and independent review.
- **Fixture-proven:** a complete DorkOS flow passed against a controlled provider substitute. This does not prove a real vendor account or deployment.
- **Live-observed:** the exact deployed source produced the recorded result against the real service. Record only redacted identities, states, and timestamps.
- **Live-pending:** a real-service result is still missing or a readiness switch remains off. Do not describe that capability as available.

A row may carry more than one state. Source proof and live proof answer different questions.

### Gate Matrix

| Boundary                                            | Current state                                            | Existing proof to reuse                                                                                                                                  | Final DOR-1905 gate                                                                                                                                                              |
| --------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosted owner, tenant and instance separation        | Source-proven                                            | `managed-mounted-isolation.integration.test.ts`, `authority-service.integration.test.ts`                                                                 | Confirm the live linked instance belongs to the signed-in owner before any provider action.                                                                                      |
| Hosted account identity and revision changes        | Source-proven                                            | Authority tests for tenant-scoped identifiers, same-owner sibling refusal, provider material change, reclassification, and captured-account revalidation | Match the live account, connection, toolkit version, operation revision and instance before dispatch.                                                                            |
| Local owner, program and agent separation           | Source-proven and fixture-proven                         | Connector management/execution/event route tests; runtime MCP and access-query tests; Connections browser tests                                          | Keep the exact owner, agent and connection in every live record. Do not seed a grant.                                                                                            |
| Operation least privilege                           | Source-proven and fixture-proven                         | Exact grant replacement, reclassified revision denial, cross-actor approval refusal, and destructive classification tests                                | Run one harmless reviewed operation only. Confirm a missing or different grant never reaches the provider boundary.                                                              |
| Notification least privilege                        | Source-proven and fixture-proven                         | Exact event definition, filter, agent and destination tests; grant cleanup and subscription reconciliation tests                                         | Use the live definition returned for that account. Do not create consent if its fields cannot be rendered safely.                                                                |
| Local revoke and disconnect                         | Source-proven and fixture-proven                         | Connection lifecycle, authority cleanup, management action, execution broker and event access tests                                                      | Revoke through the owner UI and prove the next exact operation is denied before any provider call.                                                                               |
| Hosted revoke and instance-key loss                 | Source-proven                                            | Hosted terminal receipt, final-claim recheck, offline cleanup and sibling-instance refusal tests                                                         | Reconcile hosted and local records after revoke. A failed provider cleanup must not restore local authority.                                                                     |
| Webhook authentication and tenant resolution        | Source-proven                                            | Raw-route signature-before-lookup, cross-user envelope denial, encrypted content and exact binding tests                                                 | Accept only a fresh, provider-signed event for the intended owner, account, definition and active generation.                                                                    |
| Duplicate and retry handling                        | Source-proven; live-pending                              | Signed redelivery, immutable receipt, lease ownership, exact ACK and cleanup concurrency tests                                                           | Claim live deduplication only after a real retry preserves the same provider event ID. A second message is not a duplicate.                                                      |
| Event retention and cleanup                         | Source-proven                                            | Seven-day payload and 30-day metadata windows, payload clearing after durable ACK, bounded fair cleanup tests                                            | Verify live metadata and payload-present booleans only. Never archive content or a decryption key.                                                                               |
| Hosted notification intake and backlog bounds       | Merged and deployed; capacity SQL verified; live-pending | DOR-1909 capacity admission, duplicate-before-charge, terminal reservation release, retention and migration fixtures; exact policy below                 | Reuse the recorded migration/SQL-equivalent proof while its policy is unchanged; pin fresh routing for controlled delivery. Do not repeat the migration or run a live load test. |
| Prompt-injection resistance through supported paths | Source-proven and fixture-proven                         | Agent self-decision refusal, owner-only review, exact-agent grants, foreign owner/session refusal, and capability classification tests                   | Use synthetic adversarial requests through REST, MCP, CLI and runtime seams. No real model turn or external message is needed.                                                   |
| Public identity and secret hygiene                  | Source-proven                                            | Shared DTO rejection tests, event-access response leak checks, provider result-envelope tests and payload-free usage receipts                            | Sweep logs and audit/activity output with synthetic markers. Record a separate defect for any marker that crosses a public boundary.                                             |
| Runtime turn credential lifetime                    | Source-proven; live-pending                              | DOR-1903 exact-owner fences, same-bearer renewal, no resurrection and 72-hour fake-clock adapter attachment tests                                        | Pin the installed runtime build for controlled acceptance; record the rolling-lease theft tradeoff. Do not label fake-clock coverage a days-long live SDK run.                   |
| Runtime subprocess environment                      | Source-proven; live-pending                              | DOR-1904 complete environment projection at turn/default/warmup/helper launches, exact-name configuration and synthetic secret controls                  | Recheck the installed build and supported authentication/privacy settings after a controlled restart; filtering is not same-OS-user isolation.                                   |
| Managed account action and usage                    | Live-pending                                             | Deployment configuration and source/fixture proof exist; readiness remains separately gated                                                              | Use the established owner and linked instance for one harmless read, hosted/local usage reconciliation, revoke, and immediate next-call denial.                                  |
| Managed event delivery                              | Live-pending                                             | Source and fixture proof exist; real catalog and delivery remain separate                                                                                | Complete read-only definition discovery, signed delivery, local persistence, hosted ACK, room/agent outcome, revoke, bounded no-new-delivery check, and readiness restoration.   |

## Bounded Adversarial Checks

Use synthetic requests that resemble the decisions a confused or prompt-injected agent might make. Keep the requests local and deterministic.

- Ask an agent principal to approve its own operation or notification request. The decision must fail before authority changes.
- Reuse an approval, receipt, connection, session or instance identity under a different actor. The request must fail without revealing whether the foreign object exists.
- Request an operation with a missing grant, changed revision, broader classification or different connection. No provider call may occur.
- Remove an agent, grant, subscription, instance key or connection between preflight and final claim. The final claim must deny the stale request.
- Place synthetic secret markers in provider errors, operation inputs/results and hosted event content. Public DTOs, normal logs, activity and payload-free usage records must omit them.

These checks prove the DorkOS path. They do not make a process running as the same operating-system user into an untrusted sandbox.

## Runtime Security Contract

Apply this contract only to the exact merged build that contains the reviewed changes. Historical rollout observations are recorded below; obtain a fresh target from the current verification record.

A runtime-turn credential has a four-hour expiry. A trusted process-owned supervisor renews the same bearer approximately hourly while the exact turn remains active. Requests do not renew it. The renewal authority is an opaque in-process permit, not a public route or a model tool. The principal service checks current owner, row and clock again after awaited authority checks. Expired leases cannot be revived; terminal completion, cancellation, owner-slot replacement and server restart invalidate the binding. Operation grants and account revisions remain separate per-call checks.

This supports long turns without a fixed days-long cap. It also means a stolen bearer can remain useful during an ongoing authorized turn: four hours is not an absolute lifetime measured from issuance. The supervisor's bounded recovery delays do not authorize a second provider action after an uncertain first attempt.

Each Claude Code, Codex and OpenCode launch receives a complete projected environment, including default SDK, warmup, delegated-login and runtime-owned helper paths. The supported catalog preserves OS, PATH/home, Git/SSH, proxy/TLS, selected model authentication and universal `DO_NOT_TRACK` settings. Unknown parent variables are withheld. Owner configuration uses exact names under `runtimes.environment.inherit.{claudeCode,codex,opencode}`; reserved server-only names cannot be enabled there. An explicit custom name may itself carry a secret, so inheritance is an authority choice. See [configuration](configuration.md) for the migration and exact catalog rather than assuming every credential or custom tool variable is retained.

Codex's dormant `credentialRef` is not an authentication path. Its supported projected `CODEX_API_KEY`, `OPENAI_API_KEY` and `CODEX_HOME` settings and ordinary login have distinct roles. Existing processes keep their launch environment; apply changes at a safe restart without terminating active turns just to refresh configuration. Environment filtering reduces accidental inheritance. It does not isolate same-user files or processes, and it is not a policy for general terminals or the desktop shell.

## Managed Authentication Custody

Composio-managed OAuth is the default when the toolkit supports it. An existing explicit auth-config mapping takes precedence and must still match the exact enabled toolkit and method. Unsupported or developer-only schemes remain visible with a reason; catalog availability does not require a separate live test for every service.

OAuth completion requires the original owner-bound cookie and the provider’s deferred `session_uri` verifier. A callback account ID or an ACTIVE account lookup cannot replace that proof. The pinned provider contract documents deferred verification for OAuth redirects; it does not establish the same submitter identity guarantee for non-OAuth Connect Link fields.

API-key, bearer, basic and declared company fields stay on the signed-in `dorkos.ai` owner page. Values exist transiently in that form and the bounded same-origin POST, then pass to the fixed Composio endpoint. They never enter local/agent/CLI transport, browser storage, durable flow rows, logs or error output. The full POST envelope is limited to 72 KiB; its encoded fields payload is separately limited to 64 KiB, with 64 declared fields and 8192 characters per string. No-auth methods require owner confirmation with no credential inputs.

The fields page is a read-only view of one bound owner flow. Submission checks the current owner, cookie, Origin, CSRF token, expiry, metadata digest and material before atomically consuming that flow. It dispatches at most one account-create request and retains the exact returned ID for reconciliation. It creates or activates the hosted connection binding only after user/toolkit/config/ACTIVE checks. An unknown result stays reconciliation-required; refreshing or resubmitting must not create another account.

Automatic toolkit config resolution must not change the existing provider material digest. Adding another toolkit leaves captured account/config identities and grants intact. Removing the temporary Gmail ReadOnly override is a separate deliberate maintenance action, not a product migration or permanent read-only policy. Each agent’s exact operation grants still decide read/write access. See [managed operations](managed-connections-operations.md) for deployment configuration and readiness.

## Hosted Capacity Contract

The merged hosted policy sets these fixed safety limits. Confirm the deployed policy before relying on them; they are not configurable plan entitlements.

| Boundary                             | Limit                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Novel accepted webhook transactions  | 600 per tenant per database UTC minute                                                                         |
| One physical notification binding    | 100 active or reserved destinations                                                                            |
| Retained delivery rows               | 100,000 per tenant                                                                                             |
| Stored protected-payload UTF-8 bytes | 256 MiB (268,435,456 bytes) per tenant                                                                         |
| Retention sweep                      | Up to 100 tenant pages, each bounded to 100 content clears and 100 metadata deletes, within a 20-second budget |

Exact duplicates are checked before charging. They do not renew retention or replace protected content. Fanout admission is atomic, and each destination can consume a retained row. Acknowledgement releases payload bytes once; the payload-free row remains until its 30-day metadata expiry. Terminal subscription cleanup releases its reservation without reviving consent.

Capacity rejection uses generic `429 event_intake_limited`. `Retry-After` points to the next database UTC minute for rate exhaustion, 60 seconds for storage/fanout limits, or one second for lock contention. It is advice, not proof the sender will retry or space will be available. Invalid signatures, duplicates and refused requests still require work; this ledger is not edge flood protection.

Existing limits remain: raw webhook 256 KiB, normalized content 64 KiB, pull/ACK/page 100, seven-day payload expiry and 30-day receipt metadata. Hourly maintenance shares a 25-second budget between retention and pending physical-subscription cleanup; account cleanup is outside that timing claim. A running database statement and settlement can outlast the budget. See [managed operations](managed-connections-operations.md) for cleanup and retention semantics.

## Capacity Migration Cutover Procedure

This procedure records the maintenance contract for a capacity-changing migration. Do not repeat migration `0015` for ordinary source or readiness changes. A capacity migration must be planned **before production merge**, not after deployment. Vercel runs `db:migrate` before the Next build, while the previous deployment may still serve requests. Use the reviewed rollout plan and exact operational artifacts; this guide does not grant permission to improvise platform commands.

1. **Pin the candidate and Preview database isolation.** Before the first migration-capable Preview build, verify automatic isolated Neon Preview branches and absence of an unscoped Preview database fallback. After provisioning, match the exact Git branch, Preview deployment and nonproduction Neon branch/database. Configuration evidence alone does not prove that new mapping. Before production merge or any production migration process, verify inside platform custody that the migrator’s selected `DATABASE_URL_UNPOOLED` (falling back to `DATABASE_URL`) and the runtime `DATABASE_URL` address the intended same production Neon branch/database. Do not export credentials to establish identity.
2. **Pause writers before production merge.** Keep common/event readiness at `0/0`. Disable cron and activate the reviewed narrow edge maintenance policy. Cover managed instance routes, managed callbacks/webhooks, cleanup and account deletion; leave ordinary website routes untouched. Read back the complete active policy. One exclusive firewall writer is required because draft activation is not an atomic version comparison.
3. **Drain old work.** Wait at least 30 minutes after both edge pause and cron disable are confirmed. Then require fresh aggregate database activity checks, including unknown visibility and prepared transactions, plus the expected tenant census. A function timeout or an earlier quiet database sample alone does not prove quiescence.
4. **Deploy the exact reviewed source.** After the pre-merge database identity check and drain gates pass, preserve normal Git/Vercel build provenance and use one migrator to append migration `0015`. Validate the resulting database while maintenance remains active.
5. **Validate while paused.** Use the separately reviewed SQL-equivalent validator in the authenticated Neon editor. Require expected nonzero tenant census, deterministic ledger locks, matching retained rows/protected UTF-8 bytes/deadlines, and the final ceilings verdict. This is SQL-equivalent validation, not execution of the Node CLI. Millisecond deadline comparison matches JavaScript dates; exact timestamp precision is a separate diagnostic. A successful COMMIT alone is not acceptance.
6. **Exclude old routing before reopening.** Verify new deployment source, aliases and cron target. Refresh every pre-ledger deployment's aliases; deny old hosts or prove rolling aliases moved to the reviewed deployment. Recheck Skew Protection and probe canonical deployment/header/cookie routing. An inventory and a disabled setting alone do not prove which code handled a request.
7. **Keep failures contained.** On build, migration, validation or routing failure, keep readiness off and maintenance active while investigating forward repair. Flag restoration is reversible; do not invent migration rollback, drop tables or wipe data. After the required checks, keep cron disabled while preparing, publishing and verifying removal of only the maintenance rule. Verify the complete active policy and routing, preserving unrelated policy and any persistent old-host exclusion. Only then restore cron on verified new code and read back its state.

## Controlled Live Procedure

1. **Pin the source and reconcile proof.** Record merged/deployed commits, exact owner and linked instance, readiness values and accepted source/fixture evidence. Close runtime and hosted deployment prerequisites before provider dispatch.
2. **Open one account-action window.** Enable common readiness only; keep events off. Use a genuine owner-issued program key and exact agent, connection, toolkit version and operation revision. Run one reviewed harmless read, match local/hosted usage to those identities, revoke through the UI and prove next-call denial before any provider call. Never replay an uncertain action.
3. **Restore common readiness.** Return it to `0` and read back the served deployment state after success or failure.
4. **Prepare the event window.** Discover the actual account's event definition and schema. Review exact defaults/filter, receiving agent and destination, and receive consent/authority acknowledgement. Enable common and event readiness only for this separately controlled window after signing, content-key and callback checks pass.
5. **Prove offline buffering.** Stop only the owned fixture server and confirm its PID and listener are absent **before the first specifically authorized email**. Observe the exact hosted buffered receipt with payload-present metadata while it remains stopped. Restart the same instance identity and correlate that receipt with local durable state, hosted ACK and payload clearing. Room delivery is a separate outcome. A fast live ACK does not prove commit-before-ACK ordering; retain the fixture evidence for that causal claim.
6. **Prove bounded revoke behavior.** Revoke and confirm durable local/hosted authority cleanup before a separately authorized second email. Prove its arrival at Gmail and use a defined observation interval for no new authorized delivery. Do not infer universal non-delivery or physical trigger deletion. Claim live deduplication only if the same real provider event ID is redelivered; a second email is not a duplicate.
7. **Restore and report.** Read back common/events at `0/0`, revoke temporary owner keys through ordinary UI, and preserve only closed metadata. Record every missing or failed gate separately. No paid model turn, live flood or raw provider-result archive is required.

## Recorded Rollout Evidence (2026-09-09)

Runtime renewal and environment filtering merged through PR1744 at `341bafdb9a3a916572cebf0a5f81a1ceb11bf88f`. Hosted capacity merged through PR1746 at `e3db751d254ce9413aa5ec791fa5939995e322ba`. At the September 9 cutover, deployment `dpl_FNeiFX3yLh1LjcayEkoxFRuajG5m` reached READY at that source. The isolated checkout then adopted `e3db751`; its Node 24 dependency build, 103 workspace resolutions, CLI/client build and restarted health endpoint passed. These are historical source and startup observations. They do not identify today’s running deployment or prove live service behavior.

The normal Vercel build applied PostgreSQL migration0015. The production journal matches its expected entry without conflict. While maintenance remained active and cron disabled, the SQL-equivalent validator enumerated one tenant and locked its ledger. It found zero row, byte, deadline or ceiling mismatches, with zero retained rows and zero protected payload bytes. The check also passed exact deadline precision. This is real production SQL-equivalent validation, not execution of the Node verification CLI or a live load test. The earlier quiet preflight remains baseline evidence; it is not being relabeled as the post-migration check.

Owner login, local-instance linking, normal API-key issuance/revocation and a local authenticated probe were observed. Controlled common-only windows also returned the real Gmail catalog and operation metadata, then restored readiness to `0/0` and verified unavailable responses. Metadata discovery did not dispatch a provider action. None proves a successful account action, matching usage, revoke denial or signed offline event delivery; those live acceptance gates remain open. The first specifically authorized email must still follow the owned-server stop and listener-absence check.

The temporary maintenance rule was removed, the complete remaining persistent policy was read back, and hourly cleanup cron was restored. Post-removal checks saw cookie-selector denials and authenticated old-host, alias and old-cron denials. Nonempty deployment query/header selectors returned 503, not firewall denials; all four request IDs were attributed to the exact new deployment. The Advanced dashboard explicitly showed Skew Protection disabled. These combined observations found no old-code bypass in the checked requests; they do not prove every selector was blocked by the firewall. The separate action and notification windows, revoke checks, final readiness restoration and temporary-key revocation remain required. Fake-clock runtime tests do not establish a days-long live SDK run, and PGlite fixtures do not establish real PostgreSQL lock contention. Attach exact immutable evidence references in the DOR-1905 verification record and revise this verdict only when those gates complete.

## Pending Live Verdict

The dated checks above support the specific source, migration, routing and metadata claims recorded there. They do not close DOR-1905, its programme phase or the Connections programme. A granted account action with matching usage, immediate revoke denial, signed offline event delivery and the remaining cleanup checks are still pending. Record new results against their actual source and identities; never reuse an old deployment pin as a live target.

Documentation of these boundaries does not need to wait for personal account sign-in. Managed capability readiness does: publish useful security guidance while preserving the live-pending verdict and the independent action/event gates.

## Stop Conditions

Stop the live window without dispatch when any of these is true:

- The served commit or readiness values differ from the recorded target.
- Owner, tenant, linked instance, account, provider generation, operation revision or event definition cannot be matched exactly.
- An account action is not classified as the harmless reviewed operation.
- A live event field cannot be rendered and reviewed safely.
- A callback, webhook signature, content key, linked-instance permission or expected exact grant is missing.
- A previous attempt has an uncertain outcome. Reconcile its receipt before another dispatch.
- Logs or evidence would contain a credential, private provider reference, event content or account data.

## Anti-Patterns

- ❌ Treat a fixture result as proof that a vendor account or production deployment works.
- ✅ Label fixture and live evidence separately.
- ❌ Combine account-action and event acceptance into one unchecked readiness window.
- ✅ Keep events off for action proof; use both flags only for the separately prepared event window, then restore `0/0`.
- ❌ Add a broad security test because a matrix row sounds important.
- ✅ Reuse the existing public-seam test or write the smallest falsifiable check for a concrete gap.
- ❌ Replay an uncertain provider action or captured signed webhook.
- ✅ Reconcile the original durable identity and receipt.
- ❌ Claim that login, grants or environment filtering isolate software running as the same OS user.
- ✅ State which network and DorkOS paths are controlled, and keep the same-user boundary explicit.
