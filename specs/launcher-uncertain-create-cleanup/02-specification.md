---
slug: launcher-uncertain-create-cleanup
id: 260924-004728
created: 2026-09-24
status: specified
linear-issue: DOR-2238
project: Community Self-Hosting
---

# Remove a resource left by an uncertain Community launch create

**Status:** Specified
**Author:** Claude Code
**Date:** 2026-09-24
**Input:** [`01-ideation.md`](./01-ideation.md)
**Parent spec:** [`community-self-host-launcher`](../community-self-host-launcher/02-specification.md) ("A later cleanup command needs separate provenance and confirmation.")

## Overview

`dorkos community deploy` stops with `CREATION_OUTCOME_UNCERTAIN` when a create request may have worked but the launcher could not confirm it. When no id was recorded, the run can never be resumed, and the operator has to find and delete the leftover resource by hand. This spec adds the smallest command that fixes that:

```
dorkos community deploy --remove-uncertain <run-id> [--confirm <token>]
```

It checks the run's one unresolved resource against the service. It deletes that resource only when it can **prove** the run created it, and only after the operator confirms with a token taken from a fresh read of that resource. Just before deleting, it checks again. After a verified removal, the journal goes back to its last confirmed step, so `--resume` can continue with the same plan.

The proof is a random marker. The launcher writes it into the journal before the create, sends it with the create, and later reads it back from the service. When the proof is missing, the command never deletes. It reports what it found and how to remove it by hand.

## Background

Measured against `origin/main` at `be6fa42b2`:

- `execute.ts` `executeCreationStep` records `pendingIntent { provider, organizationId, resourceName }` and then calls `create()`. Every failure after the provider process starts is classified as uncertain (`runProviderMutation`). There are two shapes:
  - **Shape A — no id.** The create failed or its output was lost. `pendingIntent` is set and `resources.<key>` is absent. Resume throws `CommunityCreationUncertainError` because `!existingId`. The run is stuck for good, and the orphan keeps any charges running.
  - **Shape B — id recorded, readback failed.** On resume, the check (`!existingId || provider !== step.service`) passes. The create is skipped and `inspect(createdId)` runs again, and preflight accepts the recorded app. **`--resume` already handles shape B**, and this spec leaves it alone.
- `formatCommunityRecovery` prints read-only commands for each service under "Manual reconciliation required", then "Automatic cleanup was not attempted."
- `LaunchJournalSchema.pendingIntent` reserves `provenanceMarker` and `idempotencyKey`. Nothing writes either one.
- `withCrossProcessLock` (`journal.ts`) is held only for the length of each `writeLaunchJournal`. It is not a lock on the run. Concurrent processes are kept apart only by the revision check inside each write.
- The deletion wrappers `destroyFlyApp(name)`, `deleteNeonProject(id)` and `FlyTigrisGraphqlClient.deleteTigris(name)` already run in the live gate's cleanup (`packages/cli/scripts/community-deploy-live-cleanup.ts`). The gate's rule is kept here: delete only after a fresh readback matches exactly.
- The seen case (DOR-2169 gate, 2026-09-23) was shape A on Fly. flyctl v0.4.104's `apps create --json` printed a blank organization name, so the parser rejected the output of a create that had worked. #2012 fixed that parse and added a fallback listing by name and slug. Shape A on Fly can still happen after a timeout, a non-zero exit, a cancelled run or a failed fallback listing.
- **Fly reads today cannot see a network.** fly-go's `GetApp` and `getAppsPage` do not select `network`, and the fixtures show `"Network": ""`. `App.id` is the app name (fixture `"ID": "community-fixture-app"`). The GraphQL `App` type exposes `network`, `createdAt`, `internalNumericId` and `appNameAvailable(name)` (fly-go v0.9.15 `schema.graphql`).
- **`NAME_CONFLICT` is never emitted.** `runProviderMutation` turns every failure after the process starts into uncertain. `assertFlyAppNameAvailable` is not called in production.
- **Tigris removal leaves secrets.** flyctl v0.4.104 `ext tigris destroy` only calls `DeleteAddOn`. The client never unsets `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` on the app.

Versions named here are the ones the fixtures were derived from. `minimumFlyctlVersion` and `minimumNeonCliVersion` are floors, not pins.

## Goals

- An operator can remove a resource left by a shape-A uncertain create with one command, without opening a provider console.
- Nothing is deleted unless a marker written before the create is read back from that exact resource, and the resource's creation time falls inside the create window. For Tigris, the equivalent is a binding to a Fly app the run proved with its own marker.
- Every deletion needs a confirmation token from fresh readback. For Fly that is `internalNumericId`, never the app name. For Neon it is the project id, and for Tigris the add-on id.
- After a verified removal, the same run can be resumed, including when Fly still holds the app name for a while.
- A process that works on the run at the same time as the removal can never cause a deletion the operator did not confirm.
- Ordinary tests never contact Fly, Neon or Tigris.

## Non-goals

- Shape B. The verdict points to `--resume`.
- Tearing down a whole run. See Follow-ups.
- Adopting a proved resource into the run instead of removing it.
- Removing anything a run without markers left behind. That includes every run started before this ships.
- Releasing an unresolved intent when nothing was found. The command reports `absent` and changes nothing.
- The "runtime secrets exist without a proven journal checkpoint" stop in `deploy.ts`. The command recognizes it and says so (§2), but removes nothing.
- Any `--yes` mode, or any change to the live gate's defaults or arms.

## Detailed design

### 1. Provenance at create time

When `executeCreationStep` records the intent, after `prepare()` and before `create()`, it adds two fields:

```ts
pendingIntent: {
  provider, organizationId, resourceName,
  provenanceMarker: randomBytes(16).toString('hex'), // 128 bits, 32 lowercase hex chars
  requestedAt: now(),                                 // new optional field
}
```

`CreationBoundary.create()` becomes `create(marker: string)`. The intent revision is durable before any provider request.

The markers are **not secret**. They show up as a Fly network name and a Postgres role name, which anyone in the organization can see. They prove that a resource came from a run; they are not credentials. The **create window** is the span from `requestedAt − 2 min` to `requestedAt + the create deadline + 2 min`. The two-minute margin allows for clock skew between the operator's machine and the service. Every proof below also requires the resource's creation time to fall inside that window.

| Service           | Marker written as                                                                                                        | Read back with                                                                                                                                                                                                                                                           | Proof                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fly app**       | `fly apps create <name> --org <slug> --network dorkos-<marker> --json --yes`                                             | A new minimal GraphQL query, `DorkosReadAppProvenance($name)`: `app(name:) { id internalNumericId name network createdAt organization { slug } machines { totalCount } volumes { totalCount } ipAddresses { totalCount } certificates { totalCount } secrets { name } }` | Exactly one app named `resourceName` in organization slug `organizationId`, with `network === "dorkos-<marker>"` and `createdAt` inside the window.                               |
| **Neon project**  | Role `community_<marker>` instead of the fixed `community_owner` (`neonctl projects create … --role community_<marker>`) | Existing `readNeonProjects(org)`, filtered by name, then the role list from `readNeonBranchTopology` on each candidate's default branch                                                                                                                                  | Exactly one project in the organization and the plan's region, named `resourceName`, with `created_at` inside the window, whose default branch has the role `community_<marker>`. |
| **Tigris bucket** | Nothing. The service offers no field a run can read back.                                                                | A new minimal GraphQL query, `DorkosFindTigrisOnApp($name)`: `app(name:) { internalNumericId network addOns(type: tigris) { totalCount nodes { id name createdAt organization { slug } } } }`                                                                            | See the carve-out below.                                                                                                                                                          |

**Tigris carve-out.** Tigris is the one service proved by binding rather than by its own marker. The binding counts as proof only when the bound app is itself re-proved in the same readback:

- `completedSteps` includes `fly_app_created`.
- The journal has `provenance.flyNetwork`, which was read back from the service (see below), and the app's `network` equals it now. An app without `provenance.flyNetwork`, which means a run started before this ships, makes the verdict `unproved`.
- `addOns.totalCount` equals the number of nodes returned. If they differ, the list was cut short, and the verdict is `unproved`.
- Exactly one add-on is named `resourceName`, it belongs to the run's Fly organization, and its `createdAt` is inside the window.

**Changes to the create path that the markers require:**

- **Fly create and inspect use the new query.** When a Fly create step completes, `inspect()` calls `DorkosReadAppProvenance` and asserts that `network` equals `dorkos-<marker>`. The completing revision stores that value, **as read back from the service**, in a new `provenance.flyNetwork` field. It is never copied from the intent.
- **The #2012 fallback uses it too.** When create output is unreadable, `createFlyApp` identifies the app by name and slug. It now also requires `network === dorkos-<marker>`, and never trusts the listing's `Network`, which is always `""`.
- **Neon.** `exactNeonProject` in `runtime/default-services.ts` matches the journaled `neonRoleId`, or, while a run is still in flight, `community_<pendingIntent.provenanceMarker>`, instead of the literal `community_owner`. `runtime/default-deploy.ts` already reads `neonRoleId`.
- **Tigris secrets must be new after a removal.** Before a Tigris removal, the command records the non-secret digests of `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` from the app's secret list in the removal record. When a resumed run creates the bucket again, its Tigris step requires both digests to differ from the recorded ones, the same rule `provesFreshStage` applies to runtime secrets. If they do not, the step stops with `INVALID_RESPONSE` and never deploys with stale bucket credentials.
- **The Fly name may still be held after a removal.** `prepare()` for the Fly step runs before the intent is recorded. When the journal's `removals` contains a Fly entry with the same name, `prepare()` calls `appNameAvailable(name)`. If Fly still holds the name, it stops before recording any intent: "Fly is still releasing the name community-acme. Try `--resume` again in a few minutes." Because no intent is recorded, this stop can never become a new uncertain stop, so removing and then resuming cannot dead-end.

**Contract gate.** The Fly and Neon proofs are safe only if the round trip is real. That means Fly accepts `dorkos-<32 hex>` as a network name and returns it unchanged, and Neon accepts `community_<32 hex>` as a role name. The mechanism:

```ts
// packages/cli/src/commands/community-deploy/provenance-gate.ts
/** Services whose marker round trip a live-gate receipt has shown. Flip only in a PR that cites the receipt. */
export const PROVENANCE_ROUND_TRIP_PROVED = { fly: false, neon: false } as const;
```

- While a flag is `false`, that service's verdict is always `unproved`, with the reason "DorkOS has not yet confirmed this proof with Fly (or Neon)". Tigris depends on the Fly flag.
- The constant is passed into `evaluateUncertainResource` as a dependency with this default, so unit tests can override it. There is no environment variable or CLI flag that can override it. A packaged CLI always uses the committed value.
- A flag is flipped in its own PR. That PR links the live-gate receipt showing the round trip and updates the packaged scenario's expectation from `unproved` to `proved` (§ Implementation phases).

### 2. Verdicts

`--remove-uncertain <run-id>` reads the journal once and keeps its `revision` as `verdictRevision`. It contacts only the service named in `pendingIntent.provider`. Every organization, name, region and time it needs comes from `recoveryContext` and `pendingIntent`. The command handles a journal as follows:

| Journal                                                      | Verdict                   | Action                                                                                                                                     |
| ------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `pendingRemoval` set                                         | (restart; see §4)         | Finish or re-offer the removal.                                                                                                            |
| `pendingIntent` set, `resources.<key>` **present** (shape B) | `resume-first`            | "This run recorded the app's id, so `--resume` can check it itself: `dorkos community deploy --resume …`" Nothing is contacted or changed. |
| `pendingIntent` set, no id (shape A)                         | one of the verdicts below | See below.                                                                                                                                 |
| `pendingIntent` null, `state: 'uncertain'`                   | `not-a-create`            | "This run stopped while checking secrets, not while creating something. There is nothing to remove." It then points to the manual steps.   |
| Anything else                                                | `nothing-pending`         | "This run has no unresolved resource." Exit 0.                                                                                             |

The shape-A verdicts:

| Verdict       | Meaning                                                                                                                                                                                                                                                                                                                                   | Action                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `proved`      | Exactly one resource meets the proof rule in §1, and the service's contract-gate flag is `true`.                                                                                                                                                                                                                                          | Show it and ask for confirmation (§3).                                                                          |
| `absent`      | Nothing with the intended name exists in the organization.                                                                                                                                                                                                                                                                                | No change. Report that the create probably never landed, and that this run cannot be resumed.                   |
| `unproved`    | Something with the intended name exists but fails the proof. The reason is printed: no marker in the journal, a different marker, another organization or region, created outside the window, more than one candidate, an incomplete add-on list, a bound app that cannot be re-proved, a contract gate not yet passed, or grown (below). | Never delete. Print the id, organization, created time and reason, plus the manual inspect and delete commands. |
| `unreachable` | A read failed, timed out, or failed its schema.                                                                                                                                                                                                                                                                                           | No change. Say it is safe to run again.                                                                         |

**Grown resources are `unproved`.** A proved resource that holds more than the launcher's create would have made is downgraded to `unproved`, with the reason "something was added after the run stopped".

- Fly: any Machine, volume, IP address, certificate or secret.
- Neon: any branch beyond the default, or any role or database beyond `community_<marker>` and `community`.
- Tigris: nothing is added to the check. Reading bucket contents is not in the query.

A journal without `recoveryContext` is `unproved` ("this run is too old to check").

### 3. Confirmation and the check before deletion

**Interactive** (stdin and stdout are a TTY, and there is no `--confirm`):

```
Run 3f2c9a1e stopped while creating a Fly app. DorkOS can prove that run made it:

  Fly app     community-acme  (internal id 4817203)
  Owner       Fly organization acme
  Created     2026-09-23 10:31:07 UTC, 4 seconds after the run asked for it
  Proof       its private network is dorkos-7f3e…c21a, the name this run recorded before creating it
  Contents    no Machines, volumes, IP addresses, certificates or secrets

Removing it deletes this app. Nothing else from this run is touched.
Type the internal id to remove it, or press Enter to keep it:
```

- **The confirmation token always comes from fresh readback.** For Fly it is `internalNumericId`. For Neon it is the project id, and for Tigris the add-on id. For Fly, the token is never the app name, which is also `App.id`, and which the operator already typed once to consent to the launch.
- Enter, EOF or Control-C keeps the resource and exits 0. A wrong token keeps it and exits 1.
- Every string shown is validated with `ExternalIdentifierSchema` or `ExternalLabelSchema` before it is printed.

**Non-interactive** (`--confirm <token>`):

- The verdict is always computed from scratch. `--confirm` is one more condition, never a bypass. The command deletes only when the verdict is `proved` and the token equals the proved resource's token exactly.
- Without a TTY and without `--confirm`, the command prints the verdict and the exact `--confirm` command, then exits 0 without writing. That is the read-only check.
- There is no `--yes`, and no environment variable can arm deletion.

**Check again just before deleting.** After confirmation, and immediately before the delete call, the command runs `find()` again. It requires the same token, the same proof and the same "not grown" result. It also re-reads the journal and requires its revision to be the one the command itself wrote in step 1 of §4. Any difference aborts without deleting.

### 4. Journal and ordering

New optional fields on schema version 1:

```ts
pendingIntent: { …, requestedAt: z.iso.datetime().optional() },
provenance: z.object({ flyNetwork: SafeIdentifierSchema.optional() }).strict().optional(),
pendingRemoval: z.object({
  provider: z.enum(['fly', 'neon', 'tigris']),
  token: SafeIdentifierSchema,          // internalNumericId / project id / add-on id
  resourceName: SafeIdentifierSchema,
  proof: z.enum(['marker', 'binding']),
  priorSecretDigests: z.record(…).optional(), // Tigris only: AWS_* digests before removal
  requestedAt: z.iso.datetime(),
}).strict().nullable().optional(),
removals: z.array(/* same fields plus removedAt */).max(8).optional(),
```

Add `REMOVAL_OUTCOME_UNCERTAIN` to `LaunchSafeErrorCodeSchema`. A launcher older than this one rejects a journal that carries these fields, because the schema is strict. That fails closed. The docs say to finish a run with the version that started it.

**The run is not locked.** Correctness comes from revision checks alone.

1. **Record intent to remove.** Write `pendingRemoval` with `expectedRevision = verdictRevision`. On `LaunchJournalConflictError`, abort without deleting: "This run changed while DorkOS was checking it. Run the command again." This catches a concurrent `--resume` or a second removal.
2. **Check again** (§3). This includes checking that the journal revision is still the one step 1 wrote.
3. **Delete** through the existing wrapper. Its exit code is only advisory, because a delete can succeed remotely and still report an error.
4. **Confirm absence** with the same query used for the verdict. Poll with capped backoff for up to 60 seconds, because Fly and Neon deletions finish asynchronously. For Fly, also call `appNameAvailable` once, and say in the result whether the name is free yet.
5. **Record the outcome** against the revision written in step 1.
   - **Gone:** append to `removals`, carrying Tigris `priorSecretDigests` forward. Clear `pendingRemoval` and `pendingIntent`. Set `state` to the last entry of `completedSteps` and `lastSafeError` to null. The run can be resumed.
   - **Still present, or the read failed:** keep `pendingRemoval`, write `state: 'uncertain'` and `lastSafeError.code: 'REMOVAL_OUTCOME_UNCERTAIN'`, and say it is safe to run the command again.

**Other processes.**

- `--resume` refuses to run while `pendingRemoval` is set.
- A `--resume` that read the journal before step 1 cannot write after it, because its next write fails the revision check. In shape A it throws before writing anyway.
- The deploy dispatcher's cancel handler currently rewrites the journal to `CREATION_OUTCOME_UNCERTAIN` whenever `pendingIntent` is set. It must not rewrite a journal that carries `pendingRemoval`.
- Removal mode has its own cancel handler. It aborts the active provider process and writes `REMOVAL_OUTCOME_UNCERTAIN` only if step 1 has landed.

**Restart with `pendingRemoval` set.** The command re-reads before doing anything else:

- The resource is gone: finish step 5 as **Gone** with no prompt.
- It is present, and still proved with the same token: go back to the confirmation prompt. A second deletion needs a second confirmation.
- Anything else: `unproved`, and stop.

**Order.** `execute.ts` stops at the first uncertain create, so there is at most one unresolved resource, and the command touches exactly that one. Resources confirmed earlier are listed as kept. When the orphan is a Tigris bucket, the app is not touched.

### 5. Command surface and output

- `community-dispatcher.ts` gains `--remove-uncertain <run-id>` and `--confirm <token>`. They cannot be combined with `--resume`, `--dry-run`, `--list-incomplete` or any plan flag. `--confirm` without `--remove-uncertain` is an error.
- `COMMUNITY_DEPLOY_HELP` changes "never removes resources automatically" to "never removes a resource without proof that this run made it and your typed confirmation", and lists both flags.
- `formatCommunityRecovery` adds one line, only for shape A: `Check whether DorkOS can prove this run made it and remove it: dorkos community deploy --remove-uncertain <run-id>`.
- `--list-incomplete` shows `removal pending` for a journal with `pendingRemoval`.
- Only the service in the intent is contacted. Fly reads use the in-memory session credential through `readFlySessionCredential`, as Tigris does today, and Neon uses the local `neonctl` profile. No token reaches argv, the environment, the journal or the output.

### 6. Module layout

- `provenance-gate.ts` (new): `PROVENANCE_ROUND_TRIP_PROVED`.
- `uncertain-removal.ts` (new): the pure verdict function and the removal state machine, behind:
  ```ts
  interface UncertainResourceProbe {
    find(intent: PendingIntent, journal: LaunchJournal): Promise<ProbeResult>; // candidates + proof facts
    remove(target: ProvedResource): Promise<void>;
    isGone(target: ProvedResource): Promise<boolean>;
  }
  ```
- `runtime/default-removal.ts` (new): the Fly, Neon and Tigris probes.
- `fly-graphql-contract.ts` and `fly-graphql-client.ts`: add `DorkosReadAppProvenance`, `DorkosFindTigrisOnApp` and `DorkosAppNameAvailable`. They never select `password`, `environment`, `ssoLink`, `metadata` or secret values; `secrets { name }` is names only.
- `execute.ts`, `fly-mutate.ts`, `runtime/default-services.ts`, `journal.ts`: the create-path changes in §1.

## User experience

1. A launch stops in shape A. The recovery text gives the `--remove-uncertain` command.
2. The operator runs it and sees one of two things: the resource DorkOS can prove, with its owner, created time, proof and contents, or a plain reason why DorkOS will not delete it.
3. They type the token. The command deletes the resource and waits until the service confirms it is gone. Then it prints: `Removed Fly app community-acme (internal id 4817203). Fly has released the name. Continue with: dorkos community deploy --resume …`. If the name is not free yet, the message says to wait a few minutes before resuming.
4. `--resume` continues from the last confirmed step with a fresh marker.

## Edge cases

- **Legacy journal (no marker):** `unproved`, "this run started before DorkOS recorded proof".
- **Same name in another organization:** the create fails and is classified as uncertain. The verdict is `absent` in the run's organization. Nothing belonging to someone else is read further or deleted.
- **Same name in the same organization, without the marker:** `unproved`.
- **Two Neon projects with the same name:** only the one with the marker, created inside the window, is proved. The other is listed as "not from this run".
- **Name held after removal:** handled by the `appNameAvailable` check in `prepare()` (§1).
- **Stale Tigris credentials after removal:** handled by the digest rule in §1.
- **Cancelled during removal:** the journal keeps `pendingRemoval`, and the restart rules apply.
- **Journal tampering is outside the threat model.** The journal is trusted local state. Someone who can write it could copy a network name they can see into it, but they could also delete the resource with the operator's own `fly` login. The proof guards against name collisions, a teammate's resources and operator mistakes, not against a local attacker.

## Testing strategy

No test contacts a live service. Everything runs at the provider seam.

- **Unit (`uncertain-removal.test.ts`)** with an in-memory probe and an injected gate:
  - Every verdict for each service: `resume-first`, `not-a-create`, `nothing-pending`, and the four shape-A verdicts.
  - Proof failures: legacy journal, different marker, wrong organization or region, created outside the window, more than one candidate, incomplete add-on list, Tigris with an app lacking `provenance.flyNetwork` or with a different network now, each Fly "grown" field, and gate `false`.
  - Confirmation: `--confirm` with the right token, a wrong token, the Fly app name (always refused), and a right token on an `unproved` verdict (refused); a clean decline.
  - The check again before deleting: the token changes between prompt and delete, a Machine appears, or the journal revision moves. Each aborts without deleting.
  - The restart matrix, the rewound journal after removal, and `REMOVAL_OUTCOME_UNCERTAIN`.
- **Concurrency:** a shape-A journal. A simulated concurrent `--resume` writes a revision between the verdict and step 1. The test asserts that `pendingRemoval` is never written and that `remove()` is never called. A second case lands a resume write between step 1 and the check before deleting, and asserts the abort.
- **Create path:** `execute.test.ts` asserts that the intent revision carrying `provenanceMarker` and `requestedAt` is persisted before `create(marker)` is called. `default-services` tests assert that the #2012 fallback rejects an app whose provenance `network` is empty or different, and that `provenance.flyNetwork` equals the value read back from the service, even when a fake returns a different value from the intent. The Tigris re-create test rejects unchanged `AWS_*` digests after a recorded removal. The `prepare()` test stops before the intent while `appNameAvailable` is false.
- **Contract fixtures:** the three new GraphQL operations, derived from fly-go v0.9.15 `schema.graphql`, and a `neonctl roles list` fixture with a `community_<hex>` role. Mutation fixtures drop or rename `network`, `internalNumericId`, `createdAt`, `organization.slug` and `addOns.totalCount` to prove that a malformed success yields `unproved`.
- **Fake executables (`scripts/test-community-deploy-package.ts`):** the fake `neonctl` echoes the requested `--role` in `roles`, in `databases.owner_name` and in the `connection-string` user, instead of the hard-coded `community_owner` (lines 112–115 today). The fake `fly` and GraphQL stand-in return the requested network. Scenarios follow the phases below.
- **Live gate** (`pnpm --filter dorkos test:community-live`, behind its existing six arms, never a default): no new arm and no induced uncertain create.
  - After the launch and before cleanup, the gate runs the read-only probes and records in its receipt the Fly `network` against `provenance.flyNetwork`, the Neon role against `community_<marker>`, and the Tigris binding.
  - It also records that `fly ssh console --app <app> --command true` works on the custom network.
  - After cleanup, it records whether the custom network still exists.
  - That receipt is what the gate-flip PR cites. Deletion needs no new live proof: the gate already exercises the same three delete wrappers.

## Documentation

- `apps/community/FLY.md` guided-launch section: what "uncertain" means, the `--remove-uncertain` command, the rule that DorkOS removes only what it can prove it made, and the leftover private network (Decision 1).
- A changelog fragment at implementation time, written for the operator.

## Implementation phases

1. **Markers and readback.** Journal fields; `create(marker)`; `--network`; the Neon role; the new Fly provenance query in `inspect()` and the #2012 fallback; `provenance.flyNetwork` from readback; the Tigris digest rule; fixtures; the fake `neonctl` role echo; `PROVENANCE_ROUND_TRIP_PROVED` committed as all `false`. Ships in a release.
2. **Live receipt.** Run the live gate on that release. It records the marker round trip, `fly ssh console` on the custom network, and whether the network is left behind.
3. **Removal command.** `uncertain-removal.ts`, the probes, the name-availability check in `prepare()`, the dispatcher flags and output, and the unit and concurrency tests with the gate overridden. The packaged scenario uses the committed gate. It asserts that a shape-A Fly orphan with the right marker gets `unproved`, with the reason "not yet confirmed", and survives. A second scenario seeds a same-name app without the marker and asserts that it survives.
4. **Gate flip.** Its own PR, citing the phase-2 receipt, sets `fly` and `neon` to `true`. It changes the packaged scenario to: the fake `fly` creates the app and then exits non-zero; `--remove-uncertain` proves it; a PTY answer with the internal id removes it; `--resume` completes. The final fake state shows exactly one app, one project and one bucket.

Runs started before phase 1 ships can never be proved.

## Decisions

The operator delegated these calls. They are the spec's defaults. **The operator may override any of them.**

1. **Each Community's Fly app gets its own private network: yes.** It is the only field a run can attach to a Fly app and read back, and it is what lets DorkOS prove the orphan class actually seen.
   - Costs: the app cannot reach other apps in the same Fly organization over Fly's private network, which Community does not need today. A custom network also persists after its apps are destroyed, so one network is left behind per launch attempt, per live-gate run and per remove-and-resume cycle.
   - Before phase 4 flips the Fly gate, the live gate must show that `fly ssh console` still works on the custom network. The `createdAt` window check applies too.
2. **Scope: the unresolved resource only.** Whole-run teardown is a follow-up.
3. **Non-interactive `--confirm`: yes.** The token comes only from fresh readback: Fly `internalNumericId`, the Neon project id, or the Tigris add-on id. It is never the Fly app name.

## Follow-ups

- **Whole-run teardown:** remove every resource a run confirmed, in the live gate's order (Tigris, Neon, Fly), reusing these probes and `provenance.flyNetwork`. Filed separately.
- **Tidy leftover private networks** from launch attempts, if the live receipt shows they accumulate.

## Related

- Parent spec: `specs/community-self-host-launcher/02-specification.md` (§"Partial failure, retry, and cancellation")
- ADR `260920-200112`: Community self-hosting starts with a local guided launcher
- DOR-2169 (live gate), #2012 (flyctl output fix and name/slug fallback)
- [Fly Machines API: apps](https://docs.fly.io/machines/api/apps-resource/), [flyctl v0.4.104 `apps create`](https://github.com/superfly/flyctl/blob/v0.4.104/internal/command/apps/create.go), [flyctl v0.4.104 `ext tigris destroy`](https://github.com/superfly/flyctl/blob/v0.4.104/internal/command/extensions/tigris/destroy.go), [fly-go v0.9.15 schema](https://github.com/superfly/fly-go/blob/v0.9.15/schema.graphql)
- [Neon create project API](https://api-docs.neon.tech/reference/createproject), [neonctl projects](https://neon.com/docs/reference/cli-projects)
