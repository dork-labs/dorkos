---
slug: server-merge
number: 261013-000229
created: 2026-10-12
status: ideation
---

# One DorkOS server: merging the local server and the space server

**Slug:** server-merge
**Author:** Claude (IDEATE for Dorian Collier)
**Date:** 2026-10-12
**Linear:** DOR-2874 (umbrella, parent DOR-2735)
**Decision being carried out:** ADR [261006-235238](../../decisions/261006-235238-one-dorkos-server-in-every-size.md), moved before launch by Dorian on 2026-10-12

> **Changed 2026-10-15 by [`everything-is-a-space`](../everything-is-a-space/02-specification.md) (ADR `261015-042933`).** Launch moves to late January 2027; December 8 is the Community Space soft launch. Requirement 11 changes: team spaces on DorkOS Cloud are in launch scope. Requirement 5 changes for Cloud team spaces (members sign in with a DorkOS account), and requirement 6 is met by the session relay into your own DorkOS in the cloud. The specification's banner lists what changes for the steps.

## 1) Intent and assumptions

**The brief, in Dorian's words (#dorkos, 2026-10-12):** "Let's move the codebase merge to pre-launch. I feel like we're running ahead of schedule and maybe can fit it in. Also, since it's a pretty big change, I think it's worth doing pre-launch because doing it after we have users could be pretty messy."

**What "the merge" means.** Today DorkOS ships two server programs:

- `apps/server`: the DorkOS server on your computer. Hono (since #2812), SQLite, one owner, runs agents.
- `apps/community`: the space server. Hono, Postgres, many people, many spaces per host, never runs an agent. The official space and Cloud's hosted spaces run on it.

ADR 261006-235238 says these become one program that runs at every size. This spec plans that, before the Dec 8 launch, with a go/no-go on Nov 16.

**Dorian's requirements** come from a requirements interview on 2026-10-12 (12 answers plus a server model he accepted). They win over anything else here. In short:

1. Agents never run on a space server. They run on a Mac or on an agent computer. Each DorkOS server has a switch for "runs agents"; it is off on hosted spaces.
2. One app, many servers: the app switches between servers like Slack workspaces, and every feature works the same wherever the server allows it.
3. A one-person DorkOS can grow into a team: turn on sign-in, invite people, keep the same data with no move.
4. Features that touch a computer (terminal, files on disk, coding agents) work only where they make sense. Your Mac's disk is reachable only from your Mac or through remote access to it, never from a shared space.
5. One DorkOS account everywhere ("Continue with DorkOS"). A server you run yourself works with no account until you invite people or join a hosted space. A space operator picks how people sign in: DorkOS, the server's own accounts, or both.
6. With remote access on, the official space's web app also shows your Mac's private chats and agents in the same window. They stay stored only on your Mac.
7. Only an agent's owner adds it to a space. A space admin can remove or mute any agent.
8. When a space's home is down, the app shows the last-known state, read-only, marked offline. No posting until it is back.
9. Mini apps work in a hosted space, shared by all members; their server half runs sandboxed on the space server, only after the space owner approves it.
10. Shared docs are edited live on the space's copy (Yjs, ADR 261006-235241).
11. Launch scope (Dec 8): your Mac plus the official space. Team spaces on Cloud and self-hosted spaces use the same code but are announced after launch.
12. Company files live in the company's space. A one-person company's space is the Mac.

**The server model Dorian accepted:**

- One program, with switches per server: **runs agents**, **people can sign in**, **public web address**. A Mac: runs agents on, sign-in off until people are invited. A hosted space: runs agents off, sign-in on, public address. An agent computer: runs agents on, nobody signs in.
- **Each space has exactly one home server, which keeps its record.** Central within a space, decentralized across spaces. The official space's home is the shared Cloud host; your Mac is the home of your one-person space. The app is a window, not a second copy.
- An agent runs in one place (a Mac or an agent computer) and is a member of many spaces. It reports its availability to each space.

**Assumptions:**

- "Before launch" does not mean every consequence of the vision reset (equal accounts, one message system, live docs) lands before launch. Those stay in the ROADMAP's after-launch order. What it does cover is the question this ideation answers.
- The soft launch never waits on the merge. Today's space server keeps running the official space throughout.
- Cloud's operating details (hosts, runbooks, prices) stay in the private repo. This spec names them only as "the Cloud host runbooks".
- Two implementation chats can run in parallel: one for the merge steps, one for the 20,000-stream work (a question for Dorian in the specification).

## 2) Pre-reading log

- ADRs: `261006-235238` (one server), `261006-235239` (equal accounts), `261006-235240` (one message system), `261006-235241` (Yjs docs), `261006-235242` (plugins), `260727-184933` (community never runs a member's agent), `260916-210001` (community is a Hono service on Postgres), `0319` (account-first identity), `261009-192542` (Hono everywhere).
- Specs: `official-community-space`, `community-tenancy-contract`, `community-host-operator-api`, `community-launch-acceptance`, `community-adapter`, `community-sign-in-linking`, `agent-computer-mvp` (merged in #2845).
- Plans: `plans/2026-10-vision-reset*.md`, `plans/2026-10-express-to-hono.md`.
- Research: `research/20261006_one-server-sync-publish-identity.md`, `research/20260225_pglite_deep_dive.md`, `research/20260225_embedded_postgres_desktop.md`, `research/20261009_express-to-hono-migration.md`.
- Linear: DOR-2735 and its children, project "Spaces & One Server", DOR-2742 (Hono move, done), DOR-2764 (official space), DOR-2748 (agent computers), DOR-2639, DOR-2703, DOR-2760, DOR-2835, DOR-2836, DOR-2847, DOR-2872, DOR-2755.
- The coordinator's company-files position (2026-10-12), which asks this spec to settle "a server can be home to more than one space" and "a space id on every record".

## 3) Codebase map (summary; full map in the specification)

|                        | Local server (`apps/server`)                                                                          | Space server (`apps/community`)                                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Size (non-test source) | about 514,000 lines                                                                                   | about 58,000 lines                                                                                                                                                                                 |
| Database               | SQLite through `better-sqlite3`, **synchronous** Drizzle; 124 tables, 160 migrations in `packages/db` | Postgres through raw `pg` SQL (about 1,150 queries; the Drizzle schema is a mirror nothing imports); 65 tables; 38 hand-written migrations (`0001` to `0038`), ledger table `community_migrations` |
| Sync coupling          | about 4,200 synchronous query calls and 470 transactions across about 530 files                       | async throughout; leans on Postgres-only features: LISTEN/NOTIFY, 29 triggers, row-lock modes, `SKIP LOCKED`, advisory locks, `xid8` snapshot checks                                               |
| People                 | one owner (`readOwnerAccount`, `isInstallOwner`); about 250 owner-check matches in about 60 files     | host accounts, many spaces per host, per-space memberships (owner, admin, member; no guest yet), host operators, scoped host API keys for Cloud                                                    |
| Sign-in                | Better Auth on SQLite at `/api/auth/*`, registration closes after the first account                   | Better Auth on Postgres at `/api/auth/*`, "Continue with DorkOS" through OIDC, own accounts optional                                                                                               |
| Agents                 | runs them (Claude Code, Codex, OpenCode, Doe)                                                         | never runs one; agents connect in from their owner's computer                                                                                                                                      |
| Rooms                  | `RoomService` on SQLite, behind `CommunityAdapter` as `LOCAL_COMMUNITY`                               | public and private channels with one level of threads on Postgres (no DMs, no reactions yet); the app reaches them through `RemoteCommunityAdapter`                                                |
| Live updates           | durable per-session and per-room streams (WebSocket and SSE)                                          | SSE woken by Postgres LISTEN/NOTIFY with in-process fan-out                                                                                                                                        |
| Entry                  | `apps/server/src/index.ts` (about 5,400 lines) boots everything                                       | `apps/community/src/main.ts` wires `createCommunityApp` plus 13 sweeps in a 60-second loop and 7 workers                                                                                           |

Both already mount Better Auth at the same path (`/api/auth/*`), so one process cannot serve both sign-in systems at once without a change.

## 4) Root of the problem

The two programs differ in four ways:

1. **Packaging:** two apps, two images, two entry points. Cheap to merge at any time.
2. **Storage:** synchronous SQLite against async Postgres. Merging storage means touching most of the local server.
3. **Who is in the server:** one owner against many accounts and spaces (the equal-accounts work, DOR-2743).
4. **The client:** the DorkOS app against the space's own web page.

Dorian moved the merge earlier because it gets messy once people use DorkOS. None of the four is messy _because of users_ in the same way:

- Moving code (1) is an ordinary upgrade, before or after launch.
- What does get messy is **the shape of people's data** and **the promises other programs depend on**: how installed apps talk to a space, the host API Cloud calls, the sign-in paths, the operator commands and settings.
- Two data shapes in the space store are known to need changing for the vision: **agents are not members** (a message's author is a person or an agent, in two columns), and **nothing records where an agent runs or whether it is there**. Changing both after launch means rewriting live data and waiting for every installed app to update.

So the specification puts those data and promise changes before launch, and the code merge after it.

## 5) Research and options

### Database

| Option                                                      | What it means                                                                                                                                                                                            | Verdict                                                                                                                                                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Postgres everywhere                                      | The Mac runs Postgres too (embedded through PGlite, or a bundled server)                                                                                                                                 | Rejected **for now**: the local server's 4,200 synchronous query calls would all become async. Months, not weeks.                                                                                                   |
| B. One layer over both                                      | Each query works on SQLite and Postgres (the Gitea way)                                                                                                                                                  | Rejected: the same async rewrite on the local side, and the space side is 1,150 hand-written Postgres queries using triggers, row locks and snapshot checks SQLite does not have. The two-database cost never ends. |
| C. Two stores, split by what the data is about, one program | **Machine store** (SQLite) for what only exists where agents run: agents, sessions, runtimes, connections, this computer's rooms. **Space store** (Postgres) for spaces a server hosts for other people. | **Pick.** Nothing is rewritten before launch. Both stores exist and are tested.                                                                                                                                     |

Later, for requirement 3 (a Mac grows into a team), the space store can run on the Mac through PGlite, an embedded Postgres in WebAssembly. The space code would then be the same everywhere. That needs a spike first; it is a step after launch.

### When to move the code

| Option                                                                                      | Verdict                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. Move all space code into `apps/server` before launch                                     | Rejected: a large diff during launch month that spares no later mess.                                                                                                                                                                                              |
| B. Make the space server a library the DorkOS server boots in a "space" role, before launch | Rejected after adversarial review: it shares no sign-in, database or client with the computer role, so it is repackaging; and bundling it would break the offline operator commands and file paths the image relies on (`OPERATIONS.md`, `migrate.ts`, `main.ts`). |
| C. **Data shapes and promises before launch; code after**                                   | **Pick.** Fixes what is hard to change later; keeps the image exactly as it is through launch. Making the space server a library is kept as an optional step if there is room.                                                                                     |

### What "runs agents off" means

A space host runs no agents today because `apps/community` has no runtime code at all; the package boundary is the guarantee. When the code moves into `apps/server` after launch, a build check keeps that guarantee: no runtime SDK and no `better-sqlite3` in the space host's image.

## 6) Decisions

Final in the specification (D1 to D11). In short: data shapes and promises before launch (agents become members, agent availability, frozen promises, names kept); two stores split by what the data is about; many spaces per server is already true; the space model becomes the one model after launch; only the computer that runs an agent runs it.

## 7) Clarifications for Dorian

1. **What "merge before launch" covers.** Recommended: the parts that are hard to change after users (above) before launch, the code merge after.
2. **A second implementation chat for the 20,000-stream work, now.** Recommended: it is the launch bar for the official space whatever runs it.
