---
slug: server-merge
number: 261013-000229
created: 2026-10-12
status: specified
---

# One DorkOS server: the merge plan

**Status:** Specified. Planning only; no code lands from this document.
**Author:** Claude, for Dorian Collier
**Date:** 2026-10-12
**Linear:** DOR-2874 (umbrella, parent DOR-2735); steps DOR-2875 to DOR-2885, project "Spaces & One Server"
**Carries out:** ADR [261006-235238](../../decisions/261006-235238-one-dorkos-server-in-every-size.md), started before launch on 2026-10-12, go/no-go November 16
**Ideation:** [01-ideation.md](01-ideation.md) (Dorian's 12 requirements, the codebase summary and the options weighed)

> **Changed 2026-10-15 by [`everything-is-a-space`](../everything-is-a-space/02-specification.md) (ADR `261015-042933`).** Steps 1 to 4 and 6 continue inside that plan's chat C, on the same dates, so the official space is upgraded by November 20 for the December 8 soft launch; step 4's 20,000-stream bar now gates the late-January launch. Step 10 ("one window") is replaced by the hub, the session relay and one sidebar. Requirement 5 changes for Cloud team spaces (members sign in with a DorkOS account), requirement 6 is met by the session relay, requirement 11 brings team spaces into launch, and the non-goal "merging the space's web page into the app" is resolved by hubs. Step 6 no longer depends on step 4, and go/no-go criterion 4 (the 20,000-stream bar) now applies to the January launch, not the soft launch, which runs with current users only. Step 2's code moves about a week later and the release with steps 2 and 3 is cut on November 9 to 10; the go/no-go and the November 20 cutoff keep their dates. The dates below are the old Dec 8 plan where they say "launch".

## Overview

DorkOS has two server programs: the DorkOS server on your computer (`apps/server`) and the space server (`apps/community`). ADR 261006-235238 makes them one program. Dorian moved that work before launch because "doing it after we have users could be pretty messy".

This plan takes that reason literally. **What gets messy after users is not where the code lives. It is the shape of people's data and the promises other programs depend on.** Code can be moved at any time with a normal upgrade. Data that thousands of people have written cannot be reshaped without risk, and an app version people have installed keeps talking the way it was built to talk.

So the plan splits the merge by how hard each part is to change later:

| Part                                                                                                                                                                                                                                                                | Hard to change after users?                                 | When          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------- |
| **How agents are stored in a space.** Today a message's author is either a person or an agent, in two different columns. Equal accounts (ADR 261006-235239) make them one kind of member. Joining them later means rewriting who wrote every message, on live data. | Yes                                                         | Before launch |
| **Agent availability.** Dorian wants to see where each agent runs and whether it is there right now. Today nothing records it. Apps installed before it exists would show "unknown" for good.                                                                       | Yes                                                         | Before launch |
| **The promises other programs depend on:** how the app talks to a space, the host API Cloud calls, the sign-in paths, the operator commands and settings. Frozen, with tests, so the rest of the merge cannot break them by accident.                               | Yes                                                         | Before launch |
| **The names** those promises use ("community" in paths and settings). Kept as they are, for good, because people never see them; the words people see already say "space".                                                                                          | Yes                                                         | Decided now   |
| **Where the code lives:** one package, one entry, one image                                                                                                                                                                                                         | No: an ordinary upgrade                                     | After launch  |
| **One account model, a Mac that can host spaces, one room system**                                                                                                                                                                                                  | Partly (the Mac's rooms move is a data move, planned below) | After launch  |
| **One window:** the app connects to any DorkOS server directly                                                                                                                                                                                                      | No                                                          | After launch  |

Before launch, the official space gets the first four. After launch, the program, model and window merges follow in order, and none of them needs to reshape the hosted data again.

## Background

`01-ideation.md` holds the full picture. The facts that drive the design:

- **The local server's database is synchronous.** About 4,200 synchronous query calls and 470 transactions across about 530 files use `better-sqlite3` through Drizzle. Putting Postgres under the local server first turns all of them async: months, not weeks.
- **The space server is raw Postgres.** About 1,150 hand-written queries; the Drizzle schema in `apps/community/src/schema.ts` is a mirror nothing imports. It uses triggers, deferred constraint checks (message numbering at commit, migration `0037`), `LISTEN/NOTIFY` for live streams, row locks and job claims SQLite does not have, and snapshot checks on sign-in. It cannot run on SQLite without a rewrite.
- **One space host already holds many spaces.** Accounts, sessions, host operators and host API keys belong to the whole host; every space's own data (members, channels, messages, files, agents) carries the space's id (`specs/community-tenancy-contract`). Roles are owner, admin and member.
- **Agents are not members in a space today.** They live in their own tables (`agents`, `agent_credentials`, `agent_channel_members`, migration `0001`). A message records its author in one of two columns, `author_member_id` or `author_agent_id`, with a check that exactly one is set (migration `0002`). Nothing records where an agent runs or when it was last seen.
- **The space image already rides the app's releases.** It is built on the same `v*` tags (`.github/workflows/publish-community.yml`). The self-host launcher already lives in the `dorkos` CLI.
- **Operators run offline commands by path inside the image:** `dist-server/host-keys.js`, `dist-server/erasure/reapply.js`, `dist-server/backout.js`, `dist-server/takedown/commands.js`, `dist-server/recover-password.js` and `dist-server/host/release-unverified-account.js` (`apps/community/OPERATIONS.md`, `RECOVERY.md`, `DEPLOYMENT.md`). The Cloud host runbooks use some of them too.
- **The 20,000-stream bar is not met yet on any image.** Laptop runs met it at 1,000 and 5,000 streams; 10,000 was inconclusive (delivery p95 about 5.5 s, the load machine saturated). Above about 5,000 streams, posts wait on a per-channel lock (DOR-2764, comment of 2026-10-11).

## Goals

- Before launch, the official space's data already has its long-term shape for agents: an agent is a member, and a message has one author.
- Before launch, every app that connects to a space reports where its agents run and when they were last there, and spaces show it.
- The promises other programs depend on are listed and pinned by tests.
- The full merge (one program, one model, one window) is planned, ordered and ticketed, so launch leaves nothing half-done.

## Non-goals (before launch)

- Moving the space code into `apps/server`, building the image from the DorkOS server package, or a `dorkos --role space` command.
- Equal accounts for people (access levels, guests, per-account keys; DOR-2743), the one message system (DOR-2744), live shared docs (DOR-2750), mini apps on hosted spaces, and agents moving between computers.
- A Mac that hosts a team, or moving a Mac's rooms into the space store.
- Merging the space's web page into the DorkOS app.

## Decisions

| #   | Question                                     | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Why                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | What goes before launch                      | **The parts that are hard to change once people use DorkOS:** agents stored as members, agent availability, frozen promises, and the names. The program, model and window merges come after launch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Dorian's own reason for moving the merge. Moving code before launch adds launch-month risk (it would break the operator commands and file paths the image relies on) and spares no later mess.                                                           |
| D2  | Database                                     | **Two stores, split by what the data is about, in one program.** The machine store (SQLite) holds what only exists where agents run: agents, sessions, runtimes, connections, this computer's own rooms. The space store (Postgres) holds spaces a server hosts for other people. No layer that hides which database is underneath.                                                                                                                                                                                                                                                                                                                                             | Postgres everywhere, or one layer over both, needs the local server's 4,200 synchronous calls made async first. Both stores exist and are tested today.                                                                                                  |
| D3  | An agent in a space                          | **An agent is a member of the space, with kind "agent" and a link to the member who owns it.** Every message has one author: a member. The old agent columns stay readable while apps upgrade, then retire after launch. Owner rules stay as today: the owner's mute and rules acceptance cover their agents, only the owner adds an agent, and an admin can remove or mute any agent.                                                                                                                                                                                                                                                                                          | It is the space-side half of equal accounts (ADR 261006-235239), and the only half that rewrites existing data. Doing it while the official space holds mostly staff and test data costs little; doing it later means rewriting authorship on live data. |
| D4  | Where an agent runs, and whether it is there | **The computer that runs an agent tells each space it belongs to.** A space stores, per agent, what kind of computer runs it (a person's computer, or an agent computer) and when it last reported in. A space shows "available" or "offline since …". Only that computer ever runs the agent; a space never runs a turn.                                                                                                                                                                                                                                                                                                                                                       | Dorian's requirement 1. Apps installed at launch must already report it, or they show "unknown" until they update.                                                                                                                                       |
| D5  | Names in paths and settings                  | **Keep "community" in paths, settings (`COMMUNITY_*`), the image name and the host API, for good.** People never see them; the words people see already say "space" (#2436). Code inside the program is renamed when it moves (after launch), with no new names on the outside.                                                                                                                                                                                                                                                                                                                                                                                                 | Renaming later means two names forever. Renaming now changes the promises Cloud and installed apps rely on during launch month. Keeping them is the only choice with one name.                                                                           |
| D6  | Frozen promises                              | The way the app talks to a space (`/api/v1/...` and `/api/v1/communities/:communityId/...`), the host API (`/api/v1/host/...`, its 10 key scopes and the host key format), the sign-in surface (the 23 allowed Better Auth endpoints, the "Continue with DorkOS" provider and its callback path, and the rule for linking accounts from the trusted provider), the page routes, `/health`, `/health/ready`, `/metrics`, the offline operator commands, the image's start command and port, and the `COMMUNITY_*` settings are pinned by tests (step 1). A deliberate change is its own PR that updates the tests and says so; Cloud-facing changes are agreed with Cloud first. | These are what installed apps, operators and Cloud depend on.                                                                                                                                                                                            |
| D7  | Many spaces per server                       | **Already true for hosted spaces.** A Mac that hosts spaces later (after launch) runs the same space store, so it can be home to more than one space (the coordinator's company-files option A). **No space id is added to the machine store now.**                                                                                                                                                                                                                                                                                                                                                                                                                             | The space store already keys every space's data by space. Adding a column to the Mac's 124 tables now is a migration nothing reads.                                                                                                                      |
| D8  | Many people on one server                    | The space store's model becomes the one model after launch: host accounts, per-space memberships, host operators, then equal accounts and the guest level (DOR-2743). The Mac's single-owner checks (`readOwnerAccount`, `isInstallOwner`, about 250 matches in about 60 files) retire then, replaced by "may this member do this in this space".                                                                                                                                                                                                                                                                                                                               | The space model already handles strangers, many spaces, ownership transfer, bans and erasure. The Mac's model handles one person.                                                                                                                        |
| D9  | Agents and secrets on a space host           | A space host runs no agents. It stores only a hash of each agent's space key and of each paired app's key, never a model login or a runtime credential.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Dorian's requirement 1; already how the space works.                                                                                                                                                                                                     |
| D10 | Data changes before launch                   | **Additive where they can be.** Availability (D4) only adds columns, so an older release still runs on the new schema. Agents-as-members (D3) changes the shape and is **forward-only**: it is proven on a copy of production data first, and its way back is the host's point-in-time restore, not an older image.                                                                                                                                                                                                                                                                                                                                                             | Honest about which change can be undone by switching releases and which cannot.                                                                                                                                                                          |
| D11 | The official space at launch                 | The space image as today, at the release that carries D3 and D4, after a rehearsal on a copy of production data and following the Cloud host runbooks. On a no-go, launch runs on the last release without them, and they land right after launch with the same rehearsal.                                                                                                                                                                                                                                                                                                                                                                                                      | The soft launch never waits on this, and today's image keeps running the space throughout.                                                                                                                                                               |

## Detailed design

### Step 1: freeze the promises

A route census and contract tests in the pattern the Hono move used (DOR-2793): every space route (179 API routes, 11 page routes, the 23 allowed Better Auth endpoints, 54 host routes, 3 test-only routes) plus `/health`, `/health/ready` and `/metrics`, with status codes, bodies and headers per group. A second check pins the image: its start command, its port, the offline commands' paths, and that the image still reads every `COMMUNITY_*` setting it reads today. Any PR may change a pinned promise on purpose, but only by updating the test in the same PR and saying so in its description.

### Step 2: agents become members

A short design note first (in this spec folder), then one migration and the code that follows it:

- each agent gets a `members` row of kind `agent`, with `owner_member_id`, in the same space; the `agents` row keeps its id and links to it;
- `members` gains `kind` (`person` or `agent`); every roster, mention, read position and moderation query says which kinds it wants, so nothing that lists people starts listing agents by mistake;
- a message's author is always `author_member_id`; `author_agent_id` stays filled for agent messages so apps from before the change still render them, and the check that exactly one is set becomes "the member is always set";
- export, import, erasure, takedown and the deletion worker carry the new rows, and the export format version goes up by one with an importer for the old version;
- the agent's space key, enrolment by its owner's paired app, the 20-agents-per-owner cap and the owner's mute and rules acceptance behave exactly as today.
- the way the app talks to a space does not change (step 1): an agent's message still reaches every app as an agent's message, exactly as today;
- agent members never count toward a space's member cap, its member usage, or the numbers the host API reports to Cloud (the CLD-376 member-cap override included);
- erasing a person's account or removing a member also handles the agent members they own, as removing their agents does today.

The migration rewrites existing rows, so it is forward-only (D10). It runs on a copy of production data before it runs for real.

### Step 3: agent availability

- **Space side:** `agents` gains `runs_on` (`computer` or `agent-computer`) and `last_seen_at`, added without touching existing rows. A paired app reports for its enrolled agents with one small call every few minutes, using the keys it already holds; the report never carries anything but availability. The member list and the space's web page show "available" or "offline since …". A capability flag tells apps the space understands the report.
- **App side:** the Mac's connection to a space (`RemoteCommunityAdapter`) sends the report while the agent's computer is on, and stops when the agent is removed or the space is disconnected. Agent computers report as `agent-computer` once they join spaces (DOR-2748). The app shows availability in a space's member list.
- It ships in a release before the soft launch, so launch-era apps already report.

### Step 4: 20,000 streams

The posting path above about 5,000 streams: posts wait on the per-channel lock while each one commits. Find the hold, shorten it, and prove delivery at the bar in `specs/official-community-space` (20,000 open streams, 50 posts a second for one minute, delivery p95 under one second, no errors) on production size with a separate load machine. This is the official space's launch bar whatever release runs it, so it does not wait for any other step.

### Step 5: the space as a library (not a must-have)

`apps/community` exports `createSpaceServer(settings)` with `start` and `stop`, holding everything `main.ts` wires today (the pool, migrations, the live hub, storage, the 13 sweeps in the 60-second loop and the 7 workers). The migrations folder and the web page folder are explicit settings, not paths worked out from where a file sits. The paid post-check switch is passed in by the entry point only, so no test can arm it. `main.ts` becomes a thin wrapper and the image is built as today. It makes the after-launch merge smaller; it lands before launch only if lane A has room.

### Step 6: rehearsal, go/no-go and rollout

Copy production data (Cloud host runbooks), upgrade the copy to the release with steps 2 and 3, and run today's Spaces checks, Cloud's host calls and the load bar against it. Decide on Nov 16. Upgrade production before the soft launch opens, with a hard cutoff of Nov 20: if it has not happened by then, it happens after Dec 8 with the same rehearsal.

### After launch, in order

1. **One program.** The space code moves into `apps/server` (`services/spaces`), its web page into the client build, and `apps/community` retires. The image is built from the DorkOS server package, keeping D6's promises (offline commands, start command, settings); a build check refuses runtime SDKs and `better-sqlite3` in it. One middleware chain serves both kinds of server. `dorkos` gains a way to run a space host for self-hosters. Internal code is renamed community to space; outside names stay (D5).
2. **The active-runner lease:** moving an agent between computers takes the lease first, so two computers never run it at once.
3. **A Mac can host spaces.** A spike first: run the space store on the Mac through PGlite, an embedded Postgres, with an adapter for the space code's connection pool, and prove its triggers, deferred checks, live notices, locks and snapshot checks behave as on a Postgres server. If it holds, turning on sign-in and inviting people makes the Mac home to one or more spaces, running the same code as hosted spaces. Then the Mac's rooms move into the space store: automatic, in place, with a backup first (`packages/db/src/backup.ts`), across every install. This is the biggest data move in the whole merge, sized XL, and gets its own spec. If the spike fails, the fallback is a bundled Postgres server (`research/20260225_embedded_postgres_desktop.md`).
4. **One window.** The app connects to any DorkOS server directly and switches between them like Slack workspaces. Signed in to the official space on the web, a person sees every agent with where it runs and whether it is there; with managed remote access on, the same window shows their Mac's private chats and agents, still stored only on the Mac. When a space's home is unreachable, the app shows the last-known state read-only, marked offline. The space's own web page retires.
5. **Equal accounts** (DOR-2743) on the space model, then the one message system (DOR-2744), live shared docs on the space's copy (DOR-2750), and mini apps on hosted spaces, whose server halves run in the isolated extension backend (`specs/isolated-extension-backends`) only after the space owner approves.

## The step list

Sizes: **S** under a day, **M** one to three days, **L** three to six days, each for one implementation chat including review.

### Before launch

| Step | What                                                                   | Size | Depends on | Must-have    |
| ---- | ---------------------------------------------------------------------- | ---- | ---------- | ------------ |
| 0    | This docs PR: the spec, the ADR status line, the ROADMAP               | S    | none       | yes          |
| 1    | Freeze the promises: route census, contract tests, image check         | M    | none       | yes          |
| 2    | Agents become members: design note, migration, code, export format     | L    | 1          | yes          |
| 3a   | Agent availability, space side                                         | M    | 1          | yes          |
| 3b   | Agent availability, app side                                           | M    | 3a         | yes          |
| 4    | 20,000 streams: fix the posting path, prove the bar on production size | L    | none       | yes          |
| 5    | The space as a library                                                 | M    | 1          | no (if room) |
| 6    | Rehearsal on a copy, go/no-go Nov 16, production upgrade by Nov 20     | M    | 2, 3a, 4   | yes          |

**Tickets:** step 1 DOR-2875, step 2 DOR-2876, step 3a DOR-2877, step 3b DOR-2878, step 4 DOR-2879, step 5 DOR-2880, step 6 DOR-2881. After launch: step 7 DOR-2882, step 8 DOR-2883, step 9 DOR-2884, step 10 DOR-2885.

**In parallel:** step 4 runs in its own chat from day one. Steps 2 and 3a can run side by side after step 1, in different files. Space fixes already in flight (DOR-2872, DOR-2847) land first or rebase.

### After launch

| Step | What                                                                                          | Size                       | Ticket                                  |
| ---- | --------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------- |
| 7    | One program: code into `apps/server`, the image from the server package, one middleware chain | L                          | new (absorbs the code half of DOR-2639) |
| 8    | The active-runner lease                                                                       | M                          | new                                     |
| 9    | A Mac can host spaces: the PGlite spike, then sign-in, invites, and the Mac's rooms move      | XL (split after the spike) | new                                     |
| 10   | One window                                                                                    | XL (split when specified)  | new                                     |
| 11   | Equal accounts, one message system, live docs, mini apps on hosted spaces                     | per their specs            | DOR-2743, DOR-2744, DOR-2750, DOR-2759  |

## Schedule against December 8

Two implementation chats: lane A for steps 1 to 3 and 6, lane B for step 4.

| Week            | Lane A                                           | Lane B                                       |
| --------------- | ------------------------------------------------ | -------------------------------------------- |
| Oct 13 to 19    | Steps 0 and 1                                    | Step 4: find the lock hold                   |
| Oct 20 to 26    | Step 2 (design note, migration); step 3a         | Step 4: fix; laptop runs past 10,000 streams |
| Oct 27 to Nov 2 | Step 2 (code, export); step 3b                   | Step 4: production-size run                  |
| Nov 3 to 9      | The release with steps 2 and 3; step 5 if room   | Step 4: rerun on that release                |
| Nov 10 to 16    | Step 6: rehearsal on a copy; **go/no-go Nov 16** |                                              |
| Nov 17 to 20    | Production upgrade (hard cutoff Nov 20)          |                                              |
| Nov 24 to Dec 8 | Soft launch, then launch                         |                                              |

**Book now:** the Cloud rehearsal slot in the week of Nov 10, and a production-size host plus a separate load machine for lane B.

**Is Nov 16 realistic?** For lane A, yes: about five PRs on a 58,000-line program, with a week of slack. Step 2 is the hardest, because it touches every query that lists members. Lane B is the real risk: the 20,000-stream bar has not been met on any image, and failing it blocks the official space's launch whatever release runs it.

**Go/no-go (Nov 16).** Go only if all hold, on the release that carries steps 2 and 3:

1. It passes every space test suite in CI (unit, Postgres, browser, packaged image, acceptance) and the step 1 contract tests unchanged.
2. On a copy of production data it upgrades cleanly, and the journey checks pass: two people, a thread, a file, pairing a DorkOS app, an agent reply, and agent availability shown.
3. Cloud's host calls (provisioning, limits, the member-cap override, usage) pass against the copy.
4. It meets the 20,000-stream bar at production size, as Dorian set it.

On a no-go, launch runs on the last release without steps 2 and 3, and they land right after launch with the same rehearsal. If the only failure is the load bar, that is a launch blocker on its own and goes to Dorian the same day.

## Cloud touchpoints

Requested by @dorkos-cloud on 2026-10-12. Each is counted and protected:

| Touchpoint                                                                                       | What this plan does                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The host API and its key scopes (provisioning, the limits push, the CLD-376 member-cap override) | Unchanged and pinned by step 1. If Cloud later wants to build against a published copy in `packages/cloud-api`, request shapes and response shapes are published separately, since Cloud reads responses loosely on purpose. Not part of this plan.                                                                                                                                                                   |
| "Continue with DorkOS" sign-in                                                                   | The provider, its callback path, its settings and the rule for linking accounts from the trusted provider are unchanged and pinned.                                                                                                                                                                                                                                                                                   |
| Monitoring                                                                                       | `/health`, `/health/ready` and `/metrics` (which needs a host key with `communities:read`) are pinned.                                                                                                                                                                                                                                                                                                                |
| The production host                                                                              | Same Postgres and point-in-time restore, same image name, signing, attestations and start command, pinned by digest as today. Same `COMMUNITY_*` settings (D5). The offline operator commands keep their paths. The erasure journal file, its off-host copy (CLD-282) and the `communities:erasure_journal` scope are unchanged. Upgrade and restore follow the Cloud host runbooks; this spec does not restate them. |
| Upgrading the official space                                                                     | Treated as a data move: step 2 rewrites rows, so the rehearsal on a copy comes first (step 6), like the last two Spaces upgrades, and the way back is point-in-time restore.                                                                                                                                                                                                                                          |
| The launcher's live tests and acceptance evidence                                                | Unaffected before launch (the image is built as today). The after-launch program merge (step 7) reruns them.                                                                                                                                                                                                                                                                                                          |

## Open tickets this changes

| Ticket                                                                  | Effect                                                                                                                                                                                         |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DOR-2742 (Hono move, then the merge)                                    | Its Hono half is done. The merge half moves to this programme's umbrella ticket.                                                                                                               |
| DOR-2639 (say space in code)                                            | Outside names stay "community" for good (D5). Internal code is renamed in step 7.                                                                                                              |
| DOR-2703 (remote room stream on WebSockets)                             | Still real for the Mac's connection to a space. Re-check when step 10 is specified; still after launch.                                                                                        |
| DOR-2748 (agent computers)                                              | Agent computers report availability as `agent-computer` (step 3). The local experiment (`specs/agent-computer-mvp`, #2845) is driven by the Mac's DorkOS and needs nothing else before launch. |
| DOR-2755 (groups, projects, company files)                              | Company files live on the company space's home. For a one-person company that is the Mac, which can share them with a team only after step 9. At launch, files stay on the Mac.                |
| DOR-2760, DOR-2835                                                      | Unchanged: app-side fixes.                                                                                                                                                                     |
| DOR-2836 (accepting the rules on a held space: app and web disagree)    | Still needs its small fix (recommended: allowed in both). Step 10 removes the class of bug.                                                                                                    |
| DOR-2872, DOR-2847, DOR-2730                                            | Unchanged; they land in the space code. DOR-2730 changes sign-up answers, so it updates the step 1 sign-in tests on purpose.                                                                   |
| DOR-2267, DOR-2247                                                      | They add space migrations; they land before or after step 2's migration in a fixed order, never in the same PR.                                                                                |
| CLD-307 (large imports)                                                 | Adds to the host import API: a deliberate change to a pinned promise, agreed with Cloud. Step 2's new export format must import through it.                                                    |
| DOR-2170 and DOR-2596 to DOR-2601 (self-host guide and launcher checks) | Unaffected before launch. Step 7 changes the image's build, so their evidence is redone then.                                                                                                  |
| DOR-2646, DOR-2565                                                      | Unaffected (launcher cleanup, test accounts).                                                                                                                                                  |
| DOR-2743, DOR-2744, DOR-2750, DOR-2759                                  | Keep their after-launch order; step 11 builds them on the space model, where agents are already members.                                                                                       |

## Testing strategy

- **Promises (step 1):** the census fails on any added, removed or changed route; per-group tests pin status codes, bodies and headers; the image check pins the start command, port, offline command paths and settings.
- **Agents as members (step 2):** migration tests on a copy of real-shaped data (agents with messages, threads, mentions, reports, mutes, exports); every roster and moderation query tested with an agent member present, so no list of people shows an agent; the remote-adapter conformance tests (`remote-adapter-conformance.integration.test.ts`) run against both the old and the new app to prove apps from before the change still work; export and import round-trip across the format bump.
- **Availability (step 3):** reporting, stopping on removal and disconnect, and "offline since" after missed reports; an app without the feature against a space with it, and the reverse.
- **Load (step 4):** `apps/community/load/` at the bar, on production size, with a separate load machine, three runs.
- **Rehearsal (step 6):** a copy of production data, the journey checks, Cloud's host calls.

## Risks

| Risk                                                   | Mitigation                                                                                                |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| The 20,000-stream bar is not met by Nov 16             | Its own chat from day one. A miss goes to Dorian the same day as a launch blocker, never quietly relaxed. |
| Step 2 makes an agent show up where only people should | Every member query names the kinds it wants; tests run each one with an agent member present.             |
| Step 2's migration fails on real data                  | Forward-only and rehearsed on a copy first; point-in-time restore is the way back.                        |
| Launch-era apps never report availability              | Step 3b ships before the soft launch; a capability flag keeps old apps and old spaces working together.   |
| A PR changes a promise by accident                     | Step 1's tests fail the PR.                                                                               |
| The after-launch Mac room move is larger than expected | It gets its own spec after the PGlite spike, with a backup-first automatic upgrade.                       |

## Open questions for Dorian

1. **What "merge before launch" covers.** This plan puts the parts that are hard to change after users before launch (agents stored as members, agent availability, frozen promises) and moves the code merge itself after launch, because moving code later is an ordinary upgrade. Recommended. The alternative is moving the code before launch as well: more launch-month risk, and no later mess avoided.
2. **A second implementation chat for the 20,000-stream work, starting now.** Recommended. It is the official space's launch bar whatever runs it, and the only part of this plan likely to miss Nov 16.

## Related ADRs

`261006-235238` (one server), `261006-235239` (equal accounts), `261006-235240` (one message system), `261006-235241` (Yjs docs), `261006-235242` (plugins), `260727-184933` (amended: community never runs a member's agent), `260916-210001` (amended: community is a Hono service on Postgres), `0319` (account-first identity), `261009-192542` (Hono everywhere), `260805-041016` (durable streams on WebSockets).

## References

- `specs/official-community-space/02-specification.md` (the load bar and monitoring)
- `specs/community-tenancy-contract/02-specification.md` (many spaces per host)
- `specs/community-host-operator-api/02-specification.md` (host API and key scopes)
- `specs/community-launch-acceptance/02-specification.md` (today's Spaces checks)
- `specs/isolated-extension-backends/` (sandboxed mini app server halves)
- `apps/community/OPERATIONS.md`, `RECOVERY.md`, `DEPLOYMENT.md` (offline operator commands)
- `research/20261006_one-server-sync-publish-identity.md`, `research/20260225_pglite_deep_dive.md`, `research/20260225_embedded_postgres_desktop.md`
- `plans/2026-10-express-to-hono.md` (the census and contract-test pattern)
