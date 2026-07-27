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

## 3) The five decisions

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

Read-only is the resolution. Reads in base NIP-01 are unauthenticated `REQ` subscriptions, so **no keypair is needed** and the zero-keys principle survives v1. It is small, it is real (point it at a live relay, not a mock), and it is genuinely foreign — WebSocket vs SSE, filters vs room ids, tags vs threads, no membership. It forces `canPost: false` / `hasRoster: false` to exist from day one, which is what stops our own server's assumptions being baked into the interface. Posting to Buzz comes later, when key handling earns its complexity.

_Open caveat, owned by the spike: if Buzz requires NIP-42 AUTH for reads on private channels, reads need a credential too, and step 4's estimate changes._

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

- **Ownership visible, not configurable.** One unobtrusive line: _"This community runs on Dorian's server."_ Not a settings panel.
- **The exit is real.** Leave a community and your local copy goes with you. `cloud-account-management` already shipped GDPR export and hard-delete; that pattern carries over.

Refused: email required to preview an invite; "install the app to continue"; any screen containing the word "server" that a joining member has to read.

## 5) Two tracks

**Track A — architecture.** D5's five steps. Independent of accounts.

**Track B — product.** Invites and multi-user auth on one install. Today `apps/server`'s `databaseHooks.user.create.before` throws `FORBIDDEN` once any user exists (`auth/index.ts:162`), so a second person cannot sign up. The schema is already multi-user-capable; the hook, an invite-token table, and a second role are what's missing. This is the `accounts-and-auth` P3 fast-follow that was deferred and never written, and it proves multi-user end to end on rooms that already work — with zero distributed-systems risk.

The tracks are largely independent and converge at `apps/community`.

## 6) Out of scope

- **Federation.** Matrix-style state resolution was evaluated and rejected as disproportionate; Block chose not to build it into Buzz either. A community is authoritative for itself.
- **Posting to Buzz**, and therefore Nostr key management. Deferred past v1 by D5.
- **Message signing.** The research doc's "sign but don't authenticate" is deferred; nothing in D1–D5 precludes adding it.
- **Channel workspaces** — `specs/channel-workspace/` (`260726-162747`) owns that.
- **Agent working directories** — `specs/agent-workspace-binding/` (`260726-162520`) owns that.

## 7) Open questions

1. **Does Buzz require auth for reads?** Decision-critical for step 4's cost. Owned by the spike.
2. **What exactly does `CommunityCapabilities` enumerate?** Falls out of the spike's capability-mapping table.
3. **Does a room's `workspaceId` mean anything for a remote room?** `rooms.workspaceId` already exists; `specs/channel-workspace/` assumes local. Remote rooms may need it null.
4. **How does an agent authenticate to a remote community?** Agents are members (requirement 4), but agents do not have email addresses. Likely an owner-attestation model — the research doc surveyed NIP-AA/NIP-OA and Mattermost's `Bot.OwnerId`, where revoking the human revokes their agents. Not yet decided.
5. **Second role name.** Track B needs one role beyond `owner`. `accounts-and-auth` P3 proposed viewer/operator.

## 8) Related

- `research/20260724_multi-user-communities.md` — the architecture research, thirteen decisions
- `research/20260727_multi-user-review-exchange.md` — the seven-document adversarial review that produced the room model
- `research/20260727_q3-contention-findings.md` — the concurrency measurement, and its limits
- `research/20260727_buzz-protocol-capability-spike.md` — D5 step 1 (in progress at time of writing)
- ADRs `260726-170125`, `260726-170127`, `260726-193526` — the room model
- ADR-0043 — file-canonical source of truth (the truth↔cache precedent behind D1)
- ADR-0310 — cross-runtime aggregation with per-backend degradation (the precedent behind D2)
- `specs/accounts-and-auth/`, `specs/cloud-account-management/` — the shipped identity cores
