---
slug: launcher-uncertain-create-cleanup
id: 260924-003404
created: 2026-09-24
status: ideation
linearIssue: DOR-2238
project: Community Self-Hosting
---

# Remove a resource left by an uncertain Community launch create

**Author:** Claude Code
**Date:** 2026-09-24

## 1) Intent and assumptions

- **Brief (DOR-2238):** when a `dorkos community deploy` step stops with `CREATION_OUTCOME_UNCERTAIN`, the service may or may not have made the resource. Today the launcher prints read-only inspection steps and nothing else. The operator has to find the leftover resource and delete it by hand. That happened in the DOR-2169 live gate on 2026-09-23: a Fly app was left behind and was destroyed manually.
- **This is the command the launcher spec deferred.** `specs/community-self-host-launcher/02-specification.md` answered "Can cancel delete partial resources?" with "No. It reports them. A later cleanup command needs separate provenance and confirmation." This item builds that command, and only that command.
- **Assumptions:**
  - The launcher as merged at `be6fa42b2` is the baseline: `execute.ts` records a `pendingIntent` before each create, and any post-spawn failure becomes `uncertain` (`provider-mutation.ts`).
  - A resumed run can never get past an unresolved intent today. `executeCreationStep` throws `CommunityCreationUncertainError` whenever `pendingIntent` is set without a recorded id, so the only way forward is a fresh run with new names.
  - The journal schema already reserves `pendingIntent.provenanceMarker` and `pendingIntent.idempotencyKey`. Nothing writes either one yet.
- **Out of scope:** tearing down a whole run, adopting a proved resource into the run, removing resources from a run that has no marker, and any change to the six-arm live gate's defaults.

## 2) What the code says

- **The orphan class.** `executeCreationStep` journals the intent, calls `create()`, and on any error that is not a certified pre-submit failure writes `state: 'uncertain'` and stops. The resource id is not recorded. A second variant records the id from the create response but fails the exact readback; that also ends `uncertain`, with the id kept.
- **The seen case.** Before #2012, `fly apps create --json` from flyctl v0.4.104 printed a blank organization name, so the parser rejected output from a create that had worked. #2012 fixed that parse and added a fallback that identifies the app by name and slug through a listing. Uncertain Fly creates are still possible: a timeout or non-zero exit after the remote create (flyctl waits for the app after creating it), a cancelled run, or a failed fallback listing.
- **What each service lets us attach at create time** (checked against the pinned sources and the providers' API references):
  - _Fly app._ The Machines API create body takes `app_name`, `org_slug`, `network` and `enable_subdomains`. There are no labels or metadata. `fly apps create --network <name>` passes `network` through (flyctl v0.4.104 `internal/command/apps/create.go`), and the Fly GraphQL `App` type exposes `network: String` and `createdAt` (fly-go v0.9.15 `schema.graphql`). So the private network name is the only field a run can set and read back later.
  - _Neon project._ `ProjectCreateRequest` has no project tags or labels. Branch `annotations` exist in the REST API, but `neonctl projects create` does not expose them, and the launcher uses only the signed-in `neonctl` profile. `neonctl` does let the launcher choose the role and database names, and the launcher already reads the role list back (`neon-read.ts`). A run-unique role name is a marker it can set and read.
  - _Tigris bucket._ `CreateAddOnInput` takes `clientMutationId`, which the launcher already sets to the run id, but it is not stored, so it cannot be read back. The bucket is created bound to the Fly app this same run already proved (`appId`), bucket names are globally unique, and the GraphQL `App.addOns(type:)` connection lists what is bound to an app. The binding is the proof.
- **How deletion works today.** The live gate's `community-deploy-live-cleanup.ts` deletes only on an exact match between journal ids and fresh readback. It uses the `destroyFlyApp`, `deleteNeonProject` and `deleteTigris` wrappers, and removes Tigris, then Neon, then Fly. Those wrappers are the deletion seam this item reuses.
- **Research.** Nothing in `research/` covers provider provenance or launcher cleanup.

## 3) Direction

- Write a random marker into the journal **before** each create, and send it with the create: as the Fly app's private network name, and as the Neon role name. The Tigris binding stands in for a marker.
- Add one explicit mode: `dorkos community deploy --remove-uncertain <run-id>`. It reads the journal, checks the one unresolved resource against the service, and prints a verdict. Only a `proved` verdict can lead to a deletion, and only after the operator types the resource's id, or passes the same id with `--confirm`.
- After a verified removal, the journal returns to its last confirmed step, so `--resume` can carry on with the same plan.
- A journal without a marker (every run before this ships) is never eligible for removal. The command reports what it found and how to delete it by hand.

Details, edge cases and tests are in `02-specification.md`.
