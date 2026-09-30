---
slug: community-launch-acceptance
id: 260930-032224
created: 2026-09-29
status: ideation
linearIssue: DOR-2170
---

# Verify launch-to-first-conversation and publish the entry point

**Author:** Claude Code, directed by Dorian
**Date:** 2026-09-29

## 1) Intent and assumptions

DOR-2170 (plan alias A5) is the last step of the Community Self-Hosting project. The guided launcher (`dorkos community deploy`, DOR-2169) can already create a Fly app, a Neon project and a private Tigris bucket, deploy a pinned Community image, and hand owner setup to the browser. A5 asks a different question: can a person who has never done this go from "I want my own community" to "two people and one of my agents are talking in it", recover when something goes wrong, and keep it running afterwards? Only when that is proven does the launch action get published without the "early" label.

The acceptance list, verbatim from the issue: test a fresh account path, interruption/resume, failed provisioning, non-admin credentials, first two people and one local agent, and backup/upgrade guidance; verify keyboard/mobile use and a standalone account path without DorkOS Cloud; publish the launch action only after this passes.

Constraints carried from the issue and the plan:

- Standalone local Community accounts and independent hosts stay the supported path. DorkOS Cloud is never a prerequisite.
- No change to DorkOS Cloud. No billable resource without an operator-designated budget. The operator approved about $5 for live tests.
- Config validation or a green `/health` alone is never deployment evidence.
- The demo-claim gate in `AGENTS.md` applies: user-facing copy never says an unverified surface works.

Assumptions:

- A5 is a verification and publishing item. It adds test tooling, documentation and at most small copy fixes. Launcher defects found by the live runs are filed as their own bugs under DOR-2169's area, not fixed inside this spec's tasks.
- DOR-2169's own closing run (a published-release live gate PASS) is a prerequisite, not part of this spec. It is already a typed blocker of DOR-2170.

## 2) Pre-reading log

- `plans/community-next-phase.md` §A (A5 and its neighbours A2–A4): the outcome sentence and the rule that live Fly checks are recorded separately from local Docker acceptance.
- `specs/community-self-host-launcher/` (01–04 and `04-live-gate.md`): the launcher design, its consent gate, journal, resume and cancel rules, the credentialed live gate and its tarball mode. Task 4.3 stays open until a published-release receipt exists.
- DOR-2169 comments: eight live gate runs, 2026-09-23 to 2026-09-30. Runs 1–7 each stopped on a real defect (fixed in #2318, #2341, #2367, #2372, #2374 and #2378; #2372, #2374 and #2378 are on `main` and not yet in a release). Run 8 passed every step on a tarball of v0.92.0 plus those fixes. Receipt `~/.dork/live-gate/receipts/dorkos-gate-33aa0ed62bf3.json`: `source.kind: tarball`, `released: false`, sha256 `c17da2f1…aea020b`, commit `b644ba86…`; `ownerCreated`, `privateFileRoundTrip` and `anonymousDownloadDenied` all true; before and after inventories identical.
- `specs/community-live-deployment/04-acceptance.md` (DOR-2167): a manually deployed Fly + Neon + Tigris Community passed two people, threads, attachments, SSE reconnect, a local DorkOS pairing with a deterministic agent reply, restart, redeploy, member revocation, and a coordinated database-and-files restore rehearsal.
- A live journey on a production Community host on 2026-09-29, recorded in the private tracker: the packaged, notarized DorkOS 0.92.0 desktop app paired through the signed-out browser approval, two accounts exchanged posts, a thread reply and a 27-byte attachment, and a local agent enrolled, joined #general and answered an @mention in 1.6 s. Its four product findings are filed and closed publicly (DOR-2561, DOR-2562, DOR-2563, DOR-2564).
- `apps/e2e/community-two-desktop/`: the two-Desktop acceptance driver. Two packaged apps, two local Communities, 29 steps including keyboard switching and phone width (17–18), agent mention (22), relaunch (23), leave and removal (24–28). Local Docker only, no model, $0.
- `apps/community/FLY.md`, `OPERATIONS.md`, `DEPLOYMENT.md`, `RECOVERY.md`: the guided-setup section, manual recipe, the pause-writes backup procedure for Fly, and the Compose-centred upgrade and restore guidance.
- `apps/community/browser-tests/owner-claim.spec.ts` and `membership-accessibility.spec.ts`: owner claim at 1440 and 390 px, keyboard-only join and leave, axe, 44 px phone targets, no sideways scroll.
- `docs/guides/cli-usage.mdx` (Community server, labelled "early"), `docs/guides/communities.mdx`, `docs/self-hosting/*`.
- `apps/client/src/layers/features/dashboard-sidebar/ui/context/community-context-actions.ts`: the switcher's **Run your own community** action already exists and opens `https://dorkos.ai/docs/guides/cli-usage#community-server`.
- `meta/positioning-202607/09-gtm-plan.md` §2.0 and `AGENTS.md` product state: the demo-claim gate.

## 3) Codebase map

- Launcher: `packages/cli/src/commands/community-deploy/` (preflight, plan, journal, execute, resume, owner handoff). Preflight marks `fly-role`, `neon-role`, billing and quota as `unknown`: a missing permission can only surface at the first write. Provider CLIs inherit the full process environment, so `FLY_API_TOKEN` and `NEON_API_KEY` reach `fly` and `neonctl`.
- Live gate: `packages/cli/scripts/test-community-deploy-live.ts` and its `community-deploy-live-*.ts` siblings; owner proof in `community-deploy-live-proof.ts` (HTTP only: owner, one post, one private file, anonymous denial).
- Two-Desktop driver: `apps/e2e/community-two-desktop/` (`infra.ts` starts its own Community servers; no remote-origin mode today).
- Docs: `apps/community/FLY.md`, `docs/guides/cli-usage.mdx`, `docs/guides/communities.mdx`, `docs/self-hosting/meta.json`.
- In-app entry point: `community-context-actions.ts` (`COMMUNITY_DEPLOY_GUIDE_URL`).

## 4) Root cause analysis

Not a bug. The gap is evidence: every live run so far checked the launcher's own steps on the operator's long-standing accounts. Nothing has yet run a second person, a local agent, a backup, an upgrade, a missing permission, or a brand-new account against a community the launcher created.

## 5) Research

- Fly roles and tokens: an org-scoped session can create apps; `fly tokens create readonly` and deploy tokens cannot. Neon project-scoped API keys cannot create projects (`specs/community-self-host-launcher/01-ideation.md` §2). Which Fly and Neon org **member** roles can create resources is not settled from documentation and must be checked read-only by the operator before the restricted-credential run.
- Past live spend: each run cost a few cents at most (160 Neon CU-seconds for the longest failed pair; Fly and Tigris near zero). A held run of about 45 minutes adds compute time on one small Machine and one Neon endpoint, still well under $0.25.

## 6) Decisions

1. **One spec, three phases** (tooling and docs at $0, attended live runs, publish). Rationale: the live runs need the tooling, and publishing needs the runs.
2. **Reuse, don't rebuild.** The live gate gains an optional hold and a second-person proof; the two-Desktop driver gains a remote-origin mode. Rationale: both already carry the cleanup and evidence discipline the runs need.
3. **The existing in-app action stays.** It is honest today: it opens a docs section labelled "early". Publishing means a dedicated guide, a re-pointed link, and dropping "early", gated on the evidence below.
4. **Launcher bugs found live are filed separately** and block publishing, not this spec's tooling tasks.
