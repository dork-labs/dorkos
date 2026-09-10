---
slug: composio-managed-auth-defaults
number: 260910-001729
created: 2026-09-10
status: implemented
---

# Make Composio services ready to connect with managed sign-in defaults

**Status:** Implemented and merged in PR #1759; separate DOR-1905 live proof remains open
**Issue:** DOR-1958, parent DOR-1792
**Source base:** 57171c402690bc82b3166ae057e75d6c599ed3d8

## Overview

People search the full current Composio catalog, choose a service, sign in or supply that service's required account fields, and then choose agent access. A per-service developer OAuth setup is not the default prerequisite. Existing explicitly configured custom authentication wins. Normal Gmail may support read and write according to consent scopes and separate per-agent permissions.

## Background / Problem Statement

Hosted authentication currently requires DORKOS_MANAGED_CONNECTOR_AUTH_CONFIGS[toolkit]. The catalog translates its absence into unsupported even when Composio offers managed OAuth. All successful completions require session_uri, which is documented for redirecting OAuth and cannot be assumed for API-key/basic/bearer flows. Unknown catalog authentication is currently guessed to be OAuth2. These are separate seams of the same incomplete setup policy.

## Goals

- Full paginated dynamic catalog; no small service allowlist or individually live-tested service gate.
- Existing custom configuration first, then supported managed OAuth, then supported account-field schemes.
- Exact owner, tenant, instance, account, config, material generation, schema/version and one-shot flow binding.
- Multiple accounts per service, separate read/write grants, revocation and receipts unchanged.
- Precise unavailable/setup-required reasons for genuine unsupported schemes or developer prerequisites.

## Non-Goals

DorkOS-owned OAuth app migration, hiding Composio on provider consent, changing existing grants/scopes/accounts, connecting services without user consent, sending email, changing event delivery, loosening readiness flags, or removing final DOR-1905 live acceptance. Do not add credentials to the local transport or agent tool schemas. Do not auto-delete or migrate the Gmail ReadOnly fixture.

## Technical Dependencies

Use pinned @composio/core 0.18.1 and @composio/client 0.1.0-alpha.76 through packages/connector-providers. Raw link.create sends POST /api/v3.1/connected_accounts/link. Auth-config metadata has is_composio_managed, status, toolkit and auth_scheme; toolkit metadata has composio_managed_auth[_schemes], auth_config_details.fields.auth_config_creation and connected_account_initiation. No SDK upgrade is required.

## Detailed Design

### Shared contract and writer split

The common task owns packages/shared/src/connector-provider.ts and any shared managed schemas. Add optional `authenticationSetup` to ConnectorToolkit, preserving old callers:

```ts
type ConnectorAuthenticationSetup = {
  kind: 'oauth' | 'fields' | 'none' | 'unsupported';
  source: 'configured' | 'managed' | 'account-fields' | 'unsupported';
  scheme?: string; // exact normalized provider mode; never a URL or auth-config ID
  requiresAccountFields: boolean;
};
```

Existing `authentication` remains the capability availability/reason field. Preserve the released strict v1 enum and response shape (`oauth2|api-key|none`). The exact `x-dorkos-catalog-auth-setup: 1` header opts into optional `authenticationSetup` at both hosted discovery and local catalog HTTP boundaries; no header means the original shape, with unfamiliar field methods marked unsupported per row rather than rejecting the whole page. New callers send the header for every search/page and accept old-server responses without the optional field. Both responses use `Vary: x-dorkos-catalog-auth-setup` and `Cache-Control: private, no-store`. The internal operator projection strips the field when not opted in. Rich setup kind drives new presentation; the coarse legacy enum never authorizes a method. No credentials, config IDs, scope secrets or field values appear in catalog DTOs. The local UI uses setup kind and availability; old BYO callers can omit the new field. Unsupported is a capability, not absence from the catalog.

Internal provider-bound metadata is a separate normalized `ComposioAuthenticationDescriptor`: the selected exact toolkit, proven scheme, completion kind, configuration source, and bounded fields (`name`, `label`, `description`, `type`, `required`, `secret`). Only string/password/boolean/number fields are supported initially; compound and enum field types remain unsupported until a separate exact wire contract is added. Unknown compound types receive a specific unsupported reason; never render provider HTML or dynamic code. Limit 64 fields, 128-character names, 512-character labels, 2048-character descriptions, 8192 characters per string and 64 KiB for the encoded fields object. The complete JSON POST envelope has a separate 72 KiB cap for the fields plus bounded CSRF/digest metadata; stream reads have a five-second budget. Secret defaults are discarded. Only declared field names are accepted; duplicate names/unknown fields and prototype keys are rejected. No DorkOS request may fetch a user-entered company URL; it is data sent only to a fixed Composio endpoint.

Track A owns hosted config/resolution, provider account client, DB migration and flow completion/routes. Track B owns SDK catalog normalization, local catalog/UI rendering, hosted field form presentation, and user/developer docs. Shared contract task lands first; A exports the frozen descriptor and field-page/submit service seams before B implements the form. B must not edit A's flow transaction or provider client. Integration writer resolves the two manifests only if needed.

### Dynamic support and precedence

1. Existing deployment-scoped toolkit override wins; validate exact returned toolkit/config/status. Never silently fall back when an explicit override is broken.
2. Without an override, choose the toolkit's declared supported managed OAuth mode (prefer OAuth2, then OAuth1/DCR when documented and supported). Keep Composio defaults within declared scope ceilings; no permanent Gmail read-only default. Do not request more scopes to satisfy an agent grant automatically.
3. Without managed OAuth, support declared API_KEY/BEARER_TOKEN/BASIC/NO_AUTH account modes whose required auth-config-creation fields need no unconfigured developer credential. These use a metadata-declared config with empty credentials and the provider's required account fields. A toolkit needing a developer OAuth app remains visible with a specific reason and advanced existing override route.
4. Required company/subdomain/account fields are collected by the hosted owner surface and passed as data, not treated as a universal unsupported service. Unsupported field shapes remain bounded exceptions.

Catalog uses page metadata for cheap supported-mode hints and exact toolkit metadata on selection; it must not issue one provider call per row. OAuth1/DCR metadata is insufficient: those modes remain unsupported until pinned SDK wire and existing session_uri verifier compatibility are both proved. Selected setup is revalidated before any create. Missing support metadata is unknown, never guessed available. Provider disablement and config/readiness failures stay capability-specific.

### Auth-config resolution and concurrency

Add a small hosted auth-config resolution table keyed by server-derived project-material digest + toolkit + scheme/policy digest. Store only IDs, mode, descriptor digest, deterministic config name, attempt ID, timestamps and state (`provisioning`, `ready`, `create_unknown`). No credentials. This is project configuration, not a user/tenant selector; it never authorizes accounts or operations.

An explicit override bypasses provisioning. Automatically resolved toolkit configurations are stored outside the global provider material digest: adding a toolkit must not advance material generation, pause existing connections, or revoke grants under an unchanged explicit map. Removing the temporary Gmail override remains an intentional operator maintenance action. Otherwise atomically claim one resolver row. Read/reuse only an enabled exact toolkit/mode DorkOS-default configuration with the deterministic name and matching managed/field policy; never select the first arbitrary custom or disabled config. Bound pages/cursor progress and total request time; normalize IDs/mode/status and a closed nonsecret policy projection without retaining credential values from vendor envelopes. Lists use at most 50 entries per page. Automatic configs must retain documented default/custom type, empty shared credentials/proxy/tool restrictions, disabled tool-router use and managed scopes within toolkit declarations; field/no-auth configs must have empty auth-config credentials. Unknown policy shapes fail closed. Existing explicit mappings retain their own validation. If absent, the sole claimed attempt issues one maxRetries:0 create. Concurrent workers do not repeat create; they read the existing state. A canceled/lost/stale provisioning attempt becomes create_unknown. Later resolution may reconcile with a bounded exact-name read: exactly one matching configuration settles ready; zero, multiple or mismatched records remain unavailable and require explicit operator configuration/reconciliation. No blind create retry or cleanup deletion. An explicit custom mapping is the existing supported recovery route; no new administrator UI is required.

Persist the resolved auth-config ID and completion kind/descriptor digest on each auth flow before its account create. Preserve request-id hash/idempotency and starting/start_unknown semantics: a replay never creates another account. Config resolution itself creates only a blueprint, not a connection or grant. Append a numbered migration for resolver rows and flow completion metadata; old rows remain OAuth-verifier flows. All new fields are additive and old active connections remain usable.

### OAuth completion

Use raw Connect Link, with private account semantics and trusted providerUserId. Current project's HTTPS verifier applies to managed and custom redirecting OAuth. Keep browser owner binding, signed-in owner, one-use cookie, expiry, material-generation check, session_uri redemption at the fixed complete_auth endpoint, and exact account/config/toolkit/user ACTIVE readback. Do not trust callback query account IDs. Missing verifier/callback readiness remains unavailable. No polling fallback completes OAuth. Raw transport has no allow_multiple field: test two accounts via real pinned transport; retain exact account IDs and replay controls.

### Non-OAuth completion and credential custody

The existing local start request still contains only toolkit/label/requestId. Its authorize URL opens a dorkos.ai owner page. That page authenticates the same hosted owner and binds the flow cookie before displaying the exact server-selected descriptor. Credential inputs exist only in component/form memory on this origin: no localStorage/sessionStorage, persistence, response echo, request-body telemetry, logs or error serialization.

POST a dedicated same-origin hosted credential-completion route. Require hosted owner session, exact Origin/CSRF validation and the one-use owner/flow cookie, unexpired fields-mode row, descriptor digest match and current material/instance. Reject OAuth rows here. Validate exact fields against server metadata; the submitted form supplies no owner/user/toolkit/config/URL authority. Atomically consume the flow before issuing the fixed Composio connected-account create with server-selected auth config, derived user and validated connection state. No automatic retry. Retain the exact returned account ID for reconciliation, then verify exact user/toolkit/config/ACTIVE before creating the hosted connection binding through the same account-binding transaction. If the first ID persistence write fails, the single guarded reconcile-state write includes the known ID; a continuing database outage stays uncertain and cannot authorize replay. An ambiguous create becomes reconciliation-required; never repeat on browser reload or infer success. Clear browser fields after submission; return only safe status. NO_AUTH uses the same owner confirmation and empty declared fields.

The provider adapter owns mapping normalized scheme/fields to the actual pinned connectedAccounts.create wire union. Unknown schemes/types fail before dispatch. Account creation request/response tests must cross the actual SDK transport, including the field schema. This path deliberately allows transient hosted handling of supplied account credentials; OAuth tokens continue to stay at Composio. State the distinction in copy and docs.

### Fixture and production override scope

The existing map is deployment-scoped, not per-person. Preserve its behavior and the custom Gmail ReadOnly configuration. Do not silently reinterpret it as production policy. Keep the verification fixture in its dedicated test/preview deployment/project where possible. Before public rollout, root may explicitly remove only the temporary Gmail entry from the normal production map while retaining the remote config and existing accounts; new production Gmail sign-ins then use managed defaults. If the same deployment must serve both, add an explicit server-owned fixture scope only after separate design approval; no hidden owner-email exception. This operational separation is not an automatic config mutation by this change.

## User Experience

Search every catalog page. Available services say Connect; field-based services say what the person needs next. Show a concise custody sentence before leaving for Composio, and never promise DorkOS-branded provider consent for managed OAuth. Credential forms explain that the account details pass through dorkos.ai to Composio and are not saved by DorkOS. After connection, choose agents and operations; connecting alone grants none. A second account is a separate row, never an overwrite. Unknown services/auth modes give a specific reason, while the remainder of the catalog remains usable.

## Testing Strategy

Representative synthetic conformance replaces per-service launch certification: managed OAuth with no map; configured override wins; API key, bearer/basic, declared company field, no-auth, unsupported developer OAuth and unknown metadata. Test complete cursor traversal, repeated cursor, disabled/custom mismatch, resolver concurrency/lost create, exact material-key invalidation and fresh request replay. Real SDK mock HTTP tests verify request bodies and two distinct account links without inventing allow_multiple.

OAuth negatives: wrong owner/cookie/account/toolkit/config, consumed/expired flow, changed material, lost complete_auth, and fields route/poll cannot bypass verifier. Non-OAuth negatives: foreign Origin, missing CSRF/session, metadata digest changed, unknown/oversize fields, secret defaults, error/body/log sentinels, cancellation/unknown response and double submit. Real mounted hosted form test proves values absent from browser storage/output after completion and metadata is rendered as text. Existing revision/grant/no-retry/usage tests must remain green; representative granted write capability is verified synthetically without sending an email.

Run scoped provider/shared/site/server/client checks, meaningful mutants for override precedence, OAuth-kind fence, owner binding and duplicate create. Separate REVIEW.md review before normal verification/hooks/PR. Root alone handles live representative consent/custody and deployment; do not claim every service was live tested.

## Performance Considerations

Keep catalog paginated and cheap, inspect exact details only on selection, share successful resolver results per material identity, and bound all upstream reads/writes. Do not hold a DB transaction across provider network calls; claim and settle with exact attempt CAS.

## Security Considerations

No widening of trusted identities, local program permissions, grants, operation revisions, events or receipts. Secrets never enter a durable flow, resolution row, logs or client persistence. Full project-key vendor responses remain confined to the adapter. Existing custom mappings are authoritative; a broken override fails closed. Unsupported schemes cannot fall through to OAuth or generic credential submission.

## Documentation

Amend white-label-connections §hosted configuration/availability to make the map an override. Update docs/connections/composio.mdx and contributing/managed-connections-operations.md plus the current security/custody guide without overwriting DOR-1905 pending evidence. Explain managed consent branding, field custody, scope-vs-agent-grant distinction, fixture override scope and supported exceptions. Future custom OAuth migration is documented separately, not a release gate.

## Implementation Phases

1. Shared contract + metadata decision + schema migration design freeze.
2. Parallel A resolver/flows/provider tests and B catalog/form/copy tests against that contract.
3. Compose, representative browser/security conformance, independent review and normal gates.

## Open Questions

All product policy choices are resolved. As of 2026-09-10, final composition, normal verification, publication, migration 0016, and managed-default deployment have passed through [PR #1759](https://github.com/dork-labs/dorkos/pull/1759). Live provider consent and the remaining account, action, usage, revoke, and notification proof stay separate under DOR-1905. SDK wire mappings are proven against the pinned transport and are not guessed from display names. Refs DOR-1798.

## Related ADRs

The accepted ADR records default managed OAuth and transient same-origin credential submission, amending the configuration/custody portion of260905-205123. Existing trust, grants and events decisions remain accepted.

## References

- https://docs.composio.dev/docs/authentication/programmatic-auth-configs
- https://docs.composio.dev/reference/api-reference/connected-accounts
- https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsLink
- https://docs.composio.dev/docs/authentication/controlling-scopes
- https://docs.composio.dev/docs/auth-configuration/migrating-initiate-to-link
- Pinned raw client resources/toolkits.d.ts, auth-configs.d.ts, link.d.ts; core dist/index.mjs:3211–3237.
