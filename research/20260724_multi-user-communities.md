# Multi-User DorkOS: Communities, Members, and Agents

- **Date:** 2026-07-24
- **Status:** active
- **Question:** How should DorkOS become multi-user — where any install can act as a community server, each login is a member, one person can join many communities, agents are members too, and humans + agents share group chats?
- **Method:** Source review of Block's Buzz (`github.com/block/buzz`, fetched via `opensrc`), plus Matrix/Synapse, Zulip, Mattermost, and Revolt; cross-referenced against the DorkOS codebase (Relay, Mesh, Pulse/Tasks, Better Auth, A2A gateway, session event stream).

---

## Executive summary

**Buzz is open source** — Apache-2.0 at `github.com/block/buzz`, launched 2026-07-21 by Block. It is the single most relevant prior art for what you're describing, because it solves the _same five requirements_ you listed, and it solves them by making one deliberate architectural bet: **the relay is the single source of truth, and identity is a keypair the member owns.** No federation, no gossip, no replication. A community is one relay at one URL; a member is an npub; an agent is also an npub; group chat is a channel on the relay.

That bet is the right one for DorkOS, and I'd copy it. The four "traditional" systems (Zulip, Mattermost, Revolt) all use server-issued accounts, which fails your requirement 3 (join many communities with one identity) — you end up with N unrelated accounts. Matrix solves requirement 3 properly via federation, but its cost is the room-state-resolution DAG, which is the single hardest thing in the entire self-hosted-chat space and has broken multiple independent implementations. **Don't build federation.**

The good news: DorkOS already has ~60% of the primitives. The durable per-session SSE stream (snapshot → gap-free replay via `Last-Event-ID` → live events with monotonic `seq`) is _exactly_ the channel-stream primitive Buzz's relay implements. Relay's envelope budget (hop count, TTL, ancestor chain) is a **better** agent-loop guard than Buzz's. Relay's rate limiter, circuit breaker, backpressure, and dead-letter queue are all things Buzz explicitly lists as _not yet built_. Better Auth's schema is already multi-user-capable — only the owner-only registration hook stands in the way.

What's genuinely missing: a **community** entity, a **member roster keyed by portable identity**, a **channel** entity with membership, and **agent identity distinct from its owner's credentials** (the `specs/agent-trust` work already heads there).

---

## Part 1 — Buzz

### Is it open source?

Yes. Apache-2.0, `github.com/block/buzz`, Rust monorepo, workspace version `0.1.0` (product versioning is separate; press reports the desktop app at 0.4.x). Desktop (Tauri + React), mobile (Flutter), admin web, and the relay all live in one repo. Block encourages experimentation, not mission-critical migration.

### What it actually is

A **self-hosted workspace where humans and AI agents are first-class equals**, built on Nostr NIP-01 wire format. Every action — chat message, reaction, workflow step, canvas update, huddle join, git event — is a cryptographically signed Nostr event identified by a `kind` integer. Adding a feature means defining a new kind number; existing clients see nothing and break nothing.

It merges Slack + GitHub: channels, threads, DMs, voice ("huddles"), forums, canvases, git repos served over smart HTTP from the same domain, and a YAML workflow engine.

### How the server works

```
Clients (desktop, mobile, agents via buzz-cli) ──WebSocket/REST──► buzz-relay (Axum)
                                                                       │
                                          ┌────────────────────────────┼──────────────┐
                                          ▼                            ▼              ▼
                                   Postgres (events,             Redis (pub/sub,   S3/MinIO
                                   channels, members,             presence,        (media)
                                   workflows, audit, FTS)         typing)
```

**The core principle, stated plainly in `ARCHITECTURE.md`:**

> The relay is the single source of truth. All reads and writes flow through it. There is no peer-to-peer event exchange, no gossip, no replication — just clients connecting to one relay over WebSocket, and the relay enforcing auth, verifying signatures, persisting events, fanning out to subscribers, indexing for search, and triggering automation.

**Crate layout** (dependency-ordered, and worth stealing as a shape):

| Crate             | Role                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `buzz-core`       | Zero-I/O. Types, signature verification, filter matching, kind registry. Explicitly bans tokio/sqlx/redis/axum in its `Cargo.toml`. |
| `buzz-db`         | Postgres: events (monthly range-partitioned), channels, members, tokens, workflows, audit                                           |
| `buzz-auth`       | NIP-42 (WebSocket challenge/response), NIP-98 (HTTP), API tokens, 14 scopes                                                         |
| `buzz-pubsub`     | Redis pub/sub fan-out, presence (`SET … EX 90`), typing (sorted sets, 5s window)                                                    |
| `buzz-search`     | Postgres FTS over a generated `search_tsv` column + GIN index                                                                       |
| `buzz-audit`      | SHA-256 hash-chain, tamper-evident, `pg_advisory_lock` single-writer                                                                |
| `buzz-workflow`   | YAML automation: 4 trigger types, 7 actions, `evalexpr` conditions with a 100ms timeout                                             |
| `buzz-relay`      | The server. The only crate that imports and orchestrates all the others.                                                            |
| `buzz-acp`        | Agent harness: bridges relay `@mention`s → AI agents over ACP/JSON-RPC stdio                                                        |
| `buzz-relay-mesh` | Inter-**pod** QUIC mesh (iroh) for multi-replica deployments — _not_ inter-community federation                                     |

Subsystems are isolated from each other: `buzz-workflow` never calls `buzz-pubsub`, `buzz-search` never calls `buzz-db`. All cross-subsystem coordination goes through the relay. This is the same discipline as DorkOS's FSD layer rule, applied server-side.

**The event pipeline** (`handlers/event.rs`) is a clean, ordered, 12-step thing worth copying wholesale:

```
1. AUTH CHECK        — authenticated? has MessagesWrite scope?
2. PUBKEY MATCH      — event.pubkey == auth_context.pubkey?
3. KIND_AUTH REJECT  — AUTH events are never stored
4. EPHEMERAL ROUTE   — kinds 20000–29999 skip storage/audit/search
5. VERIFY            — spawn_blocking(verify_event): Schnorr sig + id hash
6. MEMBERSHIP        — channel_id in tags? → check_channel_membership
7. DB INSERT         — ON CONFLICT DO NOTHING (idempotent)
8. REDIS PUBLISH     — if channel-scoped
9. FAN-OUT           — sub_registry.fan_out → conn_manager.send_to
10. SEARCH INDEX     — bounded worker queue, non-blocking
11. AUDIT LOG        — spawned async, non-blocking
12. WORKFLOW TRIGGER — spawned async, excludes workflow kinds (loop prevention)
```

Steps 10–12 are fire-and-forget; a failure there does not fail the write. The `OK` ack is sent at the _end_ of the pipeline, not right after DB insert.

**Fan-out** is a three-tier index, not a scan: `(channel_id, kind)` → O(1); `channel_id` wildcard; global fallback. Critically, **channel-scoped events are never delivered to global subscriptions** — a deliberate security boundary, not an optimization. And the `REQ` handler checks channel access _before_ registering the subscription, closing the race where a non-member would receive live events between registration and the access check.

**Connection lifecycle:** semaphore acquire (reject at capacity before reading a byte) → NIP-42 challenge → auth → three concurrent loops (recv inline, send spawned, heartbeat spawned, coordinated by a `CancellationToken`) → cleanup. Slow clients get a 3-strike grace counter on full send buffers, then get cancelled.

### The two ideas worth stealing outright

**1. Agent identity via owner attestation (NIP-OA + NIP-AA).**

This is the smartest thing in the repo. The problem: if agents are members, an operator who adds a human must also separately enroll every agent that human runs — and when the human's membership is revoked, their agents stay enrolled until manually removed.

NIP-AA closes it. The agent has its own keypair. During the auth handshake it presents an `auth` tag — `["auth", <owner-pubkey>, <conditions>, <sig>]` — a Schnorr signature by the owner over `nostr:agent-auth:<agent-pubkey>:<conditions>`. The relay verifies the signature, checks that the _owner_ is an active member, and grants the agent **virtual membership**: no persistent membership row is created, and access is re-derived on every new connection. Revoke the human, and their agents fail on their next connect. No cleanup job, no sync hazard.

Deliberate limits, all documented honestly:

- Virtual members never get admin privileges and can never modify membership.
- Channel-level, role, and quota checks evaluate the **agent's own pubkey**, not the owner's. The agent does _not_ inherit the owner's channel memberships.
- Rate limits _should_ aggregate by owner across all their agents — otherwise one member mints 50 keys and multiplies their quota.
- `kind=` conditions in the credential are **not** enforced at connection admission. The spec says so loudly: "issuing any valid `auth` tag — even one with narrow `kind=` clauses — grants the agent full relay-level read and write access unless the relay implements optional per-event enforcement."
- Revocation of a _leaked agent key_ requires removing the owner, waiting for a `created_at<t` condition to expire, or a relay denylist. Capabilities, not tokens.

**2. Tenancy resolves from the connection, never from the payload.**

Buzz's `docs/multi-tenant-relay.md` is a 1,100-line formal spec (TLA+ for the serving model, Tamarin for the auth protocol under a Dolev-Yao adversary) whose central claim is one sentence:

> The resolved `community_id` is the sole tenant authority. The `h` tag on a wire event is a _routing hint_ a client asserts; it is never the commit point of tenancy.

This is the **confused deputy** defense (Hardy 1988). The relay holds broad authority over a shared DB; a client supplies an ambient name; if the relay acts on its broad authority under the client's name, the client escapes its community. The fix: `community = resolve_host(connection.host)`, established _before_ AUTH, EVENT, REQ, REST, media, git, search, or pub/sub handling runs. An unknown host **fails closed** — never falls through to a default tenant. A client-supplied channel tag must _agree_ with the host-derived community or the request is rejected.

Their enumerated leak channels, each closed by a named mechanism, are a genuinely good checklist:

- **Event-id existence oracle** — `INSERT … ON CONFLICT DO NOTHING` on a content-hash id lets a writer in community B learn that _someone_ wrote that id. Closed by making the uniqueness constraint composite over `(community_id, …, id)` so a cross-community write gets a fresh key, not a conflict.
- **Constraint-violation error surface** — Postgres errors leak constraint names and columns. Closed by a fixed sanitized error alphabet (9 allowed prefixes).
- **Projection rebuild** — touches every tenant by construction. Closed by never serving rows from the rebuild path.
- **Unauthenticated global surface** — the relay-info document at `/`. Closed by a typed-input fence: the doc builder takes only static config, no DB handle. They note explicitly that adding a `total_events` counter is "one `&PgPool` argument away."
- Row-level security is the **backstop**, not the mechanism — a dropped application predicate yields ∅, not everything.

### What Buzz honestly admits it hasn't built

Their `## 9. Known Limitations` table is refreshingly straight, and every item is something DorkOS already has or can trivially have:

| Buzz gap                                                                                                                        | DorkOS status                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **No rate limiting implementation** — the trait exists, 4 tiers are _designed_, the only impl is a test stub that always allows | `packages/relay/src/rate-limiter.ts` — real sliding-window per-sender limiter, shipped                                           |
| No circuit breaking or backpressure mentioned anywhere                                                                          | `circuit-breaker.ts`, `backpressure.ts` — both shipped                                                                           |
| Approval gates not wired end-to-end — runs that hit one are marked **failed**                                                   | Tool-approval flow shipped; `specs/agent-trust` generalizes the marketplace confirmation-token flow into a core approval service |
| Two workflow actions (`send_dm`, `set_channel_topic`) return `NotImplemented`                                                   | n/a                                                                                                                              |
| Presence fan-out is local-only across nodes                                                                                     | n/a (single-node today)                                                                                                          |

---

## Part 2 — How the other systems do it

I fetched and reviewed Matrix (spec + Synapse), Zulip, Mattermost, and Revolt. Here's the honest comparison on the axes that matter for your five requirements.

### Identity model — the axis that decides everything

| System         | Identity                                                                                             | Join many communities?                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Zulip**      | `UserProfile` scoped to a `Realm` (org). One install hosts many realms at `{string_id}.example.com`. | **No.** A user in realm A and realm B is two rows, two passwords, two profiles.                       |
| **Mattermost** | `User` scoped to the install; `Team` is a sub-grouping within it.                                    | **No.** One install = one identity domain.                                                            |
| **Revolt**     | `User` on the instance; "servers" are sub-groupings.                                                 | **No.**                                                                                               |
| **Matrix**     | `@user:homeserver.tld` — your homeserver owns your identity, rooms federate.                         | **Yes**, and this is the whole point.                                                                 |
| **Buzz**       | An npub (secp256k1 keypair) held by _you_. Communities are relays that gate on a membership roster.  | **Yes.** "Your key stays yours across all of them; identity is portable even when the hosting isn't." |

**This is the fork in the road.** Requirement 3 ("I can connect to multiple communities") only has two real answers: federation (Matrix) or self-sovereign keys (Buzz). Everything else gives you N disconnected accounts.

### Server / fan-out architecture

- **Zulip** — Django for writes, a separate **Tornado** process pool for real-time. `send_event_on_commit(realm, event, users)` wraps `transaction.on_commit`, so an event is _never_ published if the DB transaction rolls back. Events are routed via RabbitMQ to a specific Tornado port, sharded by user id (`get_user_id_tornado_port`). Clients hold a long-poll **event queue** with a durable id and a `last_event_id` — a client that drops reconnects and gets everything since. This is the same guarantee as DorkOS's `Last-Event-ID` session stream. The `on_commit` discipline is the single best resilience idea in the whole survey and DorkOS should adopt it explicitly.
- **Mattermost** — Go monolith, `web_hub.go` holds an in-process hub per set of connections, broadcasting `WebSocketEvent`s; cluster mode gossips between nodes. Postgres/MySQL for storage.
- **Revolt** — split binaries: `delta` (REST) and `bonfire` (WebSocket events), plus `autumn` (files), `january` (proxy), `pushd`, `crond`. MongoDB. Cleanly separated, but no federation.
- **Matrix/Synapse** — federation via signed **PDUs** (persistent, room history) and **EDUs** (ephemeral, typing/presence), wrapped in **Transactions** delivered by HTTPS PUT. Origin server is responsible for delivery, but PDUs are signed so they can travel through third parties. Every room has a state DAG and **state resolution** reconciles concurrent state changes across servers. This is the hard part. It is where the complexity lives, and it's why I'd avoid it.

### Bots and agents as members

- **Zulip** — best-in-class of the traditional systems. Bots are real `UserProfile` rows with `is_bot=True` and four types: `DEFAULT_BOT` (API key), `INCOMING_WEBHOOK_BOT`, `OUTGOING_WEBHOOK_BOT` (server POSTs mentions to a URL and posts the reply back), `EMBEDDED_BOT`. A bot is a member: it appears in the user list, joins streams, gets mentioned.
- **Mattermost** — `Bot` is a satellite table whose primary key _is_ a `User` id, with an `OwnerId`. Same insight as Buzz's NIP-AA (an agent has an owner) but without the cryptographic revocation chain.
- **Matrix** — **Application Services**: register namespaces of user IDs/room aliases; the homeserver pushes matching traffic to them; they can operate "virtual users" in their namespace. Registration is by config file only — HTTP registration was _removed_ as a security risk, because a compromised appservice could register a global `*` regex and sniff all traffic. Worth remembering when designing agent registration.
- **Buzz** — agents are members, full stop. Own keypair, own audit trail, same surface as humans (channels, canvases, workflows, huddles). `buzz-acp` is the harness: it connects to the relay with NIP-42 auth, subscribes to `@mention`s, queues per channel (at most one prompt in flight per channel), batches queued events into a single prompt, and spawns 1–32 agent subprocesses over ACP/JSON-RPC. It's model-agnostic — Claude Code, Codex, goose all plug in.

That last point matters: **`buzz-acp` is architecturally the same thing as DorkOS's runtime registry.** They wrote a multi-runtime agent harness that speaks a standard protocol and pool-manages subprocesses. DorkOS already has that, and arguably a better version of it (three production runtimes behind a conformance suite).

---

## Part 3 — The design space for DorkOS

### What you asked for, restated as system requirements

1. Any install can be a **community server** → the install runs a coordinating service at a URL
2. Each login is a **member** → real multi-user auth, not single-owner
3. One person joins **many communities** → identity must not be minted by the community
4. **Agents are members** → agents need identity distinct from their owner's credentials
5. **Group chats** with people and agents → channels with membership and a shared, ordered log

### Four approaches

#### A. Server-issued accounts (Zulip / Mattermost / Revolt model)

Each community mints accounts. You log into `alice.dorkos.example` with a password; you log into `ikechi.dorkos.example` with a different one.

- **For:** simplest possible thing. Better Auth already does it — flip the owner-only registration hook to invite-based and you're most of the way there. Familiar to every user.
- **Against:** **fails requirement 3 honestly.** "Connect to multiple communities" degenerates into a credential manager with N unrelated identities. Your agents would need N enrollments each. Reputation doesn't travel. No path to requirement 4 done well.
- **Verdict:** a fine _v0.5_ to prove the UI, a dead end as the architecture.

#### B. Portable keypair + authoritative-per-community relay (Buzz model) — **recommended**

Identity is a keypair your DorkOS install (or desktop keystore) holds. A community is one DorkOS install in community mode at one URL, authoritative for its own roster, channels, and log. You "join" by proving key ownership over a signed challenge; the community checks its roster. Your client holds N live connections, one per community.

- **For:** requirement 3 falls out for free. Requirement 4 falls out via owner attestation. No federation to build — each community is independently a simple, comprehensible server. Agents get real identity, and the `specs/agent-trust` per-agent-token work is the same shape one layer down.
- **Against:** key management is a real cost, and Buzz says so plainly: _"Losing your private key means losing your identity. There's no 'forgot password' flow."_ Onboarding friction is real — "most developers don't have a keypair." DMs and profiles do **not** inherit across communities; a member reposts their profile in each one.
- **Mitigation:** this is where DorkOS's cloud Better Auth instance (`apps/site`, the P2 "DorkOS accounts" device-link path) earns its keep — it can be an _optional_ key-escrow / recovery layer without becoming the identity authority. Keep the key authoritative; make the cloud account a convenience.

#### C. Federation (Matrix model)

Communities exchange signed events server-to-server; a room's membership spans homeservers.

- **For:** the most powerful answer. Genuine cross-community rooms.
- **Against:** state resolution over a room DAG is the hardest problem in this space. Synapse has spent a decade on it; independent implementations have repeatedly gotten it wrong. It is wildly disproportionate to a pre-launch alpha, and **Block — with far more resources — explicitly chose not to build it.**
- **Verdict:** no. Not now, probably not ever in this form.

#### D. Relay-of-relays / mesh gossip

Communities gossip messages peer-to-peer.

- **For:** resilient in principle; no single point of failure.
- **Against:** you inherit every hard distributed-systems problem (ordering, dedup, partition healing, conflicting membership views) with none of federation's spec to lean on. Note that `buzz-relay-mesh` is **not** this — it's a QUIC mesh between _replicas of one relay_, arbitrated by a Redis fenced generation, with the explicit law "mesh membership is a hint; the Redis fenced generation is the arbiter." Even Buzz's mesh has a central arbiter.
- **Verdict:** no.

### The recommendation

**Approach B, with a deliberate escape hatch.** Concretely:

- **Community** = a DorkOS install running in community mode, reached at one URL. It owns its roster, channels, and event log. It is the single source of truth for itself.
- **Member** = a public key with a roster entry in that community. The _same_ key can be a member of many communities; nothing is shared between them except the key.
- **Agent** = its own keypair plus an owner attestation. Admitted because its owner is admitted; revoked when its owner is revoked; permissioned on its _own_ identity, never inheriting the owner's channel access.
- **Channel** = an ordered, append-only event log with a membership list. Group chats are channels containing both humans and agents.
- **Cross-community agent work** rides the **existing A2A gateway**, not a new federation protocol. `@dorkos/a2a-gateway` already generates Agent Cards from the Mesh registry and bridges inbound A2A requests onto the Relay bus. That is the sanctioned, standards-based way for an agent in community A to task an agent in community B — and it already exists.

---

## Part 4 — How DorkOS's existing pieces map on

### Session event stream — the primitive you already have

`GET /api/sessions/:id/events` is snapshot → gap-free replay via `Last-Event-ID` → live events with monotonic `seq`. That is _precisely_ the contract a channel stream needs, and it's the same contract Zulip's event queue and Buzz's `REQ`→`EOSE`→live-fanout provide. **A channel is a session-shaped stream with a membership list instead of an owner.** This is the single biggest reason multi-user is closer than it looks.

Reuse, don't reinvent: `collectDurableEvents` and the SSE integration test patterns transfer directly.

### Relay (`packages/relay`) — the bus, and where the community dimension is missing

What transfers cleanly:

- **Maildir + SQLite index + dead-letter queue** — this is a durable **outbox**. When a community server is unreachable, a member's local install queues and retries. Buzz has no equivalent; its clients just fail.
- **Budget envelope** — `hopCount` / `maxHops` / `ancestorChain` / `ttl` / `callBudgetRemaining` is a _better_ agent-loop guard than Buzz's, which just excludes workflow-kind events from triggering workflows. In a room where five agents can each hear each other, this is load-bearing.
- **Rate limiter, circuit breaker, backpressure** — all three shipped; all three are Buzz's admitted gaps.
- **Access control rules + the initiate-consent gate (DOR-277)** — an agent-initiated message to a human channel already passes a consent gate at the delivery layer. Extend the same gate to community channels rather than building a second one.
- `ChannelTypeSchema` already enumerates `dm | group | channel | thread`. The vocabulary exists; the entity doesn't.

**The gap that needs care:** the subject scheme has no community dimension. `relay.human.{platform}.{instanceId}.{chatId}`, `relay.agent.{runtime}.{sessionId}`, `relay.human.console.*` are all install-local. Two options:

1. Add a community segment: `relay.community.{communityId}.channel.{channelId}`. Cheap, but it puts tenancy **in a client-assertable string** — exactly the confused-deputy hazard Buzz spent a formal spec closing. If you do this, tenancy must still be resolved from the authenticated connection and the subject checked for _agreement_, never trusted.
2. One `RelayCore` instance per community connection, with the community bound at construction. Slightly heavier, structurally safer, and matches Buzz's `resolve_host` fence. **I'd lean here.**

### Mesh (`packages/mesh`) — local agent registry, not a community roster

Mesh discovers and registers agents by filesystem path (`.dork/agent.json` + SQLite cache, file-first write-through, 5-minute reconciler). It answers "what agents exist on this machine." A community roster answers "which keys may act here" — a different question with a different key space.

Keep them separate and bridge them: registering a local Mesh agent _into_ a community mints its keypair + owner attestation and adds a roster entry. `relay-bridge.ts` and `namespace-resolver.ts` are the natural seam. Note that Mesh's cross-namespace access rules (`CrossNamespaceRule`, `mesh-denial.ts`, the denial list) are already a permission model for agent-to-agent reach — that generalizes to cross-community reach rather than needing a parallel system.

DorkBot's `isSystem: true` protection (cannot be renamed, deleted, or unregistered, enforced at routes + MCP + UI) is the existing precedent for "some members are structurally special." Community owners will need the same treatment.

### Pulse / Tasks — scheduled work needs an actor

`task-scheduler-service.ts` runs agent sessions on a cron. Once agents post into shared channels, **every scheduled run needs an attributable actor identity and a quota**, or a misconfigured 5-minute Pulse job becomes a community-wide spam source. This is the concrete case for Buzz's owner-scoped rate aggregation: cap by _owner_ across all their agents, not just per agent key, so one member can't mint keys to multiply their budget.

`flow-drain-pulse-seat.integration.test.ts` suggests a seat/concurrency concept already exists — that's the right hook.

### Better Auth — closer than it looks

From `contributing/authentication.md`:

> A `databaseHooks.user.create.before` hook enforces the policy: sign-up succeeds only while the `user` table is empty… **The schema stays multi-user-capable for the future invites spec.**

So: the schema is ready, one hook and the exposure guard need to change. Two things to keep:

- **`verifyRequestAuth` as the single credential resolver** — cookie, then Bearer API key, never throws, fails closed. Add signed-challenge auth as a _third_ path inside that one function; do not add a second resolver.
- **The exposure guard's both-facts rule** (`authEnabled && hasUsers`) — a community server is by definition exposed, so this is exactly the gate that decides whether an install may enter community mode.

The transport-auth vs. identity split in `specs/agent-trust` decision 3 ("the human's credentials remain the transport auth… identity ≠ transport auth in phase 3") is the right staging. Community mode is where that split has to close: an agent connecting to a _remote_ community cannot ride its owner's local cookie. The NIP-AA attestation pattern is precisely the mechanism for closing it.

### A2A gateway — the cross-community path

Already generates Agent Cards from Mesh, bridges A2A requests onto Relay, persists task state in SQLite, serves `/.well-known/agent-card.json`. This is the standards-based cross-community agent path. Use it instead of inventing federation.

### Harness / marketplace

`@dorkos/harness` projects `.agents/` and plugins into every agent harness. A community could distribute shared skills, workflows, and conventions to its members through the same mechanism — Buzz has no equivalent, and it's a genuine differentiator. The marketplace's file-scoped, git-free install transaction (stage in tmpdir → backup → atomic rename → restore on failure) is the right shape for community-pushed content too.

---

## Part 5 — Robustness and resilience

Ordered by how badly it hurts to get wrong.

1. **Resolve tenancy from the connection, never the payload.** Bind the community before _any_ handler runs — auth, read, write, media, search. Unknown host → fail closed, never a default. A client-supplied channel id must _agree_ with the connection's community or the request is rejected. This is the one thing where getting it wrong is a cross-community data leak.

2. **Publish events only after the DB transaction commits.** Zulip's `send_event_on_commit` wrapping `transaction.on_commit`. Without it, a rolled-back write has already been fanned out to every subscriber and there is no way to un-send it.

3. **Composite uniqueness including the community id.** Otherwise a content-addressed event id turns `ON CONFLICT DO NOTHING` into a cross-community existence oracle. Buzz calls this out by name and closes it with `UNIQUE (community_id, …, id)`.

4. **Sanitize the error surface.** A fixed alphabet of error codes on tenant-scoped paths. Raw DB errors leak constraint names, column names, and conflicting tuples.

5. **Check access before subscribing, not after.** Buzz's `REQ` handler loads accessible channels and rejects _before_ registering the subscription, closing the window where live fan-out reaches a non-member.

6. **Never deliver channel-scoped events to unscoped subscriptions.** Treat this as a security boundary, not an optimization.

7. **Idempotent writes end to end.** Content-addressed ids + `ON CONFLICT DO NOTHING`, plus the `clientMessageId` echo reconciliation DorkOS already does for sessions. A member's outbox retrying after a partition must not double-post.

8. **Offline-first by default.** Relay's Maildir store, dead-letter queue, and circuit breaker are the outbox. A community being down should degrade to "queued," never "lost." DorkOS is local-first — this is an advantage over every system surveyed.

9. **Agent loop prevention with teeth.** The existing budget envelope (hop count, TTL, ancestor chain, call budget) plus Buzz's exclusion rule (agent-generated events must not re-trigger the automation that produced them). In a room with five agents, absence of this is a runaway cost incident.

10. **Owner-scoped quota aggregation.** Cap by owner across all their agents, not per agent key. Buzz specifies this and it's the obvious hole otherwise.

11. **Slow-client handling.** Bounded per-connection send buffers with a grace counter, then disconnect. One stalled mobile client must not back-pressure a channel.

12. **Per-community audit chains, never a global one.** Buzz uses a SHA-256 hash chain per community with a single-writer advisory lock. A shared chain leaks activity volume across tenants and couples their integrity.

13. **Ephemeral vs. persistent split.** Typing, presence, and progress signals must skip storage, audit, and search entirely. DorkOS's `SignalEmitter` already models this — keep the separation strict.

14. **Membership revocation is not retroactive.** Buzz declares this explicitly: revoking a member removes _current_ capability; it does not relabel or delete what they already wrote. Decide and document your position rather than discovering it.

---

## Part 6 — Suggested staging

**Phase 1 — Multi-user on one install.** Invite-based registration (flip the Better Auth hook), member list, per-user sessions and workspaces. Prove the UI and the permission model with zero distributed-systems risk. This is Approach A used deliberately as a stepping stone — but design the roster keyed on a _portable identity_ column from day one so phase 2 isn't a migration.

**Phase 2 — Channels.** A channel entity with a membership list, riding the existing durable event-stream contract (snapshot → `Last-Event-ID` replay → live `seq`). Humans only. Get ordering, resume, and read state right before adding agents.

**Phase 3 — Agents as members.** Agent keypairs + owner attestation. An agent in a channel; `@mention` triggers a turn; the reply posts back. This is where `buzz-acp`'s per-channel queueing discipline transfers: **at most one prompt in flight per channel**, subsequent mentions queue and batch into a single prompt. Without that, a busy channel spawns unbounded concurrent turns.

**Phase 4 — Community mode.** The install accepts remote members. Connection-bound tenancy, signed-challenge auth, the exposure guard as the gate. One community per install first; multi-community-per-install only if hosting demands it (and if so, read Buzz's `multi-tenant-relay.md` in full first — the isolation work is subtle and they've done it).

**Phase 5 — Multi-community client.** Your install holds N community connections. Per-community identity display, unified inbox, per-community outbox with independent retry. Cross-community agent work over A2A.

---

## Open questions worth deciding early

1. **Where do keys live?** Desktop keystore, `~/.dork/`, or the cloud Better Auth account as optional escrow? The recovery story is a product decision, not a technical one, and Buzz's honest answer ("there is no recovery") may be too harsh for Ikechi.
2. **Does a member's DorkOS install have to be running to receive messages?** If community state is authoritative on the community server, no — and that's the right answer. But it means a community server is real infrastructure someone has to run.
3. **Are agents addressable across communities, or only within?** A2A says across. That's a bigger surface than it sounds.
4. **What does an agent see?** Buzz's NIP-AA is explicit that an agent does _not_ inherit its owner's channel memberships. Agreeing with that up front avoids a nasty retrofit.
5. **Does the marketplace become community-scoped?** Communities distributing skills/agents/workflows to members via the harness is a real differentiator, and it changes the marketplace's trust model.

---

## Sources

**Code fetched via `opensrc` (cached under `~/.opensrc/repos/`):**

- `block/buzz` — Apache-2.0. Read: `ARCHITECTURE.md`, `VISION_SOVEREIGN.md`, `VISION_AGENT.md`, `VISION_MESH.md`, `NOSTR.md`, `docs/multi-tenant-relay.md`, `docs/nips/NIP-AA.md`, crate layout, migrations, `buzz-relay-mesh/src/lib.rs`
- `nostr-protocol/nips` — NIP-29 (relay-based groups), NIP-42, NIP-98
- `matrix-org/matrix-spec` — `server-server-api.md`, `application-service-api.md`
- `element-hq/synapse`, `zulip/zulip`, `mattermost/mattermost`, `revoltchat/backend`

**Press:**

- [TechCrunch — Jack Dorsey is taking on Slack with Buzz](https://techcrunch.com/2026/07/21/jack-dorsey-is-taking-on-slack-with-buzz-a-group-chat-platform-for-teams-and-their-ai-agents/)
- [Decrypt — Block Launches Buzz, a Nostr-Based Slack and GitHub Rival for AI Agents](https://decrypt.co/374026/jack-dorseys-block-launches-buzz-a-nostr-based-slack-and-github-rival-for-ai-agents)
- [TheNextWeb — Block takes on Slack with Buzz](https://thenextweb.com/news/block-buzz-humans-ai-agents-workspace)
- [GitHub — block/buzz](https://github.com/block/buzz)
