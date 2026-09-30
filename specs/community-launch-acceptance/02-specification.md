---
slug: community-launch-acceptance
id: 260930-032224
created: 2026-09-29
status: specified
linearIssue: DOR-2170
---

# Verify launch-to-first-conversation and publish the entry point

**Status:** Draft

**Author:** Claude Code, directed by Dorian

**Date:** 2026-09-29

## Overview

Prove that a person can use `dorkos community deploy` to go from nothing to a working, recoverable Community where two people and one local agent are talking, on their own Fly, Neon and Tigris accounts, with no DorkOS Cloud involved. Then publish the launch action: a dedicated guide, the in-app **Run your own community** link pointed at it, and the "early" label removed. Nothing is published until every acceptance row below has recorded PASS evidence.

## Background / Problem Statement

The launcher (DOR-2169) passed its first full live run on 2026-09-30 (gate run 8). That run proved the launcher's own steps: create and verify the app, database and bucket, deploy the pinned image, owner setup with an interruption and resume, bootstrap rotation, one post, one private file round trip, anonymous denial, and identity-checked cleanup. It ran on the operator's long-standing accounts, from an unreleased tarball, and deleted the community minutes after it was made.

What no run has touched yet on a launcher-made community: a brand-new account, a missing permission, a failure during provisioning (as opposed to the owner step), a second person, a local agent, a backup, an upgrade, keyboard and phone use on the live origin, and proof that DorkOS Cloud is never contacted. Those are exactly DOR-2170's acceptance items.

## Goals

- Every DOR-2170 acceptance item maps to recorded evidence: an automated test, a live receipt, or a signed-off manual check.
- The live runs fit inside the operator's approved ~$5, with room for re-runs.
- Every step that only the operator can do is named, with what it needs.
- The launch action is published only after the evidence exists, and its copy claims nothing the evidence does not cover.

## Non-Goals

- Fixing launcher defects the live runs find. Each is filed as its own bug and blocks publishing (task 3.2), not this spec's tooling.
- A deploy button, a hosted launcher, custom domains, multiple Machines, or backup scheduling (all excluded by `specs/community-self-host-launcher/02-specification.md`).
- Changing DorkOS Cloud, its hosted communities, or any production Community host.
- Verifying the launcher on Windows or Linux. The docs say which platform was tested.
- Marketing-site promotion. The entry point is the docs guide and the in-app action.

## Technical Dependencies

- **DOR-2169 task 4.3, the published-release live gate PASS.** It needs a release at or after the one that contains #2372, #2373, #2374 and #2378. v0.93.0 contains #2341 and #2367 only; #2372, #2373, #2374 and #2378 are all on `main` and not yet in a release. That run is budgeted under DOR-2169's approval and is the base every live run here builds on.
- `flyctl` and `neonctl` at the launcher's declared minimums; Docker and Google Chrome for the two-Desktop driver; an Apple Silicon Mac for the packaged app.
- Existing tooling: `pnpm --filter dorkos test:community-live` (live gate, paid, six arms), `pnpm --filter @dorkos/e2e community-two-desktop` (local, $0), `pnpm --filter @dorkos/community test:backup-restore` (local, $0).

## Acceptance matrix

Status legend: **Proven** = evidence exists for a launcher-made community; **Partial** = proven elsewhere (manual Fly deploy, local Docker, fakes) but not on a launcher-made community; **Gap** = no evidence.

| #   | Acceptance item                              | What already proves it                                                                                                                                                                                                                                                                                                               | Status  | What is missing                                                                                                                                                                                                                       | How it is closed                                                                                                                         |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Fresh account path                           | Gate run 2 passed the Tigris-terms preflight; runs 2–8 passed the arms, install, `--help`, consent and clipboard prompts. All on long-standing accounts with prior apps and projects.                                                                                                                                                | Gap     | A person with new Fly and Neon accounts (no apps, terms not accepted, new payment method) and a clean machine, following only the published guide.                                                                                    | **L4**, operator-only attended run (task 2.3).                                                                                           |
| A2  | Interruption and resume                      | Live: runs 7 and 8 interrupted owner setup and resumed. Fakes: `resume.test.ts`, `execute.test.ts`, and `test:community-package` (second resume run proves each resource made once); Control-C at every step in unit tests.                                                                                                          | Partial | A live interruption **during provisioning** (after a resource exists, before the deploy completes) and a resume that finishes.                                                                                                        | **L3** (task 2.2): Control-C during `fly deploy`, `--list-incomplete`, `--resume`.                                                       |
| A3  | Failed provisioning                          | Runs 2–6 each failed live on a real defect; the launcher stopped `CREATION_OUTCOME_UNCERTAIN` and cleanup was by hand. Fakes cover billing gates, expired auth, duplicate names, lost stdout.                                                                                                                                        | Partial | A deliberate, clean failure on a published release where the printed recovery table (what exists, who owns it, possible charges, inspect commands, resume command) is checked against the real inventory, then resumed to completion. | **L3** (task 2.2), induced by the restricted Neon credential in A4.                                                                      |
| A4  | Non-admin credentials                        | Preflight marks `fly-role` and `neon-role` as `unknown` (it cannot prove a role before a write). `ACCESS_DENIED` is classified as a pre-submit authorization failure in `execute.ts`. No live evidence.                                                                                                                              | Gap     | (a) A Fly credential that cannot create apps: refused with zero resources. (b) A Neon credential that cannot create projects, after the Fly app exists: stopped cleanly with an accurate recovery table.                              | **L3** (task 2.2). The operator creates both credentials (task 2.2 preconditions).                                                       |
| A5  | First two people and one local agent         | DOR-2167 (manual Fly deploy): two people, thread, file, local DorkOS pairing, one agent reply. Production-host journey 2026-09-29 (DorkOS 0.92.0 desktop): pairing, two accounts, thread, file, agent reply in 1.6 s. Two-Desktop driver steps 1–13, 20, 22 (local Docker). Gate run 8: owner and one post only.                     | Partial | The same journey on a community the launcher made, through Fly's proxy, on a published release.                                                                                                                                       | **L2** (task 2.1): gate hold (task 1.1) plus the driver's remote mode (task 1.2).                                                        |
| A6  | Backup and upgrade guidance                  | `FLY.md` "Pause writes for a matching backup"; `OPERATIONS.md` backup, restore rehearsal and upgrade (Compose commands); DOR-2167 rehearsed a coordinated Fly restore into local Docker; `test:backup-restore` locally.                                                                                                              | Partial | Guidance written for a launcher-made community (where the digest comes from, Neon and Tigris copy commands, one-Machine redeploy), followed once live.                                                                                | Task 1.4 writes it; **L2** follows it: backup, restore into local Docker, and an upgrade (see Open question 4).                          |
| A7  | Keyboard and mobile use                      | `owner-claim.spec.ts` (390 px and Enter), `membership-accessibility.spec.ts` (axe, keyboard join and leave, 44 px targets, no sideways scroll), two-Desktop steps 17–18 (switcher by keyboard, phone width). The launcher is a terminal program: typed consent and Control-C are covered by `consent.test.ts` and `command.test.ts`. | Partial | The same checks on the live origin, plus the new guide page at phone width.                                                                                                                                                           | **L2** (task 2.1) runs driver steps 17–18 and the phone-width sign-in page on the live origin; task 3.2 checks the guide page at 390 px. |
| A8  | Standalone account path without DorkOS Cloud | By design (`specs/community-self-host-launcher/02-specification.md`, Ownership and identity). Run 8 signed in with a local Community account. `apps/community/acceptance/run.sh` runs without access to DorkOS hosts.                                                                                                                | Partial | A mechanical check that the launcher and the deployed Community never contact a DorkOS host and that the deployed Community offers no DorkOS sign-in.                                                                                 | Task 1.3 (package test and gate assertion), recorded by **L2**.                                                                          |
| A9  | Publish only after this passes               | The in-app **Run your own community** action exists and opens the CLI guide's section, labelled "early".                                                                                                                                                                                                                             | Gap     | The guide page, the link, the label change, and a changelog fragment.                                                                                                                                                                 | Tasks 3.1 and 3.2, blocked by every row above.                                                                                           |

## Detailed Design

### Tooling (phase 1, no spend)

**Gate hold and second-person proof (task 1.1).** Add an optional arm `DORKOS_COMMUNITY_LIVE_HOLD_MINUTES` (integer 1–45, unset means no hold) to `packages/cli/scripts/community-deploy-live-config.ts`. After the owner proof passes, the gate:

1. Creates a one-time invite as the owner, signs up a second local account through the public HTTP contract, and proves: the member reads the owner's post, posts a reply, downloads the owner's private file byte for byte; an anonymous request is refused.
2. Writes a handoff file with mode `0600` in a fresh `0700` directory under the retained run directory (never the repo): origin, community id, channel id, owner and member credentials, and the invite link. It prints only the file path.
3. Waits until the hold expires or a sibling file `done` appears, polling every 5 s. Control-C during the hold goes straight to cleanup.
4. Deletes the handoff file, then runs the existing identity-checked cleanup. Cleanup always runs; the hold cannot skip it.

The receipt gains `secondMemberProof: true` and `held: { minutes, endedBy: 'signal' | 'timeout' | 'interrupt' }`. No credential enters the receipt. Tests: the arm's bounds and refusal, cleanup after timeout and after interrupt, the handoff file's modes, and the file's removal before cleanup.

**Two-Desktop driver remote mode (task 1.2).** Add `DORKOS_TWO_DESKTOP_COMMUNITY_HANDOFF=<path>`. When set, `infra.ts` starts no Postgres or Community server: person A is the handoff's owner, person B is the handoff's member, and the run covers the steps that make sense on one remote community: 5–7 and 9–13 (both apps connect through the real approval, post, thread, file), 14–15b (nothing from the Community shows up in "this DorkOS"; reopening the channel lands where the reader left off), 17–18 (keyboard and phone width), 19 (neither app looks up a Community room in its local rooms), 20 and 22 (each person's agent, the mention and scripted reply), 23 (relaunch), and 25 (Disconnect). It adds phone-width (390 × 844) screenshots of the live sign-in page. It skips, and lists in the receipt as `skipped: remote-mode`, every other step: 1–4 (setup and invitation, which the live gate already did), 8 and 16 (both need a second community, and remote mode starts none), 21 (needs a private channel, which the gate's community does not have; DOR-2186 proved it locally), and 24 and 26–29 (ownership moves, leave, expired invite, rejoin and removal, which change membership and were proved locally by DOR-2182). Cleanup removes only what it made: both app connections, agent enrollments, its temporary homes. The receipt names the mode and the origin's host only.

**No DorkOS Cloud (task 1.3).** (a) In `test:community-package`, preload a guard (`--import`) into the launcher process that fails any `fetch`, `http(s).request` or DNS lookup for `dorkos.ai` or a subdomain, and assert the fake-provider flow still completes. (b) The live gate loads the same guard into the installed launcher through `NODE_OPTIONS`, and records `dorkosHostsContacted: []`. (c) The gate reads `/api/v1/auth-options` on the new community and asserts it offers no single sign-on. (d) The rendered Fly config carries no `COMMUNITY_OIDC_*` setting (`fly-config-health.test.ts`).

**Backup and upgrade guidance (task 1.4).** In `apps/community/FLY.md`, add "Back up and upgrade a community made with guided setup": find the running release and digest (launcher journal and `fly releases --json`); pause writes (existing section); export the database with `pg_dump` over the direct URL; copy every bucket object with an S3 client using the app's own keys, read from the Fly secret listing by name only; record checksums; restore rehearsal into local Docker using the existing `OPERATIONS.md` steps with the S3 variant; upgrade by deploying the next release's exact image digest from its signed manifest with `--ha=false`, then the `OPERATIONS.md` post-upgrade checks; roll back by restoring the matching set. Commands are checked against the pinned `flyctl` and `neonctl` minimums.

**Attended live checklist (task 1.5).** `specs/community-launch-acceptance/05-live-checklist.md`: for each live run, the preconditions, the exact commands, what to watch, what to record, the cleanup check (before and after inventories), and the stop rules. It carries no secret and no provider identifier.

**Guide page draft (task 1.6).** `docs/self-hosting/community.mdx`, "Run your own community", written with the `writing-for-humans` skill. It covers: what you need (Fly and Neon accounts, a payment method, the two CLIs, macOS as the tested platform); what gets made and who pays; the command, the plan screen and typed consent; if setup stops (recovery table, `--list-incomplete`, `--resume`, nothing deleted automatically); owner setup; inviting the first person; connecting DorkOS and adding an agent; backups and upgrades (links to task 1.4); no DorkOS account needed. It never says "one-click". The PR stays on `hold` until task 3.2.

### Live runs (phase 2, paid, operator-approved)

All runs use the published release from the DOR-2169 prerequisite, the operator's designated Fly org and Neon org (except L4), and the live gate's inventories and cleanup where the gate is used. After each run the before and after inventories must match, and the run's receipt or checklist record goes into `04-acceptance.md`.

- **L2, journey and recovery (task 2.1).** The gate with `DORKOS_COMMUNITY_LIVE_HOLD_MINUTES=45`. During the hold: the driver's remote mode (A5, A7); then the task 1.4 backup, restore into local Docker, and upgrade (A6); then `done`. The gate records the no-Cloud assertions (A8).
- **L3, failure, restricted credentials, interruption (task 2.2).** Attended, by the checklist. (a) With a Fly read-only token, handed to `fly` through a private `FLY_CONFIG_DIR` (the launcher drops `FLY_API_TOKEN`; see `05-live-checklist.md`): consent, then refusal at the first write, zero resources, a clear permission message. (b) Normal Fly login, a Neon project-scoped key handed to `neonctl` by the method the checklist proves (the launcher drops `NEON_API_KEY`): the Fly app is made, the Neon create is refused, the recovery table matches the real inventory, `--list-incomplete` lists the run. (c) Switch `neonctl` back to the normal sign-in, `--resume`: Neon and Tigris are made; press Control-C during `fly deploy`; `--resume` again finishes, owner setup, one post. (d) Clean up with the recorded commands; inventories match.
- **L4, fresh accounts (task 2.3).** Operator-only. New Fly and Neon accounts, a clean macOS user account, only the task 1.6 guide open. Owner setup, invite a second person (a second browser profile), connect a DorkOS app and add one agent. The operator records every place the guide or the launcher was unclear. Clean up by hand with the guide's steps.

### Publish (phase 3)

- **Record the evidence (task 3.1).** Write `specs/community-launch-acceptance/04-acceptance.md`: each row A1–A8 with its PASS evidence (receipt path and ids or digests only, checklist records, test names), the release version, and the platform. Attach the summary to DOR-2170.
- **Publish (task 3.2).** Only when 3.1 has PASS on every row and no launcher bug filed by the runs is open:
  1. Merge the guide page (task 1.6) with any L4 fixes, and add it to `docs/self-hosting/meta.json`.
  2. Point `COMMUNITY_DEPLOY_GUIDE_URL` at `https://dorkos.ai/docs/self-hosting/community` and update its test.
  3. In `docs/guides/cli-usage.mdx`, drop "(early)" and link the guide. In `docs/guides/communities.mdx`, add one line under "Start or join a Community" linking the guide.
  4. In `apps/community/FLY.md`, replace "This is a deployment recipe, not a claim that a production Fly deployment has been verified" with what was verified: guided setup on macOS with Fly, Neon and Tigris at version X, with the date. Keep the manual recipe's own caveat.
  5. A changelog fragment in `changelog/unreleased/` saying what a person can now do.
  6. Check the guide page at 390 px and by keyboard in a local site build.

## User Experience

The person's path after publishing: the switcher's **Add community** menu, **Run your own community**, the guide, the terminal command, the plan and typed consent, owner setup in the browser, an invite for the first person, connecting DorkOS and adding an agent. Every exit of the launcher already says what exists, who owns it, what may cost money and how to resume. The guide adds what to do next: backups, upgrades, and where to get help.

## Testing Strategy

- **Unit:** the hold arm (bounds, refusal of non-integers and values over 45, cleanup after timeout, interrupt and `done`, handoff file modes and removal); the remote-mode config (refuses a handoff file with loose permissions or missing fields, never starts infra); the Fly config has no single sign-on setting. Each test states what regression it catches.
- **Package:** the no-DorkOS-host guard around `test:community-package`, with a mutation check: a deliberate `fetch('https://dorkos.ai')` in the fake flow must fail the test.
- **Live:** L2, L3, L4 as above. None is reachable from `pnpm test`, `pnpm verify`, pre-push or CI. The hold arm is a new `DORKOS_COMMUNITY_LIVE_*` name and joins the paid-path table in `AGENTS.md` and the name walk in `packages/evals/src/runner/__tests__/paid-provider.test.ts`.
- **Mocking:** unchanged: fake provider executables and local HTTP fixtures for everything below the live tier.

## Performance Considerations

A held run keeps one small Machine and one Neon endpoint running for up to 45 minutes. The hold is capped and ends on `done`, so an attended run releases resources as soon as the checks finish.

## Security Considerations

- The handoff file holds two account passwords and an invite link. It is `0600` in a `0700` directory outside the repo, never printed, never in a receipt, and deleted before cleanup.
- Restricted credentials for L3 are created by the operator, used through environment variables only for that run, and revoked afterwards (read-only token and project-scoped key).
- The backup copies in L2 hold real database and file content from a throwaway community. They stay in a private temporary folder and are deleted with the local restore containers.
- Receipts and `04-acceptance.md` carry ids and digests only.

## Cost and operator-only steps

**Paid runs (estimates; past runs cost a few cents each):**

| Run                                              | Covers         | Estimate                                       |
| ------------------------------------------------ | -------------- | ---------------------------------------------- |
| L2 journey and recovery, 45 min hold             | A5, A6, A7, A8 | under $0.25                                    |
| L3 failure, restricted credentials, interruption | A2, A3, A4     | under $0.15                                    |
| L4 fresh accounts                                | A1             | under $0.25, on the new accounts               |
| Re-runs after live-only defects (plan for two)   | any            | under $0.50                                    |
| **Total**                                        |                | **under about $1.15**, inside the approved ~$5 |

The DOR-2169 published-release gate run is budgeted under DOR-2169 and not counted here. Eight runs were needed to get its first PASS, so re-runs are budgeted, not assumed away. If the provider billing pages show more than $2.50 spent across these runs, stop and ask the operator before the next one.

**Operator-only steps:**

1. Approve each paid run (or the programme once) against the ~$5.
2. Before L3: create a Fly read-only token (`fly tokens create readonly`) and a Neon project-scoped API key for a throwaway project; confirm read-only which Fly and Neon org roles can create resources; revoke both after the run.
3. L4: create new Fly and Neon accounts with a payment method, on an email the operator controls; run the guided setup from a clean macOS user account; judge the guide's clarity; delete the accounts' resources afterwards.
4. The release session publishes the release that DOR-2169's gate and every run here use (releases run in their own session).
5. Optional: open the held L2 community on a real phone for a spot check. The phone-width automation is the required evidence.

## Documentation

- New: `docs/self-hosting/community.mdx` (task 1.6), and `docs/self-hosting/meta.json` entry.
- Updated: `apps/community/FLY.md` (tasks 1.4 and 3.2), `docs/guides/cli-usage.mdx`, `docs/guides/communities.mdx`, `apps/e2e/community-two-desktop/README.md` (remote mode), `specs/community-self-host-launcher/04-live-gate.md` (hold arm), `AGENTS.md` paid-path table (hold arm).
- A changelog fragment at publish.

## Implementation Phases

- **Phase 1, tooling and docs ($0):** tasks 1.1–1.6, in parallel except that 1.2 needs 1.1's handoff format.
- **Phase 2, live runs (paid):** 2.1 needs 1.1–1.4 and 1.5; 2.2 needs 1.5; 2.3 needs 1.6. All need the DOR-2169 published-release PASS.
- **Phase 3, publish:** 3.1 needs every phase 2 run; 3.2 needs 3.1.

## Open Questions

1. ~~**Should the existing in-app action be hidden until this passes?** (RESOLVED)~~
   **Answer:** No. Keep it; change its target at publish.
   **Rationale:** it opens a docs section that already says "early" and links the manual recipe, so it claims nothing unproven. Hiding it would remove a working manual path.

2. ~~**Can the journey run on a community the gate made, or does it need a second deploy?** (RESOLVED)~~
   **Answer:** On the gate's community, during a capped hold.
   **Rationale:** one deploy, one cleanup, one inventory check. A second deploy doubles spend and adds cleanup risk.

3. ~~**Does the tarball receipt from run 8 count for DOR-2170?** (RESOLVED)~~
   **Answer:** No. Every DOR-2170 run uses a published release.
   **Rationale:** the published guide tells people to run a published release; `04-live-gate.md` says a tarball run is never evidence about a release.

4. ~~**What counts as the upgrade proof if only one post-fix release exists at L2 time?** (RESOLVED)~~
   **Answer:** If two published releases with every launcher fix share a migration fingerprint, deploy the older and upgrade to the newer by the task 1.4 steps. Otherwise redeploy the same pinned image by those steps, and the guide says the cross-version upgrade has not yet been rehearsed on guided setup.
   **Rationale:** the launcher deploys only releases whose migration fingerprint it supports, and no two such releases may exist yet. The guide must not claim what was not run.

5. ~~**Is restoring into new Fly, Neon and Tigris resources needed for the backup proof?** (RESOLVED)~~
   **Answer:** No. Restore into local Docker, as DOR-2167 did.
   **Rationale:** it proves the copy is complete and usable at no provider cost; restoring into a second paid stack adds nothing about the backup itself.

6. ~~**Is the launcher on Windows or Linux part of this?** (RESOLVED)~~
   **Answer:** No. The guide says macOS is the tested platform.
   **Rationale:** the demo-claim gate forbids claiming untested surfaces, and a Windows or Linux live run needs its own budget.

## Related ADRs

- `260916-210001`: Community is an independent Hono service on persistent Node.
- `260920-200112`: Community self-hosting starts with a local guided launcher.

No new ADR: this spec adds verification and documentation. It makes no new architectural decision.

## References

- [DOR-2170](https://linear.app/dorkspace/issue/DOR-2170), blocked by [DOR-2169](https://linear.app/dorkspace/issue/DOR-2169)
- `plans/community-next-phase.md` §A (A5)
- `specs/community-self-host-launcher/02-specification.md`, `04-implementation.md`, `04-live-gate.md`
- `specs/community-live-deployment/04-acceptance.md` (DOR-2167)
- `apps/e2e/community-two-desktop/README.md`
- `apps/community/FLY.md`, `OPERATIONS.md`, `DEPLOYMENT.md`, `RECOVERY.md`
- PRs #2318, #2339, #2341, #2366, #2367, #2372, #2373, #2374, #2378
- `meta/positioning-202607/09-gtm-plan.md` §2.0 (demo-claim gate)
