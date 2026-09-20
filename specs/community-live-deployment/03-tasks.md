# Live Community deployment tasks

Generated from [02-specification.md](./02-specification.md). [03-tasks.json](./03-tasks.json) is canonical.

## Phase 1 — Reconcile and Deploy

### Task 1.1: Reconcile the resources created before the stage gate

Inventory the already-created standalone deployment resources without printing secrets: the separate Fly app, private Tigris bucket, Neon project/database/role in the operator-selected organization, staged secret names, allocated public IPs, DNS record, and issued canonical-domain certificate. Confirm ownership is independent of DorkOS Cloud, Tigris is private, the selected regions are intentional, no application Machine exists, and no Community account exists. Record the out-of-order provisioning event in private operational evidence, including the cleanup boundary for every resource. Stop before deployment if an owner, region, visibility, or isolation check fails.

Acceptance criteria:

- The live inventory is recorded with provider identifiers and secret values redacted from public artifacts.
- Every resource is confirmed independent of DorkOS Cloud.
- DNS points to the intended Fly app and the certificate is issued for the canonical domain.
- No Machine or Community account exists before reconciliation completes.
- Any mismatch stops later tasks rather than being silently accepted.

### Task 1.2: Preflight the Neon connection and schema-owner role

Preflight the direct TLS PostgreSQL URL held in the provider secret store without running a separate migration command. Confirm it targets the intended separate database and schema-owner role, preserves TLS verification parameters, and exposes the expected PostgreSQL version and region metadata. The same role intentionally runs startup migrations and serves runtime queries for this first deployment; do not claim a separate least-privilege runtime role exists. Capture only redacted facts. Do not expose the URL, password, provider project identifier, or organization identifier in the repository, tracker, logs, screenshots, or command history. Task 1.3's real application startup is the migration and connectivity proof.

Acceptance criteria:

- The URL targets the intended separate database and schema-owner role with TLS verification enabled.
- PostgreSQL version and region metadata match the selected deployment shape.
- No separate migration runner is invoked.
- No DorkOS Cloud database or credential is used.
- Failure leaves onboarding and deployment blocked with redacted evidence.

### Task 1.3: Deploy one Community Machine with private Tigris

Validate the private runtime Fly configuration with `fly config validate --strict`, including that relative paths such as the Dockerfile resolve from the private config file's directory, then deploy the pinned Community revision with `--ha=false`. Keep exactly one always-on Machine, use the staged Community and private Tigris secrets, and confirm the bucket is not public. Verify startup migrations finish before the service becomes ready, Fly checks pass, and the Machine uses S3-compatible storage rather than its temporary filesystem. Preserve redacted deployment output and the exact source revision. DOR-2190 owns any correction needed in the public guide or example config.

Acceptance criteria:

- Strict Fly configuration validation passes from the actual private config path.
- Exactly one application Machine runs the pinned revision.
- Readiness follows successful migrations.
- Private Tigris is configured and no bucket URL is exposed directly.
- Secret values do not appear in evidence.

## Phase 2 — Canonicalize and Verify

### Task 2.1: Smoke-test the Fly hostname without onboarding

Use the Fly-provided HTTPS hostname only for infrastructure smoke testing before any owner or member account exists. Verify `/health`, startup and migration evidence in redacted logs, expected security and cache response headers, and the public browser assets. Confirm the response comes from the single deployed Machine and that no secret or bootstrap value appears in URLs or captured evidence. Do not attempt authenticated file, streaming, or reconnect checks; do not create the owner, invite a person, or publish the temporary hostname.

Acceptance criteria:

- Health, startup/migration evidence, expected headers, and public assets pass on the Fly hostname.
- No authenticated behavior is claimed from the temporary-host smoke test.
- No account has been created and no invitation has been issued.
- Evidence is redacted and tied to the pinned revision.

### Task 2.2: Make spaces.dorkos.ai the canonical origin

Re-verify the existing DNS target and issued Fly certificate for `spaces.dorkos.ai`. Set `COMMUNITY_PUBLIC_URL` to exactly `https://spaces.dorkos.ai`, update any configured sign-in callbacks to the same origin, redeploy the pinned revision, and wait for health readiness. Verify HTTPS, redirects, and origin checks on the canonical domain. Keep onboarding blocked until these infrastructure checks pass. Authenticated proxy streaming and reconnect require accounts and are verified in task 2.3, as specified in the verification strategy.

Acceptance criteria:

- DNS still points to the intended Fly app and its certificate remains ready for `spaces.dorkos.ai`.
- The running app uses the exact canonical HTTPS origin.
- HTTPS, redirects, and origin/callback behavior pass on the canonical domain; authenticated streaming and reconnect are required in task 2.3.
- No account or invitation predates canonical readiness.

### Task 2.3: Verify people, files, revocation, and one local agent

On `spaces.dorkos.ai`, use the bootstrap flow to create the first owner, rotate the bootstrap secret, create a channel, invite a second person, and join from a separate browser profile. Exchange posts and a thread reply, upload and download a file with a byte comparison, disconnect and reconnect a browser, connect one local DorkOS agent, and verify one mention produces one reply before stopping participation. Remove the second member and verify the old browser and credentials cannot read the channel or download the file.

Acceptance criteria:

- Two people and one local agent complete the intended interaction path on the canonical domain.
- File bytes match and live reconnect produces ordered history without duplicate posts.
- Removed membership loses channel and file access.
- Standalone local accounts and agent pairing work without DorkOS Cloud.

## Phase 3 — Durability and Recovery

### Task 3.1: Prove restart and pinned-revision upgrade persistence

Restart the single Community Machine and verify sign-in, channel history, live updates, and the uploaded file still work. Redeploy the same pinned revision using the documented rolling strategy without running old and new application processes side by side, then repeat the checks. Record reconnect behavior and any interruption without claiming zero downtime.

Acceptance criteria:

- Database history and private file bytes survive Machine restart.
- The pinned-revision redeploy preserves accounts, membership, history, and files.
- Exactly one application process remains active.
- Observed interruption and reconnect behavior are recorded honestly.

### Task 3.2: Rehearse coordinated Neon and Tigris recovery

Pause writes, create a matching Neon database backup and private Tigris file backup, and record them as one recovery point. Restore both into an isolated target that cannot overwrite the live deployment. Verify restored owner access, channel history, membership, attachment metadata, and attachment bytes. A database-only restore or a file-only restore fails acceptance. Keep provider identifiers and credentials in private operational evidence.

Acceptance criteria:

- One coordinated database-and-file recovery point is recorded.
- Both halves restore into an isolated target without mutating the live service.
- Restored history and attachment bytes match the source.
- Recovery steps are repeatable and redacted.

### Task 3.3: Assemble redacted acceptance evidence and resource disposition

Assemble the live acceptance bundle with the source revision, public app/domain, regions at a non-sensitive level, configuration names, check timestamps, product results, restart/redeploy results, recovery results, and final disposition of every created resource. Redact secrets and provider-internal identifiers. Record any discrepancy as a follow-up rather than weakening the checklist. DOR-2167 may advance to VERIFY only when every task is evidenced; it may advance to DONE only after review confirms the evidence.

Acceptance criteria:

- Every task has concrete evidence or an explicit unresolved failure.
- No secret, credential, private provider identifier, or commercial term appears in public artifacts.
- Remaining resources and cleanup obligations are explicit.
- The tracker is not advanced prematurely.
