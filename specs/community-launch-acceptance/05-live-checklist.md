# Attended live-run checklist (DOR-2170)

Refs DOR-2170, task 1.5 (DOR-2595). The procedure for the three paid, attended runs in `02-specification.md`: **L2** (journey and recovery), **L3** (failure, restricted credentials, interruption) and **L4** (fresh accounts). Follow it in order. When a step says "record", write the value into the run's record (see [What to record](#what-to-record-and-where)) before moving on.

This file holds no secret and no real provider identifier. Every `<angle-bracket>` value is filled in at run time, in your terminal or your private notes, and never committed. Receipts and `04-acceptance.md` carry ids and digests only.

## Status of the tools this checklist uses

Some steps depend on work that is not on `main` yet. Do not start a run until everything it needs is in this table as done. The table is part of the checklist: update it in the same PR that lands each item.

| Needed by  | What                                                                                                          | Where it comes from                                  | Status on 2026-09-29        |
| ---------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------- |
| L2, L3, L4 | A published release at or after the one containing #2372, #2373, #2374 and #2378                              | the release session                                  | pending: not yet released   |
| L2, L3, L4 | DOR-2169's published-release live gate PASS, recorded in `specs/community-self-host-launcher/`                | DOR-2169 task 4.3                                    | pending                     |
| L2         | The gate's hold arm `DORKOS_COMMUNITY_LIVE_HOLD_MINUTES`, the second-person proof, `handoff.json`             | task 1.1 (DOR-2591)                                  | pending: not on `main`      |
| L2         | The driver's remote mode, `DORKOS_TWO_DESKTOP_COMMUNITY_HANDOFF`                                              | task 1.2 (DOR-2592)                                  | pending: not on `main`      |
| L2         | The no-DorkOS-host guard, `dorkosHostsContacted` and the single-sign-on check in the gate receipt             | task 1.3 (DOR-2593)                                  | pending: not on `main`      |
| L2         | `apps/community/FLY.md` "Back up and upgrade a community made with guided setup"                              | task 1.4 (DOR-2594, PR #2384)                        | done: merged                |
| L4         | The draft guide `docs/self-hosting/community.mdx`                                                             | task 1.6 (DOR-2596)                                  | pending: PR open, on `hold` |
| L3         | A confirmed way to hand the launcher a restricted Neon credential (see [L3 preconditions](#l3-preconditions)) | this checklist, proved by a dry run before any spend | pending: not yet proved     |

## Rules for every run

These apply to L2, L3 and L4 alike.

1. **Published release only.** Every run uses the published release named in the table above, installed with `npm install -g dorkos@<version>` or through the gate. A tarball run is never evidence here (`02-specification.md`, Open question 3).
2. **Operator approval first.** The operator approves each run (or the whole programme once) against the approved ~$5. Record the approval and the budget left before you start.
3. **The $2.50 stop.** Before each run, open the Fly and Neon billing pages and add up what DOR-2170 runs have spent so far. If it is more than **$2.50**, stop and ask the operator before the next run. Check again after each run and record the figure.
4. **Inventories before and after.** Take the [before inventory](#inventory-commands) immediately before a run and the after inventory once cleanup finishes. They must match, apart from the named exceptions in that section. A mismatch is a stop.
5. **A launcher or product defect is a stop.** File it as its own DOR bug, link it as blocking DOR-2170, clean up, and re-run only after the fix ships in a release.
6. **macOS, Apple Silicon.** Every run is on an Apple Silicon Mac. Record the macOS version.
7. **Never paste a secret into this repo, a receipt, a Linear comment or a PR.** Setup secrets, passwords, invite links, tokens and API keys stay in your terminal, a private `0700` folder or a password manager.

## Tools and versions

Record each version at the start of every run.

```sh
sw_vers -productVersion
node --version
dorkos --version           # must equal the published release under test
fly version                # at or above the release manifest's minimum flyctl version
neonctl --version          # at or above the release manifest's minimum neonctl version
gh --version && gh auth status
docker version --format '{{.Server.Version}}'   # L2 only: restore rehearsal and driver
```

The launcher checks the Fly and Neon CLI minimums itself and stops before consent when one is too old. Google Chrome is needed for the L2 driver.

## Inventory commands

Run these before and after each run, with the org the run uses, and save the output to a private file (it names your resources; do not commit it). Compare the two sets by resource name and id.

```sh
fly apps list --org <fly-org> --json                 # apps, and each app's network name if it is not the default
fly storage list --org <fly-org>                     # live Tigris buckets
fly storage dashboard --org <fly-org>                # opens the Tigris console: look for buckets named <name>_deleted_<suffix>
fly wireguard list <fly-org> --json                  # WireGuard peers
neonctl projects list --org-id <neon-org-id> --output json
```

What counts as a match, and the named exceptions:

- **Fly apps and live buckets:** identical before and after.
- **Soft-deleted Tigris buckets.** Fly keeps a deleted bucket's record under the name `<name>_deleted_<suffix>`, and `fly storage list` no longer shows it (see the note in `packages/cli/src/commands/community-deploy/fly-graphql-contract.ts`). After cleanup, check the Tigris console for one per bucket the run made. Record whether it is there and whether the console shows it holding objects. A soft-deleted bucket is expected, not a mismatch. Any object still in one is a stop: ask the operator.
- **WireGuard peers:** identical before and after. A new peer means something in the run opened a private tunnel into the org. Record its name, remove it with `fly wireguard remove <fly-org> <peer-name>`, and note which step created it.
- **Custom private network.** When the release includes DOR-2238's provenance markers, each launched app gets its own private network, and Fly keeps that network after the app is destroyed (`specs/launcher-uncertain-create-cleanup/02-specification.md`, Decision 1). Record the network name from `fly apps list --json` before cleanup. After cleanup the app is gone but the network may remain: record it as the expected leftover. flyctl has no command that lists networks on their own, so this check reads the app listing taken before cleanup. When the release does not include those markers, the app must show no network name at all.
- **Neon projects:** identical before and after.

## L2: journey and recovery

Covers A5 (two people and one local agent), A6 (backup and upgrade), A7 (keyboard and phone width) and A8 (no DorkOS Cloud). Estimate: under $0.25.

### L2 preconditions

- [ ] Every L2 row in the tools table is done.
- [ ] Operator approval recorded, and the $2.50 check done.
- [ ] Signed in: `fly auth login`, `neonctl auth`, `gh auth login`, on the operator's designated Fly and Neon orgs.
- [ ] Docker is running. Google Chrome is installed.
- [ ] A packaged DorkOS app of the same release for the driver: `apps/desktop/release/mac-arm64/DorkOS.app`, or `DORKOS_TWO_DESKTOP_APP` pointing at one. Build it from the release tag, never from `main`.
- [ ] The tooling (gate, driver, guard) is run from a checkout of the release tag plus the merged tooling commits, per task 2.1.
- [ ] Before inventory saved.

### L2 steps

1. **Start the gate with a 45-minute hold.** In terminal 1, from the checkout:

   ```sh
   DORKOS_COMMUNITY_LIVE_GATE=1 \
   DORKOS_COMMUNITY_LIVE_FLY_WRITES=1 \
   DORKOS_COMMUNITY_LIVE_NEON_WRITES=1 \
   DORKOS_COMMUNITY_LIVE_TIGRIS_WRITES=1 \
   DORKOS_COMMUNITY_LIVE_CLEANUP=1 \
   DORKOS_COMMUNITY_LIVE_CHARGE_ACKNOWLEDGEMENT='I ACCEPT THROWAWAY PROVIDER CHARGES' \
   DORKOS_COMMUNITY_LIVE_VERSION=<release> \
   DORKOS_COMMUNITY_LIVE_FLY_ORG=<fly-org> \
   DORKOS_COMMUNITY_LIVE_FLY_REGION=<fly-region> \
   DORKOS_COMMUNITY_LIVE_NEON_ORG=<neon-org-id> \
   DORKOS_COMMUNITY_LIVE_NEON_REGION=<neon-region> \
   DORKOS_COMMUNITY_LIVE_BUDGET_USD=<budget> \
   DORKOS_COMMUNITY_LIVE_HOLD_MINUTES=45 \
   caffeinate -i pnpm --filter dorkos test:community-live
   ```

   Watch for: the gate passes the owner proof and the second-person proof, then prints only the path of `handoff.json`. Record the start time, and the app's name (`dorkos-gate-<hex>`) from your Fly inventory or the handoff folder's path. The hold is now running: the next steps must finish inside 45 minutes, or the gate cleans up under you.

2. **Check the handoff file without reading it aloud.** `stat -f '%Lp' <handoff-dir> <handoff-dir>/handoff.json` must print `700` and `600`. Do not `cat` it into a shared terminal or a recording.

3. **Run the two-Desktop driver in remote mode.** In terminal 2:

   ```sh
   DORKOS_TWO_DESKTOP_ACCEPTANCE=1 \
   DORKOS_TWO_DESKTOP_COMMUNITY_HANDOFF=<handoff-dir>/handoff.json \
   caffeinate -i pnpm --filter @dorkos/e2e community-two-desktop
   ```

   Watch for: no Postgres container starts. Steps 5–15b, 17–20, 22, 23 and 25 run; the rest are listed as `skipped: remote-mode`. Record the run folder (`run-<timestamp>/`), the outcome, and the phone-width (390 × 844) screenshots of the live sign-in page and channel view. Proves A5 and A7.

4. **Take a backup set.** Follow `apps/community/FLY.md`, "Back up and upgrade a community made with guided setup", steps 1 to 5, against the gate's app: find what is running, pause writes, export the database, copy every file with checksums, resume service. Keep the copies in a fresh private `0700` folder outside the repo. Record the object count, the checksum file's own sha256, the image digest and the time the Machine was stopped and started.

5. **Rehearse the restore into local Docker.** Follow step 6 of the same section. Check sign-in, channel history, a thread and exact file bytes. Record which checks passed. Proves the backup half of A6.

6. **Upgrade.** Follow step 7 of the same section. Pick the version by Open question 4 of the spec:
   - If two published releases with every launcher fix share a migration fingerprint, the gate must have deployed the older one; upgrade to the newer. Record both versions and digests.
   - Otherwise redeploy the same pinned image by the same steps, and record it as a same-image redeploy. The guide and `FLY.md` then keep "not yet rehearsed on guided setup" for the cross-version upgrade.

   Then run the `OPERATIONS.md` "Upgrade and roll back" checks: `/health`, sign-in, posting, live updates and one attachment. Proves the upgrade half of A6.

7. **End the hold.** `touch <handoff-dir>/done`. Watch for: the gate deletes the handoff folder, runs identity-checked cleanup, and prints `Community live gate passed for <release> at <app>; receipt <path>`.

8. **Clean up local copies.** Delete the backup folder and remove the restore containers and volumes. Confirm with `docker ps -a` and `docker volume ls` that none of this run's remain.

9. **After inventory.** Compare with the before inventory, using the exceptions above.

### L2 pass criteria

- Gate receipt: `ownerCreated`, `privateFileRoundTrip`, `anonymousDownloadDenied` and `secondMemberProof` all true; `held.endedBy` is `signal`; `dorkosHostsContacted` is `[]`; the community offers no single sign-on. (A8)
- Driver receipt: outcome `PASS` or `PASS-WITH-FINDINGS`, and every remote-mode step passed, including 17, 18 and 22. (A5, A7)
- Restore check passed with matching bytes; upgrade check passed and is recorded as cross-version or same-image. (A6)
- Before and after inventories match.

## L3: failure, restricted credentials, interruption

Covers A2 (interruption and resume during provisioning), A3 (failed provisioning with an accurate recovery table) and A4 (non-admin credentials). Estimate: under $0.15. Attended; no gate.

### L3 preconditions

- [ ] Every L3 row in the tools table is done.
- [ ] Operator approval recorded, and the $2.50 check done.
- [ ] **Operator only:** a Fly read-only token for the designated org, with a short expiry:

  ```sh
  fly tokens create readonly --org <fly-org> --name dor-2170-l3 --expiry 4h
  ```

  Keep the token in a password manager. Record only the token's name.

- [ ] **Operator only:** a Neon project-scoped API key, made in the Neon console for a throwaway project in the designated org. It must not be able to create projects. Record only the key's name.
- [ ] **Operator only:** read-only, note which Fly org roles and which Neon org roles can create resources, from each console's members page. Record the role names, not member names.
- [ ] **How the restricted credentials reach the launcher.** The launcher does not pass `FLY_API_TOKEN` or `NEON_API_KEY` to `fly` and `neonctl`. It runs them with a fixed, short list of variables (`PATH`, `HOME`, `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR`, `WAYLAND_DISPLAY`, `FLY_CONFIG_DIR`, `GH_CONFIG_DIR` and the Windows equivalents; see `packages/cli/src/cli.ts`). An exported token is silently ignored, and the run would use the normal sign-in instead. So:
  - **Fly:** make a private `0700` folder, put the read-only token in a `config.yml` there as `access_token: <token>` with mode `0600`, and export `FLY_CONFIG_DIR=<that folder>` for step (a). Prove it first with `FLY_CONFIG_DIR=<that folder> fly orgs list`: it must show only the designated org, and `fly auth whoami` must not show the operator's normal session.
  - **Neon:** pending, not yet proved. The key has to reach `neonctl` through its own config folder under `XDG_CONFIG_HOME` or `HOME`, since `NEON_API_KEY` is dropped. Before any spend, prove a method with a dry run (below) that shows the launcher reading through the restricted key, and write the method here. **Moving `XDG_CONFIG_HOME` or `HOME` moves more than Neon's sign-in:** `gh` reads its sign-in from `XDG_CONFIG_HOME` (or `~/.config`), and moving `HOME` also moves `~/.fly`. So when you move either, pin the others back to the real folders: `GH_CONFIG_DIR=<your real gh config folder>` always, and `FLY_CONFIG_DIR=<your real ~/.fly>` too when `HOME` moves. Without that, the launcher fails at the release download (no `gh` sign-in) or at the Fly preflight, and the run proves nothing about Neon. If no method works, stop and ask the operator: A4(b) needs a different credential shape or a launcher change, filed as its own bug.
  - This corrects the earlier spec text, which assumed the environment variables reach the provider CLIs; `01-ideation.md`, `02-specification.md` and `03-tasks.json` are corrected in the same PR. The launcher gap is DOR-2602: once it ships, an exported token reaches `fly` and `neonctl` directly and this workaround can go.
- [ ] Before inventory saved.

### L3 steps

**(a) Fly credential that cannot create apps.**

1. `export FLY_CONFIG_DIR=<read-only folder>`. Keep your normal `neonctl` sign-in.
2. Dry run first; it must complete and create nothing:

   ```sh
   dorkos community deploy --fly-org <fly-org> --fly-region <fly-region> \
     --neon-org <neon-org-id> --neon-region <neon-region> \
     --app-name <app-a> --version <release> --dry-run
   ```

   **Watch for:** if the read-only token already fails a read-only check (the org listing, regions, or the app-name lookup), setup stops before consent. Record the message. That is not an A4(a) pass: A4(a) needs consent, then a refusal at the first write. Stop and ask the operator how to proceed.

3. Run it again without `--dry-run`. Type `<app-a>` at the consent prompt and `COPY TEST` at the clipboard check.
4. Expect: the first write (the Fly app create) is refused with a clear permission message, and setup stops. Record the exact message, the journal state and the recovery table it printed.
5. Inventory: nothing new in Fly or Neon. If a resource exists, that is a defect (rule 5).
6. `unset FLY_CONFIG_DIR`.

**(b) Neon credential that cannot create projects, after the Fly app exists.**

1. Normal Fly sign-in. Point `neonctl` at the restricted key by the method proved in the preconditions.
2. Dry run with `--app-name <app-b>`. **Watch for:** if the restricted key already fails the read-only preflight (it may not be able to read the org or its regions), setup stops before consent. Record the message. That is a pass for "refused with zero resources" but not for A4(b), which needs the refusal after the Fly app exists. Stop and ask the operator how to proceed.
3. Run without `--dry-run`. Type `<app-b>` and `COPY TEST`.
4. Expect: the Fly app is created and verified; the Neon project create is refused; setup stops.
5. Check the printed recovery table line by line against the real inventory: it lists exactly the Fly app, its owner (the Fly org), "may incur charges", the inspect command `fly machine list --app <app-b> --json`, the console link, "Automatic cleanup was not attempted", and a complete `--resume <run-id>` command with every flag. Record any difference.
6. `dorkos community deploy --list-incomplete` lists the run id with its state. Record it.

**(c) Resume, interrupt during the deploy, resume again.**

1. Switch `neonctl` back to the operator's normal sign-in.
2. Run the exact resume command step (b) printed.
3. Expect: the Neon project and the Tigris bucket are created. If Fly asks for Tigris terms, accept them in Fly and type `accept`.
4. When the launcher prints `Applying private secrets and deploying the pinned Community image…`, press Control-C once while `fly deploy` is running.
5. Expect: setup stops, saves its state and prints the recovery table and resume command again. Record the journal state and the error code (`CANCELLED` or `CREATION_OUTCOME_UNCERTAIN`).
6. Run the resume command again. Expect: it finishes the deploy, verifies health, then asks `Open <origin> and copy the one-time setup secret? Type copy:`.
7. Complete owner setup in the browser, press Enter in the terminal, post one message and upload then download one private file, then type `complete`.
8. Expect the completion screen: "Community setup is complete", deployment health verified, recovery readiness "not verified". Record it.

**(d) Clean up and compare.**

1. For each resource the run made, check its name and org first, then delete it:

   ```sh
   fly storage destroy <bucket> --app <app-b>
   neonctl projects delete <neon-project-id> --output json
   fly apps destroy <app-b>
   ```

2. Take the after inventory and compare, using the exceptions above.

### L3 revocation (always, even after a failed run)

- [ ] `fly tokens list --org <fly-org>`, then `fly tokens revoke <token-id>` for `dor-2170-l3`.
- [ ] Delete the Neon project-scoped key in the Neon console, and delete its throwaway project if one was made for it.
- [ ] Stop the Fly agent that ran under the read-only folder, so no background process keeps the token: `FLY_CONFIG_DIR=<read-only folder> fly agent stop`.
- [ ] Then delete the private Fly and Neon config folders made for this run.
- [ ] Record that both are revoked, with the time.

### L3 pass criteria

- (a) Refused at the first write, with a clear message, and zero resources. (A4a)
- (b) Fly app made, Neon create refused, recovery table matches the real inventory, `--list-incomplete` lists the run. (A3, A4b)
- (c) Resume after a refusal and after Control-C both finish; owner setup and one post work. (A2)
- (d) Inventories match; both credentials revoked.

## L4: fresh accounts (operator only)

Covers A1 (a new person following only the guide). Estimate: under $0.25, billed to the new accounts.

### L4 preconditions

- [ ] Every L4 row in the tools table is done.
- [ ] Operator approval recorded, and the $2.50 check done (L4 bills the new accounts; add them to the total).
- [ ] **Operator only:** new Fly and Neon accounts on an email the operator controls, each with a payment method. No apps or projects on them. Tigris terms not yet accepted.
- [ ] **Operator only:** a new macOS user account on the Apple Silicon Mac, with no DorkOS data (`~/.dork` absent) and no `fly`, `neonctl` or `gh` sign-ins.
- [ ] Only the draft guide `docs/self-hosting/community.mdx` is open, rendered from the task 1.6 branch. No other help, and no agent answering questions during the run.
- [ ] An agent may sit alongside to take notes only.

### L4 steps

1. Follow the guide from the top: install the tools, sign in, preview with `--dry-run`, start, consent, the Tigris terms step, owner setup.
2. Invite a second person from **Manage**, then **Create invite**, and join from a second browser profile.
3. In a DorkOS app of the same release, connect the community (switcher, **Add community**, **Connect a community**), add one local agent (**Members**, **Add to community**, **Join channel**), and mention it from the second person's browser. The agent answers.
4. Remove everything by the guide's own "Remove your community" steps.
5. Take an inventory of both new accounts: no Fly apps, no live buckets, no Neon projects, no WireGuard peers; soft-deleted buckets and a leftover private network recorded as above.

Throughout, the operator writes down every message, step or word that was unclear, where it was, and what they expected instead.

### L4 pass criteria

- Every step above succeeds by following only the guide.
- Every unclear point is either fixed in the task 1.6 PR or filed as a DOR bug linked as blocking DOR-2170.
- Both new accounts hold no resources afterwards.

## What to record and where

For each run, record:

- Run name (L2, L3 or L4), date, start and end times, macOS version, every tool version above.
- The published release version and the Community image digest.
- Gate receipt path (L2) and driver run folder (L2): paths and ids only.
- Journal run ids (L3), exact messages shown at each refusal, the recovery tables printed, and the completion screen text.
- Before and after inventories compared: "match", or each difference with its exception.
- Billing total across DOR-2170 runs after this run.
- Screenshots: the driver's own (L2); the terminal at each L3 stop (with nothing secret on screen); anything unclear in L4.
- Timings: how long provisioning, deploy and owner setup took.
- Every unclear message, with where it appeared.

Where:

- `specs/community-launch-acceptance/04-acceptance.md` (task 3.1): rows A1 to A8, ids and digests only.
- A comment on DOR-2170 per run, ending with the `agent:provenance` line when an agent posts it.
- Each defect as its own DOR bug, linked as blocking DOR-2170.

## Evidence map

Every acceptance row has a step here that produces its evidence.

| Row | Evidence comes from                                                |
| --- | ------------------------------------------------------------------ |
| A1  | L4, all steps                                                      |
| A2  | L3 (c)                                                             |
| A3  | L3 (b), the recovery-table comparison                              |
| A4  | L3 (a) and (b)                                                     |
| A5  | L2 steps 1 (second-person proof) and 3 (driver, including step 22) |
| A6  | L2 steps 4 to 6                                                    |
| A7  | L2 step 3 (driver steps 17 and 18, phone-width screenshots)        |
| A8  | L2 step 1 (gate receipt `dorkosHostsContacted`, no single sign-on) |
