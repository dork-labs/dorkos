---
slug: launcher-uncertain-create-cleanup
id: 260924-003404
created: 2026-09-24
status: specified
linearIssue: DOR-2238
project: Community Self-Hosting
---

# Remove a resource left by an uncertain Community launch create

**Status:** Specified
**Author:** Claude Code
**Date:** 2026-09-24
**Input:** [`01-ideation.md`](./01-ideation.md)
**Parent spec:** [`community-self-host-launcher`](../community-self-host-launcher/02-specification.md) ("A later cleanup command needs separate provenance and confirmation.")

## Overview

`dorkos community deploy` stops with `CREATION_OUTCOME_UNCERTAIN` when a create request may have worked but the launcher could not confirm it. The operator is then left to find and delete that resource by hand, and the run can never be resumed. This spec adds the smallest command that fixes both problems:

```
dorkos community deploy --remove-uncertain <run-id> [--confirm <resource-id>]
```

It checks the run's one unresolved resource against the service. It deletes that resource only when it can **prove** the run created it. The operator has to type the resource's id before anything is removed. After a verified removal, the journal returns to its last confirmed step, so `--resume` can continue with the same plan.

The proof is a random marker. The launcher writes it into the journal before the create, sends it with the create, and later reads it back from the service. When that proof is missing, the command never deletes. It reports what it found and how to remove it by hand.

## Background

Measured against `origin/main` at `be6fa42b2`:

- `execute.ts` `executeCreationStep` records `pendingIntent { provider, organizationId, resourceName }` and then calls `create()`. Every post-spawn failure from `runProviderMutation` is classified as uncertain. On one, the launcher writes `state: 'uncertain'` and `lastSafeError.code: 'CREATION_OUTCOME_UNCERTAIN'`, and throws `CommunityCreationUncertainError`. There are two shapes:
  - **A — no id.** The create failed or its output was lost. `pendingIntent` is set, and `resources.<key>` is absent.
  - **B — id but no proof.** The create returned an id and it was journaled, but the exact readback failed. `pendingIntent` is set, and `resources.<key>` is present.
- On resume, either shape throws again before any write, because `pendingIntent` is non-null for the step. There is no path forward except a new run with new names. The old resource keeps any charges running until someone deletes it.
- `formatCommunityRecovery` prints per-service read-only commands under "Manual reconciliation required", along with "Automatic cleanup was not attempted."
- `LaunchJournalSchema.pendingIntent` already reserves `provenanceMarker` and `idempotencyKey`. Nothing writes either one.
- Deletion wrappers already exist and are exercised by the live gate: `destroyFlyApp(name)`, `deleteNeonProject(id)`, and `FlyTigrisGraphqlClient.deleteTigris(name)`. `packages/cli/scripts/community-deploy-live-cleanup.ts` shows the rule this spec keeps: delete only after fresh readback matches the journal exactly, and stop on the first ambiguity.
- The seen case (DOR-2169 gate, 2026-09-23) was shape A on Fly. flyctl v0.4.104 printed `apps create --json` with a blank organization name, and the parser rejected the output of a create that had worked. #2012 fixed that parse and added a fallback listing by name and slug. Shape A on Fly can still happen: flyctl waits for the new app after creating it, so a timeout, a non-zero exit, a cancelled run or a failed fallback listing all land there.

## Goals

- An operator can remove a resource left by an uncertain create with one command, without opening a provider console.
- Nothing is deleted unless a marker written before the create is read back from that exact resource. For Tigris, the equivalent is a binding to the run's already-proved Fly app.
- Every deletion needs the resource's provider-issued id, typed at a prompt or passed in `--confirm`. A matching name is never enough.
- After a verified removal, the same run can be resumed.
- Runs are idempotent and safe to interrupt. Every step is journaled before and after the provider call.
- Ordinary tests never contact Fly, Neon or Tigris.

## Non-goals

- Tearing down a whole run, including resources that were confirmed and completed (see Open decision 2).
- Adopting a proved resource into the run instead of removing it. The same proof would allow that later; this item does not build it.
- Removing anything from a journal that has no marker. That includes every run started before this ships, and the 2026-09-23 orphan, which was already removed by hand.
- Releasing an unresolved intent when nothing was found. The command reports `absent` and changes nothing (see Edge cases).
- Uncertainty outside the three create steps, such as the "runtime secrets exist without a proven journal checkpoint" stop in `deploy.ts`.
- Any `--yes` mode, or any change to the live gate's defaults or arms.

## Detailed design

### 1. Provenance markers at create time

`executeCreationStep` generates a marker when it records the intent, after `prepare()` and before `create()`:

```ts
const marker = randomBytes(16).toString('hex'); // 128 bits, lowercase hex, 32 chars
pendingIntent: { provider, organizationId, resourceName, provenanceMarker: marker }
```

`CreationBoundary.create()` becomes `create(marker: string)`. The marker is durable before any provider request, because `persistNext` writes the intent revision first.

| Service           | How the marker is written                                                                                                                                                                                                                                                                            | How it is read back                                                                                                                                                                                                                                          | What counts as proof                                                                                                                                                                                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Fly app**       | `fly apps create <name> --org <slug> --network dorkos-<marker> --json --yes`. The app's private network name is the only field the Machines API create accepts that can be read back (`app_name`, `org_slug`, `network`, `enable_subdomains`; no labels or metadata).                                | A new pinned GraphQL query `DorkosReadAppProvenance($name)` returning `app { id name network createdAt organization { slug } machines { totalCount } volumes { totalCount } }` (`App.network` and `App.createdAt` exist in fly-go v0.9.15 `schema.graphql`). | Exactly one app named `pendingIntent.resourceName`, in organization slug `pendingIntent.organizationId`, whose `network` equals `dorkos-<marker>`. For shape B, its id must also equal the journaled `flyAppId`.                                                                                                   |
| **Neon project**  | Role name `community_<marker>` instead of the fixed `community_owner`: `neonctl projects create … --role community_<marker>`. `ProjectCreateRequest` has no project tags. Branch annotations exist in the REST API but not in `neonctl`, and the launcher uses only the signed-in `neonctl` profile. | Existing `readNeonProjects(org)` filtered to `name === resourceName`, then the existing `readNeonBranchTopology` role list on each candidate's default branch.                                                                                               | Exactly one project in `pendingIntent.organizationId`, in the plan's region, named `resourceName`, whose default branch has the role `community_<marker>`. For shape B, its id must also equal the journaled `neonProjectId`.                                                                                      |
| **Tigris bucket** | No change. `CreateAddOnInput` has no field that can be read back: `clientMutationId` is not stored, and `options` is provider-validated JSON the launcher must not rely on.                                                                                                                          | A new pinned GraphQL query `DorkosFindTigrisOnApp($name)` returning `app { id addOns(type: tigris, first: 5) { nodes { id name createdAt organization { slug } addOnProvider { name } } } }`.                                                                | The Tigris step starts only after `fly_app_created` is complete, so `flyAppId` is already proved as this run's app. Proof is exactly one Tigris add-on named `resourceName`, bound to that app id, in the run's Fly organization. Tigris bucket names are globally unique, so no other bucket can carry that name. |

After a completed create, the marker leaves `pendingIntent` along with the rest of the intent. The Neon marker is kept anyway, because the role name is already journaled as `resources.neonRoleId`. The Fly marker moves into a new optional `provenance.flyNetwork` field, so the live gate and any later teardown can re-prove the app.

Other changes the markers require:

- `runtime/default-services.ts` `exactNeonProject` stops matching the literal `community_owner`. It matches the journaled role name, or for a run still in progress, `community_<pendingIntent.provenanceMarker>`. `runtime/default-deploy.ts` already reads `neonRoleId`.
- The #2012 fallback in `createFlyApp` identifies an app by name and slug when create output is unreadable. It must also check `network === dorkos-<marker>`. This closes the gap where a same-name app created in the same organization between preflight and create would have been adopted.
- **Contract gate.** A marker counts as proof only after its round trip is pinned. That means checked-in fixtures derived from the pinned flyctl and neonctl sources, plus one live-gate receipt that shows it (see Testing). Two facts must be settled there, not assumed: Fly accepts `dorkos-<32 hex>` as a network name and returns it unchanged from `App.network`, and Neon accepts and returns `community_<32 hex>` as a role name. Until the Fly or Neon round trip is proved, that service's verdict is always `unproved`.

A private network per Community app changes nothing that Community uses. It reaches Neon over public TLS and Tigris over its public endpoint (parent spec, "Storage and recovery contract"). It does isolate the app from other apps in the same Fly organization. That is a real product choice, and it is Open decision 1.

### 2. Verdicts

`--remove-uncertain <run-id>` loads the journal read-only, then asks only the service named by `pendingIntent.provider` for one of five verdicts:

| Verdict           | Meaning                                                                                                                                                                                                                                                              | Action                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `proved`          | Exactly one resource matches the proof rule above.                                                                                                                                                                                                                   | Show it, and offer removal.                                                                                                                   |
| `absent`          | Nothing with the intended name exists in the organization.                                                                                                                                                                                                           | No change. Report that the create probably never landed, and that the run cannot be resumed (the same as today).                              |
| `unproved`        | Something with the intended name exists, but the marker is missing or different, the intent has no marker (legacy journal), it sits in another organization or region, more than one candidate carries the marker, or the service's contract gate is not yet passed. | Never delete. Print what was found (id, organization, created time, and why it is not proof) with the manual inspection and deletion command. |
| `unreachable`     | A read failed, timed out, or returned output that failed its schema.                                                                                                                                                                                                 | No change. Say that it is safe to run again.                                                                                                  |
| `nothing-pending` | `pendingIntent` is null, and `pendingRemoval` (below) is null too.                                                                                                                                                                                                   | Exit 0: "This run has no unresolved resource."                                                                                                |

A `proved` resource that already holds more than the launcher's own create would have made is downgraded to `unproved` with the reason "something was added after the run stopped", and is not deleted. For Fly, that is any Machine or volume. For Neon, it is any branch beyond the default branch, or any role or database beyond the marker role and `community`. Whatever the operator added is theirs to judge.

The command needs only `run-id`. Every organization, name and region comes from the journal's `recoveryContext` and `pendingIntent`. A journal without `recoveryContext` gets `unproved` ("this run is too old to check").

### 3. Confirmation

**Interactive** (stdin and stdout are a TTY, no `--confirm`):

```
Run 3f2c9a1e stopped while creating a Fly app. DorkOS can prove that run made it:

  Fly app     community-acme  (id: 1a2b3c4d5e)
  Owner       Fly organization acme
  Created     2026-09-23 10:31:07 UTC, 4 seconds after the run asked for it
  Proof       its private network is dorkos-7f3e…c21a, the name this run recorded before creating it
  Contents    no Machines, no volumes

Removing it deletes this app. Nothing else from this run is touched.
Type the app id to remove it, or press Enter to keep it:
```

- The operator types the **provider-issued id**, not the name. The consent to launch was typing the app name, so asking for a different string stops a reflexive repeat.
- Enter, a wrong id, Control-C or EOF each keep the resource. The command exits 0 after a clean decline, and 1 after a wrong id.
- Every string shown is validated with `ExternalIdentifierSchema` or `ExternalLabelSchema` first, so a name or id cannot inject terminal controls.

**Non-interactive** (`--confirm <resource-id>`):

- The command still computes the verdict from scratch. `--confirm` is one more condition, never a bypass. It deletes only when the verdict is `proved` **and** the given id equals the proved resource's id exactly.
- Without a TTY and without `--confirm`, the command prints the verdict and the exact `--confirm` command, and exits 0 without writing. This is the read-only check. It needs no separate flag.
- There is no `--yes`, and no environment variable arms deletion.

This design keeps a real app with a colliding name safe in three independent ways. The name alone never matches: proof needs a 128-bit marker the other app cannot carry. The organization must match. And the operator types an id the command has just shown them from fresh readback.

### 4. Journal changes (`journal.ts`)

All fields are optional additions to schema version 1. A launcher older than this one rejects a journal that carries them, because the schema is strict. That fails closed and is acceptable. The help and docs say to finish a run with the version that started it.

```ts
provenance: z.object({ flyNetwork: SafeIdentifierSchema.optional() }).strict().optional(),
pendingRemoval: z.object({
  provider: z.enum(['fly', 'neon', 'tigris']),
  resourceId: SafeIdentifierSchema,
  resourceName: SafeIdentifierSchema,
  proof: z.enum(['marker', 'binding']),
  requestedAt: z.iso.datetime(),
}).strict().nullable().optional(),
removals: z.array(z.object({
  provider: z.enum(['fly', 'neon', 'tigris']),
  resourceId: SafeIdentifierSchema,
  resourceName: SafeIdentifierSchema,
  proof: z.enum(['marker', 'binding']),
  removedAt: z.iso.datetime(),
}).strict()).max(8).optional(),
```

Add `REMOVAL_OUTCOME_UNCERTAIN` to `LaunchSafeErrorCodeSchema`.

The removal runs under the existing revision check and the cross-process journal lock. Each step is one `writeLaunchJournal` revision:

1. **Record intent to remove.** Write `pendingRemoval` with the proved id and proof kind.
2. **Delete** through the existing wrapper: `destroyFlyApp(name)`, `deleteNeonProject(id)`, or `deleteTigris(name)`. Its exit code is advisory only. Like a create, a delete can succeed remotely and still report an error.
3. **Confirm absence** with the same read used for the verdict. Poll with capped backoff for up to 60 seconds, because Fly app destruction and Neon project deletion finish asynchronously.
4. **Record the outcome.**
   - _Gone:_ append to `removals`. Clear `pendingRemoval` and `pendingIntent`. Remove the resource's key from `resources`, which only matters for shape B. Set `state` to the last entry of `completedSteps`, and set `lastSafeError: null`. The run can then be resumed.
   - _Still present, or the read fails:_ keep `pendingRemoval`. Write `state: 'uncertain'` and `lastSafeError: { category: 'uncertain', code: 'REMOVAL_OUTCOME_UNCERTAIN' }`. Tell the operator that running the same command again is safe.

**Idempotency and restart.** When the command starts with `pendingRemoval` set, it re-reads before doing anything else:

- The resource is gone: finish step 4 as _Gone_ with no further prompt.
- It is present, and its marker or binding still proves it with the same id: go back to the confirmation prompt. A second deletion needs a second confirmation.
- Anything else: `unproved`. Stop without deleting.

A second run after success reports `nothing-pending`. `--resume` refuses while `pendingRemoval` is set, and `--remove-uncertain` refuses a journal whose `state` is not `uncertain` and has no `pendingRemoval`. A run that is still active holds the lock, and the command fails with the existing `JOURNAL_LOCKED` message.

**Order and partial failure.** `execute.ts` stops at the first uncertain create, so a run has at most one unresolved resource, and the command touches exactly one. Resources the run confirmed earlier are listed as kept (Open decision 2). If the orphan is a Tigris bucket, the app is not touched. Once the bucket is removed, a resume re-creates it bound to the same app, and the secrets check (`verifyTigrisSecretNames`) runs again.

### 5. Command surface and output

- `community-dispatcher.ts` gets `--remove-uncertain <run-id>` and `--confirm <resource-id>`. The two are mutually exclusive with `--resume`, `--dry-run` and every plan flag. `--confirm` without `--remove-uncertain` is an error.
- `COMMUNITY_DEPLOY_HELP` changes "never removes resources automatically" to: "never removes a resource without proof that this run made it and your typed confirmation." It also lists both flags.
- `formatCommunityRecovery`, when `pendingIntent` is set, adds one line after the manual steps: `Check whether DorkOS can prove this run made it and remove it: dorkos community deploy --remove-uncertain <run-id>`. "Automatic cleanup was not attempted." stays.
- `--list-incomplete` shows `removal pending` for a journal with `pendingRemoval`.
- Only the service in the intent is contacted. Fly needs the local `fly` session (the GraphQL queries use `readFlySessionCredential`, as Tigris does today). Neon needs the local `neonctl` profile. Both paths keep the existing secret rules: no token in argv, env, the journal or output.

### 6. Module layout

- `uncertain-removal.ts` (new): the pure verdict and removal state machine behind an `UncertainResourceProbe` port:
  ```ts
  interface UncertainResourceProbe {
    find(intent: PendingIntent, journal: LaunchJournal): Promise<ProbeResult>; // candidates + proof facts
    remove(target: ProvedResource): Promise<void>; // one delete call
    isGone(target: ProvedResource): Promise<boolean>; // absence readback
  }
  ```
- `runtime/default-removal.ts` (new): the Fly, Neon and Tigris probes over the existing read and mutate wrappers plus the two new GraphQL operations.
- `fly-graphql-contract.ts` and `fly-graphql-client.ts`: add `DorkosReadAppProvenance` and `DorkosFindTigrisOnApp`, pinned and minimal. They never request `password`, `environment`, `ssoLink` or `metadata`.
- `execute.ts`, `fly-mutate.ts`, `runtime/default-services.ts`: marker generation and use as described in §1.

## User experience

1. A launch stops. The recovery text names the unresolved resource and gives the `--remove-uncertain` command.
2. The operator runs it. Within a few seconds they see either a proved resource, with its owner, created time, proof and contents, or a plain explanation of why DorkOS will not delete it.
3. They type the id. The command deletes the resource, waits until the service confirms it is gone, and prints:
   `Removed Fly app community-acme (1a2b3c4d5e). Continue the launch with: dorkos community deploy --resume …`
4. `--resume` picks up from the last confirmed step, with a new marker for the new create.

Every exit answers what was removed, what was kept, whether charges may continue, and what to run next.

## Edge cases

- **Legacy journal (no marker):** `unproved`, "this run started before DorkOS recorded proof". The operator gets the existing manual steps plus what was found.
- **Same name, another organization:** a Fly app name taken in another organization makes the create fail. The launcher classifies that as uncertain. The verdict is `absent` in the run's organization, and nothing that belongs to someone else is read further or deleted.
- **Same name, same organization, no marker** (a teammate's app, or the operator's own second run): `unproved`, never deleted.
- **Two Neon projects with the same name**, one carrying the marker: only that one is proved. The other is listed as "not from this run". Two carrying the marker cannot happen by chance with a 128-bit random value. If it did, the verdict would be `unproved`.
- **Resource grew after the stop:** `unproved` ("something was added after the run stopped").
- **Fly name reuse after destroy:** the resumed create uses the same app name. If Fly still reserves the name for a short time, the resumed create fails before submission with `NAME_CONFLICT`, not uncertain, and the operator retries. The live gate records whether this happens.
- **Cancelled during removal:** Control-C aborts the active provider process. The journal keeps `pendingRemoval`, and the restart rules in §4 apply.
- **Journal edited by hand to point at someone else's resource:** the marker cannot be forged without also creating the resource with it. A hand-edited `resources` id in shape B must still carry the marker, so editing the journal alone never makes a foreign resource deletable.

## Testing strategy

No test contacts a live service. Everything runs at the provider seam.

- **Unit (`uncertain-removal.test.ts`)** with an in-memory `UncertainResourceProbe`. Covers every verdict for each service and both shapes (A and B); legacy journals; a marker mismatch; an organization or region mismatch; a grown resource; `--confirm` with the right id, a wrong id, and a correct id on an `unproved` verdict (refused); a clean decline; the restart matrix for `pendingRemoval`; the post-removal journal (state rewound, intent cleared, `removals` appended, resume-ready); and `REMOVAL_OUTCOME_UNCERTAIN` when absence never arrives.
- **Execution:** `execute.test.ts` asserts that the intent revision carrying the marker is persisted before `create(marker)` is called, and that the marker reaches the create call.
- **Contract fixtures:** sanitized JSON for `DorkosReadAppProvenance` and `DorkosFindTigrisOnApp`, derived from fly-go v0.9.15 `schema.graphql`. Add a `neonctl roles list` fixture with a `community_<hex>` role. Mutation fixtures remove or rename `network`, `organization.slug` and the add-on `app.id`, to prove a malformed success yields `unproved`, never `proved`.
- **Fake executables:** `test:community-package` gains one scenario. The fake `fly` creates the app and then exits non-zero, so the run stops uncertain. `--remove-uncertain` shows the proof. A PTY answer with the id removes the app. `--resume` completes the launch. Final fake-provider state shows exactly one app, one project and one bucket. A second scenario seeds a same-name app without the marker and asserts that it survives and the command prints `unproved`.
- **Security:** terminal escapes in names and ids, a symlinked journal, a journal locked by a live pid, and no secret or token in argv, the journal, stdout or stderr. These reuse the existing harnesses.
- **Live gate** (`pnpm --filter dorkos test:community-live`, behind its existing six arms, never a default): no new arm and no induced failure. After the launch and before cleanup, the gate runs the read-only verdict probes against the three resources it just created. It asserts that the Fly `network` equals `provenance.flyNetwork`, that the Neon role equals `community_<marker>`, and that the bucket is bound to the app. It records the results in its receipt. That receipt is the contract gate in §1. Deletion needs no new live proof, because the gate already exercises the same three delete wrappers in its cleanup. Inducing a real uncertain create live is not added: it depends on timing, and the fake-executable scenario covers the logic.

## Documentation

- `apps/community/FLY.md` guided-launch section: one paragraph on what "uncertain" means, the `--remove-uncertain` command, and the fact that DorkOS removes only what it can prove it made.
- Changelog fragment at implementation time, written for the operator ("If a Community launch stops unsure whether it created something, DorkOS can now check and, once you confirm, remove it").

## Implementation phases

1. Markers: journal fields, `create(marker)`, `--network`, the Neon role, the tightened #2012 fallback, and fixtures.
2. `uncertain-removal.ts`, the probes, the two GraphQL operations, and the dispatcher flags and output.
3. The fake-executable scenarios, the live-gate read-only probe, docs, and the changelog.

Phase 1 must land before phase 2 can prove anything. Runs started before phase 1 stay unprovable forever.

## Open decisions for the operator

1. **Put each Community's Fly app on its own private network.** This is the only field a run can attach to a Fly app and read back, so it is what lets DorkOS prove, and remove, the orphan class actually seen. The cost is that the Community app cannot reach other apps in the same Fly organization over Fly's private network. It does not need to today.
   **Recommended default: yes.** The alternative is to accept weaker evidence for Fly: the name journaled before the create, plus the organization, a created time inside the create window, and an empty app. That is strong but not proof, and it would break the parent spec's rule that a name match is never proof.
2. **Remove only the unresolved resource, or offer to tear down the whole run.** The issue asks for the first. The second is what an operator who gives up on a run usually wants, and the live gate's cleanup already does it for complete runs.
   **Recommended default: only the unresolved resource in this item.** File a whole-run teardown as its own item that reuses these probes. Completed resources are already proved by exact id, so that item is small.
3. **Allow a non-interactive `--confirm <resource-id>`.** The launcher deliberately has no `--yes`. `--confirm` is not a `--yes`: it must equal the id the command has just proved, and it never skips the proof.
   **Recommended default: yes, exactly as specified.** It makes scripted recovery, and the fake-executable tests, possible without a PTY, and it keeps typed-consent semantics.

## Related

- Parent spec: `specs/community-self-host-launcher/02-specification.md` (§"Partial failure, retry, and cancellation")
- ADR `260920-200112`: Community self-hosting starts with a local guided launcher
- DOR-2169 (live gate), #2012 (flyctl output fix and name/slug fallback)
- [Fly Machines API: apps](https://docs.fly.io/machines/api/apps-resource/), [flyctl v0.4.104 `apps create`](https://github.com/superfly/flyctl/blob/v0.4.104/internal/command/apps/create.go), [fly-go v0.9.15 schema](https://github.com/superfly/fly-go/blob/v0.9.15/schema.graphql)
- [Neon create project API](https://api-docs.neon.tech/reference/createproject), [neonctl projects](https://neon.com/docs/reference/cli-projects)
