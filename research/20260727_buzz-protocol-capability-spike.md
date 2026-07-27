---
title: 'Buzz Protocol Capability Spike — can a read-only CommunityAdapter be built against block/buzz?'
date: 2026-07-27
type: external-source-review
status: active
tags: [buzz, nostr, nip-29, nip-42, community-adapter, rooms, multi-user, capability-flags]
feature_slug: community-adapter
---

# Buzz Protocol Capability Spike

- **Date:** 2026-07-27
- **Status:** active
- **Question:** Can we build a READ-ONLY `CommunityAdapter` against Block's Buzz relay, and what in Buzz's model refuses to map onto our room model (`packages/db/src/schema/rooms.ts`) — i.e. what must become a `CommunityCapabilities` flag?
- **Method:** Source review only. No running relay was stood up; every claim below is cited to a file and line in the Buzz checkout.
- **Anchoring commit:** `654f384906b5c720a60a199d85031a6f1cb6efc9` — `fix(desktop): read the newest pair-scoped harness log (#3134)`, 2026-07-27 11:45:03 -0400, `github.com/block/buzz`, branch `main`, Apache-2.0.
- **How it was obtained:** `opensrc` still had `~/.opensrc/repos/github.com/block/buzz/main` on disk (fetched 2026-07-24), but opensrc strips `.git`, so there is no SHA to anchor to. I ran a fresh `git clone --depth 1 https://github.com/block/buzz.git` into a scratch dir and **read exclusively from the clone**. All citations below are paths relative to that clone's root.

> **Citation discipline.** This spike was written under an explicit rule: never assert "Buzz does X" from knowledge of Nostr. Every Buzz behavioural claim carries a `file:line`. Where a `.md` in the Buzz repo asserts something I could not confirm in Rust, it is labelled **[doc-only]**. Where I could not determine something at all, it says so.

---

## Executive summary

**A read-only Buzz adapter is buildable, but not anonymously.** The single decisive fact is `crates/buzz-relay/src/handlers/req.rs:44-87`: `handle_req` matches on the connection's `AuthState`, and every arm that is not `Authenticated(ctx)` sends `CLOSED` with `auth-required: not authenticated` and returns. There is no config flag, no public-channel carve-out, and no anonymous variant in the `AuthState` enum (`crates/buzz-relay/src/connection.rs:37-47`) — the states are `Pending`, `Authenticated`, `Failed`. **A client with no keypair cannot receive a single message.**

The minimum credential is a **self-generated secp256k1 keypair** — nothing more, on a default-configured relay. Both gates that could reject an unknown pubkey default to off: `pubkey_allowlist_enabled` (`crates/buzz-relay/src/config.rs:479-481`) and `require_relay_membership` (`crates/buzz-relay/src/config.rs:483-485`). And an authenticated pubkey gets read access to **every `open` channel without joining it**, by SQL union (`crates/buzz-db/src/channel.rs:746-773`). So: generate a throwaway key, complete NIP-42, and you can read the whole open surface of a default relay.

The room primitive is **NIP-29 relay-based groups, not NIP-28 public chat**. Kind 41 is defined but explicitly dead (`crates/buzz-core/src/kind.rs:53-54`, "Not used by Buzz today"); NIP-28's kinds 40 and 42 appear nowhere in the crates; and `SUPPORTED_NIPS` omits 28 while including 29 (`crates/buzz-relay/src/nip11.rs:15`).

The mismatches that will shape our interface are, in order of how much they hurt: **history has no monotonic sequence** (Nostr filters page by wall-clock `created_at`, so our `seq`-keyed cursor has no counterpart on the WS path); **threads are arbitrarily deep** where ours are one level, enforced; **read cursors are client-side and end-to-end encrypted**, so a server-side unread count is structurally impossible; and **channel identity is a UUID with a mutable name**, where ours is a slug with a partial-unique index.

---

## 1. What Buzz adds over base NIP-01

Buzz is a NIP-01 relay in the same sense that a Kubernetes node is a Linux box. The workspace is 26 crates (`Cargo.toml:1-31`). The ten requested:

| Crate                 | What it actually implements                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`buzz-relay`**      | The server binary. Axum WS + HTTP; NIP-01 command handlers in `handlers/` (one module per verb: `auth`, `req`, `event`, `close`, `count`, `ingest`, `side_effects`, plus moderation/NIP-IA/NIP-43/push modules — `crates/buzz-relay/src/handlers/mod.rs:1-36`); a REST surface (`crates/buzz-relay/src/api/mod.rs:1-13`); multi-tenant community resolution from the HTTP Host; huddle audio relay (`crates/buzz-relay/src/audio/`); workflow cron; NIP-PL push worker. Also runs a **runtime conformance tracer** that emits traces checked against a TLA+ spec (`docs/spec/MultiTenantRelay.tla`).                |
| **`buzz-auth`**       | NIP-42 (WS, kind:22242) and NIP-98 (HTTP, kind:27235) — _only_. Its own doc: "No JWT validation, no token management, no IdP runtime dependency" (`crates/buzz-auth/src/lib.rs:97-98`). Also `Scope` (16 permission variants, `crates/buzz-auth/src/scope.rs:16-61`) and a `ChannelAccessChecker` trait so auth can gate on membership without depending on the DB crate.                                                                                                                                                                                                                                           |
| **`buzz-acp`**        | The **Agent Client Protocol** harness — a standalone binary that is a Nostr client on one side (NIP-01/NIP-42 over WS) and an ACP JSON-RPC-over-stdio driver of an AI-agent subprocess on the other, translating channel events into agent prompts and agent output back into signed events (`crates/buzz-acp/src/acp.rs:1-9`, `crates/buzz-acp/src/relay.rs:1-6`). Carries an agent pool, per-channel event queues, evalexpr subscription filters, and NIP-AE "engram" memory injection. **This is the crate most directly analogous to what DorkOS is doing**, and it is a _client_ of the relay, not part of it. |
| **`buzz-core`**       | Zero-I/O shared types: the authoritative kind registry (`crates/buzz-core/src/kind.rs`, 126 `KIND_*` constants), NIP-01 filter matching, `StoredEvent`, `TenantContext` (a multi-tenant fence type deliberately given no `Deserialize` so a community can never be parsed from client input — `crates/buzz-core/src/tenant.rs:68-76`), channel/role enums, NIP-AE engram crypto.                                                                                                                                                                                                                                    |
| **`buzz-db`**         | **Postgres** via `sqlx` — events table partitioned by month; one module per persistence area (`channel`, `thread`, `user`, `event`, `moderation`, `relay_members`, `push`, `workflow`, …) (`crates/buzz-db/src/lib.rs:3-53`). Ephemeral kinds (20000–29999) are never stored.                                                                                                                                                                                                                                                                                                                                       |
| **`buzz-pubsub`**     | **Redis** pub/sub for cross-pod fan-out: dynamic ref-counted `SUBSCRIBE` on `buzz:{community}:channel:{id}` topics into a `broadcast::channel(4096)` (`crates/buzz-pubsub/src/lib.rs:3-22`). Also presence, rate limiting, NIP-98 replay seen-set, and cross-pod ban propagation.                                                                                                                                                                                                                                                                                                                                   |
| **`buzz-search`**     | Query-only wrapper over **Postgres FTS** — the index is a `GENERATED ALWAYS AS (to_tsvector(...)) STORED` column on `events` with a GIN index, so "every row write _is_ the index update" (`crates/buzz-search/src/lib.rs:3-15`). It re-fetches canonical events through `buzz-db` and re-runs access checks per hit: "search is never the access boundary." The NIP-50 wire binding lives in the relay, not here (`crates/buzz-relay/src/handlers/req.rs:211-232`).                                                                                                                                                |
| **`buzz-audit`**      | A **per-community** SHA-256 hash chain over admin/moderation actions, keyed `(community_id, seq)`, with `community_id` folded into the hash so a row cannot be lifted between tenants; serialized by per-community Postgres advisory lock (`crates/buzz-audit/src/lib.rs:3-18`). Explicitly the audit half of the TLA+ non-interference property.                                                                                                                                                                                                                                                                   |
| **`buzz-workflow`**   | Channel-scoped automations: sequential steps, variable substitution, conditions, execution traces. Triggers are `MessagePosted` (kind 9), `ReactionAdded` (kind 7), `DiffPosted` (kind 40008), `Schedule` (cron), `Webhook` (`crates/buzz-workflow/src/lib.rs:958-963`), with workflow-execution kinds 46001–46012 excluded from triggering to prevent loops.                                                                                                                                                                                                                                                       |
| **`buzz-relay-mesh`** | **Pod-to-pod, not operator-to-operator.** An iroh/QUIC full mesh between relay pods of _one_ deployment, with scuttlebutt membership gossip and phi-accrual failure detection, so a client on pod A can reach a huddle/tunnel owned by pod B (`crates/buzz-relay-mesh/src/lib.rs:1-19`). **This is not federation.** Default off (`BUZZ_MESH`).                                                                                                                                                                                                                                                                     |

Worth noting for us: `buzz-conformance` replays relay-emitted traces against a TLA+ spec (`crates/buzz-conformance/src/lib.rs:1-36`), and `crates/buzz-core/src/pairing/NIP-AB.spthy` is a Tamarin protocol model. Buzz formally models its multi-tenant isolation. That is a higher bar than our `runtimeConformance`, and it is the same idea.

Buzz has also written **14 of its own NIP drafts** (`docs/nips/`): NIP-AA (agent auth), NIP-AE (agent engrams/memory), NIP-AM (agent turn metrics), NIP-AO (agent observability), NIP-AP (agent personas), NIP-CW (channel window), NIP-DV (DM visibility), NIP-ER (event reminders), NIP-GS (git signing), NIP-IA (identity archival), NIP-OA (owner attestation), NIP-PL (push leases), NIP-RS (read state), NIP-WP (workspace profile). Five of those fourteen are agent-specific. Buzz is building the same product we are.

---

## 2. Is there a channel/room primitive?

**Yes — NIP-29 relay-based groups. Buzz does not implement NIP-28.**

Evidence that NIP-28 is absent, not merely unused:

- `KIND_CHANNEL_METADATA: u32 = 41` is defined with the comment "NIP-01: Channel metadata (replaceable). **Not used by Buzz today.**" (`crates/buzz-core/src/kind.rs:53-54`).
- NIP-28's kind 40 (channel create) and kind 42 (channel message) do not appear as constants anywhere in `crates/`.
- The advertised NIP list is `[1, 2, 10, 11, 16, 17, 23, 25, 29, 33, 38, 42, 50, 56]` (`crates/buzz-relay/src/nip11.rs:15`), plus 43 when membership enforcement is on. 28 is not in it.
- `NOSTR.md:1` states the NIP-28 compatibility proxy was **removed**. **[doc-only]** for the removal itself, but consistent with the code.

### The model

A channel is a **Postgres row with a UUID primary key** (`crates/buzz-db/src/channel.rs`), addressed on the wire by that UUID in an `h` tag. Domain enums (`crates/buzz-core/src/channel.rs`):

- `ChannelVisibility` = `Open` | `Private` (line 22-27) — "Searchable; anyone can join without an invite" vs "Hidden; requires an invite."
- `ChannelType` = `Stream` | `Forum` | `Dm` | `Workflow` (line 59-66). Note **`Dm` is a channel type, not a separate table** — same shape as our `rooms.kind = 'dm'`.
- `MemberRole` = `Owner` | `Admin` | `Member` | `Guest` | `Bot` (line 108-120), with `Bot` explicitly _outside_ the linear hierarchy.

### Event kinds that matter

Messages and channel lifecycle (`crates/buzz-core/src/kind.rs`):

| Kind                          | Constant                                  | Line     |
| ----------------------------- | ----------------------------------------- | -------- |
| 9                             | `KIND_STREAM_MESSAGE` (the message)       | 419      |
| 40002                         | `KIND_STREAM_MESSAGE_V2` (rich content)   | 421      |
| 40003                         | `KIND_STREAM_MESSAGE_EDIT`                | 423      |
| 40099                         | `KIND_SYSTEM_MESSAGE`                     | 437      |
| 9007 / 9008                   | create / delete group                     | 283, 285 |
| 9000 / 9001                   | add / remove user                         | 275, 277 |
| 9002                          | edit metadata                             | 279      |
| 9005                          | admin delete event                        | 281      |
| 9009                          | create invite                             | 287      |
| 9021 / 9022                   | join request / leave                      | 289, 291 |
| 39000 / 39001 / 39002 / 39003 | group metadata / admins / members / roles | 362-368  |
| 39005 / 39006                 | thread-summary / window-bounds overlays   | 375, 379 |
| 20001 / 20002                 | presence / typing (ephemeral)             | 403, 407 |
| 7 / 5                         | reaction / deletion                       | 58, 56   |
| 30078                         | `KIND_READ_STATE` (NIP-RS)                | 75       |

Kinds requiring an `h` channel-scope tag are enumerated at `crates/buzz-relay/src/handlers/ingest.rs:455-484`.

### Enumerating channels

Historical `REQ` for kind 39000. The relay emits 39000/39001/39002 on channel create, metadata change, and membership change (`emit_group_discovery_events`, `crates/buzz-relay/src/handlers/side_effects.rs:999-1108`). The 39000 tag set is unusually rich — a full room-metadata payload:

`d` = channel UUID; `name`; `about` (if non-empty); `public` **or** `private`; `hidden` (DM channels only); `closed` (always); `t` = channel_type; `topic`; `purpose`; **`archived` = "true"** when `archived_at IS NOT NULL`; `ttl` / `ttl_deadline` for ephemeral channels (`side_effects.rs:1011-1058`). For DM channels the participant pubkeys are inlined as `p` tags so a client can render names without a second fetch (`side_effects.rs:1029-1034`).

**Important caveat, and it is a real one:** these discovery events are stored **channel-scoped**, so live global subscriptions (`{"kinds":[39000]}`) will not receive them via fan-out — the fan-out index is keyed by `(channel_id, kind)` and a channel-scoped event only reaches subscriptions registered against that channel (`fan_out_scoped`, `crates/buzz-relay/src/subscription.rs:265-288`). Channel _discovery_ is therefore a **poll**, not a stream. `NOSTR.md:135-137` says the same and calls live push for open-channel discovery "a future enhancement." For an adapter this means `listRooms()` is a periodic REQ; there is no room-created push.

### Subscribing to one channel

`["REQ", "<subid>", {"kinds":[9], "#h":["<channel-uuid>"], "limit":100}]`. The `#h` value is parsed as a UUID and becomes the subscription's channel scope (`crates/buzz-relay/src/handlers/req.rs:110`, `394-407`).

---

## 3. Is there a membership/roster primitive?

**Yes, and it is better developed than I expected.**

**"Who is in this channel"** — `REQ {"kinds":[39002], "#d":["<channel-uuid>"]}`. The relay signs a kind:39002 carrying one `["p", <pubkey-hex>, "", <role>]` tag per member, using the NIP-29 `["p", pubkey, relay_url, role]` convention with an empty relay URL because the canonical relay is the signer (`crates/buzz-relay/src/handlers/side_effects.rs:1092-1107`). Kind:39001 is the same for owners/admins only (`side_effects.rs:1073-1090`).

**Joining.** Three distinct paths:

1. **Self-join, open channels only** — kind:9021. `handle_join_request` fetches the channel and returns `"channel is private — request an invitation"` unless `visibility == "open"` (`crates/buzz-relay/src/handlers/side_effects.rs:1884-1903`); then `add_member(..., MemberRole::Member, ...)`, idempotent.
2. **Add another user** — kind:9000 → `handle_put_user` (`side_effects.rs:1240`).
3. **Leave** — kind:9022 → `handle_leave_request` (`side_effects.rs:1965`, dispatched at `side_effects.rs:165`).

**Invites — this is where the doc and the code disagree, and the code wins.** NIP-29 kind:9009 (create invite) is dispatched to a **no-op that logs a warning**:

```rust
9009 => {
    warn!(kind = kind, "NIP-29 kind 9009 handler deferred to future phase");
    Ok(())
}
```

(`crates/buzz-relay/src/handlers/side_effects.rs:157-163`.) There is **no channel-level invite mechanism.** What does exist is a _relay_-level (community-level) invite over HTTP — `POST /api/invites` to mint, `POST /api/invites/claim` to redeem (`crates/buzz-relay/src/router.rs:95,111`), authz'd to owner/admin (`crates/buzz-relay/src/api/invites.rs:230-242`). That invites someone into the **community**, not into a channel. Channel-level "invite" is really "an admin adds you" (kind:9000).

**Roles and moderation.** Roles are the five-variant `MemberRole` above, persisted per `(channel, pubkey)`. Beyond channel roles there is a full community moderation layer: ban/unban/timeout/untimeout/resolve-report as kinds 9040–9044 (`crates/buzz-core/src/kind.rs:298-310`), NIP-56 reports (kind 1984), and a ban gate that runs **at NIP-42 auth time** — a banned pubkey is denied the connection outright, and a ban on a NIP-OA-proven _owner_ cascades to its agents (`crates/buzz-relay/src/handlers/auth.rs:106-184`).

**Private channels.** Real, and enforced structurally. `get_accessible_channel_ids` unions "channels where I am an active member" with "all open channels" (`crates/buzz-db/src/channel.rs:746-773`); a REQ naming a channel outside that set is closed with `restricted: not a channel member` (`crates/buzz-relay/src/handlers/req.rs:160-171`), and historical rows outside it are filtered per-event (`req.rs:376-381`).

**What does not exist:** channel-level invites (9009 is a stub, above), and kind:39003 group _roles_ — the constant is defined (`crates/buzz-core/src/kind.rs:368`) but I found no emission site in `crates/buzz-relay/`; `NOSTR.md:88` agrees it is "not emitted by the relay."

---

## 4. AUTHENTICATION — the decision-critical question

### Does READ require NIP-42 AUTH? **Yes. Unconditionally.**

`handle_req` reads the connection's auth state before doing anything else:

```rust
let (conn_id, pubkey_bytes, token_channel_ids) = {
    let auth = conn.auth_state.read().await;
    match &*auth {
        AuthState::Authenticated(ctx) => { /* ... */ }
        _ => {
            conn.send(RelayMessage::notice("auth-required: authenticate before subscribing"));
            conn.send(RelayMessage::closed(&sub_id, "auth-required: not authenticated"));
            return;
        }
    }
};
```

(`crates/buzz-relay/src/handlers/req.rs:50-87`.) The `_` arm catches both `Pending` and `Failed`. **There is no condition on this branch** — not channel visibility, not a config flag, not a "public relay" mode.

Corroborating facts:

- **The state machine has no anonymous state.** `enum AuthState { Pending { challenge }, Authenticated(AuthContext), Failed }` (`crates/buzz-relay/src/connection.rs:37-47`).
- **The relay challenges first, unprompted.** On connect it generates a challenge, initialises `AuthState::Pending`, and pushes `["AUTH", "<challenge>"]` before any client frame is read (`crates/buzz-relay/src/connection.rs:157-197`).
- **Unauthenticated connections are reaped.** `AUTH_TIMEOUT` is 5 seconds; a connection not in `Authenticated` by then is cancelled (`crates/buzz-relay/src/connection.rs:27`, `228-249`).
- **COUNT and EVENT are gated identically.** `crates/buzz-relay/src/handlers/count.rs:46`, `crates/buzz-relay/src/handlers/event.rs:649`.
- **The relay advertises it.** NIP-11 `limitation.auth_required = true`, `restricted_writes = true` (`crates/buzz-relay/src/nip11.rs:109-111`).
- **The HTTP bridge is not a back door.** `POST /query` requires NIP-98 — a signed kind:27235 event in `Authorization: Nostr <base64>` (`crates/buzz-relay/src/api/bridge.rs:80-92`). Same keypair requirement, different transport. There is an `X-Pubkey` dev-mode fallback but it is only honoured when `require_auth_token` is false and it is explicitly a dev path (`bridge.rs:58-60`).

**The only unauthenticated read surface on the whole relay** is the NIP-11 document: `GET /` with `Accept: application/nostr+json`, plus `/info`, `/health`, `/_liveness`, `/_readiness` (`crates/buzz-relay/src/router.rs:63-69`, handler `nip11_or_ws_handler` at `router.rs:235-275` performs no auth check). That returns relay metadata — name, supported NIPs, limits — and zero messages.

### Can a client subscribe and receive messages with NO keypair at all?

**No.** Not on any transport, in any configuration.

### So what is the minimum credential?

**A self-generated secp256k1 keypair. Nothing else, on a default-configured relay.**

The NIP-42 verification is pure crypto — "no network calls, no JWT, no tokens" (`crates/buzz-auth/src/lib.rs:114-143`). After it succeeds, three gates run in `handle_auth`, and **two of the three default to permissive**:

1. **Ban gate** — always on, fail-closed, but a fresh key is not banned (`crates/buzz-relay/src/handlers/auth.rs:106-184`).
2. **Pubkey allowlist** — only when `pubkey_allowlist_enabled`, which is `BUZZ_PUBKEY_ALLOWLIST` and **defaults to `false`** (`crates/buzz-relay/src/config.rs:479-481`; gate at `auth.rs:186-214`).
3. **Relay membership** — only when `require_relay_membership`, which is `BUZZ_REQUIRE_RELAY_MEMBERSHIP` and **defaults to `false`**; when false, `check_relay_membership` short-circuits to `MembershipDecision::OpenRelay` and the caller treats it as `Ok` (`crates/buzz-relay/src/config.rs:483-485`; `crates/buzz-relay/src/api/mod.rs:67-69,130-132`).

And once authenticated, an arbitrary pubkey can read **every open channel without joining it** — the accessible-channel SQL is a union of "my memberships" and "all open channels":

```sql
SELECT cm.channel_id FROM channel_members cm ... WHERE cm.pubkey = $2 AND cm.removed_at IS NULL
UNION
SELECT id AS channel_id FROM channels WHERE community_id = $1 AND visibility = 'open' AND deleted_at IS NULL
```

(`crates/buzz-db/src/channel.rs:746-773`, doc comment: "Includes channels where the pubkey is an active member AND all open channels.")

**Practical consequence for the adapter:** a read-only Buzz adapter needs to mint and persist one keypair, and that is the entire credential story. No OAuth, no account, no operator involvement — _provided_ the target relay runs default config. If the operator sets `BUZZ_PUBKEY_ALLOWLIST=true` or `BUZZ_REQUIRE_RELAY_MEMBERSHIP=true`, our pubkey must be admitted out-of-band (SQL insert into `pubkey_allowlist`, or an invite claim via `POST /api/invites/claim`), and there is no in-protocol way to request admission. That is a per-deployment fact the adapter cannot discover before trying — which argues for a typed `AuthFailed` result on connect rather than a thrown error, exactly as `ConnectorProvider.pollConnect` types failure on the result (`packages/shared/src/connector-provider.ts:139-148`).

---

## 5. Identity model

**Identity is strictly a secp256k1 keypair.** `buzz-auth`'s own module doc is unambiguous: two auth paths, NIP-42 (WS) and NIP-98 (HTTP), both Schnorr signatures, and "No JWT validation, no token management, no IdP runtime dependency" (`crates/buzz-auth/src/lib.rs:3-16`, `97-98`). `AuthMethod` has exactly two variants, `Nip42` and `Nip98` (`crates/buzz-auth/src/lib.rs:54-60`). `AuthContext.pubkey` is a `nostr::PublicKey` (line 65-66).

**There is no non-keypair identity.** Three things look like one and are not:

- **API tokens.** A `crates/buzz-db/src/api_token.rs` module exists and `NOSTR.md:98` says token-holders bypass the allowlist. But the WS auth handler is documented and implemented as "Pure crypto verification — **no API tokens, no JWT, no DB token lookups**" (`crates/buzz-relay/src/handlers/auth.rs:41`, `86`). Tokens do not authenticate a WebSocket.
- **`derive_pubkey_from_username`.** Deterministic key derivation from a username, `SHA-256("buzz-test-key:{username}")`, gated `#[cfg(any(test, feature = "dev"))]` with a security warning that it "must never be compiled into a production release build" (`crates/buzz-auth/src/lib.rs:146-167`). Dev only.
- **NIP-OA owner attestation.** An _agent_ key can carry an `auth` tag cryptographically proving which _owner_ key vouches for it, letting the agent inherit the owner's relay membership (`crates/buzz-relay/src/handlers/auth.rs:216-275`, verified via `buzz_sdk::nip_oa::verify_auth_tag`). This is delegation **between two keypairs** — it adds a second key, it does not replace keys with accounts. Note this is a real answer to a problem we also have: how an agent's identity relates to its human's. Worth reading `docs/nips/NIP-OA.md` when we design agent identity.

**How a display name and avatar attach to a pubkey.** A user publishes a standard NIP-01 kind:0 metadata event; the relay's side-effect handler parses it and syncs `display_name`, `avatar_url`, `about`, and `nip05_handle` into the `users` table (`handle_kind0_profile`, `crates/buzz-relay/src/handlers/side_effects.rs:1149-1232`, dispatched at `side_effects.rs:149`). NIP-05 handles must canonicalize to the relay's own domain and are subject to a UNIQUE constraint; on collision the handle is skipped and the other profile fields still sync (`side_effects.rs:1215-1230`).

**The mapping onto our `authors` table is clean and worth stating precisely.** Our `authors` row is `(kind, naturalKey)` → opaque `id`, with `displayName`/`emoji`/`color` as a render cache refreshed on resolve (`packages/db/src/schema/rooms.ts:30-65`). Buzz's pubkey is a perfect `naturalKey` for `kind: 'human'` or `'agent'` — it is stable, globally unique, and never rebuilt. Buzz's kind:0 profile is exactly our render cache. This part of the interface does not need a capability flag. There is no `emoji`/`color` equivalent — Buzz has `avatar_url` (a Blossom media URL), not an emoji glyph, which our `resolveAgentVisual` hashing already tolerates.

---

## 6. Threads

**NIP-10 `e` tags with `root`/`reply` markers, plus a server-side materialised thread index.**

Ingest parses the NIP-10 marker form — a tag is only considered when `parts.len() >= 4 && parts[0] == "e"`, reading `parts[1]` as a 64-hex event id and `parts[3]` as the marker, matching `"root"` and `"reply"` (`resolve_nip10_thread_meta`, `crates/buzz-relay/src/handlers/ingest.rs:563-597`). A reply carrying only `reply` is treated as its own root (`ingest.rs:597-601`). Unknown parents are rejected. The resolved ancestry is written into a `thread_metadata` table **atomically with the event insert** (`ingest.rs:2248`).

`thread_metadata` carries `parent_event_id`, `root_event_id`, `channel_id`, and **`depth`** (`ThreadReply`, `crates/buzz-db/src/thread.rs:19-42`), and the module doc says it tracks "**infinitely nested threads**" (`crates/buzz-db/src/thread.rs:1-5`).

**Can a client reconstruct a thread tree? Yes, and it does not have to.** Two server-side affordances:

- `get_thread_replies(pool, community, root_event_id, depth_limit, limit, cursor)` returns a flat reply list with `depth` per row and a **keyset cursor** — 8-byte big-endian seconds plus the raw event id as tiebreak (`crates/buzz-db/src/thread.rs:345-375`). The event-id tiebreak exists specifically because a timestamp-only cursor silently drops ties at a page boundary (`crates/buzz-relay/src/api/bridge.rs:289-303`).
- Kind **39005** `KIND_THREAD_SUMMARY` — a relay-signed overlay, _synthesized at query time and never stored_, whose content is `{reply_count, descendant_count, last_reply_at, participants}` (`crates/buzz-core/src/kind.rs:370-376`; `ThreadSummary` at `crates/buzz-db/src/thread.rs:44-56`). This is precisely our "N replies" summary row — computed server-side rather than projected from a child room's log.

**This is the sharpest structural mismatch with our model.** Our threads are _rooms_ — a child `rooms` row with `parentId` and `rootEntryId`, one level only, with a second-level thread **refused at the service boundary rather than silently flattened** (`packages/db/src/schema/rooms.ts:67-79`). Buzz's threads are _tags on messages in the same channel_, with arbitrary depth and a `depth` column. Details in §11(b).

---

## 7. Read cursors / unread state

**Purely client-side, and end-to-end encrypted to the user's own key. The relay is an opaque blob store.**

The mechanism is Buzz's own NIP-RS draft (`docs/nips/NIP-RS.md`), riding NIP-78 kind:30078 (`KIND_READ_STATE`, `crates/buzz-core/src/kind.rs:71-75`). Shape:

- `d` tag = `read-state:<32-hex-slot-id>`, one slot per client _installation_; plus exactly one `["t","read-state"]` tag.
- `content` is a **NIP-44 ciphertext whose conversation key is `nip44_conversation_key(user_privkey, user_pubkey)`** — the user encrypting to themselves (`docs/nips/NIP-RS.md`, Content section).
- Plaintext is `{v, client_id, contexts: {<context-id>: <unix-ts>}}` — "all messages in this context at or before this time have been read."

The relay validates only the _envelope_: kind matches, exactly one `d` tag, `d` starts with `read-state:`, slot is 32 lowercase hex chars, exactly one `read-state` `t` tag (`crates/buzz-db/src/lib.rs:3672-3682`). Passing that flags it `is_nip_rs`, which makes superseded versions **hard-delete** rather than tombstone (`crates/buzz-db/src/lib.rs:3688`). It is stored as a global, user-owned, non-channel-scoped event (`is_global_only_kind`, `crates/buzz-relay/src/handlers/ingest.rs:384-392`), writable under `Scope::UsersWrite` (`ingest.rs:202-204`).

The spec's own non-goals are decisive: "This NIP does not define read receipts, seen-by lists, or any mechanism for tracking what other users have read," "does not require relay-side logic," and "does not define mark-as-unread — the merge rule is monotonic by design" (`docs/nips/NIP-RS.md`, Non-Goals).

**Consequence.** Our `roomMembers.lastReadSeq` is a server-side integer the server can read, compare, and aggregate — the unread divider reads it, and so could a badge count or a digest (`packages/db/src/schema/rooms.ts:134-149`). Buzz's equivalent is a ciphertext the server cannot open, keyed by wall-clock time, scoped to a device installation rather than a member. A Buzz adapter can _write and read back the local user's own_ cursor, but the server can never compute an unread count, and no other member's cursor is visible even in principle. This is not a missing feature; it is a deliberate privacy stance we would have to either adopt or flag.

---

## 8. Wire protocol walkthrough

All frames are NIP-01 JSON arrays. Relay-side serialization is `crates/buzz-relay/src/protocol.rs:182-216`; client-side parsing/sending is `crates/buzz-test-client/src/lib.rs:88-168`.

### Step 0 — connect

```
Client:  GET ws://relay:3000/  (WebSocket upgrade)
```

Immediately, before the client sends anything (`crates/buzz-relay/src/connection.rs:157-197`):

```json
["AUTH", "<random-challenge>"]
```

The 5-second `AUTH_TIMEOUT` clock is now running (`connection.rs:27,228-249`).

### Step 1 — authenticate (mandatory)

Client signs a kind:22242 event over the challenge and the relay URL, per NIP-42:

```json
[
  "AUTH",
  {
    "id": "<32-byte-hex>",
    "pubkey": "<32-byte-hex>",
    "created_at": 1785000000,
    "kind": 22242,
    "tags": [
      ["relay", "ws://relay:3000/"],
      ["challenge", "<random-challenge>"]
    ],
    "content": "",
    "sig": "<64-byte-hex>"
  }
]
```

Relay (`crates/buzz-relay/src/handlers/auth.rs:277-294`):

```json
["OK", "<event-id>", true, ""]
```

or on failure `["OK","<event-id>",false,"auth-required: verification failed"]`, or `["OK","<event-id>",false,"restricted: not a relay member"]`, or `["OK","<event-id>",false,"blocked: you are banned from this community"]` followed by an immediate socket close.

**Skipping this step is fatal.** Any REQ sent from `Pending` yields:

```json
["NOTICE","auth-required: authenticate before subscribing"]
["CLOSED","<subid>","auth-required: not authenticated"]
```

### Step 2 — discover channels

```json
["REQ", "chans", { "kinds": [39000], "limit": 500 }]
```

Relay replies with one relay-signed EVENT per accessible channel, then EOSE:

```json
["EVENT","chans",{
  "kind":39000,
  "pubkey":"<relay-pubkey-hex>",
  "created_at":1785000000,
  "tags":[
    ["d","3f2a…-uuid"],
    ["name","engineering"],
    ["about","Backend work"],
    ["public"],
    ["closed"],
    ["t","stream"],
    ["topic","Q3 migration"]
  ],
  "content":"",
  "id":"…","sig":"…"
}]
["EOSE","chans"]
```

An archived channel additionally carries `["archived","true"]`; a DM carries `["hidden"]` plus one `["p",<pubkey>]` per participant; a private channel carries `["private"]` instead of `["public"]` (`crates/buzz-relay/src/handlers/side_effects.rs:1011-1058`).

Remember §2: this is a **poll**. New channels will not arrive on this subscription via live fan-out.

Roster for one channel:

```json
["REQ", "roster", { "kinds": [39002], "#d": ["3f2a…-uuid"] }]
```

→ a 39002 event whose tags are `["p","<pubkey-hex>","","owner"]`, `["p","<pubkey-hex>","","member"]`, … (`side_effects.rs:1092-1107`).

### Step 3 — subscribe to one channel (history + live in one REQ)

```json
["REQ", "room-3f2a", { "kinds": [9], "#h": ["3f2a…-uuid"], "limit": 200 }]
```

The relay registers the subscription **before** running the historical query (`crates/buzz-relay/src/handlers/req.rs:364-386`), so there is no gap between backfill and live.

### Step 4 — historical messages, then EOSE

One DB query per filter, NIP-01 OR semantics, dedup by event id, per-event access re-check, then EOSE (`crates/buzz-relay/src/handlers/req.rs:389-414`):

```json
["EVENT","room-3f2a",{
  "kind":9,
  "pubkey":"<author-pubkey-hex>",
  "created_at":1784999000,
  "tags":[["h","3f2a…-uuid"]],
  "content":"the actual message text",
  "id":"…","sig":"…"
}]
["EVENT","room-3f2a",{ …older… }]
["EOSE","room-3f2a"]
```

`limit` is clamped to `MAX_HISTORICAL_LIMIT = 2000` (`req.rs:25,537-539`).

### Step 5 — live messages

Same `["EVENT","room-3f2a",{…}]` frames arrive as they are ingested, routed by the `(community, channel_id, kind)` fan-out index (`crates/buzz-relay/src/subscription.rs:265-288`) and, cross-pod, via the Redis topic `buzz:{community}:channel:{id}` (`crates/buzz-pubsub/src/lib.rs:3-22`).

Teardown: `["CLOSE","room-3f2a"]`.

### Step 6 — posting (for completeness; our adapter is read-only)

```json
[
  "EVENT",
  {
    "kind": 9,
    "tags": [["h", "3f2a…-uuid"]],
    "content": "hello",
    "pubkey": "…",
    "id": "…",
    "sig": "…"
  }
]
```

→ `["OK","<event-id>",true,""]`. A reply adds `["e","<parent-id>","","reply"]` (`crates/buzz-relay/src/handlers/ingest.rs:576-582`).

### Paging deeper than the first window

Two options, and they are **not** equivalent:

- **WS**: NIP-01 `until` / `since` / `limit` on the filter, mapped straight to SQL (`crates/buzz-relay/src/handlers/req.rs:873-882`). Wall-clock only — no tiebreak, so events sharing a `created_at` across a page boundary can be dropped.
- **HTTP `POST /query`** (NIP-98 auth): Buzz's own NIP-CW "channel window" — `{"#h":["<uuid>"],"top_level":true,"until":<ts>,"before_id":"<64-hex>"}`. The composite `(until, before_id)` keyset is mandatory-both-or-neither; half a cursor is a deterministic 400, explicitly never demoted to a head request (`crates/buzz-relay/src/api/bridge.rs:404-455`). The response appends a relay-signed **kind:39006 window-bounds** overlay carrying `{has_more, next_cursor}`, and the kind doc states it is "the only authority on exhaustion — clients must not infer `has_more` from row counts" (`crates/buzz-core/src/kind.rs:377-380`).

`handle_channel_window_filter` exists only in `bridge.rs`; grepping the crates finds no caller outside it. **The gap-free keyset cursor is HTTP-only. The WebSocket path cannot do it.** An adapter that wants correct backfill must speak both transports.

---

## 9. Deployment shape

**Five ways to run it**, all wrapping `cargo build -p buzz-relay --bin buzz-relay`:

1. **Cargo** — `cargo run -p buzz-relay` (`Justfile:371`).
2. **Docker** — `ghcr.io/block/buzz:<tag>`, `ENTRYPOINT ["/usr/local/bin/buzz-relay"]`, `EXPOSE 3000 8080 9102` (`Dockerfile:3,151,159`).
3. **docker-compose, production** — `deploy/compose/compose.yml` runs the relay plus Postgres/Redis/MinIO; `./run.sh start`, with a Caddy TLS overlay (`deploy/compose/README.md:6-20`). Note the **root** `docker-compose.yml` is dev infra only and does _not_ run the relay (`README.md:157`).
4. **Helm** — `helm install buzz oci://ghcr.io/block/buzz/charts/buzz --set quickstart=true …` bundles Postgres/Redis/MinIO subcharts (`deploy/charts/buzz/README.md:14-22`).
5. **`just dev` / `just relay`** — auto-starts dockerised Postgres+Redis, runs migrations, launches the relay (`Justfile:162-191,366-371`).

**Hard boot requirements: Postgres and Redis.** Both are `?`-propagated at startup and abort the process on failure — `"DB connection failed"` (`crates/buzz-relay/src/main.rs:146-154`) and `"Redis pool creation failed"` / `"PubSub init failed"` (`main.rs:336-347`). There is no SQLite or in-memory fallback anywhere in `Config::from_env()`. S3/MinIO is _not_ a boot requirement (the client is constructed without a network call, `crates/buzz-media/src/storage.rs:34-67`) but is needed for media at request time. Migrations do **not** run automatically — `BUZZ_AUTO_MIGRATE` defaults off (`main.rs:161-171`).

Three ports: app `0.0.0.0:3000` (WS + REST), health `8080`, Prometheus `9102` (`crates/buzz-relay/src/config.rs:406-408,609-617`; `Dockerfile:150-151`).

### Is there a public/demo relay to test against?

**No. There is no public Buzz relay.** Every OSS-facing default is localhost:

- Relay's own advertised URL: `RELAY_URL` defaults to `ws://localhost:3000` (`crates/buzz-relay/src/config.rs:427-428`).
- Desktop app: `const DEFAULT_RELAY_WS_URL: &str = "ws://localhost:3000";` (`desktop/src-tauri/src/relay.rs:12`).
- Example bot: same default (`examples/countdown-bot/src/main.rs:26`).
- Web client has no baked default at all — it reads `VITE_RELAY_URL` or falls back to same-origin (`web/src/shared/lib/relay-url.ts:12-19`).
- README, verbatim: "By default the app connects to `ws://localhost:3000`. … **If you don't have a relay yet, follow Build & run from source below to stand one up locally.**" (`README.md:120`).

Two hosted relays exist and both are **Block-internal**: `wss://sprout-oss.stage.blox.sqprod.co` (`Justfile:519`) and `wss://buzz.block.builderlab.xyz` (`Justfile:546`), reachable via `just staging` / `just production`. The README's "I work at Block" section routes employees to a pre-wired build from a _private_ repo, `squareup/buzz-releases` (`README.md:122-126`). We have no access and should not plan on it.

### Cheapest live instance for integration testing

Docker is required — there is no Docker-free path to a working relay.

```bash
. ./bin/activate-hermit
cp .env.example .env
just setup                      # docker compose up postgres/redis, run migrations
cargo build --release -p buzz-relay -p buzz-cli -p buzz-admin
export PATH="$PWD/target/release:$PATH"
buzz-relay                      # ws://localhost:3000
```

(`TESTING.md:19-130`.) Verify with `curl -s http://localhost:3000/health` and `curl -s http://localhost:8080/_readiness`. `just relay` is the one-liner equivalent. For CI, `scripts/start-relay-for-tests.sh` does the whole thing headless and exports `RELAY_URL=ws://localhost:3000`; `scripts/start-isolated-test-relay.sh` runs a parallel-safe instance on non-default ports (relay `3030`, Postgres `5471`, Redis `6471`) inside a detached tmux session, which is the right one for agent-driven test runs.

For **our** e2e, the relevant existing pattern is `crates/buzz-test-client`: a NIP-01 WS client whose e2e tests are `#[ignore]` and point at an already-running relay via `RELAY_URL` (`crates/buzz-test-client/tests/e2e_relay.rs:1-31`). We would mirror that — a Buzz-adapter conformance run gated on a `BUZZ_RELAY_URL` env var, skipped when absent, exactly as `runtimeConformance` handles a runtime whose binary is missing.

---

## 10. Capability mapping table

One row per capability our room model needs. **Citations are Buzz source unless marked [doc-only].** "Partial" is used precisely — it means the capability exists but with a semantic difference that must be encoded in a flag, and the Notes column says which.

| Capability                       | Buzz support | How (kind / NIP / endpoint)                                                                                                                                                          | Evidence                                                                                                                | Notes — what the flag must capture                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **list rooms**                   | **partial**  | `REQ {"kinds":[39000]}` → relay-signed group metadata, `d` tag = channel UUID                                                                                                        | `handlers/side_effects.rs:999-1071`; `core/kind.rs:362`                                                                 | Poll-only. 39000 is stored **channel-scoped**, so a live global sub never receives it by fan-out (`subscription.rs:265-288`); channel-created is not pushed. Flag: `roomListIsPolled`.                                                                                                                                                                                                                                                                                  |
| **get room metadata**            | **yes**      | Tags on kind:39000 — `name`, `about`, `topic`, `purpose`, `t`=type, `public`/`private`, `closed`, `archived`, `ttl`                                                                  | `handlers/side_effects.rs:1011-1058`                                                                                    | Richer than ours. Maps cleanly to `title`/`topic`/`kind`. No `workspaceId` equivalent; `ttl`/ephemeral channels have no counterpart in our schema.                                                                                                                                                                                                                                                                                                                      |
| **subscribe to live entries**    | **yes**      | `REQ {"kinds":[9],"#h":["<uuid>"]}`; live `EVENT` frames after `EOSE`                                                                                                                | `handlers/req.rs:364-414`; `subscription.rs:265-288`; `pubsub/lib.rs:3-22`                                              | Subscription is registered _before_ the historical query runs, so backfill→live is gapless within one REQ.                                                                                                                                                                                                                                                                                                                                                              |
| **replay history with a cursor** | **partial**  | WS: NIP-01 `since`/`until`/`limit`. HTTP: NIP-CW `top_level` + composite `(until, before_id)` keyset + kind:39006 bounds overlay                                                     | `handlers/req.rs:873-882`; `api/bridge.rs:404-455`; `core/kind.rs:377-380`                                              | **The big one.** No monotonic per-room `seq` anywhere. WS paging is wall-clock and can drop `created_at` ties across a page. The gap-free keyset cursor is **HTTP-only** — `handle_channel_window_filter` has no caller outside `bridge.rs`. `limit` clamped to 2000 (`req.rs:25`). Flag: `historyCursor: 'timestamp' \| 'keyset' \| 'sequence'`.                                                                                                                       |
| **post an entry**                | **yes**      | `["EVENT",{kind:9, tags:[["h",uuid]], …}]` → `["OK",id,true,""]`                                                                                                                     | `handlers/ingest.rs:455-484` (h required); `protocol.rs:204-206`                                                        | Open channels accept writes from non-members: `check_channel_membership` returns Ok on `visibility == "open"` (`ingest.rs:493-524`). Not used by a read-only adapter.                                                                                                                                                                                                                                                                                                   |
| **list members**                 | **yes**      | `REQ {"kinds":[39002],"#d":["<uuid>"]}` → `["p",pubkey,"",role]` per member; 39001 for admins                                                                                        | `handlers/side_effects.rs:1073-1107`                                                                                    | Roles are 5-valued (`Owner/Admin/Member/Guest/Bot`, `core/channel.rs:108-120`) vs our `roomMembers` which has no role column at all — only `responseMode`. Buzz has no `responseMode` equivalent.                                                                                                                                                                                                                                                                       |
| **invite a member**              | **partial**  | Channel-level kind:9009 is a **no-op stub**. Real paths: kind:9000 (admin adds user), kind:9021 (self-join, open only), `POST /api/invites` + `/api/invites/claim` (community-level) | `side_effects.rs:157-163` (stub); `side_effects.rs:1240` (9000); `side_effects.rs:1884-1903` (9021); `router.rs:95,111` | "Invite" as we mean it — offer a specific person a specific channel — **does not exist**. HTTP invites admit to the _community_; kind:9000 is "an admin adds you," not an offer you accept. Flag: `invite: 'none' \| 'community' \| 'room'`.                                                                                                                                                                                                                            |
| **mark read**                    | **partial**  | NIP-RS kind:30078, `d`=`read-state:<32-hex>`, content NIP-44-encrypted to self                                                                                                       | `core/kind.rs:71-75`; `db/lib.rs:3672-3688`; `docs/nips/NIP-RS.md`                                                      | Client-side only; relay validates the envelope and cannot read the payload. Keyed by **wall-clock ts per device slot**, not per `(member, room)` — our `lastReadSeq` has no counterpart. Server-side unread count is impossible by design. Flag: `readCursor: 'server' \| 'client-opaque' \| 'none'`.                                                                                                                                                                   |
| **threads**                      | **partial**  | NIP-10 `["e",<id>,"","root"\|"reply"]`; server `thread_metadata` with `depth`; kind:39005 summary overlay; `get_thread_replies` keyset cursor                                        | `ingest.rs:563-601`; `db/thread.rs:1-5,19-56,345-375`; `core/kind.rs:370-376`                                           | **Arbitrary depth** ("infinitely nested", `db/thread.rs:3`) vs our one-level-and-refuse. A thread is tags on a message in the same channel, not a child room. Their 39005 = our "N replies" row, computed rather than projected. Flag: `threadDepth: 1 \| 'unbounded'`.                                                                                                                                                                                                 |
| **archive**                      | **yes**      | kind:9002 `["archived","true"\|"false"]` → `channels.archived_at`; surfaced back as an `["archived","true"]` tag on kind:39000                                                       | `side_effects.rs:1526-1560`; `db/channel.rs:1341,1381`; `side_effects.rs:1050-1053`                                     | Archiving **evicts every live subscription** on the channel via `evict_all_channel_subscriptions` (`side_effects.rs:119-128`), sending `["CLOSED",subid,"restricted: channel access revoked"]` (emitted at `side_effects.rs:85`) — an adapter must treat that CLOSED as "archived," not "error." An open→private flip evicts non-members the same way (`side_effects.rs:95-116`). Their archive does not free the name; ours frees the slug via a partial unique index. |
| **typing / presence**            | **yes**      | Presence kind:20001 (ephemeral, arbitrary status string, Redis-backed); typing kind:20002 (ephemeral, Redis pub/sub, never stored)                                                   | `core/kind.rs:403,407`; `handlers/event.rs:795`; ingest excludes 20000–29999 from storage (`db/lib.rs:3-10`)            | We have neither today. Buzz also has a kind:40902 presence _snapshot_. Free to adopt later; nothing to reconcile now.                                                                                                                                                                                                                                                                                                                                                   |

Two capabilities we did not list but that Buzz has and we will be asked for: **reactions** (kind:7 NIP-25, channel derived from the `#e` target — `NOSTR.md:44` **[doc-only]** for the derivation detail, reactions are handled inline in the ingest pipeline rather than the side-effect dispatcher — the channel is resolved from the target at `ingest.rs:1670` and applied at `ingest.rs:2271`, and `requires_h_channel_scope(KIND_REACTION)` is asserted false at `ingest.rs:2656`) and **search** (NIP-50 `{"search":"…","kinds":[9],"#h":[…]}`, one-shot, never registered as a persistent subscription, `handlers/req.rs:211-232`).

---

## 11. Verdict

### (a) Is a read-only Buzz adapter buildable with no keypair?

**No — and this is not a configuration detail we can engineer around.** `handle_req` refuses any REQ from a connection that is not `Authenticated`, with no branch on channel visibility or config (`crates/buzz-relay/src/handlers/req.rs:76-86`), and the connection state machine has no anonymous variant to reach (`crates/buzz-relay/src/connection.rs:37-47`). The relay pushes an AUTH challenge before reading a byte from the client and kills the socket 5 seconds later if unanswered (`connection.rs:157-197,27,228-249`). The HTTP bridge is the same wall in different bricks — NIP-98, a signed kind:27235 (`api/bridge.rs:80-92`). The only thing an anonymous client can fetch from a Buzz relay is the NIP-11 metadata document (`router.rs:63,235-275`), which contains no messages.

**The minimum credential is one self-generated secp256k1 keypair, and on a default-configured relay that is sufficient with no operator involvement.** NIP-42 verification is pure Schnorr with no DB lookup (`crates/buzz-auth/src/lib.rs:114-143`), and the two gates that could reject an unknown key both default to `false` — `BUZZ_PUBKEY_ALLOWLIST` (`config.rs:479-481`) and `BUZZ_REQUIRE_RELAY_MEMBERSHIP` (`config.rs:483-485`). Once authenticated, the key can read **every open channel without joining**, because accessible-channel resolution unions memberships with all open channels (`db/channel.rs:746-773`). So the adapter's credential story is: mint a key, persist it, sign the challenge. That is genuinely light.

The caveat that matters for interface design: whether those two gates are on is a **property of the target deployment that we cannot discover before attempting to connect**. A hardened relay will reject our key at AUTH with `restricted: not a relay member` or `auth-required: verification failed`, and there is no in-protocol way to request admission — admission is a SQL insert or an out-of-band invite claim. So `CommunityAdapter.connect()` must return a **typed failure** distinguishing "wrong credential" from "credential fine, not admitted here" from "relay unreachable," rather than throwing. This is exactly the shape `ConnectorProvider` already uses: `ConnectPoll` carries `status: 'pending' | 'connected' | 'failed'` with an `error` string, and the doc says failure is "TYPED on the result … never thrown across the port — callers branch on `status`, they do not catch" (`packages/shared/src/connector-provider.ts:134-148`). We should copy that verbatim rather than invent a second convention. Likewise, "the operator must admit this pubkey" is a _disclosure_, and `ConnectorCapabilities.custody` is the precedent for surfacing an honest pre-connect disclosure in the UI (`connector-provider.ts:55-66`).

### (b) What in Buzz's model does NOT map onto our room model?

Seven mismatches. The first three are structural and will shape the interface; the rest are flags.

**1. There is no monotonic sequence. This is the deepest one.** Our entire durable-stream design rests on a per-room monotonic `seq` allocated inside an IMMEDIATE transaction (`packages/db/src/schema/rooms.ts:151-210`), and it is the same primitive the session SSE stream uses for gap-free replay via `Last-Event-ID`. Buzz has nothing equivalent: NIP-01 filters page by `created_at` wall-clock (`handlers/req.rs:873-882`), and the only tiebroken cursor is NIP-CW's composite `(until, before_id)` keyset — **available on HTTP `POST /query` only**, with no caller of `handle_channel_window_filter` outside `bridge.rs`. So `CommunityAdapter` cannot take a `sinceSeq: number` and expect every backend to honour it. The cursor must be an **opaque, adapter-minted token** — local rooms encode a `seq`, Buzz encodes `(until, before_id)` or a bare timestamp — with a capability flag saying whether replay from it is _gap-free_ or _best-effort_. Our `AgentRuntime` already has the right precedent for the failure mode: `subscribeSession` throws `StaleResumeCursorError` **eagerly, at call time**, when a cursor cannot be served gap-free, and callers must fall back to a fresh snapshot (`packages/shared/src/agent-runtime.ts:596-621`). Reuse that contract; do not weaken the cursor into "roughly here."

**2. A thread is not a room.** Ours is a child `rooms` row, one level, second-level refused at the service boundary so the "N replies" row is a projection of a child log (`packages/db/src/schema/rooms.ts:67-79`). Buzz's is a set of NIP-10 `e` tags on messages _in the same channel_, with a server-side `thread_metadata` table that explicitly supports "infinitely nested threads" and carries a `depth` column (`db/thread.rs:1-5,19-42`). Neither model can be expressed in the other without loss: flattening Buzz's depth-3 reply into our two-level model discards ancestry, and projecting our child room into their model would need a synthetic root event. The honest interface treats "thread" as an **entry-level relation** (`parentEntryId`) rather than a room-level one, with a `threadDepth: 1 | 'unbounded'` capability — and our service keeps refusing depth > 1 for _local_ rooms while faithfully _reading_ deeper Buzz trees. Note their kind:39005 thread-summary overlay is the same object as our "N replies" row, arrived at independently; that is a good sign the entry-level relation is the right seam.

**3. Read cursors are private by construction.** Ours is `roomMembers.lastReadSeq`, a server-visible integer keyed `(member, room)` (`packages/db/src/schema/rooms.ts:145-146`). Buzz's is a NIP-44 ciphertext the user encrypts **to their own pubkey**, keyed by a random per-installation slot id and holding wall-clock timestamps per opaque context string; the relay validates only the envelope (`db/lib.rs:3672-3688`, `docs/nips/NIP-RS.md`). Three separate mismatches in one: the server cannot read it, the key is per-device not per-member, and the value is a timestamp not a sequence. Anything that needs a server-computed unread count, badge, or digest is **impossible** against Buzz, not merely unimplemented. `readCursor: 'server' | 'client-opaque' | 'none'` is a required flag, and any product surface that depends on server-side unread must be gated on `'server'`.

**4. Room identity is a UUID with a mutable name; ours is a slug with a partial unique index.** Buzz addresses channels by UUID in the `h` tag, and `name` is freely editable via kind:9002 with no uniqueness constraint (the `"name"` arm of `handle_edit_metadata`, `side_effects.rs:1398-1410`). Ours enforces `rooms_channel_slug_unique` over non-archived channels, so `#general` is unique and archiving frees the name (`packages/db/src/schema/rooms.ts:115-117`). A Buzz adapter cannot promise slug uniqueness or slug-based addressing. `roomAddressing: 'slug' | 'opaque-id'`.

**5. Membership carries roles, not response modes — and the fields do not overlap at all.** Buzz has `Owner/Admin/Member/Guest/Bot` (`core/channel.rs:108-120`) and no concept of an agent's per-room response policy. Ours has `responseMode` (`always/direct-only/mention-only/silent`) written explicitly at join time and **no role column whatsoever** (`packages/db/src/schema/rooms.ts:134-149`). These are orthogonal, so the member DTO needs both as optional fields, each capability-gated — not a merged "permission" abstraction that would misrepresent both.

**6. There is no channel-level invite.** kind:9009 is a stub that logs a warning and returns Ok (`side_effects.rs:157-163`); the real HTTP invites admit to the _community_, not a channel (`router.rs:95,111`; `api/invites.rs:230-242`). If our interface exposes `inviteMember(roomId, who)`, Buzz can only satisfy it by _adding_ the member (kind:9000) — a different act with different consent semantics, and one that requires admin. Do not paper over this: `invite: 'none' | 'community' | 'room'`.

**7. Buzz's tenancy is one community per host; ours is one server, many rooms.** `TenantContext` is resolved from the HTTP Host at "row zero" before any frame is read and is deliberately not `Deserialize`-able, so a community can never come from client input (`core/tenant.rs:19-24,68-76`); `NOSTR.md:6-12` states each community is reached by its own domain or subdomain. So "join two Buzz communities" means **two WebSocket connections to two hosts**, and the adapter instance is per-community, not per-server. Our `rooms` table has no community column at all. Whatever addresses a room in `CommunityAdapter` must therefore be `(communityRef, roomId)`, not a bare room id — and the registry that resolves an adapter must key on the community, mirroring how `runtimeRegistry` binds a session to a runtime first-write-wins (ADR-0255).

**One thing that maps better than expected**, and is worth banking: **identity.** A Buzz pubkey is a flawless `authors.naturalKey` — stable, globally unique, never rebuilt — and their kind:0 profile sync into a `users` table (`side_effects.rs:1149-1232`) is precisely our `displayName`/`emoji`/`color` render cache that is "refreshed on resolve, never the key" (`packages/db/src/schema/rooms.ts:11-29`). The opaque-`id`-over-natural-key design we already committed to absorbs a Nostr pubkey with zero adaptation. Their NIP-OA owner attestation — a cryptographic proof binding an _agent_ key to the _human_ key that vouches for it (`handlers/auth.rs:216-275`, `docs/nips/NIP-OA.md`) — is a solved version of a problem we have not yet designed, and is worth reading before we do.

### Recommendation on sequencing

The brief's instinct — put the read-only Buzz adapter second, before our own Postgres server sets the interface in concrete — is validated by findings 1, 2, and 3. Each is a case where the obvious interface (a numeric `sinceSeq`, a room-shaped thread, a server-side read cursor) is one our own two backends would both satisfy and Buzz would not, and we would only discover it after the concrete had set. Build the Buzz adapter against a **locally-run** relay (§9 — there is no public one, so budget the Docker Compose setup), and treat these three as the interface's real acceptance tests.

---

## Sources

- Buzz source, `github.com/block/buzz` @ `654f384906b5c720a60a199d85031a6f1cb6efc9` (2026-07-27), Apache-2.0. Fresh `git clone --depth 1`; all `crates/…`, `docs/…`, `Justfile`, `Dockerfile`, `deploy/…`, `README.md`, `TESTING.md`, `NOSTR.md` citations above resolve against that commit.
- DorkOS: `packages/db/src/schema/rooms.ts`, `packages/shared/src/agent-runtime.ts`, `packages/shared/src/connector-provider.ts`.
- Prior DorkOS research: `research/20260724_multi-user-communities.md` (the broader survey; this spike drills its Buzz section to source), `research/20260727_multi-user-review-exchange.md` (the adversarial review that corrected it).
