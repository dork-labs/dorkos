---
slug: launcher-uncertain-create-cleanup
id: 260924-004728
created: 2026-09-24
status: ideation
linear-issue: DOR-2238
project: Community Self-Hosting
---

# Remove a resource left by an uncertain Community launch create

**Author:** Claude Code
**Date:** 2026-09-24

## 1) Intent and assumptions

- **Brief (DOR-2238):** when a `dorkos community deploy` step stops with `CREATION_OUTCOME_UNCERTAIN`, the service may or may not have made the resource. Today the launcher prints read-only inspection steps and nothing else. The operator has to find the leftover resource and delete it by hand. That happened in the DOR-2169 live gate on 2026-09-23: a Fly app was left behind and was destroyed manually.
- **This is the command the launcher spec deferred.** `specs/community-self-host-launcher/02-specification.md` answered "Can cancel delete partial resources?" with "No. It reports them. A later cleanup command needs separate provenance and confirmation." This item builds that command, and only that command.
- **Assumptions:**
  - The launcher as merged at `be6fa42b2` is the baseline. `execute.ts` records a `pendingIntent` before each create, and any failure after the provider process starts becomes `uncertain` (`provider-mutation.ts`).
  - The journal schema already reserves `pendingIntent.provenanceMarker` and `pendingIntent.idempotencyKey`. Nothing writes either one yet.
  - The journal is trusted local state. It is mode `0600` under the operator's DorkOS data directory. Anyone who can rewrite it can already run the operator's `fly` and `neonctl` directly.
- **Out of scope:** tearing down a whole run (filed as a follow-up), adopting a proved resource into the run, removing anything a run without markers left behind, and any change to the six-arm live gate's defaults.

## 2) What the code says

- **Two shapes of uncertain stop.** In `executeCreationStep`, a failed or unreadable create writes `state: 'uncertain'` without recording an id. This is **shape A**. When the create returned an id but the readback failed, the id is journaled. This is **shape B**.
  - **Shape A is stuck.** On resume, `executeCreationStep` throws whenever `pendingIntent` is set and no id is recorded (`!existingId || pendingIntent.provider !== step.service`). The only way forward today is a fresh run with new names, and the orphan stays behind. This is the class seen in the live gate.
  - **Shape B is not stuck.** With the id journaled, resume skips the create and runs `inspect(createdId)` again. Preflight accepts the recorded app. So `--resume` is already the fix for shape B, and this item leaves it alone.
- **The seen case.** Before #2012, flyctl v0.4.104's `fly apps create --json` printed a blank organization name, so the parser rejected output from a create that had worked. #2012 fixed that parse and added a fallback that identifies the app by name and slug through a listing. Shape A on Fly can still happen: flyctl waits for the new app after creating it, so a timeout, a non-zero exit, a cancelled run or a failed fallback listing all land there.
- **What each service lets a run attach at create time and read back later.** These were checked against flyctl v0.4.104 and fly-go v0.9.15, the versions the fixtures come from (`minimumFlyctlVersion` is a floor, not a pin), and against the providers' API references.
  - _Fly app._ The Machines API create body takes `app_name`, `org_slug`, `network` and `enable_subdomains`. There are no labels or metadata. `fly apps create --network <name>` passes `network` through. The fly-go queries flyctl uses (`GetApp`, `getAppsPage`) do not select `network`, and the checked-in fixtures show `"Network": ""`. The GraphQL `App` type does expose `network`, `createdAt` and `internalNumericId`, so the launcher needs its own GraphQL read. `App.id` is the app's name, not a separate id.
  - _Neon project._ `ProjectCreateRequest` has no project tags or labels. Branch `annotations` exist in the REST API, but `neonctl projects create` does not expose them. `neonctl` does let the launcher choose the role name, and the launcher already reads the role list back.
  - _Tigris bucket._ `CreateAddOnInput.clientMutationId` is not stored, so it cannot be read back. The bucket is created bound to the run's Fly app, bucket names are globally unique, and `App.addOns(type:)` lists what is bound to an app, with a `totalCount`. flyctl's `ext tigris destroy` only calls `DeleteAddOn`. Nothing in the client unsets the app's `AWS_*` secrets.
- **How deletion works today.** The live gate's `community-deploy-live-cleanup.ts` deletes only on an exact match between journal ids and fresh readback. It uses the `destroyFlyApp`, `deleteNeonProject` and `deleteTigris` wrappers, which this item reuses.
- **Journal locking.** `withCrossProcessLock` is held only for the length of one `writeLaunchJournal`, not for a whole run. Two processes can work on the same run; only their writes are serialized, through the revision check.
- **Research.** Nothing in `research/` covers provider provenance or launcher cleanup.

## 3) Direction

- Before each create, write a random marker and its request time into the journal. Send the marker with the create: as the Fly app's private network name, and as the Neon role name. Tigris is proved by being bound to a Fly app the run itself proved with its marker.
- Add one explicit mode: `dorkos community deploy --remove-uncertain <run-id>`. It handles only shape A. It checks the one unresolved resource against the service and prints a verdict. A deletion happens only on a `proved` verdict, only after the operator types a token from fresh readback (or passes the same token with `--confirm`), and only after a second check just before the delete.
- After a verified removal, the journal returns to its last confirmed step, so `--resume` can carry on with the same plan.
- A run without a marker is never eligible for removal. The command reports what it found and how to delete it by hand.

Details, edge cases and tests are in `02-specification.md`.
