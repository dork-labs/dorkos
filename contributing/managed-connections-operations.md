# Managed Connections Operations

## Overview

Use this guide to deploy, verify and maintain DorkOS-managed accounts and notifications. It separates code readiness from real service availability, and explains how to stop access without losing recovery records.

The recorded managed deployment has its readiness switches off. Its project key, callback verifier and event secrets were provisioned. Owner sign-in, local-instance linking and controlled catalog/schema discovery have been observed. Real account-action, usage, revoke-denial and notification proof remains pending. Pin the actual current deployment and keep both readiness switches off outside the controlled proof windows below. See [Connections security verification](connections-security-verification.md) for the dated rollout evidence and open gates.

## Key Files

Paths below are relative to the repository root.

| Responsibility                                                   | Location                                                                                                                                                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Environment validation and availability                          | `apps/site/src/env.ts`; `apps/site/src/lib/connectors/managed/config.ts`                                                                                                                  |
| Existing site deployment, migrations and hourly cleanup schedule | `apps/site/vercel.json`; `apps/site/drizzle.config.ts`; `apps/site/src/app/api/cron/cleanup/route.ts`                                                                                     |
| Owner, tenant and linked-instance authority                      | `apps/site/src/lib/instance-service.ts`; `apps/site/src/lib/connectors/managed/{request-context,authority-service}.ts`                                                                    |
| Browser account linking                                          | `apps/site/src/lib/connectors/managed/authentication-service.ts`; `apps/site/src/app/connectors/managed/authorize/route.ts`; `apps/site/src/app/api/connectors/managed/callback/route.ts` |
| Composio SDK and material identity                               | `packages/connector-providers/src/composio/{hosted-client-factory,sdk-client,event-client,webhook-verifier}.ts`                                                                           |
| Hosted event intake, capacity, buffer and cleanup                | `apps/site/src/lib/connectors/managed/{event-capacity-service,event-ingress-service,event-delivery-service,event-cleanup-service,event-protection}.ts`                                    |
| Local event setup, recovery and delivery                         | `apps/server/src/services/connectors/events/`; `apps/server/src/services/connectors/event-inbox-store.ts`; `apps/server/src/index.ts`                                                     |
| Private session acceptance and dispatch                          | `apps/server/src/services/session/private-messages/acceptance.ts`; `apps/server/src/services/session/{message-dispatcher,trigger-turn}.ts`                                                |
| Delivery and metadata retention policy                           | `packages/shared/src/connector-event-schemas.ts`                                                                                                                                          |
| Hosted usage receipts                                            | `apps/site/src/lib/connectors/managed/usage-service.ts`                                                                                                                                   |

See [Environment Variables](./environment-variables.md), [Adding a Connector](./adding-a-connector.md) and [API Reference](./api-reference.md) for their existing reference material.

## When to Use What

| Situation                                                       | Action                                                                               | Boundary                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Launch DorkOS-managed account access                            | Follow the controlled production proof below.                                        | DorkOS supplies the server project key; the owner reviews access.                      |
| Operator brings a Composio project                              | Use local BYO setup in Connections.                                                  | It requires no DorkOS cloud link; local keys remain local.                             |
| People talk with agents through Slack or Telegram               | Use Messaging.                                                                       | Existing native chat connections keep owning ordinary chat ingestion.                  |
| Account events should reach an agent, room or supported channel | Create an explicit receive subscription.                                             | Operation access does not authorize notifications.                                     |
| Change an event filter, agent or destination                    | Revoke the old subscription and create a reviewed replacement.                       | Standalone subscription editing/pause is deferred; connection pause remains available. |
| Stop new managed event intake                                   | Set the event readiness flag to `0` and apply the deployment change.                 | Buffered recovery remains possible. Revoke scope to stop queued delivery.              |
| Stop an affected account or instance                            | Pause/revoke its local scope; revoke its linked-instance authority when appropriate. | Check both hosted and local state. An already sent effect cannot be recalled.          |
| A provider result is unknown                                    | Inspect the existing receipt and reconcile using its original identity.              | Do not resend an uncertain effect as a new operation.                                  |

Hosted relay for a BYO project is deferred. The supported choices are direct BYO events and separately managed accounts.

## Core Patterns

### Keep preparation unavailable

These nonsecret deployment values keep new managed capabilities unavailable while configuration is prepared:

```dotenv
DORKOS_MANAGED_CONNECTORS_ENABLED=0
DORKOS_MANAGED_CONNECTORS_LIVE_READY=0
DORKOS_MANAGED_CONNECTOR_EVENTS_LIVE_READY=0
DORKOS_MANAGED_CONNECTOR_AUTH_CONFIGS={}
```

The common `LIVE_READY` gate covers catalog, account authentication and execution. Authentication also needs the callback origin and either a validated explicit override or a supported resolved default for the selected service. Events additionally require their own readiness gate, signing secret and usable content key ring. A configured webhook secret alone is not a successful event smoke test.

Missing signing or payload configuration keeps events unavailable without disabling otherwise configured account operations. Malformed shared configuration can reject the whole managed request. Validate configuration before changing a deployment.

Buffered pull and acknowledgement authenticate the linked instance independently of SDK/readiness flags. Pull still needs the correct payload decryption keys and current receive authority. An acknowledgement clears the hosted copy only after durable local inbox persistence; it does not mean a session queue, agent or channel has received the event.

### Resolve each service's authentication method

Managed discovery covers the current paginated Composio catalog. Do not restore a toolkit allowlist. Resolve authentication for each service in this order:

| Condition                                                                    | Result                                                                                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| An explicit deployment auth-config override exists                           | Validate and use that exact override. A missing, mismatched or unusable override fails closed; it must not fall through to another method. |
| Composio declares a supported managed OAuth method                           | Provision or reuse the managed configuration and open the owner-bound consent flow. The consent page may name Composio.                    |
| Composio declares supported account fields                                   | Show the owner-bound hosted form. Field values stay off the local transport.                                                               |
| Composio declares that no authentication is needed                           | Ask the owner to confirm the service and account context before continuing.                                                                |
| The service needs unsupported authentication or custom developer credentials | Keep the service visible with the exact prerequisite. Do not present an OAuth button that cannot work.                                     |
| Metadata is unknown, malformed or contradictory                              | Fail closed for that service without rejecting unrelated valid catalog entries.                                                            |

OAuth scopes determine which operations the connected account can expose. An explicit grant then limits a named agent to reviewed operation revisions. Do not turn the Gmail Read Only production fixture into a product-wide Gmail rule; other reviewed Gmail connections may expose write operations when their consent scopes allow them.

[Composio-managed apps](https://docs.composio.dev/docs/authentication/custom-app-vs-managed-app) use shared quotas and default scopes, and their polling triggers have a 15-minute minimum interval. Do not apply that interval to webhooks or ordinary Slack and Telegram Messaging.

The hosted account form belongs on `dorkos.ai`, under the signed-in owner session and single-use flow binding. It must identify the service and account context, render provider-declared labels as text, mask secret fields, and return accessible validation errors without echoing values. Keep ordinary DorkOS login visually separate from service credentials. Values may exist only in the page's form memory and site process memory while the fixed Composio request is in progress. Do not persist them, put them in URLs or logs, echo them in a response, or send them to the linked installation or agent.

Automatic toolkit configurations are stored outside the global provider material digest. Adding a service must not pause existing connections or revoke grants. Existing bindings keep their captured configuration identity; a metadata or display-name change does not select a newer account. Changing an explicit map remains a deliberate material rotation.

Do not substitute a generic Composio-hosted field link. Composio documents deferred owner verification for OAuth redirects, but not for every supported account-field scheme. The DorkOS form keeps field completion inside the signed-in owner flow.

### Keep each secret with its owner

| Material                                              | Stored by                                                            | Use                                                                                                                                        |
| ----------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Managed Composio project key                          | Server-only deployment secret for `apps/site`                        | DorkOS's calls to the dedicated Composio project. Never reuse an operator's BYO or tracker key.                                            |
| Service OAuth tokens                                  | Composio's vault                                                     | Access to the connected Gmail, Notion or other service account. Agents receive neither the token nor its provider handle.                  |
| Hosted account fields                                 | Transient site process memory, then Composio's vault                 | API keys, passwords or similar provider-declared values. DorkOS does not store them; the local installation and agents never receive them. |
| Linked-instance key                                   | The linked local DorkOS installation's credential storage            | Authenticated calls to DorkOS hosting. Owner, tenant and instance derive from verified server state.                                       |
| Managed webhook signing secret                        | Server-only site deployment secret                                   | Verify incoming raw webhook bytes before resolving a stored subscription.                                                                  |
| Managed event content keys                            | Independent site deployment key ring                                 | Encrypt retained event content. Never derive these keys from the project key or signing secret.                                            |
| BYO project/signing keys and local event content keys | The local encrypted credential store                                 | Direct BYO intake and local protected content, without a cloud link.                                                                       |
| Browser completion secret                             | A short-lived HttpOnly cookie, with only its hash stored server-side | Bind one owner browser to the single-use callback. The URL nonce is not this secret.                                                       |

Usage and audit records contain identifiers, outcomes, timing and payer attribution. They exclude arguments, results and event content. Those records support future billing work; this programme does not turn billing on.

### Configure the actual fields

Keep secrets in the deployment secret manager, not in documentation, screenshots, shell history or review artifacts.

| Environment name                              | Expected value and purpose                                                                                                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DORKOS_MANAGED_CONNECTORS_ENABLED`           | `0` or `1`; defaults to `0`. Deployment switch for new managed capabilities.                                                                                                                                                         |
| `DORKOS_MANAGED_CONNECTORS_LIVE_READY`        | `0` or `1`; defaults to `0`. Common readiness decision for catalog/authentication/execution.                                                                                                                                         |
| `DORKOS_MANAGED_CONNECTOR_EVENTS_LIVE_READY`  | `0` or `1`; defaults to `0`. Additional event readiness decision.                                                                                                                                                                    |
| `DORKOS_MANAGED_COMPOSIO_PROJECT_KEY`         | Dedicated Composio project API key, server-only.                                                                                                                                                                                     |
| `DORKOS_MANAGED_COMPOSIO_API_ORIGIN`          | Optional fixed upstream origin. Production normally omits it and uses the SDK's Composio origin. Never accept a browser-provided URL.                                                                                                |
| `DORKOS_MANAGED_CONNECTOR_CALLBACK_ORIGIN`    | Canonical HTTPS origin, with no path, query, credentials or fragment. Production callback path is `/api/connectors/managed/callback`.                                                                                                |
| `DORKOS_MANAGED_CONNECTOR_AUTH_CONFIGS`       | JSON object mapping exact toolkit slugs to explicit auth-config overrides. An override takes priority and must validate. An empty `{}` leaves supported managed defaults available.                                                  |
| `DORKOS_MANAGED_CONNECTOR_WEBHOOK_SECRET`     | Project webhook signing secret, at least 16 characters. Registered receiver path: `/api/connectors/managed/events`.                                                                                                                  |
| `DORKOS_MANAGED_CONNECTOR_EVENT_PAYLOAD_KEYS` | JSON object with `activeKeyId` and `keys`. Each key ID uses 1–64 ASCII letters/digits/underscore/hyphen. Each value is a base64-encoded 32-byte key. The active ID must exist. Maximum serialized configuration size is 8,192 bytes. |
| `CRON_SECRET`                                 | Existing server-only cleanup authentication secret. Missing or wrong bearer authentication produces 401 and runs no cleanup.                                                                                                         |
| `DATABASE_URL`                                | Existing Neon database connection for the target environment. Keep it aligned with the site's Better Auth/instance data.                                                                                                             |

The existing site also needs its usual identity configuration, including `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`. Follow the existing account deployment guide; do not create another identity system for Connections.

### Verify configuration logic without live calls

From the repository root, this scoped test checks the implemented availability rules:

```bash
pnpm vitest run apps/site/src/lib/connectors/managed/__tests__/config.test.ts
```

A passing test validates code behavior. It does not verify an owner sign-in, connected account, approved action, or provider delivery.

## Anti-Patterns

- ❌ Enable readiness because fixtures passed. ✅ Record a controlled real-service smoke for that environment and capability.
- ❌ Treat `EVENTS_LIVE_READY=0` as deletion of queued content. ✅ Revoke the affected receive authority and inspect hosted/local receipts.
- ❌ Rotate every secret by replacing all key material at once. ✅ Rotate signing, provider and content keys according to their separate recovery rules.
- ❌ Recreate an unknown operation to get a fresh ID. ✅ Recover the existing receipt; keep uncertainty visible.
- ❌ Delete a shared or borrowed BYO trigger merely because one destination was removed. ✅ Close local consent first and respect proven upstream ownership.
- ❌ Claim notification completion means a person read it. ✅ Report the actual destination receipt or turn outcome.

## Deploy and Prove Availability

1. **Pin the release and target.** Use the merged, reviewed source. Confirm the recorded Vercel target `dopel/dorkos-web`, selected environment, database, callback origin, and served commit. Preserve evidence outside disposable worktrees.

2. **Provision only the intended services.** The dedicated project key, callback verifier, webhook signing secret, and payload keys are provisioned. The controlled Gmail fixture also uses its explicit custom OAuth app and auth config. Read deployment secrets back without copying values into evidence. The Google app remains in Testing for the owner account. Do not describe the fixture, its read-only scopes, or its consent screen as the default for every managed service.

3. **Deploy migrations before capabilities.** `apps/site/vercel.json` runs `pnpm db:migrate` before the site build. Confirm the target migration journal includes the managed tables and all append-only event migrations. Preserve old SQL and snapshots. Verify the deployment completes while readiness remains off. A failed migration or build is a failed rollout, not a reason to skip migrations.

4. **Run a controlled production account smoke.** Preview is protected by a platform login that the linked local server cannot cross. Keep Preview readiness off. Temporarily enable the non-event gates in Production for the owner test account. Link a real DorkOS instance, connect the exact Gmail account, and review one harmless read that the current catalog classifies as read-only. Execute it through DorkOS. Match its immutable revision, logical operation, and attempt to hosted and local usage. Revoke the grant or connection and prove the next call is denied. Record only redacted outcomes and stable internal test references.

5. **Run a separate production event smoke.** Keep common and event readiness independent. Create exact receive consent, deliver a real signed event, and prove hosted persistence, local persistence before ACK, intended destination delivery, and a truthful receipt. Confirm duplicates do not create a second local effect and revoked receive consent blocks another event. Verify the cleanup job runs and report its bounded counts. Read actual timing metadata; polling and unknown timing are not instant webhook promises.

6. **Restore the gates.** The flags are deployment-wide, not owner allowlists. Restore both readiness values to `0` after the bounded proof while Google OAuth remains in Testing. If any step fails, restore the relevant gate before diagnosis or retry. A rollout that needs narrower exposure requires an explicit reviewed gating change.

7. **Publish the evidence status.** Record deployment SHA/environment, timestamp, tested service, account flow outcome, reviewed read/receipt match, revoke denial, event receipt and cleanup outcome. Keep credentials, provider-private IDs, auth URLs, cookies and message content out of artifacts. Record a missing key or OAuth approval as the exact pending gate. Do not substitute an offline fixture result.

## Rotate Keys Without Losing Recovery

**Project key, auth-config map or upstream origin:** these values participate in the hosted provider material digest. A changed digest advances the material generation when registered, pauses existing connections and revokes old grants. Rotation is not transparent reuse of old authority. Plan a maintenance window, let pending sign-in flows settle or restart them, deploy the intended material, then reconnect/review through the owner path and repeat harmless-read/revoke proof. Never edit stored generations or grants to bypass this behavior.

**Webhook signing secret:** the current verifier accepts one configured secret, not an old/new overlap ring. Coordinate the provider-side registration and deployment change. There may be an intake gap; do not promise replay unless the provider's actual retry policy supports it. Set event readiness off during an unsafe transition, keep payload keys available for existing buffered content, then verify a newly signed event before restoring readiness. A signing-secret change is not content-key rotation.

**Payload key ring:** add a new independent 32-byte key under a new ID while retaining existing keys. Set `activeKeyId` to the new ID and apply the deployment change. New content uses that key; old content still needs its original key. Retain an old key until its original seven-day content window has elapsed and successful retention/ACK evidence shows no protected rows need it. Retention can lag while maintenance is unavailable, so elapsed time alone is not deletion proof. An unknown ciphertext key fails closed; restoring the correct old key can recover access. Never substitute the active key, regenerate an old ID, extend event expiry or return plaintext as a fallback.

**Linked-instance key:** use the existing revoke/relink flow. Keys missing the dedicated event permission require the established upgrade/relink path. A same-owner key for another instance cannot recover this instance's leases or cleanup authority. Do not synthesize bearer tokens for maintenance.

## Retention and Recovery Limits

Hosted notifications have fixed service safety ceilings. These are deployment safeguards, not
plan entitlements or owner-configurable quotas:

| Boundary                         | Fixed ceiling                                                                |
| -------------------------------- | ---------------------------------------------------------------------------- |
| Novel accepted events            | 600 per tenant per UTC minute                                                |
| One physical notification source | 100 active or reserved destinations                                          |
| Retained inbox receipts          | 100,000 per tenant                                                           |
| Protected payload storage        | 256 MiB per tenant                                                           |
| Cleanup work                     | 100 tenant pages of 100 content clears and 100 metadata deletes, within 20 s |

An exact redelivery does not spend another arrival unit or create another receipt. Fan-out does:
one accepted event with 20 destinations adds up to 20 retained rows. Acknowledgement clears the
protected payload and releases its bytes, but the payload-free receipt remains for deduplication
until its 30-day metadata expiry. At the 100,000-row ceiling, a tenant can retain roughly 3,333
receipts per day over 30 days. Row exhaustion may therefore continue after every payload has been
acknowledged and until metadata retention frees rows.

The signed receiver returns the same `429 event_intake_limited` response for every capacity reason.
`Retry-After` is a positive retry hint. It does not promise that room will exist then or that the
upstream sender will retry without loss. The 600-per-minute budget limits novel accepted work; it
does not rate-limit invalid signatures, duplicates, or refused requests before the database. Edge
flood protection remains a deployment concern outside this service ledger.

- Managed event delivery expires seven days after verified reception. Pull, retry and local handoff preserve that original deadline.
- Hosted payload is cleared after durable local ACK. Local protected content remains until a truthful terminal destination/turn outcome, or expiry. Queue acceptance alone does not clear content needed for protected dispatch.
- Physical deletion runs on the next successful bounded sweep. A powered-off local app cannot erase its files; startup cleanup must precede resumed dispatch. Do not promise deletion at the exact expiry instant.
- Payload-free dedupe/receipt metadata uses a separate 30-day policy and bounded sweeps. This is not a retention promise for provider-owned data or for every usage/billing record.
- Raw webhook requests are capped at 256 KiB, normalized event content at 64 KiB, and batch operations at 100 rows. Signatures outside the 300-second window are rejected. Only proven V1/V2 trigger envelopes are accepted; V3 lifecycle payloads are not trigger support.
- Hosted pull leases last at most 60 seconds and never outlive event expiry. Local retry before dispatch is bounded to eight attempts and the original expiry. Once a send may have happened, quarantine the uncertain outcome; do not resend blindly.
- Channel delivery uses the exact authorized Slack/Telegram destination and at most 4,000 characters, including a shortening notice. It does not persist another payload in Relay Maildir, buffers or dead letters. A native send receipt is not a human-read receipt.
- Agent delivery uses the shared durable private acceptance/dispatcher. Recovery keeps the recorded session origin. It does not choose a recent session or create another queue owner. A dispatch interrupted before an observed turn start remains unknown rather than automatically sent again.
- Direct BYO offline delivery depends on the service's webhook retry behavior. DorkOS hosting does not buffer direct BYO events. Unknown provider cadence or retry metadata stays unknown.

There is no exactly-once delivery promise. Dedupe, leases and durable receipts reduce duplicates and preserve truthful outcomes across known failures.

## Maintenance and Incident Response

The existing authenticated `GET /api/cron/cleanup` runs hourly through Vercel Cron. It gives event
retention and pending physical-subscription cleanup one shared 25-second signal; account cleanup is
separate from that timing claim. Retention uses at most 20 seconds and then leaves the remaining
signal for physical cleanup. Success returns aggregate `eventRetention` and `eventSubscriptions`
counts; an event maintenance failure returns 500 with `event_cleanup_failed`. Inspect the response
and deployment logs without logging payloads or tenant identifiers. A bounded successful pass does
not mean the entire backlog is empty.

Before the first deployment enables managed notification readiness, exclude or quiesce every old
receiver version, apply the migration, and run `pnpm --filter @dorkos/site
db:verify-event-capacity`. The command refuses to run while event readiness is on. It checks every
tenant ledger against the retained inbox and refuses missing, stale, or already over-limit state;
it does not repair or truncate data. Keep readiness off until it succeeds. After cutover, ingress,
ACK, and retention maintain the ledger transactionally. A missing ledger or a counter inconsistency
detected during one of those operations fails closed.

For recovery, compare `retained_rows` with the tenant's inbox row count and
`protected_payload_bytes` with the sum of UTF-8 bytes in non-empty protected payloads. Also check
that `next_cleanup_at` is the earliest deadline that can clear content or delete metadata. Do this
while intake is disabled and old receivers are excluded. Do not edit counters to force readiness;
find the incomplete transaction or old-version write, preserve accepted receipts, and reconcile by
an explicit reviewed repair or cleanup procedure.

Pending physical cleanup scans due receipts fairly, normally 25 per pass. Scheduling makes a claimed row due again no sooner than 30 seconds; it does not create a new 30-second cloud job. Recovery requires the exact still-live owner/instance authority, matching provider material and usable event configuration. Missing/revoked keys, disabled event readiness or changed provider material can leave cleanup pending without SDK mutation. Local consent remains revoked. Do not enable another key or borrow another instance to clear the row.

The local app uses existing startup/maintenance work for pending approved BYO subscriptions, authority outboxes, delivery and accepted session receipts. Recovery must preserve the original owner review and management-consent decision. Missing legacy consent fails closed. No controller, cron or operator should manufacture consent to make a pending row ready.

For an incident:

1. Close the affected local connection/receive scope and revoke the linked instance where required. Confirm hosted and local denial separately, especially if an installation is offline or already holds content.
2. Disable new event intake or all new managed capabilities with the relevant deployment gates. Confirm the new deployment is serving. These gates do not recall a sent request or erase an already accepted local event.
3. Keep safe decryption keys and recovery records available unless the incident requires key revocation. Stop ambiguous attempts from being retried.
4. Inspect exact receipt, generation and cleanup state. For compromised upstream credentials, revoke them through the owning provider account. Record any pending safe cleanup rather than restoring authority to force a delete.
5. Restore service only after fresh scoped owner review where required, controlled real-service smoke and next-call revoke proof.

## Troubleshooting

| Symptom                                                          | Check and safe response                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Managed connections are awaiting production verification.`      | Common readiness is off. Complete the environment's smoke; do not treat changing the flag as proof.                                                                                                           |
| `Managed account sign-in is not available for this service yet.` | Check an explicit override first, then the service's managed authentication metadata. Report unsupported account fields or developer prerequisites precisely. Another service's configuration does not apply. |
| `Managed account events are awaiting production verification.`   | Event readiness is separately off. Account operations may still be available.                                                                                                                                 |
| `events_unavailable` on buffered pull                            | Check instance authority, current receive scope and the payload key ring. SDK readiness is not required for buffered pull. Missing old keys need restoration, not a new key ID attached to old ciphertext.    |
| Permission upgrade/relink required                               | Relink the exact instance through the existing account flow; do not copy another instance's token.                                                                                                            |
| Cleanup stays pending                                            | Check its exact instance key, provider generation, event readiness and remaining subscribers. Borrowed BYO triggers may deliberately remain upstream.                                                         |
| Sign-in link fails after rotation                                | Start a new owner flow under the intended material. Do not forge or reuse the browser completion cookie.                                                                                                      |
| `outcome_unknown` or an uncertain notification send              | Retain the original operation/event identity and receipt. Investigate without automatic resend.                                                                                                               |
