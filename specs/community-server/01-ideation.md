---
slug: community-server
id: 260727-155419
created: 2026-07-27
status: ideation
---

# Ideation: The community server — multi-user DorkOS

- **Slug:** community-server
- **Date:** 2026-07-27
- **Author:** Claude (directed by Dorian)
- **Tracker:** unassigned at time of writing (community program)
- **Anchors:** codebase = `origin/main` @ `1dde6fa34`. Prior art = `research/20260724_multi-user-communities.md`, `research/20260727_multi-user-review-exchange.md`.

## 1) Intent

DorkOS becomes multi-user. Five requirements, set by Dorian:

1. Any install can operate as a server that coordinates messages for a community.
2. Each login is a community member.
3. One person can connect to multiple communities.
4. Agents can also be community members.
5. Group chats where people and agents both participate.

The architecture research (`research/20260724_multi-user-communities.md`) explored the design space and produced thirteen decisions. This spec records the **five decisions Dorian made on 2026-07-27** that turn that research into a build order, and the evidence that changed three of them.

## 2) What already exists — the finding that reshaped the plan

Three things were already built, and each removed a chunk of planned work.

**The room primitive shipped** (DOR-521 → DOR-526, PRs #502/#504/#509/#510/#515/#519/#520). Rooms are membership-scoped durable streams; threads are child rooms; the read cursor is keyed `(member, room)`; agents reply in rooms with addressing and a cascade guard. Three ADRs cover it: `260726-170125`, `260726-170127`, `260726-193526`.

**`authors.naturalKey` never reaches the wire.** `apps/server/src/services/rooms/author-registry.ts` resolves `(kind, naturalKey)` to an opaque `authorId`, and only the opaque id travels. The stated reason is a privacy boundary, not indirection: a raw `agentPath` "would put `/Users/dorian/…` in front of every member of every room… the boundary that stops one agent learning where another one lives." **A remote member is therefore additive** — a new `naturalKey` scheme minting opaque ids through the same path — not a migration of existing rows. This was the single largest risk in the multi-user plan, and it is retired.

**Cloud identity shipped.** `specs/accounts-and-auth` P1 **and** P2 are complete. `apps/site` runs Better Auth on Neon Postgres with email+password (verified via Resend), **Google and GitHub sign-in with account auto-linking**, RFC 8628 device flow linking local instances to accounts, an admin/audit/GDPR-export layer, and migrations applied on every Vercel build. `specs/cloud-account-management` is likewise implemented.

Two absences matter as much as the presences:

- **No invites spec was ever written.** `accounts-and-auth` P3 lists "invites + viewer/operator roles" as deferred; `apps/server/src/services/core/auth/index.ts:14` promises "a future invites spec"; that spec does not exist. Greenfield.
- **No keypair exists anywhere.** Not local, not cloud. Both `apikey` tables hold bearer tokens, not keypairs. The "invisible keypair" in the research doc is a proposal, never built.

## 3) The decisions

### D1 — Postgres on the community server; SQLite stays local

The community server runs Postgres. The local install keeps its SQLite exactly as it is. The shared **message wire format** lives in `packages/shared`.

The framing carries the weight: these are **not two copies of one database**. They are a **source of truth and a cache** — the pattern ADR-0043 already established here, where `.dork/agent.json` is canonical and the SQLite `agents` table is a derived index. The server holds the roster, permissions, full history, and invites. The local install holds the rooms you are in, what you have read, and your purely-local rooms. Different tables, different contents.

So AGENTS.md's prohibition on two drifting models does not bite: there is one model, one authoritative store, one cache.

**Rejected — Postgres everywhere.** It would end zero-setup install. Bundling is technically possible (PGlite is Postgres compiled to WASM, npm-installable, no server), but it buys nothing: it means porting all 17 sqlite-core schema files (1,146 lines) and removing `better-sqlite3` from `cli`, `server`, `desktop`, `e2e`, and `db`, for no user-visible benefit — under D1 the local install never hosts a community.

**Rejected — SQLite everywhere.** Dorian's call: the server needs a robust database.

### D2 — A server-side `CommunityAdapter`; the client's `Transport` is unchanged

```
client ──Transport──▶ your local DorkOS server ──CommunityAdapter──▶ ┌ local rooms (SQLite, today)
       (unchanged)                                    (new)          ├ Buzz relay (Nostr/WS)
                                                                     └ apps/community (Postgres)
```

The adapter is a server-side interface with a shared conformance suite, modeled on two patterns the codebase already runs:

| Interface              | Backends                                | Conformance                    |
| ---------------------- | --------------------------------------- | ------------------------------ |
| `AgentRuntime`         | claude-code, codex, opencode, test-mode | `runtime-conformance.ts`       |
| `ConnectorProvider`    | raw-MCP, Composio, Nango, Fake          | `connector-conformance.ts`     |
| **`CommunityAdapter`** | **local, Buzz, apps/community**         | **`community-conformance.ts`** |

`connector-conformance.ts` states the doctrine to copy: the suite is _"capability-aware: the multi-account assertion branches on `supportsMultiAccount` rather than weakening, exactly as `runtimeConformance` declares differences via opts."_ **That capability-branching is what accommodates Buzz.** A Nostr relay has no invites, no roster, and no read cursors — under this pattern those become `CommunityCapabilities` declarations, not compromises in the contract.

Four reasons it is server-side rather than client-side:

1. **One render path.** Client-side adapters mean two streaming models (SSE vs WebSocket), two auth models, two of everything.
2. **Keys never touch the browser.** Nostr requires a secp256k1 keypair to post. On the local server that is a `0600` file, as the Better Auth secret already is. In browser storage it is a security defect.
3. **Established pattern**, twice over, with conformance suites.
4. **ADR-0310 already solved the aggregation problem** — session listing aggregates across runtimes with per-runtime degradation and `warnings[]`. Listing rooms across communities is the same shape.

**Rejected — a new client-side `CommunityConnector`.** The client seam already exists and rooms are already on it (`apps/client/src/layers/shared/lib/transport/room-methods.ts`). A second abstraction over `Transport` would be two seams doing one job.

### D3 — A remote member is filed under the community's own member id

`kind` stays `'human'` / `'agent'`. The `naturalKey` for a remote member is the opaque member id that community's server minted — Slack's `U024BE7LH`, not an email.

Rationale is `author-registry.ts`'s own: a raw path in front of every room member is a privacy defect, and an email address is the same defect one layer up. An opaque id carries no personal data into any other member's local cache and survives an email change.

Cost, accepted: the same person in two communities is two author rows locally. That is what Slack does. It is joinable later with a link table — never a key migration.

**Zero user-facing keys, in every path.** People sign up with an email and a password their password manager saves, or with Google or GitHub. There is nothing to write down and nothing to lose.

### D4 — `apps/community` is its own app

A new, self-hostable app that **copies** `apps/site`'s proven auth setup (Better Auth on Postgres, Google/GitHub, Resend, migrate-on-deploy) rather than importing it. Anyone can deploy one; "you run your own community" stays literally true.

**Rejected — adding communities to `apps/site`.** Fastest to an MVP, but it conflates our marketing site and cloud account service with software people self-host, which breaks the ownership story.

**Rejected — a hosted mode inside `apps/server`.** Every local install would carry community code it never runs, and the SQLite/Postgres split would have to live inside one app.

### D5 — Build order: spike → interface → local → Buzz read-only → `apps/community`

1. **Buzz spike** (time-boxed, prose deliverable). What does Buzz add over NIP-01? Does it have channels, membership, invites? **Do reads require NIP-42 AUTH?** → `research/20260727_buzz-protocol-capability-spike.md`
2. **`CommunityAdapter` + `CommunityCapabilities` + `communityConformance`**, shaped by the spike's findings.
3. **Local rooms as adapter #1** — wraps what ships today.
4. **Buzz read-only as adapter #2** — the foreign case that keeps the interface honest.
5. **`apps/community` as adapter #3** — the one that delivers the MVP.

**Why Buzz is second and read-only.** An interface with one implementation is a fake abstraction, and the review exchange flagged exactly that risk. But **the MVP is not expressible on Nostr**: NIP-01 has no membership, no roster, no invites, no read cursors, and identity _is_ a keypair. Buzz-first would put the MVP behind an integration that structurally cannot deliver it.

Read-only is the resolution. It is small, it is real (point it at a live relay, not a mock), and it is genuinely foreign — WebSocket vs SSE, filters vs room ids, tags on messages vs child rooms. It forces `canPost: false` to exist from day one, which is what stops our own server's assumptions being baked into the interface. Posting to Buzz comes later, when key handling earns its complexity.

**Corrected 2026-07-27 by `specs/community-adapter/` (`260727-221432`): "no membership" and `hasRoster: false` were wrong, and contradicted the spike this paragraph cites.** Buzz serves a per-channel roster with per-member roles as relay-signed kind:39002 (`side_effects.rs:1092-1107`); the spike's own capability table records `list members: **yes**`, and calls it better developed than expected. All three backends enumerate members, so **`listMembers` is universal and there is no roster capability flag** — what differs between backends is the _role vocabulary_, not whether a roster exists. Read cursors were wrong for the same reason: Buzz has NIP-RS kind:30078, which is client-opaque rather than absent, and `'client-opaque'` is not `'none'`.

The lesson is worth keeping next to the error: this paragraph was written before the spike and never revisited after it, so a pre-spike belief survived in prose next to a citation of the evidence that falsified it.

**Amended 2026-07-27, after the spike** (`research/20260727_buzz-protocol-capability-spike.md`, Buzz @ `654f384906b5c7`). The premise that reads need no keypair was **wrong**, and the correction matters:

- **Buzz requires NIP-42 AUTH for every read.** `crates/buzz-relay/src/handlers/req.rs:50-87` — `handle_req` matches `AuthState` and the catch-all arm sends `CLOSED "auth-required: not authenticated"` and returns. There is no anonymous variant in the enum (`connection.rs:37-47`) and no public-channel carve-out. Verified directly, not taken on report.
- **The credential stays invisible, but it is not free — corrected again 2026-07-27.** The three gates do all default to `false` **in code** (`config.rs:475-487`), and on a relay left at library defaults a self-generated keypair is enough: an authenticated stranger then reads every open channel without joining (`db/channel.rs:746-773` unions memberships with all open channels). **But no shipped Buzz deployment runs at library defaults.** `deploy/compose/.env.example:17-18` sets `BUZZ_REQUIRE_RELAY_MEMBERSHIP=true` and `BUZZ_ALLOW_NIP_OA_AUTH=true`; the Helm chart templates both (`deploy/charts/buzz/templates/deployment.yaml:119,121`), and `Justfile:318-319` sets them for local dev. With membership required, _"only pubkeys with a row for that community may use that community"_ (`NOSTR.md:202-206`) — a stranger key cannot connect at all until an operator runs `buzz-admin add-member`.

  **What this actually means: joining a Buzz community is an admission event, not a connection.** Their equivalent of our invite is an operator adding your pubkey. That is the more realistic model to build against and it does not change A4's estimate much (we run our own test relay, so we hold `buzz-admin`), but it does mean the read-only adapter cannot lurk on an arbitrary relay, and a DorkOS user joining a Buzz community will need that community to admit them first.

**D3 survives intact.** The Nostr keypair is _infrastructure_, not identity: the local server generates one and holds it in a `0600` file, exactly as `resolveBetterAuthSecret` already does for the Better Auth secret. Nobody signs up with it, saves it, or can lose it. This is D2 paying for itself — because the adapter is server-side, a private key is a config file rather than a security defect in browser storage.

A4's estimate rises by roughly one point (generate/persist a key, implement the NIP-42 challenge-response). The sequencing decision is unaffected, and the spike's four mismatches (§7 Q1) vindicate it.

### D6 — Your own install stays single-user. All multi-user lives in `apps/community`

Decided 2026-07-27. There are two servers with two jobs, and they were being conflated:

|             | **Local install** (`apps/server`)    | **Community server** (`apps/community`) |
| ----------- | ------------------------------------ | --------------------------------------- |
| Whose       | Your machine                         | A shared space                          |
| Holds       | Your agents, filesystem, credentials | Roster, channels, history               |
| Humans      | **You, and only ever you**           | Many                                    |
| Roles about | Nothing — it is yours                | Invite, moderate, create channels       |

So the `FORBIDDEN`-on-second-signup hook in `auth/index.ts:162` **stays**. Nobody else ever holds an account on the machine that runs your agents and spends your model quota — which is ADR-0320's trust-domain argument taken to its conclusion rather than half-way.

**This retires most of Track B as originally specced.** `specs/invites/` (`260727-161438`) designed invites, registration reopening, and a local `member` role for a person who does not exist in this architecture. Invites belong to the community server. The spec is kept, not deleted — its token design, security analysis, and experience contract all transfer — but its _host_ changes.

**What survives, with a better justification than it was given.** DOR-598 replaces "human means operator" with "is this the owner account". That was sold as future-proofing for a second local account. The real reason is stronger and applies today: **once you join a community, your local database will hold other humans as authors** — remote members whose messages you have cached. Any code reading `kind === 'human'` and concluding "operator" is then wrong on your own machine, with no second account anywhere.

### D7 — Community roles are `owner` / `admin` / `member`

One **owner** — whoever deployed it. Irreducible: they hold the database. Many **admins** — invite, moderate, create and archive channels, remove people, eject agents. Many **members** — join channels, post, and bring their own agents.

A community with exactly one administrator stops working the week that person goes on holiday. This is the model everyone already knows from Slack and Discord, and it is deliberately _not_ a permission system: three named roles, no per-resource grants. Per-channel roles are much easier to add later than to remove.

Note this is a **different role model from the local install**, which has exactly one person and therefore no roles at all.

### D8 — A member adds their own agents; admins can eject them

No approval step. A member adds an agent to any channel they belong to, and it is the whole point of the product rather than a feature to gate.

The mechanism is Buzz's shape minus the keypair (`research/20260727_agent-identity-in-communities.md`): the agent gets **its own identity in the community, vouched for by the member who brought it**. Three properties follow, and all three matter:

- **Removing the human removes their agents**, automatically, because the attestation is what admits them. Buzz's own implementation fails this — nothing there can even enumerate "agents of this owner" — and that is the specific hole not to copy.
- **The agent inherits none of its owner's powers.** A member's admin-less agent is not an admin's agent. Capability does not flow owner → agent.
- **Admins can eject an agent** or bar it from a channel, without removing its owner.

Quotas must be **aggregated per owner**, not per identity. Buzz's are inverted — agents get 120 msg/min against a human's 60 on independent counters, so N agents buy `60 + 120N`. That is the unbounded-spend gap `specs/invites/` §14.6 already admits, and it should be closed at the community server rather than inherited.

### D9 — The community server never executes a member's agent

Promoted to **ADR `260727-184933`**, because it is the constraint most likely to erode one pull request at a time.

Hosted DorkOS is three products, not one: (1) remote access to your own install — **already shipped** via the tunnel and ADR-0320's exposure guard; (2) a hosted community server with a browser client, which is this program; (3) hosted agent execution — a real future product with its own economics, and not merely "our apps on a server."

Agents run on their members' own machines and connect in. A community holds the conversation; it does not hold compute.

**Presence follows the install.** If a member's computer is off, that member _and their agents_ are offline, the way a person who is asleep is offline. v1 does not queue for absent members and does not promise a later reply. Accepted deliberately.

## 4) The experience this is all for

The design principle, stated so later work can be measured against it:

> **Each community is its own front door.** You sign up to _that community_ — email and password, or Continue with Google, or Continue with GitHub. The community's owner runs the server, owns the roster, holds the messages. DorkOS-the-company is nowhere in the middle.

That is more private than a mandatory central account **and** more familiar than keys. A DorkOS account becomes one optional button beside Google and GitHub — a convenience for people in several communities, never an authority.

The MVP experience:

1. Dorian clicks **Invite** in a channel and gets a link. No form.
2. Priya opens it and sees **the community name, who invited her, and the channel** — before signing up. An invite that shows you nothing is a form, not an invitation.
3. **One screen.** Continue with Google · Continue with GitHub · or email + password. Real password fields with `autocomplete` so password managers work. No username to invent. No verification wall before she can look around.
4. She lands **in the conversation**, not an empty state.
5. **She brings her agents.** Her Claude Code, on her machine, posting in Dorian's channel. That is the demo, not a follow-up.

Two cheap commitments:

- **Ownership visible, not configurable.** One unobtrusive line: _"Dorian runs this community."_ Not a settings panel. (Corrected 2026-07-27: this line originally read _"This community runs on Dorian's server"_ — which contains the exact word this section forbids a joining member from having to read. Caught by `specs/invites/`.)
- **The exit is real.** Leave a community and your local copy goes with you. `cloud-account-management` already shipped GDPR export and hard-delete; that pattern carries over.

Refused: email required to preview an invite; "install the app to continue"; any screen containing the word "server" that a joining member has to read.

## 5) Two tracks

**Track A — architecture.** D5's five steps. Independent of accounts.

**Track B — product.** Invites and multi-user auth on one install. Today `apps/server`'s `databaseHooks.user.create.before` throws `FORBIDDEN` once any user exists (`auth/index.ts:162`), so a second person cannot sign up. This is the `accounts-and-auth` P3 fast-follow that was deferred and never written, and it proves multi-user end to end on rooms that already work — with zero distributed-systems risk.

**Corrected 2026-07-27** — the sentence that stood here said the schema is already multi-user-capable and only "the hook, an invite-token table, and a second role" are missing. That **understated the work**, and `specs/invites/` (`260727-161438`) found why. The room authorization model does not merely lack a second role; it equates _human_ with _operator_:

- `room-service.ts` `seesEveryRoom()` returns true for any author with `kind === 'human'` — its own docstring reads _"Human authors are the operator; nothing in a single-player cockpit hides from them."_ A second human author therefore reads **every room**, including the owner's agent DMs.
- `requireOperator()` grants on the same test, so a second human can rewrite **any** roster.
- The client has the matching assumption: `ChannelsPage.tsx` and `use-mark-room-read.ts` both locate the viewer via `members.find((m) => m.author.kind === 'human')`. With two humans, `find` returns whoever sorts first, so one person reads and advances the other's cursor. The code names this itself: _"v1 mints exactly one human author… there will not be one until accounts land."_

None of this is exploitable today — there is only ever one human — but all of it activates the instant a second one exists.

**Superseded later the same day by D6.** Track B is no longer "multi-user auth on one install", because D6 decided the local install never holds a second account. What remains of it:

- **Ships now** — the authorization hardening (DOR-598), on D6's stronger justification: joining a community puts _other humans_ in your local `authors` table, so "human means operator" is wrong on your own machine today, with no second account anywhere.
- **Moves to the community server** — invite tokens, registration, and the `member` role. `specs/invites/` is kept rather than deleted; its token design, security analysis and experience contract transfer to `apps/community` unchanged. Only the host moves.
- **Deleted** — reopening local registration. The `FORBIDDEN` hook stays forever.

The tracks converge at `apps/community`.

## 6) Out of scope

- **Federation.** Matrix-style state resolution was evaluated and rejected as disproportionate; Block chose not to build it into Buzz either. A community is authoritative for itself.
- **Posting to Buzz**, and therefore Nostr key management. Deferred past v1 by D5.
- **Message signing.** The research doc's "sign but don't authenticate" is deferred; nothing in D1–D5 precludes adding it.
- **Channel workspaces** — `specs/channel-workspace/` (`260726-162747`) owns that.
- **Agent working directories** — `specs/agent-workspace-binding/` (`260726-162520`) owns that.

## 7) Open questions

1. ~~**Does Buzz require auth for reads?**~~ **Answered 2026-07-27: yes, always.** See the D5 amendment. Closed.

2. **What exactly does `CommunityCapabilities` enumerate?** Largely answered by the spike's capability table. **Four mismatches are the ones that shape the interface** — each is a case where the obvious design would satisfy every backend of ours and fail against Buzz:

   | Mismatch                                                                                                                                                                           | Why it bites                                                                                                                                                                                                                          | Candidate flag                                         |
   | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
   | **No monotonic sequence.** Our `seq` cursor has no counterpart; WS paging is wall-clock `since`/`until` with no tiebreak, and the gap-free keyset cursor is HTTP-only.             | A cursor typed as a number bakes in an assumption two of three backends cannot meet. The cursor must be an **opaque adapter-minted token**. `AgentRuntime.subscribeSession`'s eager `StaleResumeCursorError` is the contract to copy. | `historyCursor: 'timestamp' \| 'keyset' \| 'sequence'` |
   | **Threads are arbitrarily deep**, and are tags on a message _in the same channel_ — not child rooms.                                                                               | Directly contradicts ADR `260726-170125`'s "thread = child room." Argues for an entry-level `parentEntryId` relation rather than a room-level one.                                                                                    | `threadDepth: 1 \| 'unbounded'`                        |
   | **Read cursors are encrypted to the user's own key**, keyed per device slot by wall-clock time. Server-side unread counts are _structurally impossible_, not merely unimplemented. | Our `(member, room)` cursor has no counterpart at all.                                                                                                                                                                                | `readCursor: 'server' \| 'client-opaque' \| 'none'`    |
   | **Channel-level invites do not exist.** NIP-29 kind:9009 is a logged no-op; HTTP invites admit to the _community_, not a channel.                                                  | "Offer a specific person a specific room" is not expressible. Relevant to B1's design too.                                                                                                                                            | `invite: 'none' \| 'community' \| 'room'`              |

   Also: room listing is **poll-only** on Buzz (channel-created is never pushed), and archiving **evicts live subscriptions** with `CLOSED "restricted: channel access revoked"` — an adapter must read that as "archived," not "error."

3. **Does a room's `workspaceId` mean anything for a remote room?** `rooms.workspaceId` already exists; `specs/channel-workspace/` assumes local. Remote rooms may need it null.

4. **How does an agent authenticate to a remote community?** Agents are members (requirement 4), but agents do not have email addresses. Likely an owner-attestation model — the research doc surveyed NIP-AA/NIP-OA and Mattermost's `Bot.OwnerId`, where revoking the human revokes their agents. **The spike found Buzz's NIP-OA owner attestation is a working implementation of exactly this** — cryptographically binding an agent key to its human's. Read it before designing ours.

5. **Second role name.** Track B needs one role beyond `owner`. `accounts-and-auth` P3 proposed viewer/operator. Note Buzz uses five (`Owner`/`Admin`/`Member`/`Guest`/`Bot`) while our `roomMembers` has no role column at all.

6. **Tenancy addressing.** Buzz is one community per host (`core/tenant.rs:19-24`), so a room reference must be `(communityRef, roomId)` — a bare room id is ambiguous once a second community exists.

## 8) Related

- `research/20260724_multi-user-communities.md` — the architecture research, thirteen decisions
- `research/20260727_multi-user-review-exchange.md` — the seven-document adversarial review that produced the room model
- `research/20260727_q3-contention-findings.md` — the concurrency measurement, and its limits
- `research/20260727_buzz-protocol-capability-spike.md` — D5 step 1, **complete**. Buzz @ `654f384906b5c7`; 11-row capability table that becomes the `CommunityCapabilities` flag set.
- ADRs `260726-170125`, `260726-170127`, `260726-193526` — the room model
- ADR-0043 — file-canonical source of truth (the truth↔cache precedent behind D1)
- ADR-0310 — cross-runtime aggregation with per-backend degradation (the precedent behind D2)
- `specs/accounts-and-auth/`, `specs/cloud-account-management/` — the shipped identity cores
