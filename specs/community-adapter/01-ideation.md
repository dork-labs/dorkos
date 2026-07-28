---
slug: community-adapter
id: 260727-221432
created: 2026-07-27
status: ideation
---

# Ideation: `CommunityAdapter` — the port every community backend implements

- **Slug:** community-adapter
- **Date:** 2026-07-27
- **Author:** Claude (directed by Dorian)
- **Tracker:** DOR-591
- **Parent:** `specs/community-server/01-ideation.md` (`260727-155419`), decision **D2**
- **Anchors:** codebase = working tree at `5a84de271`. Buzz = `github.com/block/buzz` @ `654f384906b5c720a60a199d85031a6f1cb6efc9`.

## 1) What this inherits, and does not re-argue

The community program's nine decisions are settled in `specs/community-server/01-ideation.md`. This spec is **D2 only** — the server-side port and its conformance suite. It does not reopen D1, D3–D9.

| Inherited                                                                                                                                              | What it fixes for this spec                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| **D1** — Postgres on the community server, SQLite stays local; the shared wire format lives in `packages/shared`                                       | The port's DTOs live in `packages/shared`, not in either store                                    |
| **D2** — a server-side `CommunityAdapter` with a shared conformance suite; the client's `Transport` is unchanged                                       | **This spec.** Nothing about the port may reach the browser                                       |
| **D3** — a remote member is filed under the community's own opaque member id; **zero user-facing keys, in every path**                                 | A Nostr keypair is machine infrastructure in a `0600` file, never an identity a person holds      |
| **D4** — `apps/community` is its own app                                                                                                               | The third backend, and the one the MVP ships on                                                   |
| **D5** — build order: spike → **interface** → local → Buzz read-only → `apps/community`                                                                | This is step 2. Buzz read-only is second **so the interface cannot bake in our own assumptions**  |
| **D6** — your own install stays single-user                                                                                                            | The local adapter honestly declares **no roles**; that is not a gap to fill later                 |
| **D7** — community roles are `owner` / `admin` (many) / `member`                                                                                       | The port must express roles across backends that disagree about how many there are                |
| **D8** — a member adds their own agents; admins can eject them; removing the human removes their agents; the agent inherits none of its owner's powers | Four invariants the conformance suite asserts, not prose                                          |
| **D9** — the community server never executes a member's agent (ADR `260727-184933`)                                                                    | The port carries conversation, never compute. No method may accept or return an execution request |

Two shipped precedents set the pattern, and this is the third instance of it:

| Interface                                                         | Backends                                    | Conformance                                        |
| ----------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------- |
| `AgentRuntime` (`packages/shared/src/agent-runtime.ts`)           | claude-code, codex, opencode, test-mode     | `packages/test-utils/src/runtime-conformance.ts`   |
| `ConnectorProvider` (`packages/shared/src/connector-provider.ts`) | raw-MCP, Composio, Nango, Fake              | `packages/test-utils/src/connector-conformance.ts` |
| **`CommunityAdapter`**                                            | **local, Buzz read-only, `apps/community`** | **`community-conformance.ts`**                     |

The doctrine is stated in `connector-conformance.ts` and is copied verbatim: the suite is _"capability-aware: the multi-account assertion branches on `supportsMultiAccount` rather than weakening"_, and _"this suite covers connector BEHAVIOR; the TypeScript interface covers SHAPE."_

## 2) The one thing this spec is for

> Three backends. The contract must accommodate a backend with no channel invites, no server-readable read cursors, no monotonic sequence, and no in-protocol way to ask for admission — **without weakening**. If satisfying Buzz means softening an assertion for everyone, the design is wrong; it must be a declared capability instead.

`research/20260727_buzz-protocol-capability-spike.md` found four mismatches where the obvious interface satisfies **both of our own backends** and fails against Buzz. Those four, plus admission, are the design input:

1. **No monotonic sequence.** Our `seq` has no counterpart. WS paging is wall-clock with no tiebreak; the gap-free keyset cursor is HTTP-only. → the cursor must be an **opaque adapter-minted token**.
2. **Threads are arbitrarily deep** and are tags on a message _in the same channel_, not child rooms.
3. **Read cursors are encrypted to the user's own key**, per device slot, by wall-clock. Server-side unread is **structurally impossible**, not unimplemented.
4. **No channel-level invite primitive.** kind:9009 is a logged no-op; HTTP invites admit to the _community_.
5. **Joining is an admission event, not a connection.** Every deployment path Buzz publishes sets `BUZZ_REQUIRE_RELAY_MEMBERSHIP=true`, so a stranger key is refused until an operator admits it. This is **closer to how `apps/community` will work** than an anonymous-read model, so out-of-band admission is a first-class concept, not a Buzz quirk.

## 3) Three things the parent ideation asserts that the spike falsified

Recorded here because the spec builds on the corrected version, and because a later reader will otherwise reconcile them the wrong way.

- **"A Nostr relay has no roster"** (D2 rationale; D5 "forces `hasRoster: false` to exist from day one"). **False.** Buzz has a per-channel roster with per-member roles, served as relay-signed kind:39002 events carrying `["p", pubkey, "", role]` per member (spike §3: _"Yes, and it is better developed than I expected"_). All three backends can enumerate a room's members, so **`listMembers` is universal and there is no roster flag** — the roles are what differ.
- **"No read cursors."** **False.** Buzz has NIP-RS (kind:30078). It is client-opaque, not absent. The distinction matters: `'client-opaque'` means the adapter can round-trip its _own_ cursor while no server-side unread count can ever exist; `'none'` means there is no cursor at all.
- **"No invites."** Half true. There is no _channel-level_ invite; community-level HTTP invites are real (`POST /api/invites` + `/claim`). That is exactly why the flag is three-valued rather than boolean.

## 4) Scope

**In:** the `CommunityAdapter` port, `CommunityCapabilities`, the DTOs it speaks, the two typed errors, the `CommunityRegistry` and its per-community degradation, the credential-resolution contract, and `communityConformance` + a `FakeCommunityAdapter`.

**Out:** all three concrete adapters (DOR-59x each), the `rooms` table's `communityRef` migration (belongs to the local adapter), `apps/community` itself, posting to Buzz, message signing, reactions, search, and any UI.

## 5) Related

- `specs/community-server/01-ideation.md` — the nine decisions
- `research/20260727_buzz-protocol-capability-spike.md` — the 11-row capability table (`feature_slug: community-adapter`)
- `research/20260727_agent-identity-in-communities.md` — D8's mechanism, and the eight principles that survive with no keys
- ADR `260726-170125` (a room is a membership-scoped durable stream), `260726-170127` (cascade guard), `260727-184933` (never runs a member's agent), ADR-0310 (cross-backend aggregation with `warnings[]`), ADR-0255 (first-write-wins binding)
