---
slug: community-self-host-launcher
id: 260920-200102
created: 2026-09-20
status: ideation
linearIssue: DOR-2168
---

# A guided launch for an independently owned Community

**Author:** Codex, directed by Dorian
**Date:** 2026-09-20

## 1) Intent and assumptions

The operator should be able to start one command, sign in to the services that will own the deployment, approve a concrete resource plan, and finish with a working Community and an owner account. The first supported stack is one Fly Machine, a separate Neon Postgres project, and a private Tigris bucket. Each resource remains in the operator's account. DorkOS Cloud is not required for identity, operation, or recovery.

This research assumes the current one-process Community topology and the Fly recipe in `apps/community/FLY.md`. It also assumes that releases can publish an immutable Community image before the launcher ships. Live provisioning, provider billing experiments, custom domains, horizontal scaling, hosted credential custody, and automatic teardown are outside this issue.

## 2) Pre-reading log

- `plans/community-next-phase.md` §A3: compare Fly's launch surface, a local command, and a delegated web flow; keep account sign-in and resource approval visible.
- `apps/community/FLY.md`: the deployable unit needs a Fly app, one Machine, a direct TLS PostgreSQL URL, six app secrets, a private bucket, and a browser owner claim.
- `apps/community/OPERATIONS.md`: the database, objects, image, and signing secrets form one recovery set.
- `apps/community/Dockerfile`: the current image is self-contained at runtime, but today it is built from the monorepo rather than published as a release artifact.
- `apps/community/src/config.ts`: startup fails closed when required settings are absent; S3 credentials must be supplied as a pair.
- `apps/community/src/app.ts` and `apps/community/src/auth.ts`: owner setup uses a secret submitted in a same-origin POST, becomes a short-lived HTTP-only grant, and cannot claim a second owner.
- [Fly Launch overview](https://fly.io/docs/reference/fly-launch/): `fly launch` is the documented orchestration surface; `--no-deploy` separates resource creation from deployment.
- [Fly access tokens](https://fly.io/docs/security/tokens/): creating an app requires user or organization scope; app-scoped credentials become possible only after the app exists.
- [Fly Apps API](https://fly.io/docs/machines/api/apps-resource/): the Machines API can create an app in a selected organization, but does not replace the higher-level deployment workflow.
- [Fly Tigris guide](https://fly.io/docs/tigris/) and [`fly storage create`](https://fly.io/docs/flyctl/storage-create/): buckets are private by default; creation can bind credentials to an app; snapshots are not enabled by this Fly command.
- [Fly billing](https://fly.io/docs/about/billing/): resources are billed to the chosen organization and most accounts need an active payment method.
- [Neon project management](https://neon.com/docs/manage/projects), [API keys](https://neon.com/docs/manage/api-keys), and [organization API](https://neon.com/docs/manage/orgs-api): projects can be created by CLI/API in an explicit organization; project-scoped keys cannot create the project that they are scoped to.
- [Neon CLI](https://neon.com/docs/reference/cli-projects): the CLI can authenticate locally, enumerate organizations, and create a project in a chosen region.
- [Neon connection pooling](https://neon.com/docs/connect/connection-pooling): Community needs the direct TLS URL for startup migrations and currently uses the same URL at runtime.

## 3) Codebase map

- `packages/cli/src/cli.ts` is the natural home for `dorkos community deploy`; it already dispatches isolated subcommands before starting the local server.
- A new `packages/cli/src/commands/community-deploy/` module should own provider checks, planning, execution, recovery, and rendering.
- `apps/community/fly.toml.example` remains the configuration source of truth. The launcher renders an equivalent temporary config and uses a release image, avoiding a repository checkout and a remote source build.
- `apps/community/src/app.ts` remains the owner handoff boundary. The launcher never creates a Community member or retains the setup secret.
- The blast radius includes CLI packaging, Community image publishing, release metadata, Fly deployment configuration, and deployment documentation. It does not change Community identity or data models.

## 4) Research

### Option A — Fly Launch UI or repository link

Fly documents `fly launch`, source templates through `--from`, and its dashboard. The reviewed public documentation does not define a stable, repository-owned URL that creates the Fly app, a Neon project, a private Tigris bucket, secrets, and a one-Machine deployment as one consented transaction. A repository link also cannot choose or authorize a separate Neon account. Advertising a one-click deploy button would promise a contract the two providers do not supply.

### Option B — local guided launcher

A local command can use each provider's supported browser sign-in, list only organizations available to that signed-in person, show a resource plan before writes, and call the providers' CLIs. Sensitive values can move directly from local process memory into Fly's encrypted app-secret import. Before each write, the command can persist non-secret creation intent; after a confirmed write, it can persist provider-issued identifiers and verified bindings. An interrupted create resumes automatically only when provider evidence proves that the exact resource belongs to that run. This is viable once an immutable release image and machine-readable provider output are pinned and tested.

The limitation is honest friction: the operator must have Fly and Neon accounts, satisfy each provider's billing requirements, complete two sign-ins, choose owning organizations, and approve provisioning. Near-single-click describes one guided command after those gates, not one unattended web click.

### Option C — delegated DorkOS web flow

A hosted flow could offer a smoother screen, but it would need an organization-capable Fly token and Neon OAuth partner access or a broad API key before it can create either resource. It would also need secure token storage, callback and revocation handling, organization and billing selection, resumable server-side orchestration, and an explicit transfer or continuing-management contract. Fly's narrow app token exists only after app creation. This adds a credential-custody service and Cloud dependency to a feature whose promise is independent ownership.

### Recommendation

Build `dorkos community deploy` as a local, resumable wizard. It shells out to pinned minimum versions of `flyctl` and the Neon CLI instead of reimplementing undocumented APIs. It deploys an immutable release image, asks for separate Fly and Neon organization choices, and stops at a typed confirmation that names every resource and its owner. Provider login and billing screens remain provider-owned.

The command reports a setup address and copies the one-time setup secret to the clipboard only on an explicit local action. It must never put the secret in a URL, process arguments, persisted state, analytics, or logs. The browser completes owner creation against Community itself, preserving standalone identity.

### Capability verdict

| Need                      | Supported path                                                      | Constraint                                                                                                       |
| ------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Select the paying owner   | Fly and Neon both enumerate organizations for the signed-in user    | The launcher must ask; it cannot infer the intended owner.                                                       |
| Create the app            | `fly apps create` or the Apps API                                   | Name and organization checks are necessary but do not prove which interrupted run created the app.               |
| Deploy one public Machine | `fly deploy` with a rendered config, pinned image, and `--ha=false` | Public addresses are allocated during deploy; health still needs an application-level check.                     |
| Create PostgreSQL         | Neon CLI/API project creation in a selected organization and region | Creation needs account or organization scope; a project-scoped key cannot create its own project.                |
| Obtain the migration URL  | Neon returns a direct TLS connection string                         | The value contains a password and must go straight to Fly's secret import.                                       |
| Create private files      | `fly storage create --app ...` without `--public`                   | The command prints credentials and has no JSON mode; all raw output is secret-bearing and must be suppressed.    |
| Store runtime secrets     | `fly secrets import --stage` over stdin, then deploy staged secrets | A running Machine keeps its old values until the staged version is deployed and verified.                        |
| Narrow ongoing access     | Fly app-scoped tokens and Neon database-role credentials            | Narrow credentials exist only after the app/project is created; the interactive creation session starts broader. |
| Hand off ownership        | Community's existing bootstrap form                                 | The setup secret belongs in a same-origin POST, never a URL or provider identity mapping.                        |

## 5) Decisions

| #   | Decision             | Choice                                                          | Rationale                                                                               |
| --- | -------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | First launch surface | Local `dorkos community deploy` command                         | It can coordinate both providers without DorkOS receiving provider credentials.         |
| 2   | Provider ownership   | Separate operator-selected Fly and Neon organizations           | Ownership and billing remain visible and portable.                                      |
| 3   | Application artifact | Immutable release image pinned by digest                        | A launcher should not clone the repository or rebuild unreviewed source.                |
| 4   | File storage         | Private Tigris bucket attached to the Fly app                   | Attachments survive Machine replacement and still pass through Community authorization. |
| 5   | Identity             | Existing Community signup and one-time owner claim              | Provider accounts provision infrastructure; they do not become Community accounts.      |
| 6   | Failure recovery     | Journaled intent plus provider-proven resource identity         | Retrying continues only when the launcher can prove which resource the run created.     |
| 7   | Cancellation         | Stop future work and show retained resources; never auto-delete | Deleting a partly used database or bucket is too destructive to infer.                  |
| 8   | Hosted launcher      | Defer                                                           | It requires partner/OAuth and credential-custody work that the local path avoids.       |

No ambiguities remain for specification. Live provider writes remain gated to DOR-2169 and an operator-approved budget.
