# Community launch acceptance record

Refs DOR-2170, task 3.1 (DOR-2600). This records the evidence for each acceptance row in `02-specification.md`, from the attended runs in `05-live-checklist.md`.

**Status: not yet complete.** A2 to A8 pass. A1 (L4, fresh accounts) is still pending, and so is one sub-case of A2 and A3 (DOR-2701, below). Task 3.2 (publish) does not start until both are done.

The spec stays `specified` in `specs/manifest.json` on purpose. This file's name is not one of the artifact names that move a spec's status (`STATUS_BEARING_ARTIFACTS` in `.claude/scripts/spec-manifest-ops.ts`), the same as `specs/community-live-deployment/04-acceptance.md`. The spec becomes `implemented` only when task 3.2 ships.

This file holds ids, digests, versions, pass or fail, and messages with names replaced by the checklist's `<angle-bracket>` placeholders. It holds no secret and no provider identifier: no org ids, L3 app names, project names, Machine ids or keys. A gate receipt id is the gate's own throwaway app name (`dorkos-gate-<hex>`), recorded here as `04-live-gate.md` and the checklist already do. The full run records stay private, outside the repo.

## Summary

| Row | Acceptance item                              | Status  | Evidence                                                                                                                         | Release |
| --- | -------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- | ------- |
| A1  | Fresh account path                           | PENDING | L4 not yet run (operator only)                                                                                                   | n/a     |
| A2  | Interruption and resume                      | PASS    | L3 (c): Control-C during `fly deploy`, then one immediate `--resume` that finished. Sub-case DOR-2701 pending                    | v0.97.0 |
| A3  | Failed provisioning                          | PASS    | L3 (c): the recovery table after the stop matched the real inventory line by line, then resumed to completion                    | v0.97.0 |
| A4  | Non-admin credentials                        | PASS    | L3 (a) Fly read-only token refused at the first write; L3 (b) Neon project-scoped key stopped before consent (operator decision) | v0.97.0 |
| A5  | First two people and one local agent         | PASS    | L2 gate receipt `dorkos-gate-0781c780f1f1` (`secondMemberProof`); driver run `run-1791067459626` steps 5–13, 20, 22              | v0.96.0 |
| A6  | Backup and upgrade guidance                  | PASS    | L2 steps 4–6: backup, restore into local Docker with matching bytes, same-image redeploy                                         | v0.96.0 |
| A7  | Keyboard and mobile use                      | PASS    | L2 driver steps 17 and 18, live sign-in and channel at 390 × 844 with no sideways scroll                                         | v0.96.0 |
| A8  | Standalone account path without DorkOS Cloud | PASS    | L2 gate receipt: `dorkosHostsContacted` is `[]`, `singleSignOnOffered` is `false`                                                | v0.96.0 |

## Platform and what was not verified

- Every run: macOS 26.6.2 on Apple Silicon (arm64), Node v24.14.1, flyctl v0.4.110, neonctl 7.0.1, Tigris CLI 3.14.0, gh 2.101.0. L2 also used Docker 29.5.2 and Google Chrome 154.
- Not verified: Windows, Linux, and fresh accounts (A1).
- Not verified: an upgrade from one release to another on a guided-setup community. L2 ran on v0.96.0 when v0.95.0's migration fingerprint differed, so by Open question 4 it rehearsed a same-image redeploy. The guide keeps "not yet rehearsed on guided setup" for the cross-version upgrade. v0.97.0 now shares v0.96.0's fingerprint, so a later run could rehearse v0.96.0 to v0.97.0.
- Not verified: Control-C right after setup saves a create intent and before the create's outcome is known (DOR-2701). The fix is #2528, merged but in no release yet.

## The runs

### L2: journey and recovery, v0.96.0, PASS

- Date: 2026-10-03 (UTC). Gate start 22:39:25Z, hold reached 22:44:16Z, hold ended by `done` 22:52:11Z, gate exit 0 at 22:52:41Z.
- Launcher: published `dorkos@0.96.0` from npm, installed by the gate (receipt `source.kind` is `release`, `released` is `true`). Tooling from tag `v0.96.0` (`5825e8ab5`).
- Desktop app: published `DorkOS-0.96.0-arm64.dmg`, sha256 `81264e434976966ae0699c79455fd290e9458f5cbfaf57a6a98059e4a5cb24f5`. The app inside is notarized and stapled.
- Community image: release digest `sha256:e2fdb80bae9bb3c0f892cbd0675086a1e77ccd4950a20afc2b8d98a76519b7c7`; linux/amd64, what ran on Fly, `sha256:139f652b801ed9708407d35ddc7b0866f97fbd75e69dfec330267081ccb7b4bb`. Release manifest and image attestations verified. `migrationCompatibilityId` `sha256:970a13c4e8c14d2f1effae92a3c9ff18e8ea1531d1696eb924d8565488c77511`.
- Gate receipt: id `dorkos-gate-0781c780f1f1`, file sha256 `c74461062bbfbd3d38c4f457fa2394deea2acb7029c85dd60ea3c1041b53ee06`. `ownerCreated`, `privateFileRoundTrip`, `anonymousDownloadDenied` and `secondMemberProof` all `true`; `held` is `{ minutes: 45, endedBy: "done" }`; `dorkosHostsContacted` is `[]`; `singleSignOnOffered` is `false`; `cleanup.retained` is `[]`.
- Driver receipt: run `run-1791067459626`, commit `5825e8ab5`, outcome `PASS`, file sha256 `c1f7b486d4800e6e2c2ae4b65af9a188e20c6bb2bea1e3df0dac149ec0211186`. One run, no rerun.
- Inventories before and after: match, apart from the checklist's named exceptions (the bucket's Tigris access key, deleted by hand; the private network Fly keeps; one WireGuard peer from the gate's `sshOnCustomNetwork` probe, removed).
- Spend: under $0.02.

### L3: failure, restricted credentials, interruption, v0.97.0, PASS

- Date: 2026-10-04, 02:27Z to 02:43Z (UTC).
- Launcher: published `dorkos@0.97.0` from npm.
- Community image: release digest `sha256:b65d5353fb8f460ec8d1fc1886042b99775ae00fc1f0001391c69a185788087d`; linux/amd64 `sha256:462384023d817351b248c273b97d6c1c372ed6f00083418366433cf015a83bc1`. `migrationCompatibilityId` is the same as v0.96.0's.
- Credentials: a Fly read-only token with a 4-hour expiry, a Neon project-scoped key on a throwaway project, and a Neon organization key. All three were revoked during or right after the run, and the throwaway project was deleted.
- Inventories before and after: match, apart from the named exceptions (the bucket's access key, deleted by hand; the private network Fly keeps).
- Spend: about $0.01 to $0.02.

## Evidence by row

### A1: fresh account path — PENDING

L4 has not run. It is operator only: new Fly and Neon accounts, a clean macOS user, and only the draft guide (task 1.6, PR #2387, on `hold`). Every run so far used the operator's long-standing accounts.

### A2: interruption and resume — PASS

L3 (c), run id `67c073e0-69aa-4356-a65e-9a46c9687fe9`, with `NEON_API_KEY` set to the Neon organization key for the whole run.

1. The first run made the Fly app, the Neon project and the Tigris bucket, then started `fly deploy`.
2. One Control-C while `fly deploy` ran. Setup stopped with exit code 130, printed the recovery table and the resume command, and ended on one plain line:
   `Setup was stopped. What it made so far is kept: run the resume command above to carry on.`
   The journal read state `secrets_staged`, `lastSafeError` code `CANCELLED`, no pending intent. The last line matches `CANCELLED`, as the checklist asks.
3. The printed resume command, run 11 seconds after the stop. Fly still held the Machine for the stopped deploy, so setup waited by itself about 4.5 minutes, then finished:
   ```
   Fly is still holding the Machine of <app> for another deploy. Waiting up to about 5 minutes for Fly to let go of it…
   Still waiting for Fly to let go of the Machine…
   Fly has let go of the Machine. Deploying now…
   Verifying the owner handoff and final deployment health…
   ```
4. Owner setup, one post, one private file up and down with matching bytes, anonymous download refused (401), then `complete`:
   ```
   Space setup is complete at <origin>
   Deployment health: the pinned image, one Machine, applied secrets, and /health were verified.
   Recovery readiness: not verified. Configure and rehearse a matching Neon database and Tigris file restore before relying on recovery.
   ```
   `--list-incomplete` then listed nothing. The journal read `complete`.

Earlier live runs also interrupted and resumed owner setup (gate runs 7 and 8, DOR-2169).

Automated tests: `packages/cli/src/commands/community-deploy/__tests__/resume.test.ts`, `execute.test.ts`, `fly-lease.test.ts`, `stop-launch.test.ts`, `stop-wording.test.ts`, and the second resume run in `packages/cli/scripts/test-community-deploy-package.ts`.

**Pending sub-case (DOR-2701).** A Control-C that lands just after setup saves a create intent, before the create's outcome is known, left v0.96.0 with a run that `--resume` could not continue. The fix is #2528, merged but not yet released. This sub-case needs one more attended run on the first release that contains it.

### A3: failed provisioning — PASS

Evidence comes from L3 (c)'s Control-C stop, not from (b). By the operator's decision on A4(b), a Neon project-scoped key now stops before anything is made, so (b) has no recovery table to check.

The table printed after the stop in L3 (c), checked line by line against the real inventory taken 16 seconds later:

- The Fly app, the Neon project and the Tigris bucket, each with its owner, "may incur charges", a working inspect command and a console link. The bucket is named by its name, as `fly storage list` shows it.
- The access-key note: `Removing the bucket does not remove this key; it keeps working until you remove it in Tigris.` The real key had the name the note gives.
- `Journal state: secrets_staged` and `Automatic cleanup was not attempted.`
- A complete `--resume <run-id>` command with every flag.
- Nothing else existed: no other app, bucket, key or WireGuard peer. The deploy had already started one Machine; the app line and its inspect command cover it.

Result: the table was accurate with no differences. `--list-incomplete` listed the run (`secrets_staged`, 7 resources confirmed). Resuming finished, as under A2.

Automated tests: `refused-create-launch.test.ts`, `stop-launch.test.ts`, `stop-wording.test.ts` and `execute.test.ts` under `packages/cli/src/commands/community-deploy/__tests__/`.

### A4: non-admin credentials — PASS

**(a) Fly token that cannot create apps.** A read-only token in `FLY_API_TOKEN`. The dry run created nothing. The real run passed consent, then the first write was refused:

```
Space setup failed: Fly refused to create app <app> in organization <fly-org>. The Fly token in FLY_API_TOKEN can't create apps there. Use a token or sign-in that can, then run setup again. Nothing was created, so there is nothing to clean up.
```

Exit 1, no resume command, no journal written, `--list-incomplete` empty, no new Fly app or Neon project.

**(b) Neon key that cannot create projects.** A project-scoped key in `NEON_API_KEY`, with the normal Fly sign-in. Such a key cannot read the org, so it cannot pass the read-only preflight, and the stop comes before consent rather than after the Fly app exists. The operator decided to count this early stop as the A4(b) result: before consent, zero resources, and a clear message naming `NEON_API_KEY` and the org. Five dry runs and one real run, all six the same:

```
Using the Neon key in NEON_API_KEY from your environment, not your saved sign-in.
Space setup failed: The Neon key in NEON_API_KEY can't read organization <neon-org-id>. Setup needs a key or sign-in that can create projects in it.
```

No journal, no Fly app, `--list-incomplete` empty, no Neon project beyond the key's own throwaway one. On v0.96.0 the clear message came 3 times in 9; the DOR-2700 fix made it the same every time.

**(b2) Neon organization key.** Not an A4 criterion, recorded because it is the other key shape a person may use. The dry run passed preflight and printed the full plan. A made-up region stopped before consent with a plain message:

```
Space setup failed: This Neon key can't read Neon's live list of regions, so setup checked <neon-region> against a saved list, and it isn't there. Check the region name. If it's a new Neon region, use a personal key or sign in with neonctl auth, so setup can read the live list.
```

The same organization key then carried all of L3 (c) end to end (A2).

Automated tests: `access-refusal.test.ts`, `preflight-read-order.test.ts`, `neon-read.test.ts`, `refused-create-launch.test.ts` and `credential-env-launch.test.ts` under `packages/cli/src/commands/community-deploy/__tests__/`.

### A5: first two people and one local agent — PASS

On the gate's community, made by the published v0.96.0 launcher and reached through Fly's proxy:

- Gate: the owner made the community; a second person joined by a one-time invite, read the owner's post, replied, and downloaded the owner's private file byte for byte; an anonymous download was refused (`secondMemberProof`, `privateFileRoundTrip`, `anonymousDownloadDenied` all `true`).
- Driver, two packaged DorkOS 0.96.0 apps in remote mode: both connect through the real approval (steps 6, 7), see the same channel (9), switch into the community (10), post and see each other live (11), reply in a thread (12) and pass a file with its bytes intact (13). Each person picks their own local agent (20). A mentions B's agent and B's app answers (22). B's app restarts and picks up again (23). Disconnect ends only that app's connection (25). Also passed: 14, 15, 15b and 19.
- Skipped by design in remote mode: 1–4, 8, 16, 21, 24 and 26–29 (`02-specification.md`, task 1.2).

Automated tests: the two-Desktop driver itself (`apps/e2e/community-two-desktop/`).

### A6: backup and upgrade guidance — PASS

Followed `apps/community/FLY.md`, "Back up and upgrade a community made with guided setup", during the L2 hold:

- **Backup (steps 1–5):** one Machine, stopped to pause writes for 32 seconds; a request while stopped did not wake it. Database dump 255,181 bytes, readable by `pg_restore --list`. Both bucket objects copied. Checksum file sha256 `436d441b7a2750931f14739b7ea61765749e23deeb5cd2472b4bbe5bb3a9073c`. The copy used a read-only key scoped to the bucket, deleted afterwards.
- **Restore (step 6) into local Docker:** health 200; both people sign in; history 200 with 48 entries whose ids match the live community; both threads read; both files download with sha256 values matching the checksum file.
- **Upgrade (step 7):** a same-image redeploy, by Open question 4 (see "Platform and what was not verified"). Attestations verified, `fly deploy --image …@sha256:e2fd… --ha=false` exited 0, and exactly one Machine ran the amd64 digest afterwards. The `OPERATIONS.md` checks passed: `/health` 200, sign-in for both people, a post (201), the live update seen by the member, and both files with matching bytes.
- The local copies, containers, volumes and built image were all removed afterwards.

Automated tests: `pnpm --filter @dorkos/community test:backup-restore`.

### A7: keyboard and mobile use — PASS

- Driver step 17: ⌘⇧K opens the switcher with the selected row focused, arrow keys and Enter move between contexts, and Escape returns focus to the trigger.
- Driver step 18: at phone width the icon trigger opens the context sheet.
- The live sign-in page and channel view at 390 × 844: no sideways scroll on either (`signIn-phone-overflows` and `channel-phone-overflows` both `false`), with screenshots kept in the private run folder.
- Still to do in task 3.2: the guide page itself at 390 px and by keyboard.

Automated tests: `apps/community/browser-tests/owner-claim.spec.ts` and `membership-accessibility.spec.ts`; the launcher's own typed consent and Control-C in `packages/cli/src/commands/community-deploy/__tests__/consent.test.ts` and `command.test.ts`.

### A8: standalone account path without DorkOS Cloud — PASS

- The gate loaded the no-DorkOS-host guard into the installed launcher and recorded `dorkosHostsContacted: []`.
- The new community's sign-in options offered no single sign-on (`singleSignOnOffered: false`).
- Every person in L2 and L3 used a local account on the community. No DorkOS account was used anywhere.

Automated tests: `packages/cli/src/__tests__/community-deploy-no-dorkos-hosts.test.ts`, the guard in `packages/cli/scripts/test-community-deploy-package.ts`, and `packages/cli/src/commands/community-deploy/__tests__/fly-config-health.test.ts` (no `COMMUNITY_OIDC_*` setting).

## How the live runs got here

The runs in order. Each defect a run found was filed, fixed and released before the next try, except DOR-2701.

| Run | Release | Date       | Result                          | Defect found                                                                                                                                                      | Fixed in | Released in |
| --- | ------- | ---------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| L3  | v0.94.0 | 2026-10-01 | Stopped at (a)                  | A refused Fly create ended in "creation outcome requires manual reconciliation", and `--remove-uncertain` could not clear the run (DOR-2656, DOR-2657)            | #2447    | v0.96.0     |
| L2  | v0.95.0 | 2026-10-02 | Stopped at the driver           | Step 15: a channel reopened at an old saved row after the reader caught up. Step 17: the driver expected the wrong first menu row (a test fix, not a product bug) | #2476    | v0.96.0     |
| L2  | v0.96.0 | 2026-10-03 | PASS                            | none                                                                                                                                                              |          |             |
| L3  | v0.96.0 | 2026-10-03 | (a) passed; (b) and (c) stopped | DOR-2700: the Neon preflight message was a race, vague 6 times in 9, and an organization key could never pass                                                     | #2526    | v0.97.0     |
|     |         |            |                                 | DOR-2701: Control-C right after a create intent left a run that `--resume` could not continue                                                                     | #2528    | not yet     |
|     |         |            |                                 | DOR-2702: resuming right after a stopped `fly deploy` failed while Fly held the Machine's lease, and ended on a raw error code                                    | #2529    | v0.97.0     |
| L3  | v0.97.0 | 2026-10-04 | PASS ((a), (b), (b2), (c), (d)) | none                                                                                                                                                              |          |             |

## Findings that did not block

- **Soft-deleted buckets not checked.** After cleanup Fly keeps a deleted bucket's record, which only the Tigris console shows. Neither L2 nor L3 opened the console. L3's bucket held one test object when it was removed. The operator still needs to look for the L2 and L3 buckets there and say whether they hold objects (checklist: an object left in one is "ask the operator").
- **Wording.** "Fly is still holding the Machine of `<app>` for another deploy": "another deploy" is the stopped one, and "the stopped deploy" would be plainer. Not filed.
- **Dry runs print a journal path** (`Journal: …/<id>.json`) though no journal is written. Not filed.
- **`tigris access-keys list` cuts ids short** in its table. Use `--json` to get the full id to delete. The checklist now says so.
- **The DMG reads "Unnotarized Developer ID"** under `spctl -t open`, while the app inside is notarized and stapled. Someone checking the download that way could think the signature failed. Not new in v0.96.0. Not filed.
- **`tar` warns** `Ignoring unknown extended header keyword 'LIBARCHIVE.xattr.com.apple.provenance'` when the restore unpacks an archive packed on macOS. Harmless. `FLY.md` step 6 could pack with `COPYFILE_DISABLE=1`. Not filed.
- **The bucket's Tigris access key outlives the bucket** (DOR-2646, known). The gate and the recovery table both say how to delete it.
- **Spend** across the DOR-2170 runs is well under $0.65, against the $2.50 stop and the ~$5 approval. The billing pages were not opened during these runs.
