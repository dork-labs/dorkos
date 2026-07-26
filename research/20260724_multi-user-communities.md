# Multi-User DorkOS: Communities, Members, and Agents

- **Date:** 2026-07-24 (consolidated 2026-07-25)
- **Status:** active
- **Question:** How should DorkOS become multi-user — where an install can act as a community server, each login is a member, one person can join many communities, agents are members too, and humans + agents share group chats?
- **Method:** Source review of Block's Buzz (`github.com/block/buzz`, fetched via `opensrc`), plus Matrix/Synapse, Zulip, Mattermost, Revolt, and the Nostr NIPs; cross-referenced against the DorkOS codebase (Relay, Mesh, Pulse/Tasks, Better Auth, A2A gateway, session event stream, `packages/db`, `apps/site/src/db`).

---

## Executive summary

**Buzz is open source** — Apache-2.0 at `github.com/block/buzz`, launched 2026-07-21 by Block. It is the closest prior art to what we want, because it answers the _same five requirements_ and answers them with one deliberate bet: **the relay is the single source of truth, and identity is a keypair the member owns.** No federation, no gossip, no replication. A community is one relay at one URL; a member is a public key; an agent is also a public key; group chat is a channel on the relay.

The architectural bet is right and we should copy it. The identity bet is right _for their audience_ and wrong for ours — Buzz requires every member to hold a Nostr keypair, and their own vision doc concedes the cost ("most developers don't have a nostr keypair… you'll lose some people at the door"). We can keep the architecture and swap the identity layer for something Ikechi can use.

The four traditional systems (Zulip, Mattermost, Revolt) all issue accounts per install, which only satisfies a weak reading of "join many communities." Matrix satisfies the strong reading via federation, at the cost of the room-state-resolution DAG — the hardest problem in this space, which has broken multiple independent implementations. **We should not build federation.**

DorkOS already has ~60% of the primitives. The durable per-session SSE stream (snapshot → gap-free replay via `Last-Event-ID` → live events with monotonic `seq`) is _exactly_ the channel-stream primitive Buzz's relay implements. Relay's envelope budget (hop count, TTL, ancestor chain) is a **better** agent-loop guard than Buzz's. Relay's rate limiter, circuit breaker, backpressure, and dead-letter queue are all things Buzz explicitly lists as not yet built. Better Auth's schema is already multi-user-capable, and `apps/site/src/db/auth-schema.ts` already has those tables in the Postgres dialect.

What's genuinely missing: a **community** entity, a **member roster keyed on a portable identity**, a **channel** entity with membership, and **agent identity distinct from its owner's credentials** (`specs/agent-trust` already heads there).

---

## Decisions taken

| #   | Decision                                                                          | Rationale                                                                                                                            |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **`apps/community` is its own app**, not a mode of `apps/server`                  | The cockpit spawns agents with filesystem access; the community server must be structurally incapable of that, not configured not to |
| 2   | **Postgres from the first commit** for `apps/community`                           | Migration cost is zero now and painful later; SQLite's single-writer ceiling is a discover-it-at-200-users failure                   |
| 3   | **No Redis in v1 — but keep the fan-out seam**                                    | Three implementations behind one seam: in-process (VPS), polling (serverless), Redis (multi-process, later)                          |
| 4   | **Community chat never touches the Maildir**                                      | Not accumulation (it drains) — **write-time fan-out**: one file _per endpoint_ per message, plus one chokidar watcher per endpoint   |
| 5   | **Email-first identity, keypair invisible underneath**                            | Passkeys are keypairs; nobody calls Touch ID web3. Ikechi never sees a key; Priya can audit every signature                          |
| 6   | **Signed invite links for v1, not magic links**                                   | Requires zero email infrastructure per community operator                                                                            |
| 7   | **Sign messages in v1; don't authenticate with keys in v1**                       | Signing is additive and reversible; key auth is the risky half. Buys verifiable attribution now, key auth later without migration    |
| 8   | **One _hosted_ community per install**                                            | Multi-tenancy is where Buzz's 1,100-line formal isolation spec comes from. Belonging to many is unaffected                           |
| 9   | **`CommunityConnector` interface with two implementations** (Buzz, DorkOS-native) | The Buzz connector is the design exercise for our own protocol, proven against a running server                                      |
| 10  | **Single-player is the product; multiplayer is additive**                         | Enforced by construction — the cockpit cannot import community code                                                                  |
| 11  | **DorkOS cloud is one optional identity provider, never the authority**           | Otherwise every community depends on our uptime, contradicting "an install can be a server"                                          |
| 12  | **Two deployment targets: Docker/VPS (default) and Vercel + Neon (one-click)**    | Serverless replaces the laptop-as-server idea outright — better on security, availability, and ops at the same time                  |
| 13  | **`apps/community` has no filesystem persistence and never imports `dork-home`**  | The rule that keeps serverless viable; enforceable as an ESLint boundary like the existing SDK-confinement rules                     |

---

## Glossary

| Term                           | Meaning                                                                                                                                                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Nostr**                      | _Notes and Other Stuff Transmitted by Relays._ A protocol by the pseudonymous fiatjaf. One object type (a signed `event`), one signature scheme (Schnorr over secp256k1), servers called relays that store and forward. That's the entire protocol. |
| **NIP**                        | _Nostr Implementation Possibility._ Like a BIP or an RFC, but deliberately looser — the registry README says "NIPs are not a protocol checklist… don't implement something just because it exists in this repo."                                    |
| **npub**                       | A member's public key in its human-readable bech32 encoding. Their identity.                                                                                                                                                                        |
| **Relay** (Nostr sense)        | A Nostr server. In Buzz, one relay = one community. Not to be confused with `@dorkos/relay`, our internal message bus.                                                                                                                              |
| **NIP-01 / 42 / 29 / 43 / 98** | Base protocol / client-to-relay auth / relay-based groups / membership rosters / HTTP auth. The five that matter here.                                                                                                                              |

**Buzz also writes private NIPs** — `docs/nips/NIP-AA` (agent auth), `NIP-AP` (personas), `NIP-CW` (channel window), `NIP-RS` (read-state sync), and ten more. These are not in the public registry. **A meaningful part of Buzz's protocol is Buzz's, not Nostr's** — standard NIPs get you connected, but the custom ones are where the product lives. Relevant when scoping interop.

---

## Part 1 — Buzz

### Is it open source? Yes

Apache-2.0, `github.com/block/buzz`, Rust monorepo, workspace version `0.1.0` (product versioning is separate; press reports the desktop app at 0.4.x). Block encourages experimentation, not mission-critical migration.

### Is it web3 / blockchain? No

Grepped the whole repo for lightning, bitcoin, blockchain, onchain, zaps, wallets, and NIP-57 (the Nostr payments NIP). Every hit was a false positive:

- `Zap` — a lucide-react icon in the chat header
- `bitcoin::secp256k1`, `bitcoin::hashes` — Rust crate _namespaces_. That crate is simply where the audited elliptic-curve and hashing bindings live.

Their README, line 254, settles it:

> **Not blockchain.** Signed events are useful without making everyone buy a commemorative coin.

No chain, no consensus, no mining, no tokens, no gas, no wallet. The keypair does the job a username and password does — not the job a wallet does.

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

**The core principle, from `ARCHITECTURE.md`:**

> The relay is the single source of truth. All reads and writes flow through it. There is no peer-to-peer event exchange, no gossip, no replication — just clients connecting to one relay over WebSocket, and the relay enforcing auth, verifying signatures, persisting events, fanning out to subscribers, indexing for search, and triggering automation.

**Crate layout** (dependency-ordered, worth stealing as a shape):

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

Subsystems are isolated from each other: `buzz-workflow` never calls `buzz-pubsub`, `buzz-search` never calls `buzz-db`. Cross-subsystem coordination goes only through the relay — the same discipline as our FSD layer rule, applied server-side.

**The event pipeline** (`handlers/event.rs`) is a clean ordered thing worth copying wholesale:

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

Steps 10–12 are fire-and-forget; a failure there does not fail the write. The `OK` ack is sent at the _end_ of the pipeline, not after DB insert.

**Fan-out** is a three-tier index, not a scan: `(channel_id, kind)` → O(1); `channel_id` wildcard; global fallback. **Channel-scoped events are never delivered to global subscriptions** — a deliberate security boundary. The `REQ` handler checks channel access _before_ registering the subscription, closing the race where a non-member would receive live events between registration and the access check.

**Connection lifecycle:** semaphore acquire (reject at capacity before reading a byte) → NIP-42 challenge → auth → three concurrent loops (recv inline, send spawned, heartbeat spawned, coordinated by a `CancellationToken`) → cleanup. Slow clients get a 3-strike grace counter on full send buffers, then get cancelled.

### Server and client are separate deployables

This is the most decision-relevant fact in the repo:

- **Server:** `buzz-relay`, a Rust binary shipped as a Docker `runtime` target, with **Helm charts** — ArgoCD and Flux examples, cert-manager ingress, `replicaCount: 3`. Dev compose stack is Postgres + Redis + Keycloak + MinIO + Prometheus.
- **Clients:** `desktop/` (Tauri), `mobile/` (Flutter), `web/`, `admin-web/` — separate apps.

Block shipped Kubernetes charts on day one. **Nobody runs their laptop as a Buzz relay.** They did not build "any install is a server," with substantially more resources than we have.

### The two ideas worth stealing outright

**1. Agent identity via owner attestation (NIP-OA + NIP-AA).**

The problem: if agents are members, an operator who adds a human must separately enroll every agent that human runs — and revoking the human leaves their agents enrolled.

NIP-AA closes it. The agent has its own keypair and presents an `auth` tag during the handshake — `["auth", <owner-pubkey>, <conditions>, <sig>]`, a Schnorr signature by the owner over `nostr:agent-auth:<agent-pubkey>:<conditions>`. The relay verifies it, checks the _owner_ is an active member, and grants **virtual membership**: no persistent row, re-derived on every connection. Revoke the human, their agents fail on next connect.

Deliberate limits, all documented honestly:

- Virtual members never get admin privileges and can never modify membership.
- Channel-level, role, and quota checks evaluate the **agent's own pubkey**. The agent does _not_ inherit the owner's channel memberships.
- Rate limits _should_ aggregate by owner across all their agents — otherwise one member mints 50 keys and multiplies their quota.
- `kind=` conditions are **not** enforced at connection admission: "issuing any valid `auth` tag — even one with narrow `kind=` clauses — grants the agent full relay-level read and write access unless the relay implements optional per-event enforcement."
- Revoking a _leaked agent key_ requires removing the owner, waiting for a `created_at<t` condition to expire, or a relay denylist. Capabilities, not tokens.

**2. Tenancy resolves from the connection, never from the payload.**

`docs/multi-tenant-relay.md` is a 1,100-line formal spec (TLA+ for the serving model, Tamarin for the auth protocol under a Dolev-Yao adversary) whose central claim is one sentence:

> The resolved `community_id` is the sole tenant authority. The `h` tag on a wire event is a _routing hint_ a client asserts; it is never the commit point of tenancy.

This is the **confused deputy** defense (Hardy 1988). The fix: `community = resolve_host(connection.host)`, established _before_ any handler runs. Unknown host **fails closed** — never a default tenant. A client-supplied channel tag must _agree_ with the host-derived community.

Their enumerated leak channels, each closed by a named mechanism, are a good checklist:

- **Event-id existence oracle** — `INSERT … ON CONFLICT DO NOTHING` on a content-hash id lets a writer learn _someone_ wrote that id. Closed by a composite unique key over `(community_id, …, id)`.
- **Constraint-violation error surface** — Postgres errors leak constraint and column names. Closed by a fixed sanitized error alphabet (9 allowed prefixes).
- **Projection rebuild** — touches every tenant by construction. Closed by never serving rows from the rebuild path.
- **Unauthenticated global surface** — the relay-info document at `/`. Closed by a typed-input fence: the builder takes only static config, no DB handle. They note that adding a `total_events` counter is "one `&PgPool` argument away."
- Row-level security is the **backstop**, not the mechanism — a dropped application predicate yields ∅, not everything.

### What Buzz honestly admits it hasn't built

| Buzz gap                                                                                           | DorkOS status                                                                                                           |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **No rate limiting** — trait exists, 4 tiers designed, only impl is a test stub that always allows | `packages/relay/src/rate-limiter.ts` — real sliding-window limiter, shipped                                             |
| No circuit breaking or backpressure                                                                | `circuit-breaker.ts`, `backpressure.ts` — both shipped                                                                  |
| Approval gates not wired end-to-end — runs that hit one are marked **failed**                      | Tool-approval flow shipped; `specs/agent-trust` generalizes the marketplace confirmation-token flow into a core service |
| Two workflow actions (`send_dm`, `set_channel_topic`) return `NotImplemented`                      | n/a                                                                                                                     |
| Presence fan-out is local-only across nodes                                                        | n/a (single-node)                                                                                                       |

---

## Part 2 — How the other systems do it

### Identity model — the axis that decides everything

| System         | Identity                                                                                       | Join many communities?                          |
| -------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Zulip**      | `UserProfile` scoped to a `Realm`. One install hosts many realms at `{string_id}.example.com`. | Separate records per realm                      |
| **Mattermost** | `User` scoped to the install; `Team` is a sub-grouping                                         | Separate records per install                    |
| **Revolt**     | `User` on the instance; "servers" are sub-groupings                                            | Separate records per instance                   |
| **Matrix**     | `@user:homeserver.tld` — your homeserver owns your identity, rooms federate                    | Yes, and it's the whole point                   |
| **Buzz**       | A keypair _you_ hold. Communities are relays that gate on a roster.                            | Yes — "your key stays yours across all of them" |

### Correction on Slack, and why it matters

An earlier draft of this analysis claimed Slack workspaces are "unrelated accounts." **That was overstated.** What's accurate:

- Member records **are** separate per workspace — workspace-scoped user IDs, and you can carry a different display name, avatar, and settings in each.
- But Slack layers a **central login service keyed on email** on top, which finds every workspace you belong to and issues sessions across them. Enterprise Grid goes further and unifies identity across an org's workspaces.

So the accurate description is **separate member records under a shared login layer** — and that _validates_ the design in Part 4 rather than undermining it. "Separate member records per community + an optional shared login layer" is exactly what we're proposing, and Slack is large-scale proof that users never perceive the seam.

### Server / fan-out architecture

- **Zulip** — Django for writes, a separate **Tornado** pool for real-time. `send_event_on_commit()` wraps `transaction.on_commit`, so an event is **never** published if the DB transaction rolls back. Events route via RabbitMQ to a Tornado port sharded by user id. Clients hold a durable event queue with `last_event_id` — same guarantee as our `Last-Event-ID` session stream. **The `on_commit` discipline is the single best resilience idea in the survey.**
- **Mattermost** — Go monolith, `web_hub.go` holds an in-process hub broadcasting `WebSocketEvent`s; cluster mode gossips between nodes.
- **Revolt** — split binaries: `delta` (REST), `bonfire` (WebSocket), `autumn` (files), `january`, `pushd`, `crond`. MongoDB. Cleanly separated, no federation.
- **Matrix/Synapse** — federation via signed **PDUs** (persistent room history) and **EDUs** (ephemeral), wrapped in **Transactions** over HTTPS PUT. Every room has a state DAG, and **state resolution** reconciles concurrent state changes across servers. This is the hard part, and the reason to avoid it.

### Bots and agents as members

- **Zulip** — best of the traditional systems. Bots are real `UserProfile` rows with `is_bot=True` and four types: `DEFAULT_BOT`, `INCOMING_WEBHOOK_BOT`, `OUTGOING_WEBHOOK_BOT` (server POSTs mentions to a URL, posts the reply back), `EMBEDDED_BOT`.
- **Mattermost** — `Bot` is a satellite table whose primary key _is_ a `User` id, with an `OwnerId`. Same owner insight as NIP-AA, without the cryptographic revocation chain.
- **Matrix** — **Application Services** register namespaces of user IDs and room aliases and operate "virtual users." Registration is config-file only; HTTP registration was _removed_ as a security risk, because a compromised appservice could register a global `*` regex and sniff all traffic. Worth remembering when designing agent registration.
- **Buzz** — agents are members, full stop. `buzz-acp` is the harness: connects with NIP-42 auth, subscribes to `@mention`s, queues per channel (**at most one prompt in flight per channel**), batches queued events into a single prompt, spawns 1–32 agent subprocesses over ACP.

That last point matters strategically: **`buzz-acp` is architecturally the same thing as our runtime registry, and weaker.** It's subprocess pooling over ACP stdio, ~7 modules. We have three production runtimes behind a shared conformance suite, session management, permissions, task scheduling, and a marketplace.

---

## Part 3 — The design space

### Requirements restated

1. An install can be a **community server** → a coordinating service at a URL
2. Each login is a **member** → real multi-user auth
3. One person joins **many communities** → identity must not be minted solely by the community
4. **Agents are members** → agent identity distinct from its owner's credentials
5. **Group chats** with people and agents → channels with membership and a shared ordered log

### Four approaches

**A. Server-issued accounts (Zulip / Mattermost / Revolt).** Simplest possible thing; Better Auth already does it. Satisfies only the weak reading of requirement 3 — agents need N enrollments, reputation doesn't travel. A fine stepping stone, a dead end as the architecture.

**B. Portable identity + authoritative-per-community server (Buzz model) — recommended.** A community is one server at one URL, authoritative for its own roster, channels, and log. Your client holds N live connections. Requirements 3 and 4 fall out. Cost is key management, which Part 4 addresses.

**C. Federation (Matrix).** The most powerful answer; state resolution over a room DAG is the cost. Wildly disproportionate to a pre-launch alpha, and **Block — with far more resources — explicitly chose not to build it.** No.

**D. Relay-of-relays / gossip.** Inherits every hard distributed-systems problem with no spec to lean on. Note that `buzz-relay-mesh` is _not_ this — it's a QUIC mesh between _replicas of one relay_, and even that has a central arbiter ("mesh membership is a hint; the Redis fenced generation is the arbiter"). No.

### The recommendation

**Approach B**, concretely:

- **Community** = an `apps/community` deployment at one URL. Owns its roster, channels, and event log. Single source of truth for itself.
- **Member** = an identity with a roster entry. The same identity can be a member of many communities; nothing is shared between them.
- **Agent** = its own identity plus an owner attestation. Admitted because its owner is admitted; revoked when its owner is revoked; permissioned on its _own_ identity.
- **Channel** = an ordered, append-only event log with a membership list. Group chats are channels containing humans and agents.
- **Cross-community agent work** rides the existing **A2A gateway**, not a new federation protocol.

---

## Part 4 — Identity: email, keypairs, and what each is actually for

The framing that resolves this: **email and keypairs are not competing answers to one question.** A keypair is a _credential_ — it authenticates, signs, and delegates. An email is an _account handle and a recovery channel_. The failure mode isn't picking wrong, it's conflating them.

### Honest scorecard

|                             | Email + magic link                                                                                  | Keypair                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Auth strength               | Weak. Mailbox takeover = full account takeover. Phishable. Depends on a provider you don't control. | Strong. No shared secret in transit, nothing to phish.                         |
| **Recovery**                | **Excellent — its entire job**                                                                      | **None. Lose the key, lose the identity.**                                     |
| Portable across communities | Needs a trusted identity provider                                                                   | Free                                                                           |
| Works offline               | No — needs a live round trip                                                                        | Yes: sign now, verify later                                                    |
| Attribution                 | "The server says it was Ikechi"                                                                     | "Here is Ikechi's signature" — verifiable by anyone, later, without the server |
| Delegation to agents        | Nothing native (invent scoped tokens)                                                               | Native and elegant                                                             |
| UX                          | Everyone understands it                                                                             | Needs hiding                                                                   |

**Passkeys are keypairs.** Every Touch ID login is a signature. Nobody calls it web3 because the key is invisible. That is the whole trick.

### Split requirement 3 before choosing

- **Weak reading:** _my client holds connections to several communities at once._ A client feature. Needs no shared identity. **This is literally what Slack ships**, and it feels seamless because of the central login layer, not because accounts are unified.
- **Strong reading:** _the Dorian in community A is provably the same as in community B._ Needs portable keys or a shared IdP.

**The weak reading is ~95% of the felt value and ~5% of the complexity.** Ship it. The corner to avoid is cheap: **key the roster row on an opaque, stable identity string from day one** — not an email, not a community-local integer. Promoting to portable identity later becomes a data migration, not a rewrite.

### What to build

**Auth is boring and email-shaped.** Better Auth already does this. Note the current local instance is `email + password`, plugins `[apiKey()]`, and its docstring says _"email is an identifier only — never verified, no SMTP."_

**Use signed invite links, not magic links, for v1.** If every community server needs SMTP configured, running a community gets meaningfully harder for exactly our target users. Instead: the owner generates an invite URL and sends it however they like — Telegram, iMessage, Signal. Clicking it in a DorkOS install enrolls you. **Zero email infrastructure to ship phase 1.** Email becomes an optional recovery channel set after you're in.

Enrollment UX largely exists already: `apps/site/src/lib/auth.ts` runs **RFC 8628 device authorization** — request a code, human approves at `/activate`, instance polls for the token. That generalizes to "approve this device for this community" and "approve this agent."

**Sign messages even though you don't authenticate with keys.** Auth stays session-cookie boring. But every message committed to a channel log carries a signature from a device-local key, generated silently and stored `0600` under the dork home — the precedent and code path already exist for the Better Auth secret.

Why it earns its keep:

- **Once anyone can run a community, the operator isn't always you.** If Ikechi hosts and I post there, a signature means his server can't fabricate messages from me.
- Agent actions in shared channels get attribution that survives the server.
- **Additive and reversible.** Signing is low-risk; key-based _auth_ is the risky half. Doing the safe half now lets the key be promoted from "attribution" to "authentication" later without a migration.

**Recovery is email, and the cost gets said out loud.** Lost every device? Magic link, new device key, old keys revoked. The honest cost: **the mail provider joins the trust boundary.** So make it a per-community policy switch — _allow email recovery_ vs _keys only, no recovery_. A hobby community turns it on; a community running production infra turns it off. Don't claim it's as strong as keys; let the operator choose.

**Power users bring their own key.** Kai and Priya skip email entirely. The escape hatch preserves sovereignty without imposing it on Ikechi.

**DorkOS cloud is one optional identity provider, never the authority.** If every community authenticates through dorkos.ai, every community depends on our uptime and good behavior — which contradicts requirement 1. Cloud is a provider a community _may_ choose to trust. Easy mode for those who want it, sovereignty intact for those who don't.

### What `specs/agent-trust` already gets right

Decision 3 — "a per-agent scoped token minted by DorkOS, delivered through the runtime env seam, attributing Activity events" — **is the email-world version of NIP-AA.** Same shape: the agent acts as itself, derived from its owner, revocable with its owner. Ours is server-authoritative rather than self-verifying, which is a real but acceptable weakening.

So keypairs aren't needed for requirement 4. What's needed is that spec landing, plus one thing it currently defers: **an agent connecting to a _remote_ community can't ride its owner's local session cookie.** That's the seam where the token must become presentable to a server we don't run — and the natural place to shape the envelope so it could carry a signature later.

---

## Part 5 — Deployment shape and scaling

### Three things that were being conflated

1. **The capability** — the code _can_ run community mode. Keep this.
2. **The default posture** — every install exposes itself. **No.**
3. **The production deployment shape** — where it actually runs. This is the real question.

### The case against "every install is a server"

**Security is decisive.** The cockpit process spawns agents with filesystem access. Making _that process_ internet-facing is the highest-risk move in the design — one route-gating bug is remote code execution on a user's laptop. Not hypothetical: `session-gate.ts` already carries a comment about lowercasing the path _before_ the gate check "because Express routes case-insensitively." Exactly that bug class, already encountered once.

**Availability.** Laptops sleep. A community whose server sleeps is broken, and users blame DorkOS.

**Ops and support.** Backups, disk, TLS, DNS. Every user who flips the switch becomes a support case.

### The scaling ceiling — measured, not guessed

| Component                                           | Actual behavior                                                                                                                    | Ceiling                                                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **SQLite**                                          | WAL, `synchronous=NORMAL`, `busy_timeout=5000` — correctly configured                                                              | Not the constraint. Thousands of small writes/sec; a 100-person community peaks at ~1–5 msg/sec           |
| **Maildir** (`packages/relay/src/maildir-store.ts`) | Drain-style work queue — `complete()` unlinks. Bounded at `maxMailboxSize: 1000`/endpoint; depth read from SQLite, never `readdir` | Not depth. **O(members) file writes and O(members) chokidar watchers per message** — see below            |
| **Node, single process**                            | One core for JS; fan-out is CPU work; one SSE connection per member                                                                | **~1,000 concurrent members.** Past that: clustering → cross-process pub/sub → Redis → we've rebuilt Buzz |

#### On the Maildir — a corrected reading

An earlier draft claimed the Maildir would accumulate ~864k files/day at chat rate. **That was wrong**, and the code disproves it: `complete()` unlinks, so the Maildir is a drain-style work queue and the archive is `sqlite-index.ts`. Steady-state depth is _arrival rate × processing latency_, not _arrival rate × time_.

It is also better hardened than that draft credited, and matches what large mail systems consider mandatory:

| Mail-system technique                                                                                                                            | Our status                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| **Queue ≠ store; cap the queue.** Postfix bounds its `active` queue (`qmgr_message_active_limit`, default 20000) so scans and state stay bounded | **Have it** — `checkBackpressure` rejects at `maxMailboxSize: 1000` per endpoint     |
| **Never enumerate; keep an index.** Dovecot's `dovecot.index` / `.index.cache` answer queries; the maildir is only the store                     | **Have it** — `sqliteIndex.countNewByEndpoint()` is on the delivery hot path         |
| **Shard so no directory grows huge.** Postfix's `hash_queue_depth` nests `deferred/`; providers shard mailboxes across hosts                     | Sharded by endpoint hash; directory hashing unnecessary while the 1000 cap holds     |
| **Change format when per-file overhead dominates.** Dovecot built **mdbox** (many messages per file) because Maildir costs too much at volume    | The mail world's own verdict that this substrate has a ceiling                       |
| **Batch fan-out; never one copy per recipient.** A 50k-subscriber list writes one queue entry with many recipients, expanded at delivery         | **This is the one we don't do** — `deliverToEndpoint` writes one file _per endpoint_ |

The GC is correspondingly complete: TTL expiry, dead-letter retention purge, crash recovery re-driving stranded `cur/` messages (gated on claim ctime, not envelope age), and orphan directory reaping that never reaps persistent `relay.inbox.*` mailboxes.

> **Decision 4, with the correct reasoning:** community chat must **not** ride the Maildir — because of **write-time fan-out**, not accumulation. One file per endpoint per message is O(members), and one chokidar watcher per endpoint is O(members) against Linux's inotify watch limit (this repo already has EMFILE as a known failure mode). A channel wants one stored copy with fan-out at _read_ time, which is exactly what the durable event log (`event-log.ts`, `ring-buffer.ts`, `session-event-store.ts`) already does. Maildir stays the agent coordination bus, where its cardinality is right.

Optional cheap hardenings, neither urgent: `newestActivityMs()` `stat`s every file across all four subdirs per endpoint on the orphan-reaping sweep (the documented dir-mtime fallback would remove the scan), and a watcher-count metric is useful insurance on Linux.

**Net: fine to ~1,000 concurrent members, cliff after that.** Team-scale and company-scale, not Discord-scale. That's a positioning choice to state deliberately, not a defect to discover.

### `apps/community` as its own app

Not a config toggle on the cockpit.

- Shares `packages/shared` and the event-stream contract. One implementation, no drift.
- Contains **no runtimes, no Mesh scanning, no harness sync, no marketplace installs, no workspace management**. It structurally _cannot_ spawn an agent — by construction, not configuration.
- Ships as a Docker image for a small VPS. That's the documented, recommended path.
- Also deploys to Vercel + Neon as a one-click path (see below), which **replaces** the earlier laptop-as-server idea rather than complementing it.

Note the convergence: the security argument, the single-player invariant (Part 8), and serverless viability (below) all point at the _same_ structure. Three independent lines of reasoning agreeing is usually the right sign.

### Serverless as a first-class target (Vercel + Neon)

Verified against current platform capabilities, not recalled:

- **Fluid Compute** is the default execution model — 300s max duration on every plan, 800s on Pro/Enterprise. An SSE stream can be held 5–13 minutes.
- **Active CPU pricing** bills only while the CPU works; idle/await time bills at a much lower rate, and optimized concurrency packs many invocations onto one instance. A mostly-waiting SSE connection is now the _cheap_ case, reversing the classic serverless objection to held connections.
- **Streaming is zero-config** on the Node.js runtime (`ReadableStream` + `text/event-stream`). Edge is out — 25s hard cap, not configurable. WebSockets are still not the path; SSE is, which is already what we use.
- **Vercel Cron** covers the GC sweep.

**Fan-out is the only hard part.** Alice's POST lands on one instance; Bob's stream lives on another, with no shared memory. Options: each held stream polls Postgres since its cursor (50 members at 1s polling ≈ 50 indexed queries/sec on Neon — trivial, ~1s latency, no third party); external pub/sub (lower latency, adds a dependency that cuts against sovereignty); or `LISTEN/NOTIFY` (needs persistent TCP, fights serverless connection limits — skip). **Polling wins**, and it is the third implementation behind Decision 3's seam.

**Does it need local files? No** — provided Decisions 1, 4, and 13 hold.

| State                                    | Destination                                                              | Serverless-safe              |
| ---------------------------------------- | ------------------------------------------------------------------------ | ---------------------------- |
| Messages, channels, roster, memberships  | Postgres                                                                 | Yes                          |
| Sessions, invites, API keys              | Postgres (Better Auth pg adapter)                                        | Yes                          |
| Session-signing secret                   | `BETTER_AUTH_SECRET` env var — checked _before_ the `0600` file fallback | Yes, set the env var         |
| Channel event log                        | Postgres (Decision 4)                                                    | Yes                          |
| Maildir, chokidar watchers, SQLite `.db` | Not present (Decisions 2 and 4)                                          | N/A                          |
| **File attachments / avatars**           | **The one genuine gap**                                                  | **Needs a `BlobStore` seam** |

Uploads today write to `{cwd}/.dork/.temp/uploads/` — workspace-relative and filesystem-bound, exactly what `apps/community` must not inherit. The fix is a `BlobStore` interface: `FilesystemBlobStore` (VPS) and `VercelBlobStore`/`S3BlobStore` (serverless). Buzz hit the same wall and solved it identically (`buzz-media` over Blossom/S3, MinIO in dev). `/tmp` is writable on Vercel and fine for transient upload processing, never durable state.

**The pattern is already proven in-repo:** `apps/site` runs on Vercel + Neon today and never writes a file — its only `node:fs` calls are build-time reads (install.sh, blog markdown, OG fonts).

**Remaining work item:** the rate limiter, circuit breaker, and backpressure counters currently live in process memory. On serverless they need Postgres backing or per-instance approximation. Cheap to design in now, annoying to retrofit — which is the whole reason Decision 12 is recorded rather than deferred.

**Honest cons:** ~1s message latency instead of instant; a reconnect every few minutes (free and gap-free, since the stream contract already resumes on `Last-Event-ID`); harder debugging with no persistent process; less predictable cost than a fixed VPS, though Active CPU pricing narrows the gap. None of it constrains the Docker path — the same code runs on both.

### Datastore and infrastructure

**Postgres from the first commit.** The migration cost is zero now and painful at any later point. Specific wins: concurrent writers, horizontal headroom, `tsvector` + GIN full-text search (exactly what Buzz uses, including their trick of excluding privacy-sensitive kinds at the storage level so they're structurally unsearchable), and row-level security available as a fail-closed backstop if multi-tenancy ever happens.

**Caveat on "our ORM supports it":** true, but Drizzle has _separate dialect builders_ and schemas aren't portable. The repo already demonstrates the split — `packages/db` → `drizzle-orm/better-sqlite3`; `apps/site/src/db/*` → `drizzle-orm/pg-core` + `neon-http`. So `apps/community/src/db/` gets written in `pg-core` from the start, mirroring `apps/site`.

**Useful precedent:** `apps/site/src/db/auth-schema.ts` is already Better Auth's tables in `pg-core`. The hardest schema to port is done and in-repo.

For dev/test/CI, **PGlite** (`drizzle-orm/pglite`) gives real Postgres dialect embedded in-process — same schema, no container. Ship `docker-compose` with actual Postgres for the standard deployment path.

| Buzz uses      | Us?                      | Why                                                                                            |
| -------------- | ------------------------ | ---------------------------------------------------------------------------------------------- |
| **Postgres**   | **Yes, day one**         | Above                                                                                          |
| **Redis**      | **No — design the seam** | Only needed for cross-_process_ fan-out, and that threshold is the same as going multi-process |
| **S3/MinIO**   | No                       | Filesystem until uploads are real; keep storage behind an interface                            |
| **Prometheus** | Whenever convenient      | A `/metrics` endpoint is nearly free                                                           |
| **Keycloak**   | No                       | Their dev SSO harness. We have Better Auth.                                                    |

On Redis, the lesson isn't "use Redis" — it's **the seam**. From `buzz-relay-mesh`:

> The seams are what keep single-instance deployments and same-pod sessions mesh-free: when `BUZZ_MESH=off` or no peers exist, the relay never constructs a mesh and the in-process fast path is untouched.

Put fan-out behind an interface with an in-process implementation. Adding Redis later is one new implementation, not a refactor. Presence and typing are a `Map` with TTL in one process; what's worth copying _now_ is keeping ephemeral signals out of storage, audit, and search entirely — which `SignalEmitter` already models.

---

## Part 6 — `CommunityConnector`: the Buzz integration and our own client are one interface

### Why a normal adapter won't do

Confirmed in the code: a binding is `{ adapterId, agentId, chatId?, channelType? }` — **one adapter, one agent.** `BaseRelayAdapter` is a message pipe: `_start(relay)`, `_stop()`, `deliver()`, plus a subject prefix. It projects one agent into a foreign chat surface and knows nothing about who else is in the room.

Buzz needs five things that shape lacks:

1. **Cardinality** — a human plus N agents join, not one agent
2. **Directory sync** — pull the channel list and member roster, not just receive messages
3. **Per-identity keystore** — every agent needs its own keypair, because Buzz members _are_ pubkeys
4. **Subscription semantics** — long-lived WebSocket with `REQ` filters, `EOSE`, resumable cursors — not a webhook
5. **Addressing** — subjects for remote channels and members, e.g. `relay.community.buzz.{relayId}.channel.{id}`

### The reframe

**A Buzz connector and our own community client are the same interface.** Both are: connect to a remote community, sync roster and channels, project my members into it, route messages both ways.

```
CommunityConnector
  connect(credentials)                 → session
  listChannels()                       → Channel[]
  listMembers()                        → Member[]
  subscribe(channelId, sinceCursor)    → AsyncIterable<CommunityEvent>
  post(channelId, message, asIdentity) → messageId
  identities()                         → my members projected here (human + agents)
```

`BuzzConnector` speaks NIP-29/42 over WebSocket. `DorkOSConnector` speaks ours. **Same client UI over both.**

This is the third use of an established repo pattern — `Transport` (HTTP vs Direct) and `AgentRuntime` (claude-code / codex / opencode) are the first two. `runtimeConformance` in `@dorkos/test-utils` is the model for a `communityConformance` suite both connectors must pass.

**The real payoff: we design and prove our community protocol against someone else's already-running, already-debugged server before writing our own.** If the interface drives Buzz cleanly, it's a good interface. If it can't, we learned that for the cost of a connector rather than a server.

### Strategic notes

Buzz explicitly wants third-party clients — `NOSTR.md` is titled _"Using Third-Party Nostr Clients with Buzz"_ and documents connection, group discovery, membership, sending, threading, and DMs. And **DorkOS-as-agent-harness is strictly better than `buzz-acp`**: "point DorkOS at your Buzz community and your Claude Code, Codex, and OpenCode agents become Buzz members" is a genuinely stronger offering than what ships in their repo, and it makes us complementary rather than competitive.

What it must not become is the foundation:

- Buzz is days old at 0.x, with 24 migrations already and a `preview-features.json`.
- **It requires keypairs** — the exact friction we're designing around. The Buzz path serves Kai and Priya, never Ikechi.
- A meaningful part of the protocol is private NIPs, not standard ones.
- Market perception: DorkOS becomes a feature of Buzz rather than the reverse.

**Keep the existing adapters exactly as they are.** "One agent into Telegram" is a different, still-valuable use case. `RelayAdapter` and `CommunityConnector` are different abstractions that happen to both move messages — don't merge them.

---

## Part 7 — How DorkOS's existing pieces map on

**Session event stream.** `GET /api/sessions/:id/events` is snapshot → gap-free replay via `Last-Event-ID` → live with monotonic `seq`. That is precisely the channel-stream contract, and the same one Zulip's event queue and Buzz's `REQ`→`EOSE`→fan-out provide. **A channel is a session-shaped stream with a membership list instead of an owner.** `collectDurableEvents` and the SSE integration test patterns transfer directly.

**Relay (`packages/relay`).** Transfers cleanly: the Maildir + SQLite index + DLQ as a durable **outbox** (a member's install queues when a community is unreachable — Buzz clients just fail); the **budget envelope** as a better agent-loop guard than Buzz's; rate limiter, circuit breaker, and backpressure, all of which are Buzz's admitted gaps; the DOR-277 **initiate-consent gate**, which should be extended to community channels rather than duplicated. `ChannelTypeSchema` already enumerates `dm | group | channel | thread` — the vocabulary exists, the entity doesn't.

The gap needing care: the subject scheme has no community dimension. Adding `relay.community.{id}.*` puts tenancy in a **client-assertable string** — the confused-deputy hazard Buzz spent a formal spec closing. Prefer one `RelayCore` per community connection with the community bound at construction; if a subject segment is used anyway, tenancy must still resolve from the authenticated connection and the subject checked for _agreement_, never trusted.

**Mesh (`packages/mesh`).** Discovers agents by filesystem path — answers "what agents exist on this machine." A roster answers "which identities may act here." Different questions, different key spaces; keep them separate and bridge them. `relay-bridge.ts` and `namespace-resolver.ts` are the seam. Mesh's `CrossNamespaceRule` + denial list is already a permission model for agent-to-agent reach and generalizes to cross-community reach. DorkBot's `isSystem: true` protection is the existing precedent for structurally special members — community owners need the same.

**Pulse / Tasks.** Once agents post into shared channels, **every scheduled run needs an attributable actor and a quota**, or a misconfigured 5-minute job becomes a community-wide spam source. This is the concrete case for owner-scoped rate aggregation. `flow-drain-pulse-seat.integration.test.ts` suggests a seat/concurrency concept already exists — the right hook.

**Better Auth.** The schema is multi-user-capable; one hook (`databaseHooks.user.create.before`) and the exposure guard need to change. Keep `verifyRequestAuth` as the **single** credential resolver — add signed-challenge auth as a third path _inside_ it, never a second resolver. The exposure guard's both-facts rule (`authEnabled && hasUsers`) is exactly the gate for entering community mode.

**A2A gateway.** Already generates Agent Cards from Mesh, bridges onto Relay, persists task state, serves `/.well-known/agent-card.json`. The standards-based cross-community agent path — use it instead of inventing federation.

**Harness / marketplace.** `@dorkos/harness` projects `.agents/` and plugins into every agent harness. A community distributing shared skills, workflows, and conventions through it is a genuine differentiator Buzz has no equivalent for. The marketplace's file-scoped, git-free install transaction is the right shape for community-pushed content.

---

## Part 8 — The single-player invariant

**DorkOS solo is the product. Multiplayer is a layer on top of something that already stands alone.** Enforced, not merely intended:

- **The dependency arrow points one way: community → core, never core → community.** Same discipline as the FSD layer rule, enforceable the same way.
- Making `apps/community` a separate app enforces it **by construction** — the cockpit cannot import community code.
- No "sign in to continue" ever appears for a solo user. Absent a community, nothing degrades.

This is also a positioning asset. **Buzz has no single-player mode** — a relay with one member is a chat server with one person in it. Worth stating in `meta/positioning-202607/`.

---

## Part 9 — Robustness checklist

Ordered by how badly it hurts to get wrong.

1. **Resolve tenancy from the connection, never the payload.** Unknown host → fail closed, never a default. A client-supplied channel id must _agree_ with the connection's community. Getting this wrong is a cross-community data leak.
2. **Publish events only after the DB transaction commits** (Zulip's `send_event_on_commit`). Otherwise a rolled-back write has already been fanned out and cannot be un-sent.
3. **Composite uniqueness including the community id.** Otherwise a content-addressed event id becomes a cross-community existence oracle.
4. **Sanitize the error surface.** A fixed alphabet of error codes on tenant-scoped paths; raw DB errors leak constraint and column names.
5. **Check access before subscribing, not after.** Closes the window where live fan-out reaches a non-member.
6. **Never deliver channel-scoped events to unscoped subscriptions.** A security boundary, not an optimization.
7. **Idempotent writes end to end.** Content-addressed ids + `ON CONFLICT DO NOTHING`, plus the `clientMessageId` echo reconciliation already used for sessions.
8. **Offline-first by default.** Maildir + DLQ + circuit breaker as the outbox. A community being down degrades to "queued," never "lost."
9. **Agent loop prevention with teeth.** The budget envelope plus Buzz's exclusion rule (agent-generated events must not re-trigger the automation that produced them).
10. **Owner-scoped quota aggregation.** Cap by owner across all their agents, not per agent identity.
11. **Slow-client handling.** Bounded per-connection send buffers with a grace counter, then disconnect.
12. **Per-community audit chains, never a global one.** A shared chain leaks activity volume across tenants and couples their integrity.
13. **Ephemeral vs. persistent split.** Typing, presence, and progress skip storage, audit, and search entirely.
14. **Membership revocation is not retroactive.** Buzz declares this explicitly — revoking removes _current_ capability, it does not relabel prior writes. Decide and document rather than discover.

---

## Part 10 — Staging

**Phase 0 — Buzz spike (decided 2026-07-25).** A **throwaway script**, not a shipped connector: connect to a live Buzz relay, join a channel, post a message, subscribe to replies. Days, not a phase. Its only deliverable is knowledge of what `CommunityConnector` actually needs — resumption semantics, roster sync, error surfaces — learned against a running server instead of a whiteboard. Deliberately _not_ a product feature, so no keypair-management work gets committed for a path that doesn't serve Ikechi. Design `CommunityConnector` from what the spike teaches, then proceed to Phase 1.

**Phase 1 — Multi-user on one install.** Invite-based registration (flip the Better Auth hook), member list, per-user sessions and workspaces. Roster keyed on an opaque portable identity from day one so phase 4 isn't a migration.

**Phase 2 — Channels.** A channel entity with membership, riding the durable event-stream contract. Humans only. Get ordering, resume, and read state right before adding agents.

**Phase 3 — Agents as members.** Agent identity + owner attestation. `@mention` triggers a turn; the reply posts back. **At most one prompt in flight per channel**, with subsequent mentions queued and batched — without that, a busy channel spawns unbounded concurrent turns.

**Phase 4 — `apps/community` standalone.** Postgres, Docker image, connection-bound tenancy, signed invite enrollment. `DorkOSConnector` implements the same interface phase 0 defined.

**Phase 5 — Multi-community client.** N live connections, per-community identity display, unified inbox, independent per-community outbox retry. Cross-community agent work over A2A.

---

## Open questions

1. **Where do keys live?** OS keychain (no current usage in desktop/CLI), `~/.dork/` at `0600` (precedent exists for the Better Auth secret), or cloud escrow? Recovery is a product decision, not a technical one.
2. **Does a member's install have to be running to receive messages?** No, if community state is authoritative on the community server — which is the right answer, but means a community server is real infrastructure someone runs.
3. **Are agents addressable across communities, or only within?** A2A says across. Bigger surface than it sounds.
4. **What does an agent see?** NIP-AA is explicit that agents don't inherit their owner's channel memberships. Agreeing up front avoids a nasty retrofit.
5. **Does the marketplace become community-scoped?** Communities distributing skills and agents via the harness is a real differentiator, and it changes the marketplace's trust model.
6. **Do we ever want E2E encryption?** It makes email recovery genuinely impossible. Buzz uses gift-wrapped DMs for a reason. Separate decision; not v1.

---

## Sources

**Code fetched via `opensrc` (cached under `~/.opensrc/repos/`):**

- `block/buzz` — Apache-2.0. Read: `ARCHITECTURE.md`, `VISION_SOVEREIGN.md`, `VISION_AGENT.md`, `VISION_MESH.md`, `NOSTR.md`, `README.md`, `docs/multi-tenant-relay.md`, `docs/nips/NIP-AA.md`, crate layout, migrations, `deploy/charts/`, `Dockerfile`, `docker-compose.yml`, `buzz-relay-mesh/src/lib.rs`
- `nostr-protocol/nips` — README (NIP definition), NIP-01, NIP-29, NIP-42, NIP-98
- `matrix-org/matrix-spec` — `server-server-api.md`, `application-service-api.md`
- `element-hq/synapse`, `zulip/zulip`, `mattermost/mattermost`, `revoltchat/backend`

**DorkOS files referenced:** `packages/relay/src/{maildir-store,relay-core,base-adapter,rate-limiter,circuit-breaker,backpressure}.ts`, `packages/db/src/index.ts`, `packages/shared/src/{relay-envelope-schemas,relay-adapter-schemas,mesh-schemas}.ts`, `apps/server/src/services/core/auth/`, `apps/server/src/services/relay/`, `apps/server/src/services/session/`, `apps/site/src/db/`, `apps/site/src/lib/auth.ts`, `contributing/{architecture,authentication}.md`, `specs/agent-trust/`

**Press:**

- [TechCrunch — Jack Dorsey is taking on Slack with Buzz](https://techcrunch.com/2026/07/21/jack-dorsey-is-taking-on-slack-with-buzz-a-group-chat-platform-for-teams-and-their-ai-agents/)
- [Decrypt — Block Launches Buzz, a Nostr-Based Slack and GitHub Rival for AI Agents](https://decrypt.co/374026/jack-dorseys-block-launches-buzz-a-nostr-based-slack-and-github-rival-for-ai-agents)
- [TheNextWeb — Block takes on Slack with Buzz](https://thenextweb.com/news/block-buzz-humans-ai-agents-workspace)
- [GitHub — block/buzz](https://github.com/block/buzz)
