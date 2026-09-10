# DOR-1958 tasks

Canonical source: 03-tasks.json. Design review precedes execution.

### Task 1.1: [composio-managed-auth-defaults] Freeze typed authentication and SDK wire contracts

Owner: common. Dependencies: none.

Add optional secret-free authenticationSetup to toolkit schemas with kind oauth/fields/none/unsupported, source configured/managed/account-fields/unsupported, exact scheme and requiresAccountFields. Keep strict v1 authKind/shape unchanged; use exact header negotiation for optional setup, Vary/private-no-store, page/search propagation, public/operator projection and new-client old-server fallback. Freeze the selected exact scheme and bounded field descriptor; Track A implements metadata selection and scope/config validation against this contract. OAuth1/DCR stay unsupported without pinned wire plus verifier proof. Prove OAuth link, API_KEY/BEARER_TOKEN/BASIC and NO_AUTH create wire unions against pinned @composio/client0.1.0-alpha.76 using synthetic HTTP transport; do not guess display-name-to-wire mapping. NO_AUTH must use explicit owner confirmation with empty credentials and exact ACTIVE account verification, never fake OAuth; unsupported upstream behavior produces a precise visible reason. Freeze descriptor/page/submit seams before parallel tracks, including64fields/64KiB body and fixed Composio destinations.

### Task 2.1: [composio-managed-auth-defaults] Resolve supported auth configurations without a manual catalog map

Owner: A. Dependencies: 1.1.

Implement explicit deployment override precedence, exact enabled toolkit/config validation, managed OAuth preference and supported account-field/no-auth config fallback. Add durable project-material/toolkit/scheme-policy resolution row provisioning/ready/create_unknown with attempt CAS. Bounded paginated exact-name reuse excludes arbitrary custom/disabled/mismatched configs; sole create maxRetries0, no DB transaction across network, no retry after unknown result. Reconcile exact one matching config by read only; otherwise remain unavailable with explicit override as recovery. Snapshot resolved config/completion kind/descriptor digest on auth flow; migration preserves old OAuth flows. Test concurrency, repeated cursor, unsupported metadata, custom precedence, cancellation and lost-create outcomes. Do not expand account scopes/grants or delete existing configs. Store automatically provisioned configs outside the global material digest; regress unchanged explicit-map generation, connections and grants when adding another toolkit. Fixture override removal is deliberate maintenance.

### Task 2.2: [composio-managed-auth-defaults] Complete OAuth and hosted account-field flows with exact owner binding

Owner: A. Dependencies: 2.1.

Preserve OAuth session_uri deferred verifier and single-use owner cookie; fields submission must reject OAuth rows. Implement dedicated same-origin hosted owner credential POST with explicit Origin/CSRF/session/flow/expiry/material checks, exact descriptor digest, declared keys/types/body limits and no secret persistence/body telemetry/error echo. Consume flow before fixed Composio create, no retry, exact user/toolkit/config/ACTIVE readback and same persistence transaction; ambiguous responses reconcile without replay. Local/agent/CLI transports carry no credentials. Test wrong owner/cookie/config/account, cross-origin, metadata drift, overflow, double submit, lost response and OAuth bypass mutants. Raw link two-account regression proves no fictitious allow_multiple field or newest-account selection.

### Task 2.3: [composio-managed-auth-defaults] Expose the dynamic catalog and hosted credential form honestly

Owner: B. Dependencies: 1.1.

Normalize catalog page authentication support using exact declared mode metadata; never guess unknown schemes are OAuth or call details per row. Use authenticationSetup contract and existing availability reason, preserve all pages/search and visible unsupported entries. Selected setup revalidates exact metadata. Implement dorkos.ai owner form against frozen TrackA descriptor/submit seams, render provider strings as text, support declared company fields and bounded primitive input types, password-mask secrets, no secret defaults/browser storage/URL params/local transport. Clear fields on submission and explain transient hosted-to-Composio custody. Root-approved no-auth path is explicit owner confirmation without fake credentials. Test representative managed/custom/key/basic/bearer/none/unknown/setup-required cases and field-secret sentinels. Do not modify TrackA flow transactions/provider client.

### Task 3.1: [composio-managed-auth-defaults] Compose security conformance and update setup guidance

Owner: integration. Dependencies: 2.2, 2.3.

Compose both tracks preserving exact contract, OAuth verifier, raw multiple-account behavior, immutable operation revisions, per-agent read/write grants, approvals/no-action-retry and receipts. Run representative mounted browser and actual SDK synthetic conformance, scoped package type/lint/tests, meaningful override/owner/OAuth-kind/duplicate-create mutants, then separate REVIEW.md review and normal verify/hooks/PR. Update white-label spec configuration wording, Composio setup/custody docs and operations guide: managed defaults, custom precedence, fixture-only Gmail ReadOnly policy, full dynamic catalog exceptions and future custom OAuth migration. Preserve DOR1905 pending live evidence; root alone performs production/live adoption, no individual live test per service gate.
