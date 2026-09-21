---
slug: community-self-host-launcher
id: 260920-200102
created: 2026-09-20
status: specified
linearIssue: DOR-2168
---

# Guided Community self-host launch

**Status:** Draft

**Author:** Codex, directed by Dorian

**Date:** 2026-09-20

## Overview

Add `dorkos community deploy`, a local wizard that provisions an independently owned Community on Fly, Neon, and Tigris. A run begins with read-only account and capability checks, presents one exact plan, waits for explicit resource consent, then creates and verifies resources step by step. The operator finishes owner signup in Community's own browser flow.

This is a near-single-click experience: one command coordinates setup, but provider sign-in, organization selection, billing readiness, resource approval, and owner creation remain visible decisions.

## Problem statement

The manual recipe is executable but asks an operator to translate values among two provider consoles, several commands, a generated secret file, and a browser setup flow. A generic Fly launch does not provision a separate Neon project or preserve Community's one-Machine and private-storage constraints. A hosted DorkOS launcher would have to receive credentials broad enough to create resources before it could narrow them.

The launcher must reduce coordination work without hiding who owns the resources, when billing can begin, or which data a failed run left behind.

## Goals

- Take a signed release to a healthy `fly.dev` Community through one guided local command.
- Keep the app, database, bucket, data, and provider billing in accounts the operator selects.
- Require a final, concrete consent screen before the first provider write.
- Resume safely after interruption without duplicate resources.
- Keep database credentials, object-store credentials, signing secrets, and the setup secret out of logs, URLs, command arguments, telemetry, and the journal.
- Hand owner creation to the deployed Community and verify meaningful application behavior after `/health`.

## Non-goals

- A public deploy button, unattended browser provisioning, or DorkOS-hosted provider tokens.
- Custom-domain or DNS automation.
- Creating provider accounts, organizations, payment methods, or spending limits.
- Multiple app Machines, Fly Managed Postgres, public buckets, or filesystem-only storage.
- Automatic rollback or deletion of resources after a partial run.
- Automatic owner-account creation, invitations, social sign-in, backup scheduling, or recovery rehearsal.

## Dependencies and release gates

The launcher may ship only after all of these are true:

1. The Community release pipeline publishes a multi-platform OCI image and a signed release manifest that maps the DorkOS version to an immutable digest. The launcher refuses an unpinned tag.
2. DOR-2167 records a passing live Fly + Neon + Tigris acceptance run for the same topology.
3. The tested `flyctl` and Neon CLI minimum versions are declared. Startup rejects older versions and links to official installation instructions.
4. Provider commands used by the launcher have machine-readable output or a narrow wrapper with fixture-based contract tests. Human console text is never parsed. Raw output from commands that return credentials is treated wholly as secret material and never rendered or retained.
5. The release's configuration schema and migration behavior match the rendered Fly config.

## Detailed design

### Command and process boundary

`dorkos community deploy` runs entirely on the operator's machine. It starts neither the DorkOS server nor DorkOS Cloud. Provider commands inherit a minimal environment and receive no Community secret through `argv`. The launcher captures structured stdout, redacts provider-defined sensitive fields before diagnostic output, and never enables verbose provider logging during secret-bearing steps. Neon project creation and Tigris bucket creation can return credentials; their raw stdout and stderr go to a bounded sensitive sink that is never printed, journaled, or attached to an error. The wrapper emits its own sanitized result.

The implementation lives under `packages/cli/src/commands/community-deploy/` with these boundaries:

- `preflight.ts`: binary versions, browser sign-in, organizations, billing-readiness errors, region availability, and app-name availability.
- `plan.ts`: immutable `LaunchPlan` creation and presentation.
- `journal.ts`: atomic, mode-`0600` persistence of non-secret state.
- `fly.ts` and `neon.ts`: typed command invocations and response validation.
- `secrets.ts`: cryptographic generation, in-memory handoff, staged Fly import through stdin, and explicit clipboard action.
- `execute.ts`: the state machine and compensation guidance.
- `verify.ts`: resource inventory, health, storage, database migration, and owner-handoff checks.

Provider-specific code must remain behind these modules so fixture tests can prove every accepted response shape and every redaction rule.

### Authentication and organization choice

Preflight calls each provider's local authentication flow when needed. Fly authentication must come from `fly auth login`; Neon authentication must come from its CLI browser flow or an already authenticated local profile. The launcher does not ask the person to paste a personal or organization token.

After authentication, the launcher lists organizations from each provider and requires an explicit choice for each. It shows the human-readable organization name and stable identifier. It never silently chooses `personal`, the first result, or an organization used by another local project. The plan records only identifiers, names, regions, and intended resource names.

If the provider reports a missing payment method, spending restriction, insufficient role, quota, or unavailable region, preflight stops before any write and opens the relevant official provider page only when the operator chooses to do so. The launcher never creates or changes billing settings.

### Plan and consent gate

The final pre-write screen contains:

- the exact DorkOS version and image digest;
- the Fly organization, app name, region, one-Machine size, public `fly.dev` origin, and always-on policy;
- the Neon organization, project name, nearest compatible region, direct TLS connection, and dedicated database ownership;
- the Tigris bucket name, private access, and the fact that snapshot protection is a separate choice;
- which resources may start provider billing and links to the providers' current billing pages;
- the generated resource names and the path of the non-secret recovery journal;
- a statement that cancellation or failure retains created resources until the operator reviews them.

The user must type the generated app name to authorize writes. `--yes`, CI mode, piped stdin, and an environment variable cannot bypass this gate in the first release. A dry run performs every read-only preflight and renders the same plan, then exits.

### Provisioning state machine

The journal is stored under the existing DorkOS data directory at `launches/community/<run-id>.json`. It contains a schema version, desired plan hash, release digest, pending creation intent, provider-supported idempotency or provenance markers, provider-issued resource identifiers, verified bindings, completed steps, last safe error, and timestamps. It contains no URL with credentials, token, password, signing secret, setup secret, or object-store key.

Before every create, the launcher atomically journals the intended provider, selected organization, generated name, immutable attributes, and any provider-supported idempotency key or provenance marker. Each transition then follows **journal intent → inspect → prove identity or create → inspect exact identity and bindings → journal completion**. A matching name in the selected organization is not proof that this run created a resource; Neon project names are not unique, and another actor can win a name between planning and creation.

1. `planned`: record the consented plan.
2. `fly_app_created`: create the named app in the selected Fly organization. Record the provider-issued app identity and verify its organization and network identity. After an interrupted create, accept an existing app only when provider-supported idempotency or provenance evidence ties that exact app to the journaled intent.
3. `neon_project_created`: create a separate project in the selected Neon organization and chosen region. Record the provider-issued project, default branch, database, role, and endpoint identifiers; hold the direct TLS URL only in memory. Never recover by project name alone.
4. `bucket_created`: create a deterministically named Tigris bucket bound to the verified Fly app, with no `--public` flag. Treat the command's full output as secret material. Confirm success through its exit status, exact app/bucket binding, and Fly's structured secret listing, which must contain both AWS credential names. A deterministic name and attached secret names do not by themselves prove that this run created the bucket. Do not capture or reproduce credential values in diagnostics.
5. `secrets_staged`: generate three independent 256-bit Community secrets, combine them with the direct database URL, and stream the secret document to `fly secrets import --stage` over stdin. Confirm their names and digests, plus the two AWS credential names, through Fly's non-secret listing.
6. `deployed`: render a temporary Fly config from the release manifest, deploy the pinned image with `--ha=false`, and record the Fly release, Machine, and public-address identifiers from structured status output.
7. `healthy`: wait with a bounded deadline for one Machine, passing Fly checks, and public `/health`.
8. `owner_pending`: show the exact HTTPS origin and offer to open it. Copy the setup secret only after a local confirmation; clear the clipboard on a short best-effort timer and tell the operator that clipboard managers may retain it.
9. `complete`: detect that bootstrap is no longer claimable, stage a fresh bootstrap secret through a second stdin import, deploy the staged secret, and wait until provider readback proves the new secret version is applied to exactly one healthy Machine running the same pinned image. Ask the signed-in operator to confirm one post and one private attachment upload/download in the browser before declaring launch complete; the launcher never receives their session.

The launcher must not derive success from `/health` alone. A restart around secret import first inspects Fly's actual secret versions, digests, releases, and Machine state instead of trusting the last journal step. It never regenerates authentication or invitation secrets merely because the journal predates `secrets_staged`. Once a bootstrap secret has been staged but its local copy is lost, resume stages a fresh bootstrap secret, runs `fly secrets deploy`, and verifies the applied secret version, same pinned image, one-Machine topology, and health before offering the replacement for owner claim. Authentication and invitation secrets remain unchanged unless the operator explicitly starts a documented rotation.

### Partial failure, retry, and cancellation

On restart, the user selects an incomplete journal. The launcher reauthenticates and re-reads every recorded resource by provider-issued identity. It stops on an ownership, region, name, image, plan, or binding mismatch. If a create may have succeeded but its response or completion journal was lost, automatic resume requires provider-supported idempotency or provenance plus exact resource identity, organization, and binding readback. When that proof is unavailable, the run enters `uncertain` and prints read-only reconciliation steps; it neither adopts a same-name resource nor repeats the create. A changed plan starts a new run rather than mutating an old journal.

Cancellation stops the current bounded subprocess, writes the last confirmed state atomically, and prints a table of resources that exist with provider-console links and exact inspect commands. It performs no deletion. Cleanup is a separate, typed command added only after it can prove each target was created by that run; database and bucket deletion always require their own confirmation.

Every external call has a deadline and classifies errors as authentication, authorization, billing, capacity, conflict, transient provider failure, invalid response, or uncertain creation outcome. Automated retry is limited to read operations and provider-documented idempotent operations. Creation retries first inspect by recorded provider identifier, idempotency key, or provenance marker; they never repeat a blind create.

### Secrets and least privilege

The initial local Fly session and Neon session necessarily have create access in the selected organizations. The launcher uses them only during the interactive run. After app creation, continuing Fly operations should use the narrowest app-scoped credential that supports deployment; if `flyctl` cannot switch without exposing that credential, the first release retains the local session and records this limitation rather than exporting a token.

Neon's project-scoped key cannot create its own project. The launcher therefore uses the authenticated local profile for creation and does not mint or persist an extra Neon management key after it has obtained the database URL. Community receives a database role credential, not a Neon API credential.

Fly stores runtime secrets in its encrypted app vault. Community receives only the direct database URL, Tigris credentials, and its three signing/bootstrap secrets. DorkOS telemetry records event names and coarse outcomes only; it never records organization IDs, app/project/bucket names, origins, journal contents, provider output, or error bodies from secret-bearing calls.

### Ownership and identity

Fly login proves permission to create infrastructure in a Fly organization. Neon login proves permission to create a database in a Neon organization. Neither identity grants Community membership.

The first Community owner opens the deployed origin, submits the setup secret in the existing same-origin form, creates a standalone account, and claims the only owner seat. No setup token appears in the URL. The launcher does not proxy this request or learn the account password. DorkOS Cloud remains absent from the data and identity path.

### Storage and recovery contract

Tigris is private from creation and is the only supported attachment store for this launcher. The Machine filesystem is disposable. The completion screen states that Tigris snapshots are not enabled by `fly storage create` and links to the operations guide.

The launcher records the release digest and non-secret resource IDs needed for later backups, upgrades, and diagnosis. It does not claim recovery readiness until the operator has configured and rehearsed a matching Neon database restore and Tigris object restore. Database and object copies must describe one stopped-write point.

## User experience

1. The operator runs `dorkos community deploy`.
2. Preflight checks local tools and opens provider sign-in only when needed.
3. The operator chooses one Fly organization and one Neon organization, then a geographic area. The launcher offers only compatible nearby regions and explains that Neon uses public TLS rather than Fly private networking.
4. The launcher shows the full plan. No resource exists yet.
5. The operator types the generated app name. Progress then shows named steps, current provider, and whether a failure is safe to resume.
6. When the service is healthy, the launcher offers to open it and copy the setup secret locally.
7. The operator creates the owner account in Community. The launcher verifies meaningful behavior and shows rotation, backup, custom-domain, and local DorkOS pairing next steps.

At every exit, the last screen answers: what was created, who owns it, whether it may incur charges, whether data exists, and the exact resume command.

## Testing strategy

- Unit tests cover plan hashing, consent refusal, state transitions, journal permissions and atomic replacement, redaction, timeout classification, secret regeneration rules, and cancellation at every step.
- Provider contract tests run wrappers against checked-in sanitized JSON fixtures from the pinned CLI versions. Mutation fixtures remove or rename every field the launcher trusts so malformed success cannot pass.
- Integration tests use fake provider executables that simulate interrupted creates, duplicate names, lost stdout after success, a same-organization name collision, a duplicate Neon project name, expired auth, billing gates, transient reads, and secret-bearing error bodies. They prove that exact provider identity and provenance can resume a run, while an unprovable create enters manual reconciliation without adoption or another write. Assertions also prove no secret reaches argv, journal, stdout, stderr, or telemetry.
- A packaged CLI test starts from no repository checkout and verifies that the rendered config uses the pinned image and exactly one Machine.
- A credentialed release gate, separately armed and budgeted, provisions throwaway resources in designated organizations, runs owner signup and private attachment checks, resumes one induced interruption, and records cleanup. Ordinary tests and `pnpm verify` can never arm it.
- Security tests cover symlink and permission attacks on the journal, malicious provider output with terminal escapes, app-name collisions within and across organizations, duplicate Neon project names, clipboard disclosure messaging, refusal to adopt foreign resources, a crash after secret import but before journaling, and setup-secret replacement on an already running Machine. The secret tests assert that the replacement is deployed, the new provider version/digest is active on the same pinned image, and authentication and invitation secrets did not rotate.

## Performance considerations

Provisioning is network-bound. Progress should update after every provider operation and at least every ten seconds during a long build or health wait. Polling uses capped backoff and provider-recommended limits. The launcher deploys a published image so setup does not upload or rebuild the monorepo.

## Documentation

- Add a short guided-launch path ahead of the manual `apps/community/FLY.md` recipe while preserving the manual path as recovery and audit documentation.
- Document prerequisites, ownership, billing consent, supported regions, the journal, resume and cancel behavior, secret handling, owner claim, custom-domain follow-up, paired backups, and local DorkOS pairing.
- Publish the release image provenance and digest lookup contract.
- Never label the entry point “one-click deploy”; describe it as guided setup and list the sign-in and approval steps.

## Implementation phases

- **Phase 1 — release artifact and read-only plan:** publish the pinned image and release manifest; add CLI dispatch, preflight, organization/region selection, dry run, plan hash, journal, and consent screen.
- **Phase 2 — resumable provisioning:** add Fly app, Neon project, private bucket, secret staging, pinned-image deploy, structured progress, cancellation, resume, and provider fixture tests.
- **Phase 3 — owner handoff and proof:** add safe setup-secret handoff, meaningful acceptance checks, bootstrap rotation guidance, packaged CLI test, credentialed release gate, and operator docs.

## Open questions

- **Resolved — Can this be a public Fly deploy button?** No. The supported stack crosses two provider accounts and needs an explicit organization and billing decision in each.
- **Resolved — Should DorkOS host provider credentials?** No for the first release. The local command keeps them on the operator's machine.
- **Resolved — Can the launcher create the owner?** No. Existing same-origin owner claim remains the identity boundary.
- **Resolved — Can cancel delete partial resources?** No. It reports them. A later cleanup command needs separate provenance and confirmation.
- **Release gate — Which exact CLI versions and structured output fields are stable?** DOR-2169 must pin these from executable fixtures before implementation merges.
- **Release gate — Where is the signed Community image published?** The release pipeline must settle the registry and provenance contract before launcher code can deploy it.

## Related ADRs

- `260916-210001`: Community is an independent Hono service on persistent Node.
- `260920-200112`: Community self-hosting starts with a local guided launcher.

## References

- [DOR-2168](https://linear.app/dorkspace/issue/DOR-2168/specify-the-self-hosted-launch-experience-and-prove-fly-provisioning)
- [Fly Launch](https://fly.io/docs/reference/fly-launch/)
- [Fly access tokens](https://fly.io/docs/security/tokens/)
- [Fly Apps API](https://fly.io/docs/machines/api/apps-resource/)
- [Fly secrets](https://fly.io/docs/apps/secrets/)
- [Fly Tigris](https://fly.io/docs/tigris/)
- [Fly billing](https://fly.io/docs/about/billing/)
- [Neon projects](https://neon.com/docs/manage/projects)
- [Neon API keys](https://neon.com/docs/manage/api-keys)
- [Neon organizations API](https://neon.com/docs/manage/orgs-api)
- [Neon CLI projects](https://neon.com/docs/reference/cli-projects)
- [Neon connection pooling](https://neon.com/docs/connect/connection-pooling)
