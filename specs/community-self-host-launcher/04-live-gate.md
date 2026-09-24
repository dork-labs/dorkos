# Credentialed launcher acceptance gate

Refs DOR-2169, task 4.3. Status: implemented and locally tested; the actual provider run remains outstanding.

`pnpm --filter dorkos test:community-live` installs an exact published version, refuses a release without the launcher, and runs that installed CLI against explicitly designated disposable Fly, Neon and Tigris resources. It interrupts and resumes owner setup, checks the applied bootstrap-secret rotation, signs in through the public HTTP contract, posts and downloads a private attachment, and verifies anonymous denial. Secrets stay in private temporary files or memory; the clipboard handoff uses a private local socket.

The gate requires every `DORKOS_COMMUNITY_LIVE_*` arm, exact published version, provider organization and region, charge acknowledgement, and operator-designated budget before it may start. The budget is recorded, not a provider-enforced billing cap. Ordinary verification and CI do not receive these variables. No production origin is accepted by the HTTP proof.

Cleanup verifies recorded provider identities before deleting the disposable resources. If failure leaves resources behind, it preserves the deployment journal and prints a recovery command using the exact published `npx` package, with an explicitly quoted `DORK_HOME`, which remains usable after the temporary install is removed. Successful nonsecret receipts are written outside both cleanup directories. An execution regression runs that command through an executable package-manager stand-in after removing a disposable installation and verifies its exact arguments and ability to read a retained fixture journal. This proves command durability; it is not a full provider-failure cleanup rehearsal.

## Provenance receipt (DOR-2238, phase 2)

The receipt also carries a `provenance` block for `specs/launcher-uncertain-create-cleanup/`. It needs no new arm and adds no create: the probes run after the launch finishes and before cleanup. They only read, apart from the SSH no-op below, and they never fail the gate or hold up cleanup. A probe that cannot read records a stable code instead of provider text. `scripts/community-deploy-live-provenance.ts` holds them.

- **`fly`**: the app's network, read through the launcher's own `DorkosReadAppProvenance`, against the journal's `provenance.flyNetwork`. It records whether the two match and whether the network has the `dorkos-<32 hex>` shape, plus the app's `createdAt` and whether `internalNumericId` came back.
- **`neon`**: whether the journaled role has the `community_<32 hex>` shape and is on the project's default branch, plus the project's `created_at`.
- **`tigrisBinding`** and **`tigrisSecrets`**: whether the add-on is still bound to the journaled app, and whether `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` both exist on the app. The launcher never sets them, so both being there means Fly's `createAddOn` did.
- **`sshOnCustomNetwork`**: whether `fly ssh console --app <app> --command true` exits cleanly. It is the one probe that runs anything, a no-op inside the gate's own Machine, and it may issue an SSH certificate the first time.
- **`unknownApp`**: what the launcher's parser returns for a name no app has (`null` or an error code), and the raw envelope's shape: whether `data` and `data.app` are `null`, the error count, and each error's `extensions.code` and `path`. Error messages are never kept. This settles whether an unknown app answers `app: null` or `data: null`, and what a real not-found looks like next to a server error.
- **`networkAfterCleanup`**: whether the app's private network outlived it. Fly's API cannot list an organization's networks, so before cleanup the gate saves the node id of the network from any IP address that exposes it, and after cleanup it reads that node back: `left-behind`, `gone`, or `unknown` with a reason. It stays `unknown` when no IP address exposed the network.

The PR that flips `PROVENANCE_ROUND_TRIP_PROVED` cites this block. It needs a run on a version that writes markers. On an older version, the journal has no network to compare, and the block says so.

The implementation received independent REVIEW.md reviews, including the recovery and rotation fixes. The final local evidence is recorded in the PR. A successful local unit run does not establish a successful provider deployment. Task 4.3 remains open until a real published-release run produces its nonsecret deployment, owner, attachment and cleanup receipt.
