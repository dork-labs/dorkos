---
title: 'Thread models — container or pointer, why Buzz chose tags, and whether DorkOS should change'
date: 2026-07-27
type: internal-architecture
status: active
tags:
  [
    threads,
    rooms,
    buzz,
    nostr,
    nip-10,
    nip-cw,
    slack,
    discord,
    zulip,
    matrix,
    community-adapter,
    adr-260726-170125,
  ]
feature_slug: room-participation
---

# Thread models: container or pointer?

- **Date:** 2026-07-27
- **Status:** active
- **Question:** DorkOS models a thread as a **child room** (ADR `260726-170125`). Buzz models a thread as **tags on a message in the same channel**, nested deeply. Is there a stated explanation for Buzz's choice? If not, what is the real reason? And should DorkOS change?
- **Method:** Source review of Block's Buzz at a pinned commit; the NIP-10 upstream text; a web survey of six shipping products; and a read of our own shipped room model, its ADRs, and the `community-adapter` spec.
- **Buzz anchor:** `654f384906b5c720a60a199d85031a6f1cb6efc9` — `fix(desktop): read the newest pair-scoped harness log (#3134)`, 2026-07-27, `github.com/block/buzz`, branch `main`, Apache-2.0. Shallow clone (`git log | wc -l` = 1), so **there is no commit history to mine for design intent** — every Buzz claim below is cited to a file and line in the working tree.
- **Prior art in this repo:** `research/20260727_buzz-protocol-capability-spike.md` §6 and §11(b) map the code; this document asks the _why_ that spike deferred.

---

## Executive summary

**There is no stated rationale.** Nothing in Buzz's repo — not `NOSTR.md`, not `ARCHITECTURE.md`, not the seven `VISION*.md` files, not `docs/`, not any of the fourteen house NIPs, not the `thread.rs` module doc — explains why a thread is tags rather than a child channel. What exists is a conformance checkmark: "**NIP-10 threads** | ✅" (`NOSTR.md:70`). Buzz **inherited a 2022 convention and never revisited it**, and the evidence for "never revisited" is that Buzz had a container primitive in hand — NIP-29 channels, which are Postgres rows with UUIDs and rosters — and did not consider it for threads.

**The hypothesis in the brief is half right, and wrong in its most confident parts.** Its claims 3 and 4 hold. Claims 1 and 2 are falsified by Buzz's own source: Buzz **does** have containers (NIP-29 channels), and its relay is emphatically **not** a dumb store — `thread_metadata` is relay-maintained derived state with materialized counters, written atomically with the event insert. The constraints the brief names were real for _NIP-10 in 2022_ and had been lifted by the time Buzz wrote a line of code. Buzz kept the convention anyway.

**The real reason, corrected:** not "no containers exist" but **"containers are not free and event ids are."** A Nostr event id is a content hash a client mints offline with no permission and no round trip; a NIP-29 channel needs an authorized `kind:9007`, a roster, and three relay-signed discovery events. Pointer-threading is the only threading a client can perform unilaterally. Add one mechanism covering every channel-scoped kind for free, and the economics are decisive — for Buzz.

**The receipt for what that cost them is `docs/nips/NIP-CW.md`**, a bespoke relay extension whose entire reason to exist is that the pointer model makes the default chat view unqueryable: _"'Channel messages that are **not** replies' — the timeline every threaded-chat client renders first — is therefore inexpressible in vanilla filters"_ (NIP-CW §Motivation). **That cost does not transfer to DorkOS.** We own a SQL engine; `WHERE parent_entry_id IS NULL` is free.

**The industry split has a better explanation than "cheap channels."** Discord chose containers, Slack/Matrix/Teams/Linear/GitHub chose pointers, Zulip chose a mutable string key that is neither. The decisive variable is not what a container costs to _create_ but how much parent state it must be kept _in sync with_ — which is why **Matrix, with the cheapest containers in existence, explicitly considered and rejected threads-as-rooms.** MSC3440's four stated disadvantages of that design match four costs we independently found in our own code, one for one (§4.3a). Depth-one is unanimous across all six products and essentially undefended.

**The question that should decide this is agent context, and it reframes the rest (§4.6).** Two verified facts: `composeRoomPrompt` sends an agent **only the triggering message** — no history — and a session binds `(room, agent)` first-write-wins with **no hydration**. So an agent triggered in a thread starts _blank_, not merely separate. Testing the claim that structure and context-binding are independent axes: **it holds.** The binding key is `(roomId, authorId)` and nothing more, so either structure reaches either policy for one small change — meaning the context benefit is obtainable without changing the thread model, and context alone cannot decide the question. But three things around it do, and all point one way: the child-room's _free default_ is the blank agent while the entry model's is the useful one; the retrieval substrate the addendum expected to favour rooms in fact **favours entries** (one predicate over one log, versus a `UNION` across N thread logs — and an entry-level thread is fully addressable, replayable and membership-scoped, so the premise fails); and **agent-opened threads are safe by default under entries and a privilege that must be gated under rooms.** A primary-source pass over five platforms' bot APIs confirms the independence directly: **container and pointer platforms hand an agent exactly the same thing — one message and an identifier** (§4.6.4, which also records one inference of mine that the same pass falsified).

**Verdict: change it — move the thread relation from the room to the entry, and do it now.** Not because of depth (the weakest argument on the table — six of six surveyed products stop at one level, and Buzz's own rendered product is two-level). Because the container is overhead we measured and are already routing around: each thread mints a fresh turn-budget window and a fresh cascade namespace, duplicates the parent's whole roster, and shows up in `listRooms` as a sidebar row. The `community-adapter` spec has **already** ruled the pointer shape correct at the port, which means the container is now a storage artifact that no consumer above it can see. And the migration surface is at its historic minimum: **the cockpit has no thread UI** — four lines of client code, one route, one service method — because **R4 (DOR-527), the phase that builds threading's entire product surface, has not started.** ADR `260726-170125` needs **superseding in part**, one clause of it, on the precedent of `260713-143958`.

**Keep the thread's id.** The survey's one rule that cuts against this — _the moment you want per-thread state, you want an id_ — is right, and we do want per-thread state (a read cursor, a resolve bit). It is answered, not dodged: an entry-level thread already has a stable id in its root entry, which is precisely the key Matrix had to reconstruct after the fact (`thread_id` = root event id). Give the thread an id; do not give it a room (§5).

---

## 1. Buzz's stated rationale, from source

### (a) Explicit stated rationale: **none exists**

Searched exhaustively: `NOSTR.md`, `README.md`, `ARCHITECTURE.md`, `AGENTS.md`, `VISION.md` and its six siblings, every `docs/*.md`, all fourteen `docs/nips/*.md`, `crates/buzz-db/src/thread.rs`, and the ingest path. **No document states why a thread is tags on a message rather than a child channel.**

The only place the decision is recorded at all is a compatibility table:

> | **NIP-10 threads** | ✅ | WS-submitted replies with `["e","<root>","","reply"]` tags create `thread_metadata` atomically. Visible in REST thread queries. Unknown parents rejected. |
>
> — `NOSTR.md:70`

That is a conformance claim. It says Buzz implements NIP-10; it does not say why NIP-10 is the right shape for a chat product. The framing itself is the tell — threading appears in a list of _NIPs supported_, alongside NIP-50 search and NIP-17 gift wraps, not in a design document.

The module doc is equally silent on motive:

> ```rust
> //! Thread metadata persistence.
> //!
> //! Tracks parent/root relationships, depth, and reply counts for infinitely
> //! nested threads. The `thread_metadata` table is populated when events are
> //! ingested and updated as replies arrive or are deleted.
> ```
>
> — `crates/buzz-db/src/thread.rs:1-5`

It describes the mechanism. It does not defend it. And "infinitely nested" is **not true** — see §1(c).

### (b) The closest thing to a "why" explains the _repair_, not the choice

There is exactly one substantial piece of design prose about threading in the Buzz repo, and it is an admission of cost. `docs/nips/NIP-CW.md` ("Channel Window") is a house NIP Buzz wrote to make the ordinary chat timeline queryable — something the pointer model broke:

> **A NIP-01 filter can only _match_ tag values; it cannot express their absence. "Channel messages that are **not** replies" — the timeline every threaded-chat client renders first — is therefore inexpressible in vanilla filters, so generic clients page the full event stream and reassemble threads client-side. That costs bandwidth proportional to reply volume, and worse, it breaks pagination correctness: `limit` counts raw events, so a page of 50 events may contain 3 top-level rows or 50, and the client cannot ask for "the next 50 rows."**
>
> — `docs/nips/NIP-CW.md:23` (§Motivation)

Read that as what it is. The default view of a chat channel — "show me the messages, not the replies" — is not expressible, so the relay had to grow a proprietary filter extension (`top_level: true`), two new relay-signed event kinds (`39005` thread summary, `39006` window bounds), a composite keyset cursor, and a formal degradation protocol for relays that don't implement it. **That is roughly 200 lines of specification whose entire purpose is to undo a consequence of threading by pointer.** Had a thread been a child channel, the same query would have been `{"kinds":[9],"#h":["<channel-uuid>"]}` with no extension at all.

This is the strongest available evidence about Buzz's reasoning, and it is evidence _against_ the choice, written by the people who made it — while not reversing it.

### (c) What is inferable from the code's shape (labelled inference, not statement)

Three things the source shows and no document says.

**1. Threading is implemented once and applies to every channel-scoped kind — for free.** Thread resolution is not gated on "is this a chat message." It is gated on whether the kind is channel-scoped at all:

```rust
let thread_meta = if requires_h_channel_scope(kind_u32) {
    if let Some(ch_id) = channel_id {
        resolve_nip10_thread_meta(tenant.community(), &event, ch_id, state)
```

— `crates/buzz-relay/src/handlers/ingest.rs:2246-2248`

So stream messages (kind 9), rich messages (40002), **forum posts (45001) and forum comments (45003)**, canvases, and git issues all inherit threading with no per-kind work. A container model would require every new content kind to know how to mint a container and seed its roster. This is a real engineering economy and it is invisible in the docs. _(Inference.)_

Note the forum case specifically: kinds 45001 (`KIND_FORUM_POST`, "A forum post (thread root)") and 45003 (`KIND_FORUM_COMMENT`, "A comment reply on a forum post") are a **fresh surface Buzz designed itself**, with no NIP-10 legacy to honour — the kind comment even records a prior redesign, "V1 used addressable range (30001–30003) — wrong" (`crates/buzz-core/src/kind.rs:487-494`). Given a clean slate they still made root-vs-reply a _kind_ distinction and left the actual parenthood to NIP-10 `e` tags. That is the clearest signal available that pointer-threading is the house default, not a per-surface judgement.

**2. Buzz had a container primitive and did not use it.** A Buzz channel is a Postgres row with a UUID primary key, a five-role roster (`Owner | Admin | Member | Guest | Bot`), a visibility flag, and relay-signed discovery events `39000`/`39001`/`39002`. Creating one is `kind:9007`. Nothing prevented a thread from being a child channel — and nothing anywhere considers it. The likely reason is that channel creation is _expensive in protocol terms_: every thread would emit three discovery events and appear in channel enumeration. But that reasoning appears nowhere. _(Inference.)_

**3. The "infinitely nested" claim is false, and the true limit is undefended.** The enforced cap is 100:

```rust
let depth = meta.depth + 1;
if depth > 100 {
    return Err("thread depth limit exceeded".to_string());
}
```

— `crates/buzz-relay/src/handlers/ingest.rs:646-649`

NIP-CW records it as a permission rather than a decision — _"relays MAY cap depth; Buzz rejects beyond 100"_ (§Top-level Classification). **No document justifies 100, and no document reconciles it with `thread.rs`'s "infinitely nested."** That is what an inherited default looks like: a resource guard picked to stop a pathological writer, never a product statement about how deep a conversation should go.

There is a second, sloppier tell in the same function. When a parent has no `thread_metadata` row yet, depth is _guessed_:

```rust
let depth = if parent_root == parent_bytes { 1 } else { 2 };
```

— `crates/buzz-relay/src/handlers/ingest.rs:680`

A reply whose grandparent chain is deeper than 2 is recorded as depth 2 on that path. Depth is load-bearing for NIP-CW's top-level classification, and it is approximated here. A field nobody's product depends on precisely is a field nobody designed.

### (d) Upstream: was Buzz inheriting a convention? **Yes, decisively.**

NIP-10 is Nostr's threading convention, written in 2022 for kind-1 notes on a **global public feed where containers genuinely did not exist**. Its only stated rationale is about _marked versus positional_ `e` tags — an intra-scheme cleanup, not a model choice:

> "This scheme is preferred because it allows events to mention others without confusing them with `<reply-id>` or `<root-id>`."
>
> — NIP-10, on marked tags

> "Positional `e` tags are deprecated because they create ambiguities that are difficult, or impossible to resolve when an event references another but is not a reply."
>
> — NIP-10, §Deprecated positional e tags

**NIP-10 says nothing about containers versus pointers, and nothing about nesting depth.** There was no depth decision to inherit, because upstream never made one. Arbitrary depth in Nostr is not a choice anybody defended; it is the absence of a constraint nobody wrote.

So the honest reconstruction of Buzz's history: NIP-10 solved threading for a container-less global feed. Buzz adopted NIP-29 relay-based groups — acquiring real containers — and kept NIP-10 for threads, because it was already there, it interoperates with the wider Nostr ecosystem (`e2e_nostr_interop.rs` tests exactly this, and `nak`, a third-party CLI, is verified against it — `NOSTR.md:193-194`), and it costs one tag. Then discovered the timeline was unqueryable and wrote NIP-CW.

---

## 2. The hypothesis, tested

The brief proposed four constraints. **Two hold, two are falsified.** The falsified pair are the confident ones.

### Claim 1 — "Nostr has no containers." **Half true; false as an explanation of Buzz.**

True of bare NIP-01: one primitive, a signed event. **But Buzz does not run on bare NIP-01.** It implements NIP-29 relay-based groups, and the spike already established this in detail (`research/20260727_buzz-protocol-capability-spike.md` §2): a channel is a Postgres row with a UUID PK (`crates/buzz-db/src/channel.rs`), a `ChannelVisibility` and `ChannelType`, a five-variant `MemberRole` roster, and relay-signed discovery events. `SUPPORTED_NIPS` includes 29 (`crates/buzz-relay/src/nip11.rs:15`).

So the constraint was real when the convention was written and **had already been lifted by the time Buzz chose**. Buzz had containers. It did not use them for threads. The constraint cannot be the reason.

**Verdict: holds for NIP-10's origin in 2022. Does not hold for Buzz.**

### Claim 2 — "Relays are dumb stores; a first-class thread object would require derived state." **Falsified, strongly.**

Buzz's relay maintains derived thread state as a matter of course. `thread_metadata` is written **atomically with the event insert** (`ingest.rs:2248`), and it carries materialized counters that every write path must maintain:

> **Thread counters**: `reply_count` and `descendant_count` are materialized on thread root events. Any code that inserts replies must update these counters
>
> — Buzz `AGENTS.md:155-156`

The architecture doc names the whole category:

> **Disposable projections**: mentions, thread metadata, reactions, full-text
>
> — `docs/multi-tenant-relay.md:86`

And the relay goes further still: it _synthesizes and signs_ thread summaries at query time (`kind:39005`, carrying `{reply_count, descendant_count, last_reply_at, participants}`), maintains a Postgres FTS index, and keeps a per-community SHA-256 audit hash chain. A relay that materializes a thread index, maintains counters through delete paths, and signs aggregate overlays with its own key is not a dumb store by any reading.

**The load-bearing correction:** Buzz pays the derived-state cost _anyway_. The pointer model did not save it from maintaining a thread index — it just made the index a private projection instead of a public object. So "avoiding derived state" cannot be the reason either.

**Verdict: falsified.**

### Claim 3 — "Parenthood is the child's own signed statement; nobody can reparent your message." **Holds. Strongest of the four.**

A reply's parenthood lives inside the signed event as `["e", <parent-id>, "", "reply"]`. The relay _validates_ it — it rejects a mismatched root (`"root tag does not match thread ancestry"`, `ingest.rs:634` and `:678`), rejects an unknown parent (`"reply parent not found"`, `:610`), and rejects a cross-channel parent (`"parent event belongs to a different channel"`, `:613-614`) — but it cannot **change** it without forging a signature it does not hold.

And there is no verb to try. Grepping `crates/`, `web/`, and `desktop/` for `reparent|move_thread|thread_move|change_parent|set_parent` returns **only** Unix process reparenting in the Tauri agent sweeper. **Buzz has no move-thread, merge-thread, or reparent operation of any kind.**

This is worth stating precisely, because it is the one property the container model structurally cannot offer: in a container model, "which thread is this message in" is a mutable field on a row that a server can rewrite. In the pointer model it is a fact the author signed.

**Verdict: holds.** Note it is a _property_ the model has, not necessarily the reason it was chosen — nothing in Buzz claims it. But it is real, and it is the strongest thing to be said for the pointer model on the merits.

### Claim 4 — "Arbitrary depth is free; limiting it would take extra enforcement." **Holds as stated — and Buzz spent the enforcement twice.**

Both spends are informative:

1. **A hard cap at depth 100** (`ingest.rs:646-649`) — a resource guard, undefended, discussed in §1(c).
2. **NIP-CW's top-level classification**, which defines the _product_ view in exactly two levels:

> An event is **top-level** — eligible to be a window row — iff its depth is 0, or its depth is 1 and it is broadcast.
>
> — `docs/nips/NIP-CW.md:86`

> **broadcast**: a reply is _broadcast to the channel_ iff it carries the exact tag `["broadcast", "1"]`. Broadcasting is an author's opt-in to surface a **depth-1** reply on the channel timeline as well as in its thread.
>
> — `docs/nips/NIP-CW.md:84`

**So Buzz's rendered product is two-level.** Channel timeline shows depth 0, plus depth-1 replies the author chose to broadcast — which is precisely Slack's "also send to channel." The thread pane shows the subtree below. Buzz stores 100 levels and shows 2.

**Verdict: holds, with a qualification that reframes the whole question — Buzz's product does not use the depth its storage permits.** Arbitrary depth here is not a feature anybody shipped. It is an unenforced default with a resource cap bolted on, and a two-level product rendered on top of it.

### The constraint the hypothesis missed — and it is the one that actually bit

**Filter expressiveness.** NIP-01 filters match tag _presence_ and cannot express _absence_, so "messages that are not replies" is unqueryable (NIP-CW §Motivation, quoted in §1(b)). This is downstream of the pointer model, not of Nostr's lack of containers — and it is the constraint that cost Buzz a whole NIP.

**It does not transfer to us.** Nostr's problem is that its _query language_ is a tag-matching filter. Ours is SQLite. `WHERE parent_entry_id IS NULL` is a one-line predicate on an indexed column. The single largest cost Buzz pays for the pointer model is a cost DorkOS would simply not incur.

### Corrected statement of the real reason

Not "it is what falls out of Nostr's constraints" — Buzz had escaped most of those constraints and kept the convention regardless. The accurate version has three parts, in order of weight:

1. **Inherited convention with interop value.** NIP-10 predates Buzz, is what other Nostr clients speak, and Buzz tests against third-party tooling (`nak`) to keep that interop. Changing threading would forfeit it.
2. **Containers are not free; event ids are.** A Nostr event id is a content hash a client mints offline, with no permission and no round trip. A NIP-29 channel requires an authorized `kind:9007`, a roster, and three relay-signed discovery events. **Pointer-threading is the only threading a client can perform unilaterally.** This is the sharpest form of the brief's claim 1, and it survives contact with the source where the original form does not.
3. **One mechanism covers every channel-scoped kind** at zero marginal cost per kind (§1(c), inference).

And the cost, paid later and in public: NIP-CW.

---

## 3. Comparative survey — how the industry actually splits

Six products, and the split is real: **Discord chose containers, everyone else chose pointers, and Zulip chose something that is neither.** What follows is what each one gave up, and — where it exists — what the vendor said about why.

### Zulip — a mutable string key, not a thread at all

**Neither container nor pointer.** The only container is the channel; a **topic** is a required string label on every message. There is no topic object, no topic id, no parent pointer. A conversation is addressed by the pair `(channel, topic)`, and topic lists are _derived_ by aggregating over messages. The message field is still literally named `subject` — [Zulip's API docs](https://zulip.com/api/get-messages) call it "a legacy holdover from when topics were called 'subjects'."

Depth is **two levels total** (channel → topic) and there are no sub-topics — not by rule, but because a message carries one string and no parent, so deeper nesting is _unrepresentable_.

Zulip's stated rationale is the best in the industry, and the design thesis is one sentence ([Introduction to topics](https://zulip.com/help/introduction-to-topics), verified verbatim):

> "In other apps, threads generally start from a message in the main channel feed." … **"There's nothing special about the first message in a thread. Instead, each thread is labeled with a topic."** … "This makes threads in Zulip easy to find."

That is the whole idea: **a Slack thread's identity is a message; a Zulip thread's identity is a name.** Everything else follows — because the key is a mutable string, you can move, rename, split, merge, and resolve conversations with `PATCH /messages` and a `propagate_mode` of `change_one | change_later | change_all` ([update-message](https://zulip.com/api/update-message)). Resolving a topic is literally a rename: it "[p]uts a ✔ at the beginning of the topic name" ([resolve-a-topic](https://zulip.com/help/resolve-a-topic)).

**What it gives up**, and Zulip's own tracker says so — [zulip/zulip#1191](https://github.com/zulip/zulip/issues/1191), open since 2016:

> "Currently stream topics are represented as strings in the Message table. This decision dates back to a time when users were not allowed to retroactively change topics on prior messages… When you change the name of a topic in Zulip, the back end has to basically fan out writes to change all messages that used the original topic name."

Also: no per-topic membership or ACL (a topic cannot be private or have a roster), and a mandatory topic at compose time — enough of a tax that Zulip shipped ["general chat" channels](https://zulip.com/help/general-chat-channels) and empty topics to opt out of it.

### Slack — pointer; the parent message _is_ the thread

`thread_ts` is the parent message's own `ts`. There is no thread object; thread state (`reply_count`, `reply_users`, `latest_reply`) is denormalized onto the parent. [Slack's docs](https://docs.slack.dev/messaging/retrieving-messages/):

> "Identify parent messages by comparing the `thread_ts` and `ts` values. If they are _equal_, the message is a parent message." … "One quirk of threaded messages is that a parent message object will retain a `thread_ts` value, even if all its replies have been deleted."

Depth is one, enforced by **server-side normalization** rather than rejection — [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postMessage/) says "Avoid using a reply's `ts` value; use its parent instead," and a reply's `ts` simply resolves to the same parent. **No Slack doc sentence prohibiting nesting was found**; do not cite one.

"Also send to channel" is a **separate channel-level message** with `subtype: thread_broadcast`, which Slack's own docs describe as "a pointer or reference to the actual thread." That is a compensating hack: the pointer model hides replies from scrollback, so Slack invented a second message whose only job is to make an invisible thread visible.

Slack's design retrospective explains the _UX_, never the data model ([Part 1](https://slack.design/articles/threads-in-slack-a-long-design-journey-part-1-of-2/), [Part 2](https://slack.design/articles/threads-in-slack-a-long-design-journey-part-2-of-2/)):

> "We decided to start our first exploration of Threads based on the same model as Twitter, because it looked like the most flexible solution." … "The main problem with this first version was the 'expanding' effect that you would experience when opening a thread… it was difficult not to lose your bearings when closing a thread."

> "Hiding replies from the channel content turned out to be the single most meaningful change we made while designing Threads."

Note what that records: **Slack started at Twitter-style unlimited depth and abandoned it for navigation reasons.** Depth-one is documented as a UX outcome, not a storage decision. **No Slack engineering post explaining why a thread is a `ts` pointer was found.**

### Discord — threads genuinely are channels

The only true container model in the survey. A thread is a channel object of type `PUBLIC_THREAD` (11), `PRIVATE_THREAD` (12), or `ANNOUNCEMENT_THREAD` (10), with `parent_id` repurposed to name the parent channel, a `thread_metadata` blob (`archived`, `auto_archive_duration`, `locked`, `invitable`), **its own explicit roster** of thread member objects, and dedicated permission bits (`SEND_MESSAGES_IN_THREADS` — "[t]he `SEND_MESSAGES` permission has no effect in threads"). [Discord's docs](https://docs.discord.com/developers/topics/threads) describe them as "temporary sub-channels" that "share and repurpose a number of the existing fields from the channel object."

Depth is one, enforced **structurally** — `parent_id` may only name a text/announcement/forum/media channel, so a thread cannot parent a thread. **I could not confirm a docs sentence saying "threads cannot be nested"**; the constraint is a type constraint, not prose.

**What containers cost, in Discord's own words** — this is the most valuable part of the row:

> "Since the number of archived threads can be quite large, keeping all of them in memory may be quite prohibitive." → "Therefore guilds are capped at a certain number of active threads, and only active threads can be manipulated."

> "Users cannot edit messages, add reactions, use application commands, or join archived threads."

So containers bill you in **working set and lifecycle machinery**: active-thread caps, archive/unarchive-on-write, locking, thread-list sync events, bots having to join. **No Discord engineering post explaining "why threads are channels" was found** — only the launch blog's product framing.

### Matrix — pointer, with threads-as-rooms explicitly considered and rejected

This is the single most important row for our purposes, because **Matrix is the only vendor that wrote down a container-versus-pointer analysis.**

The model is a typed relation: `"m.relates_to": {"rel_type": "m.thread", "event_id": "$thread_root"}`, stabilized in Matrix v1.4. Depth is flat and the enforcement rule is explicit in [MSC3440](https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/3440-threading-via-relations.md):

> "This MSC does not include support for nested threads." … **"A `m.thread` event can only reference events that do not have a `rel_type`."**

Matrix had the cheapest containers imaginable — rooms are its _only_ primitive — and rejected them anyway. Its Alternatives section lists the disadvantages of "threads as rooms":

> - "Access control, membership, history visibility, room versions etc needs to be synced between the thread-room and the parent room"
> - "Harder to control lifetime of threads in the context of the parent room if they're completely split off"
> - "Clients which aren't aware of them are going to fill up with a lot of rooms."
> - "Bridging to non-threaded chat systems is trickier as you may have to splice together rooms"

And on depth, the only real justification any vendor offers: threads "can be of arbitrary width… and depth… which complicates UI design when you just want 'simple' threading."

**What the pointer model cost Matrix is equally well documented, and it is the honest other side.** Threads broke the one-timeline-per-room assumption that read receipts and notification counts rested on. MSC3440 concedes it — "Read receipts and read markers assume a single chronological timeline" — and shipping threads took **six MSCs**, including [MSC3771](https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/3771-read-receipts-for-threads.md) (a `thread_id` on receipts, or the literal `"main"`) and MSC3773 (per-thread notification counts). MSC3771's own drawbacks list unbounded receipt growth and inconsistent read state between threaded and unthreaded clients.

### Microsoft Teams — pointer, root/reply split in the API

A channel post is a root `chatMessage`; replies carry `replyToId` and live in a `replies` navigation collection ([Graph docs](https://learn.microsoft.com/en-us/graph/api/resources/chatmessage?view=graph-rest-1.0)). Depth is one. A telling detail: reply ids are "unique within a chat/channel/reply-to-message" — namespaced _under the root_, which is as close to a container as you get without one.

The recent "Threads" layout (default for the first channel in new teams from May 2026) is **presentation only** — [Practical365](https://practical365.com/teams-threaded-layout/): "the underlying data for channel messages remains the same." Teams channels are extremely heavyweight (each provisions a SharePoint folder and a governance surface), so one-channel-per-conversation was never available. **No Microsoft statement about the data-model choice was found.**

### GitHub and Linear — pointer, depth one, plus the thing chat lacks

GitHub PR review comments are a pointer in REST (`in_reply_to_id`) and a container in GraphQL (`PullRequestReviewThread` with `isResolved`, `resolveReviewThread`). Depth is one and GitHub is the only vendor that says so plainly: **"Replies to replies are not supported"** ([REST docs](https://docs.github.com/en/rest/pulls/comments)). A GitHub thread is anchored to a _diff position_, not a parent message — a third identity model — which is why threads go `isOutdated` when code moves.

Linear: `Comment.parent`, one level, plus `resolvedAt` and `resolvingUser`.

**The contrast that matters:** GitHub and Linear threads have a **terminal state with a resolver identity**. Zulip fakes one (the ✔ rename). Slack, Discord, Matrix, and Teams have none. Chat products model threads as conversations that _decay_ — scroll away, auto-archive, or nothing. Dev tools model them as conversations that _complete_.

### Summary table

| Product      | Model                                                                         | Field or object                                                                               | Depth                                        | Enforced by                                                | What it gives up                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Zulip**    | Mutable **string key** on each message                                        | `subject` on message; topics listed as `{name, max_id}`; `PATCH /messages` + `propagate_mode` | 2 levels total                               | Data model — one string, no parent pointer                 | No topic id → renames fan out writes over every message; no per-topic membership/ACL/private topics; mandatory topic at compose time        |
| **Slack**    | Pointer; parent message **is** the thread                                     | `thread_ts` = parent's `ts`; state denormalized on parent; broadcast = `thread_broadcast`     | 1                                            | Server normalizes a reply's `ts` to its parent             | Replies invisible in scrollback (hence broadcast); no rename/move/split/promote; no membership (only follow); no resolve                    |
| **Discord**  | **Container** — a thread _is_ a channel                                       | types 10/11/12, `parent_id`, `thread_metadata`, thread member objects, own permission bits    | 1                                            | Type system: `parent_id` may only be a non-thread channel  | Working set → **active-thread caps per guild**; archived threads read-mostly; archive/lock/sync lifecycle machinery; bots must join; sprawl |
| **Matrix**   | Pointer (typed relation); container **explicitly rejected**                   | `m.relates_to: {rel_type: "m.thread", event_id}` + `is_falling_back`                          | 1, flat                                      | Spec: a thread event may only reference an unrelated event | Read receipts **and** notification counts each needed a new MSC; receipt growth; inconsistent read state across client versions             |
| **MS Teams** | Pointer, root/reply split in the API                                          | `chatMessage.replyToId` + `replies` collection                                                | 1                                            | API surface — replies exist only under a root              | No thread identity/membership/permissions/retention/resolve; the 2026 "Threads" layout is presentation only                                 |
| **GitHub**   | Hybrid: pointer (REST) / container (GraphQL), anchored to a **diff position** | `in_reply_to_id`; `PullRequestReviewThread` + `resolveReviewThread`                           | 1 — _"Replies to replies are not supported"_ | Server, documented                                         | Thread bound to path/line → goes outdated when code moves; no membership; no move/rename                                                    |
| **Linear**   | Pointer + resolve bit                                                         | `Comment.parent`, `resolvedAt`, `resolvingUser`                                               | 1                                            | API/product                                                | No membership, no move/rename; issue-scoped                                                                                                 |

### What actually drove the split

**Not container cost — container _state weight_.** The intuitive story is that products with cheap channels chose containers and products with expensive channels chose pointers. That explains Discord (threads inherit the parent's permissions, don't count against the channel cap, and acquire members implicitly) and it explains Slack and Teams (a channel is the unit of membership, retention, eDiscovery, external sharing, and for Teams a SharePoint folder — one per conversation would multiply the governance surface).

**Matrix breaks that story cleanly, and its explanation is the better one.** Matrix has the cheapest containers in the industry and rejected them anyway, because **a container inherits its parent's entire state machine and must be kept in sync with it, while a pointer inherits nothing**: "[a]ccess control, membership, history visibility, room versions etc needs to be synced between the thread-room and the parent room," and "[c]lients which aren't aware of them are going to fill up with a lot of rooms."

**A second driver nobody advertises: retrofit cost.** Slack shipped threads in January 2017, years after channels, into an existing message store, search index, mobile client and compliance-export pipeline — adding a nullable `thread_ts` is a migration, adding a container is a re-architecture. **Teams is the natural experiment that confirms it:** Microsoft wanted the threaded experience badly enough to make it the default layout for new channels from May 2026, and still did not change the data model — "the underlying data for channel messages remains the same." When a product this size adds threads, it adds a _rendering_. Zulip is the control: it never retrofitted anything, because topics were there from day one.

**And the rule that unifies all six:** whether a thread is a container correlates with **whether the product needed per-thread state.** Membership, permissions, archival, unread, resolution — each needs somewhere to live. Discord wanted membership and archival and already had a cheap object, so threads became channels. Slack wanted only unread and built a global Threads view instead of an object. Matrix wanted unread, discovered mid-flight that it needed a key, and synthesized one from the root event id (`thread_id`, plus the magic `"main"`) — **a container reconstructed from a pointer**, which is the most instructive artifact in the survey and the one §5 has to answer.

Three further findings that bear directly on our decision:

1. **Depth-one is unanimous — six of six — and essentially undefended.** The only written justification is Matrix's, and it is about UI, not storage. Slack independently started at unlimited depth and retreated. **ADR `260726-170125`'s "chosen to match Slack and Matrix" is accurate, and the consensus is broader than the two products it names.** Buzz's storage depth of 100 is the outlier, and Buzz's _rendered product_ is two-level like everyone else's (§2, claim 4).
2. **The live axis is not container-versus-pointer — it is whether a thread's key is assigned at compose time and mutable afterwards.** That is Zulip's actual innovation and it is orthogonal to representation: a container can be mutable (Discord threads rename), and a pointer cannot be (a Slack thread can never be renamed, because its name is a message).
3. **Resolve is the missing primitive in chat and the default in dev tools.** For a product where a thread is a unit of _work_ with a definite end, this matters more than depth.

One honesty note: **no neutral third-party essay using "container versus pointer" framing was found.** MSC3440's Alternatives section is the only rigorous vendor treatment. If that framing appears in this document, it is ours, not the industry's.

---

## 4. What changing would cost or gain DorkOS

### 4.1 What the child-room model gives us for free

Every one of these is keyed on `roomId` today, and a thread — being a room — inherits all of them with no code:

| Capability                         | Mechanism                                                                                       | Source                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Roster**                         | `room_members` PK `(roomId, authorId)`; a thread inherits the parent's whole roster at creation | `rooms.ts:134-149`; `room-roster.ts:71-90`           |
| **Read cursor**                    | `roomMembers.lastReadSeq`, keyed `(member, room)` — thread unread is free and server-computed   | `rooms.ts:145-146`                                   |
| **Monotonic `seq`**                | `room_entries` PK `(roomId, seq)`, allocated in an IMMEDIATE transaction; a thread gets its own | `rooms.ts:159-167`                                   |
| **Gap-free SSE**                   | `RoomBroadcaster` fans out per `roomId`; cursors framed `${roomId}-${STREAM_EPOCH}-${seq}`      | `room-stream.ts`; `room-events-handler.ts:69-73,118` |
| **Cascade guard**                  | `authorsInCascade` scoped `(room_id, cascade_root)`                                             | ADR `260726-170127`; `rooms.ts:195-198`              |
| **Turn budget**                    | per-room ceiling on automatic replies                                                           | `turn-budget.ts`                                     |
| **Response mode**                  | `roomMembers.responseMode`, inherited from the parent for a thread                              | `room-roster.ts:211-214`                             |
| **Archive, workspace, addressing** | plain room fields                                                                               | `rooms.ts:98-109`                                    |

This is a genuine and large free ride, and ADR `260726-170125` claims it correctly: _"Threads cost one nullable `parentId`, not a second conversation model."_

### 4.2 What an entry-level model would have to re-derive — precisely

Taking each in turn, honestly:

**Genuinely lost, must be rebuilt: per-thread read state.** This is the only one. `lastReadSeq` is one integer per `(member, room)`. Per-thread unread would need a narrow second table keyed `(member, room, threadRootEntryId) → seq`. Worth noting how much worse this is for Buzz than it would be for us: their NIP-RS had to invent a `thread:<root-event-id>` context scheme **and** a parent-fold rule —

> `effective(thread:<root>) = max(merged[thread:<root>], merged[<channelId>])`
>
> — `docs/nips/NIP-RS.md:165`

— plus rules for marking a channel read without swallowing its threads (`NIP-RS.md:199-209`). That is ~90 lines of specification. Ours would be one table with a compound primary key and an index, because we have a server that can read its own cursors. Call it a day of work, not a design project.

**Partly lost, cheaply replaced: per-thread streaming and ordering.** `RoomBroadcaster` keys on `roomId`, so a thread pane would either subscribe to the parent room and filter client-side, or the broadcaster grows a second index. Entries in a thread would share the parent's `seq` space, so a thread's replay is a _filtered_ view of the parent's — resumable and gap-free, but the cursor stops meaning "position in this thread." For a cockpit where a thread is tens of entries inside a room of thousands, filtering is fine; if it ever isn't, a per-thread ordinal is a column, not an architecture.

**Not lost at all: the top-level query.** `listEntries` learns `WHERE parent_entry_id IS NULL`. This is the cost that forced Buzz to write an entire NIP, and for us it is a predicate on an indexed column. §2 covers why.

**Not lost, simplified: roster.** A thread would have no roster of its own and would use the parent's — which is what `inheritedFrom` is already faking by copying every row.

### 4.3 What the child-room model costs us — measured, not speculative

**1. Each thread mints a fresh turn-budget window.** Our own code says so:

> **Rooms are free.** A caller that can create rooms multiplies its budget by creating them: measured through the real mount, a cap of 2/room bought 16 turns across 8 channels. **Threads are cheaper still, since a thread inherits the parent's whole roster, so five threads off one parent bought 12.**
>
> — `apps/server/src/services/rooms/turn-budget.ts`

Five threads off one parent bought six times the per-room cap. That is a measured budget leak that exists _because_ a thread is a room. Under an entry-level model a thread shares the parent's window and the multiplication does not happen. (The global cap still bounds the wallet — this is about the per-room instrument doing what it says.)

**2. Each thread mints a fresh cascade namespace, and the code already defends against it:**

> ```
> // A thread inherits the parent's whole roster, response modes included, so
> // opening one is a seeding operation and answers to the same rule
> // `createRoom` does: only the operator puts a SECOND agent in a room. It is
> // not a formality here — a thread is a new room, and `authorsInCascade` is
> // scoped `(room_id, cascade_root)`, so an ungated `createThread` would hand
> // an agent an unlimited supply of fresh cascade namespaces.
> ```
>
> — `apps/server/src/services/rooms/room-service.ts:317-322`

The `requireSeedingAllowed` call guarding `createThread` exists **only because a thread is a room**. In an entry-level model a thread shares the parent's cascade scope, the hole never opens, and the guard is unnecessary. ADR `260726-170127` already notes the ancestry rule is a within-room guarantee only — every thread is another room to be within.

**3. A thread carries a room's whole apparatus for something conceptually much smaller.** A `rooms` row with `slug: null` and `topic: null`, a title auto-summarized from the root entry's first 60 characters (`room-service.ts:340`, `summarize`), one inherited `room_members` row per member, and a `room_sessions` row per agent member — for three replies about a typo.

**4. Threads appear in `listRooms`.** `RoomService.listRooms` has no thread exclusion; a human "sees every room" (`room-service.ts:385-407`), so every thread is a candidate sidebar row. The `community-adapter` spec identifies this as wrong and requires the local adapter to filter them out (§4, U4: _"a room that is itself a thread is a leak of a storage model into the contract"_).

**5. One-level-and-refuse is a real ceiling** — and the ADR says so itself, in its own Negative section:

> One level of threading is a real ceiling, chosen to match Slack and Matrix. A thread of a thread has no representation and will eventually be asked for.
>
> — ADR `260726-170125`, Consequences → Negative

**6. We are already maintaining two representations.** The `community-adapter` spec has ruled that at the port a thread is an entry relation (`parentEntryId`, `threadRootEntryId`, `depth`) and `listRooms` never returns one — while local storage keeps the child room. It is candid about the price: _"This is the largest single consequence of the design"_ (§4), and it leaves an unresolved question about whether the client's thread surfaces break (§ Open questions, OQ1 — since answered). **A container that no consumer above storage can see is the worst of both models: you pay the container's cost and forfeit its benefit.**

### 4.3a Matrix already wrote our costs down, four years early

The costs in §4.3 were found by reading our own code. Matrix's MSC3440 enumerated the disadvantages of "threads as rooms" before rejecting it (§3), and the match is **four for four** — which is worth taking seriously, because we and they arrived at the same list independently, from opposite directions:

| MSC3440's disadvantage of threads-as-rooms                                                                                             | What it is called in our codebase                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Access control, membership, history visibility, room versions etc needs to be **synced** between the thread-room and the parent room" | `roster.inheritedFrom(parent.id, …)` copies every membership row, and `seedResponseMode` re-reads the parent to inherit `responseMode` (`room-roster.ts:71-90, 211-214`) |
| "Harder to control **lifetime** of threads in the context of the parent room if they're completely split off"                          | a thread carries its own `archived` flag and its own turn-budget window (§4.3, cost 1)                                                                                   |
| "Clients which aren't aware of them are going to **fill up with a lot of rooms**"                                                      | `listRooms` returns every thread as a `RoomSummary` (§4.3, cost 4)                                                                                                       |
| "**Bridging** to non-threaded chat systems is trickier as you may have to splice together rooms"                                       | exactly why `specs/community-adapter` §4 had to make the port entry-level and filter threads out of `listRooms` (§4.3, cost 6)                                           |

Matrix reached that list with the cheapest containers in the industry — rooms are its only primitive. We reached it with SQLite rows. **The cost is not about how expensive containers are to create; it is that a thread-container must be kept in sync with its parent forever**, which is the one thing a pointer never has to do.

### 4.4 What sets the timing: there is no thread UI to migrate

The cockpit's _entire_ thread surface today:

| Surface                            | What it is                                      |
| ---------------------------------- | ----------------------------------------------- |
| `router.tsx:242-252`               | a `thread?: string` search param on `/channels` |
| `ChannelsPage.tsx:20-21`           | `const roomId = thread ?? id ?? null`           |
| `use-room-document-title.ts:64-65` | same precedence, for the tab title              |
| `DashboardSidebar.tsx:131-133`     | same precedence, for the active-room highlight  |

That is four lines of precedence logic. There is **no thread pane, no "N replies" row, and no create-thread affordance** — the transport factory says so outright: _"Room settings (rename, topic, archive), roster edits and **thread creation** reach the client in later phases"_ (`room-methods.ts:5-9`), and the message action bar agrees: _"reactions and reply-in-thread land here in later phases"_ (`message-variants.ts:37`).

Server-side the surface is equally small: one route (`POST /:id/threads`, `routes/rooms.ts:208-225`), one service method (`createThread`), one request schema (`CreateThreadRequestSchema`), one error code (`NESTED_THREAD`), one enum member (`RoomKind` = `'thread'`), and two columns (`rooms.parentId`, `rooms.rootEntryId`).

**And the phase that would build the rest has not started.** `specs/rooms/02-specification.md` §10 lists it explicitly:

> | **R4** (DOR-527) | Threads: child rooms, summary rows, `conversation_context` digest | R3b |

R4 is the thread pane, the "N replies" summary row, and the thread digest — the entire product surface of threading — and it is gated behind R3b. Everything shipped so far (R0–R3a, R5, R6a/b) built rooms, addressing, the cascade guard and the sidebar. **Threading is specified and unbuilt.**

**This is the smallest this migration will ever be**, and the window closes when R4 starts. Every phase that ships a thread pane, an unread badge, or a reply affordance against the room shape makes it larger. Changing the model now costs a schema migration; changing it after R4 costs a schema migration plus a UI rewrite plus a data backfill.

### 4.5 Which is better for DorkOS's product?

The brief asks whether long agent tool-call sequences are a case where deep nesting helps. **They are not, and the reason is already settled.**

ADR `260726-170125` fixed the log granularity at the turn boundary: a room entry is a _completed_ turn, and _"a room-log entry is what another member should be able to read later. In-flight token deltas are not that."_ A tool-call sequence lives in the **session** event stream — runtime-owned, ADR-0310 — and only the finished turn lands in the room. So a fifty-step tool run never becomes fifty thread replies under _either_ model. It is one entry, and the depth question never arises.

Deep nesting would therefore only ever be reached by _conversational_ branching — and in a cockpit where agents carry `responseMode`, every branch point is another place an agent can be triggered. Unbounded depth multiplies the cascade surface for a benefit no shipping chat product has demonstrated: **six of six products in §3 stop at one level**, and the only vendor who justified it in writing (Matrix) cited UI complexity, not storage. Buzz's own product agrees — it stores 100 and renders 2 (§2, claim 4).

**So the depth argument for changing is weak, and the brief was right to be suspicious of it.** One level is very likely correct for DorkOS's product, and would remain correct after the change.

**What the survey says DorkOS should actually want is different, and the entry-level model is what unlocks it.** Two findings from §3 point the same way:

- **A thread should be resolvable.** GitHub and Linear give a thread a terminal state with a resolver identity; Zulip fakes one; no chat product has it. DorkOS is not a chat product — it is a cockpit where **a thread is usually a unit of work with a definite end** ("did the agent finish this?"). A `resolvedAt` / `resolvedBy` pair on the thread root is a natural fit and would be genuinely differentiating. On an entry it is two nullable columns; on a room it is two more fields on an object that already has too many.
- **A thread's key should not be a message.** Zulip's thesis — _"There's nothing special about the first message in a thread"_ — is the sharpest idea in the survey, and it is orthogonal to container-versus-pointer. Our `rootEntryId` already makes the root entry the key, and both candidate models keep it. Worth noting as a deliberate deferral rather than an oversight: we are choosing Slack's identity model, and if renaming or splitting threads ever matters, that is the decision to revisit — not this one.

The argument for changing is entirely about **where the relation lives**, not how deep it goes: the container is overhead we have measured (budget windows, cascade namespaces, roster duplication, sidebar leakage), it is overhead we are already writing translation layers to hide, and the pointer shape is the one all three prospective backends share.

---

### 4.6 The deciding dimension: which model gives an agent the right context?

Everything above is about display, membership and storage. The question that actually matters for DorkOS is narrower: **what does an agent know when it is triggered?** Two facts about the shipped code reframe it.

**Fact 1 — the agent is sent one message, and nothing else.** `composeRoomPrompt` is the entire context an agent receives:

```typescript
return [
  `New message in ${where} from ${request.authorName}:`,
  '',
  request.entry.body.text,
  '',
  `Reply as you would in a chat room. Your answer is posted into ${where}, where everyone in the room reads it.`,
].join('\n');
```

— `apps/server/src/services/rooms/room-turn-runner.ts:147-156`

No history, no roster, no parent entry. **An agent's memory of a room _is_ its session**, accumulated one message per turn.

**Fact 2 — the session binds per room, first-write-wins, with no hydration.** `roomSessions` has primary key `(roomId, authorId)` (`packages/db/src/schema/rooms.ts:220-229`), and `bindRoomSession` is an `onConflictDoNothing` insert followed by a read-back of the winner (`room-store.ts:577-584`). Nothing anywhere replays room history into a new session.

So the consequences the addendum names are real and confirmed: **an agent triggered in a thread starts blank**, and an agent added to a channel with 200 messages sees message 201 onward.

There is a sharp asymmetry worth naming, because it is the whole problem in one line. The room log _is_ already read with a history window — for the human:

```typescript
snapshot(roomId, viewerAuthorId, historyLimit) {
  const entries = this.store.listEntries(roomId, { limit: historyLimit });
```

— `room-service.ts:661-668`

**The retrieval substrate already exists and is already called on every human SSE connect. It is simply never called for the agent.**

### 4.6.1 Does the structure constrain the binding? **No — the axes are independent.**

Tested against the code rather than argued. The binding key is `(roomId, authorId)` and nothing more, so:

| Binding policy              | Under **child-room**                                                              | Under **entry-level**                                          |
| --------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Session per thread**      | **free** — a thread has its own `roomId`, so it gets its own session mechanically | one column: PK becomes `(roomId, threadRootEntryId, authorId)` |
| **Session per parent room** | one expression: bind on `room.parentId ?? room.id` at `room-trigger.ts:316`       | **free** — a thread's entries carry the parent's `roomId`      |

**The addendum's claim holds.** Both structures reach both policies, and in each case the non-default costs one small change. The structure does not lock the binding, so the context benefit is obtainable under either model and **cannot by itself decide the thread-model question.**

Two refinements to the claim, though:

- **It is a 2×2, not a 2×3.** "Session per room-tree" and "session per channel" are the same policy, because at one level of depth a thread's parent is always a channel or DM. There is no third cell.
- **The defaults differ, and defaults are what ship.** Child-room's free default is session-per-thread — the blank agent. Entry-level's free default is session-per-parent — the agent carries the channel's accumulated context into the thread. Since the blank-in-thread outcome is the one we do not want, **entry-level's default is the safe one and child-room's default is the bug.** That is a real argument, but a mild one: it is about which mistake you make by doing nothing, not about what either model permits.

### 4.6.2 The compaction trade, and why retrieval is the answer

One shared session per `(channel, agent)` sees everything and compacts sooner, losing old threads. Per-thread sessions stay bounded and start blind. The third answers, and what each costs us:

| Option                      | What it is                                      | Cost here                                                                                                     | Problem                                                                                                |
| --------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Hydrate-on-bind**         | replay the last N entries into the first prompt | ~1 line — `listEntries` exists and `snapshot` already calls it                                                | you must guess N, and it **accelerates** compaction: N entries sit in context forever, paid every turn |
| **Summarize-parent digest** | inject a rolling summary at bind                | R4 already names `conversation_context` — but it appears **only** in the phase table and is specified nowhere | a name without a design; also a guess, and stale by construction                                       |
| **Retrieval on demand**     | give the agent a tool to query the room log     | a tool over `listEntries`, which already exists                                                               | needs the agent to know when to ask                                                                    |

**Retrieval is right, and the reason is compaction itself.** Hydration happens once, at bind; when the session later compacts, the hydrated history is exactly what gets discarded, and there is no mechanism to get it back. Retrieval re-pays only when needed and **survives compaction**, because the agent can ask again. Hydration makes the compaction problem worse; retrieval is the only one of the three that makes it better.

**Now the addendum's instinct, tested: is a room the better substrate for retrieval?** The premise is that a room is addressable, replayable and membership-scoped while a tag-filtered scan is not. Checked against our schema, **the premise does not hold, and the conclusion inverts**:

- **Addressable** — an entry-level thread is `(roomId, threadRootEntryId)`, and `room_entries` already carries `uniqueIndex(roomId, id)`. That is a stable composite address.
- **Replayable** — the parent room's `seq` is monotonic and never trimmed, and a stable predicate over a monotonic log replays deterministically from a cursor. Nothing about filtering breaks resume.
- **Membership-scoped** — inherited from the parent room, which is _more_ correct than a thread carrying a roster that can drift from its parent's.

And the inversion: the query an agent doing retrieval most wants is **"what has been said in this channel, including its threads."** Under entry-level that is one predicate over one log. Under child-room it is a `UNION` across the parent's log and every child thread's log. **Entry-level is the better retrieval substrate, not the worse one.**

The "tag-filtered scan" framing imports Nostr's constraint — filters that cannot express tag absence (§2) — into a system that runs SQL. It is the same error the original hypothesis made, in a new place.

### 4.6.3 Agent output, and threads an agent opens for itself

Long tool-call sequences are settled and do not bear on depth: a room entry is turn-atomic, tool calls live in the runtime-owned session stream, and a fifty-step run is one entry under either model (§4.5).

**Threads that agents create for their own work are a different and better question, and here the two models genuinely diverge.** Under the child-room model an agent opening a thread is a privileged act that must be _gated_ — `requireSeedingAllowed` exists precisely because "an ungated `createThread` would hand an agent an unlimited supply of fresh cascade namespaces" (`room-service.ts:317-322`), and each thread also mints a fresh turn-budget window (§4.3). Under the entry-level model an agent opening a thread is an ordinary post carrying a `parentEntryId`: it inherits the parent's cascade scope and the parent's budget, so **no gate is needed and none of the multiplication happens.**

That matters because agent-opened threads are a _desirable_ behaviour — an agent reporting a long sub-result without flooding the channel is exactly the affordance Slack's broadcast exists to approximate. **The child-room model makes the good behaviour a privilege to be granted; the entry-level model makes it safe by default.**

### 4.6.4 What the platforms do

The closest existing evidence, and it lines up with §4.6.2 rather than against it. (Sibling research `research/20260727_agents-in-group-chat-industry-survey.md` verified these independently; quotes are its citations.)

**The norm is a scoped window, and the scope follows the thread.** Claude in Slack publishes exact numbers — the only vendor that does:

> "when mentioned in a channel, Claude will have access to the last 20 messages in that channel, including any files shared within those messages, while when using @Claude in a thread, it will have access to the last 50 messages in that thread."

Two things to take from that. First, **the assistant is given context it did not accumulate** — the platform assembles a window per invocation rather than relying on a long-lived session's memory. That is the opposite of our current design, where the agent's memory _is_ its session and the platform hands it one message. Second, **the thread window is larger than the channel window** (50 vs 20), which is the right instinct: a thread is bounded and self-contained, so more of it is affordable and more of it is relevant.

**Slack's own guidance to agent developers is, almost verbatim, the retrieval conclusion of §4.6.2:**

> "Do not store any Slack data you obtain. Instead, store metadata and pull in data in real time if needed."
>
> — [Slack agent design docs](https://docs.slack.dev/concepts/agent-design/)

That is a platform telling agent builders not to accumulate conversation into the agent's own memory, but to **key on an id and fetch on demand**. It is the same answer arrived at from the opposite direction, and it is worth more than our reasoning alone because it reflects what Slack learned from apps in production.

**And Slack's guidance endorses agent-opened threads** — the behaviour the child-room model would make a gated privilege (§4.6.3):

> "Agent responses should be made in threads. This prevents flooding the main conversation."

Slack goes further and makes it structural for assistants: "Slack will automatically group your app conversations into threads, shown in a timeline above the composer."

#### Correction: a primary-source pass broke my inference

An earlier draft of this section argued, as labelled inference, that a container model narrows what an agent can address — that a thread-scoped trigger makes the parent harder to reach, while a pointer hands the agent both scopes at once. **A subsequent primary-source pass over five platforms' bot APIs falsified that, and on two of the three axes it found, the container is _better_.** Recording the correction rather than quietly deleting it, because the reasoning was plausible and someone will reconstruct it.

**First and most important: the amount of context is identical under both models.** Five of five platforms deliver the agent one message plus an identifier — never the parent's text, never prior replies, never channel history. Matrix (pure pointer, and the vendor that explicitly rejected threads-as-rooms) and Discord (pure container) hand a bot exactly the same thing. **The data model does not determine what an agent receives.** That is direct evidence for §4.6.1's conclusion, from a source that had no stake in it.

Where the models do differ, three real ways — and the first two favour the container:

1. **Containers hand you a state key; pointers hand you a puzzle.** A container puts thread identity in the routing field the bot must read anyway — Discord's `channel_id`, Teams' `conversation.id` — where it is never missing and never ambiguous. Pointers put it in an _optional_ field: Slack's own sample handler is literally `const threadTs = event.thread_ts ?? event.ts`, and Zulip has **no thread id at all**, forcing a synthesized `(stream_id, subject)` key that `propagate_mode` can rename out from under a bot mid-conversation.
2. **Containers make scope a parameter; pointers make it an API choice.** In Discord, `GET /channels/{id}/messages` serves both scopes — pass the thread id or the parent id. In Slack, Matrix, Zulip and Teams they are different methods with different shapes (`conversations.replies` vs `history`; `/relations` vs `/messages`; narrow-with-topic vs narrow-without). On a pointer platform, "which context?" is forced into the code path and cannot be deferred.
3. **Delivery gating differs, and here the container is worse.** Container platforms gate at the _thread_ level — Discord: "Clients will not be informed of a thread through the gateway if they do not have permission to view that thread," and archived threads are not gateway-synced at all — so a bot can be structurally blind to threads inside a channel it can otherwise read. Pointer platforms gate at the parent.

**Why this does not move the verdict.** Both advantages are about _wire protocols with optional or absent fields_, and neither transfers: our thread key is `(roomId, threadRootEntryId)`, minted by us, never optional, never renamed, and already backed by `uniqueIndex(roomId, id)` — so we have the container's state-key property without the container. And scope-as-a-parameter is already the shape `specs/community-adapter` §4 specifies (`listEntries(roomId, { thread })`), so both models give us one method with a parameter. This is the NIP-CW pattern again (§2): a cost that is real for a public protocol and absent for a system that owns its own schema and query engine.

**What the pass genuinely changes is the retrieval recommendation, and it sharpens it.** Slack's context-management guidance argues _against_ naive full-thread hydration on every turn:

> "**Don't refetch entire threads:** Use structured state objects, like `{ goal, constraints, decisions, artifacts }`." … "**Token budgets per request:** Enforce token budgets and prefer small, relevant context slices over raw conversational exhaust."
>
> — [Slack, agent context management](https://docs.slack.dev/ai/agent-context-management/)

So the shipped answer is neither hydration nor unbounded retrieval: it is **agent-maintained distilled state plus targeted fetches.** §4.6.2's ranking stands — retrieval beats hydration because it survives compaction — but "give the agent a tool over `listEntries`" is the floor, not the finished design.

**And the industry has a settled answer on memory scope, which is worth adopting wholesale:** transcript memory keyed per **thread**, durable memory keyed per **user/resource**, and the channel is **not a memory scope anywhere**. LangGraph checkpoints on `thread_id` with a separate cross-thread `Store`; Mastra pairs `threadId` with a `resourceId` whose working memory persists across threads. Read against §4.6.1, that is a mild argument _for_ per-thread sessions — with the crucial condition that the agent can fetch, which is exactly what makes a per-thread session survivable and what we do not have today.

**One frontier finding worth banking.** Slack — the only vendor that built a first-class assistant surface — still refuses to hand over the transcript. What it added twice in 2026 (`assistant_thread_context_changed`, then `app_context_changed`) is **ambient context: which channel, DM, thread or canvas the user is currently looking at, as an ordered list of ids, never bodies.** The division of labour is deliberate and it is the sharpest idea in this survey: _the transcript is something the app can fetch; what the user is looking at right now is something only the platform knows._ We have that signal — the cockpit knows the active room — and we send an agent none of it.

## 5. Recommendation

**Move the thread relation from the room to the entry. Keep the one-level limit. Do it before the thread pane ships.**

Concretely:

- Add `parentEntryId` and `threadRootEntryId` to `room_entries`, with an index on `(roomId, threadRootEntryId)`.
- Retire `RoomKind = 'thread'`, `rooms.parentId`, and `rooms.rootEntryId`. `POST /:id/threads` becomes an ordinary post carrying `parentEntryId`; `NESTED_THREAD` stays as the refusal when the target entry already has a parent — **the one-level rule survives the change unchanged**, and is now enforced by one predicate instead of a room-kind check.
- Add the `(member, room, threadRootEntryId)` read-cursor table. This is the only genuinely new construct and it is the smallest piece of the work.
- `listEntries` gains `WHERE parent_entry_id IS NULL` for the timeline and `WHERE thread_root_entry_id = ?` for a thread.
- Delete the `requireSeedingAllowed` call in `createThread` and the roster-inheritance path — both exist only to serve the container.

**Why now rather than later:** four lines of client code and one route (§4.4), and **R4 (DOR-527) — the phase that builds the thread pane and the summary rows — has not started.** Doing this as R4's opening move costs a schema migration and a handful of call sites. Doing it after R4 costs a migration, a UI rewrite, and a backfill. The cheapest version of this change is available for exactly as long as R4 stays unstarted.

**And decide the agent-context question separately, because it is separable (§4.6.1).** These are three independent choices, and the structure change does not make any of them for us:

1. **Binding policy: retrieval first, then pick.** The industry has converged on **transcript memory per thread, durable memory per user/resource, and the channel as no memory scope at all** (§4.6.4) — which is a mild argument for per-thread sessions, on the strict condition that the agent can fetch what it is missing. Today it cannot, which is why per-thread reads as "blank" rather than "bounded." **So ship retrieval before choosing.** If you must choose now, take one session per `(parent room, agent)` — the entry model's free default, and the option whose failure mode is a longer context rather than an ignorant agent.
2. **Context: retrieval, but distilled — not raw refetch (§4.6.2, §4.6.4).** A tool over `listEntries` is the floor: the method exists and `snapshot()` already calls it for the human's SSE connect. Retrieval is the only candidate that **survives compaction**, because the agent can ask again. But Slack's shipped guidance is explicitly against refetching whole threads every turn — "prefer small, relevant context slices over raw conversational exhaust," carried between turns as a structured `{ goal, constraints, decisions, artifacts }` state object. Hydrate-on-bind remains the ~one-line stopgap if retrieval slips.
   2b. **Send the agent what only we know.** Slack's assistant APIs deliberately withhold the transcript and instead push **ambient context — which room the person is looking at, as ids** (§4.6.4). The cockpit has that signal and currently sends an agent none of it. It is cheap, it is not derivable by the agent, and it is the one piece of context a fetch cannot recover.
3. **Retire or specify `conversation_context`.** R4 names it in the phase table and **nothing specifies it anywhere in the repo.** It is a name without a design, and it is the third answer to a question retrieval answers better. Either give it a spec or delete the words.

**What I am _not_ recommending:** unbounded depth. Nothing in the survey supports it — six of six products stop at one level — and it makes the cascade surface worse (§4.5). Change the location of the relation; keep the ceiling. Buzz is the wrong model to copy here, and copying its depth while adopting its shape would be the one genuinely bad outcome of this analysis.

**Worth folding into R4 while it is open:** `resolvedAt` / `resolvedBy` on the thread root (§4.5). Two nullable columns on an entry, and the one affordance every dev tool has and no chat product does — which is the right side of that line for a cockpit.

### The strongest objection, and why it does not land

The survey in §3 produces one rule that argues _against_ this recommendation, and it deserves a direct answer rather than a footnote. Stated as the pattern across all six products: **whether a thread is a container correlates with whether the product needed per-thread state** — membership, permissions, archival, unread, resolution each need somewhere to live. The corollary: if threads will ever need their own state, give them an id on day one, because retrofitting one cost Matrix six spec changes and still left clients disagreeing about what had been read.

**And we do want per-thread state** — a read cursor (§4.2) and a resolve bit (§4.5). So the objection is live: are we walking into Matrix's mistake?

**No, because "has an id" and "is a container" are different things, and the objection conflates them.** An entry-level thread already has a stable, unique id: the root entry's, and `room_entries` already carries `uniqueIndex(roomId, id)` to guarantee it. Per-thread state attaches to `(roomId, threadRootEntryId)` — a real composite key — without a `rooms` row, a slug, a roster, a budget window or a cascade namespace. Matrix's own repair proves the point: MSC3771's `thread_id` is the **root event id**, plus the literal `"main"` for the unthreaded timeline. The survey's sharpest observation is that this is "a container reconstructed from a pointer" — and the reconstruction is exactly the cheap half of a container (a key to hang state on) without the expensive half (state that must be synced with a parent, §4.3a).

What made that expensive _for Matrix_ was circumstance we do not share: receipts were already shipped keyed on the room, in a federated protocol, across independent server and client implementations that had to keep interoperating through the change. **Our read cursor is one table in one SQLite database we own, and threading is unbuilt.** The retrofit that cost Matrix six MSCs costs us a compound primary key.

So the rule survives and points the other way: **give the thread an id on day one — `threadRootEntryId` — and do not give it a room.** The objection would land if we were choosing between "a thread with an id" and "a thread with no id." We are not; both candidate models key on the root entry (§4.5). We are choosing whether that id also drags a container, and every cost in §4.3 and §4.3a says it should not.

### Does ADR `260726-170125` need superseding?

**Yes — in part, one clause.** The ADR's load-bearing decision is its title: _a room is a membership-scoped durable stream, not a session_. That is untouched and correct — it is what makes a mixed-runtime room possible, and nothing here disturbs it. What this reverses is one sentence of the Decision section:

> A **thread is a child room** — the same entity with a parent, one level deep — so threads need no second model, and the "N replies" summary row is a projection of the child's log rather than a new storage concept.

…and its matching Positive consequence (_"Threads cost one nullable `parentId`"_). The Negative consequence about the one-level ceiling **stays true and stays in force**, because we are keeping the ceiling.

The repo has an exact precedent for this shape: `260713-143958` carries `status: superseded` with `superseded-by: 260727-182651`, and a Status section reading _"**Superseded in part** … **Only the [named] section below is reversed.** Everything else here still stands and is still the governing decision."_ Follow that pattern.

**What it touches:**

| Artifact                                         | Change                                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| ADR `260726-170125`                              | Status → superseded in part; new ADR "a thread is a relation between entries"                                                    |
| ADR `260726-170127`                              | Unchanged in substance; the "fresh cascade namespace per thread" hazard it guards simply stops existing                          |
| `specs/rooms/`                                   | Thread section rewritten                                                                                                         |
| `specs/community-adapter/02-specification.md` §4 | **Gets simpler.** The local adapter no longer needs a room→entry translation, and its open question OQ1 dissolves                |
| `packages/db/src/schema/rooms.ts`                | Two columns off `rooms`, two onto `room_entries`, one new cursor table + migration                                               |
| `packages/shared/src/room-schemas.ts`            | `RoomKind`, `CreateThreadRequest`, `RoomSummary.parentId`, entry schema                                                          |
| `apps/server/src/services/rooms/`                | `room-service.ts` (createThread, listRooms), `room-roster.ts` (inheritedFrom, seedResponseMode), `room-store.ts`, `room-rows.ts` |
| `apps/server/src/routes/rooms.ts`                | `POST /:id/threads` retired into `POST /:id/entries`                                                                             |
| `apps/client/src/`                               | Four lines (§4.4)                                                                                                                |

**Confidence and what would change my mind.**

- **Strongest parts:** the cost side (§4.3) is measured and quoted from our own code and comments; the Matrix correspondence (§4.3a) is four-for-four against a vendor's written list; the migration surface (§4.4) is a grep anyone can rerun.
- **The claim to attack** is that per-thread read state is the _only_ real loss (§4.2). If per-thread streaming turns out to need its own ordinal after all, the change is bigger than described — though still smaller than the container.
- **What would genuinely change the verdict:** evidence that the room structure _does_ constrain the session binding. §4.6.1 says it does not, on the grounds that the binding key is `(roomId, authorId)` and nothing more. If some other path keys agent context on the room in a way I did not find, the blank-thread problem becomes structural rather than a default, and the analysis inverts. I checked `room-trigger.ts`, `room-store.ts`, `room-turn-runner.ts` and the `room_sessions` schema; I did not audit every consumer of `roomId`.
- **One claim of mine was tested and falsified, and the retraction is in §4.6.4.** I inferred that container platforms narrow an agent's addressable scope; a primary-source pass over five platforms' bot APIs found the opposite on two of three axes — containers hand a bot an unambiguous state key and make scope a parameter, where pointers make it optional (Slack's `event.thread_ts ?? event.ts`) or absent (Zulip). It does not move the verdict, for the reason given there, but it is the clearest instance in this document of reasoning-from-shape losing to reading the docs. Treat the remaining unsourced inferences with that in mind.
- **Known gap:** I have not traced every client thread surface beyond the four found by grep — the same gap the `community-adapter` spec flags at its open question OQ1. Redo that grep as a read before DECOMPOSE.
- **Not re-verified:** §4.6.4's platform quotes come from a primary-source pass and from `research/20260727_agents-in-group-chat-industry-survey.md`; I did not independently re-fetch them. That pass flags its own caveats — notably that Slack's `app_mention` reference examples do **not** show `thread_ts` (its presence is documented only via Slack's sample code and SDK types), and that no Discord sentence requires a bot to _join_ a public thread to receive messages (the documented rule is view-permission). Do not harden either into a citation without checking.

---

## Sources

- **Buzz**, `github.com/block/buzz` @ `654f384906b5c720a60a199d85031a6f1cb6efc9` (2026-07-27), Apache-2.0, shallow clone. Cited: `crates/buzz-db/src/thread.rs`, `crates/buzz-relay/src/handlers/ingest.rs`, `crates/buzz-core/src/kind.rs`, `crates/buzz-relay/src/nip11.rs`, `docs/nips/NIP-CW.md`, `docs/nips/NIP-RS.md`, `docs/multi-tenant-relay.md`, `NOSTR.md`, `AGENTS.md`.
- **NIP-10**, `github.com/nostr-protocol/nips/blob/master/10.md` — marked `e` tags; no container or depth rationale.
- **DorkOS**: `packages/db/src/schema/rooms.ts`, `apps/server/src/services/rooms/{room-service,room-roster,room-stream,turn-budget}.ts`, `apps/server/src/routes/rooms.ts`, `apps/client/src/{router.tsx,layers/widgets/room-view/ui/ChannelsPage.tsx}`, ADRs `260726-170125` / `260726-170127`, `specs/community-adapter/02-specification.md`.
- **Prior research**: `research/20260727_buzz-protocol-capability-spike.md` (§6, §11(b)), `research/20260724_multi-user-communities.md`, `research/20260727_multi-user-review-exchange.md`. No prior doc in `research/` covers thread data models. **§4.6.4's platform quotes are cited from `research/20260727_agents-in-group-chat-industry-survey.md`**, a sibling doc written concurrently — see its §1.2 and §1.3 for the primary sources and its own confidence notes.
- **§4.6.4 bot-context sources:** [Slack agent context management](https://docs.slack.dev/ai/agent-context-management/), [`app_mention`](https://docs.slack.dev/reference/events/app_mention/), [`assistant_thread_started`](https://docs.slack.dev/reference/events/assistant_thread_started/), [`app_context_changed`](https://docs.slack.dev/reference/events/app_context_changed/), [`conversations.replies`](https://docs.slack.dev/reference/methods/conversations.replies/), [Bolt Assistant class](https://docs.slack.dev/tools/bolt-js/concepts/using-the-assistant-class/); [Discord Threads](https://docs.discord.com/developers/topics/threads) and [Message resource](https://docs.discord.com/developers/resources/message); [Zulip outgoing-webhook payload](https://zulip.com/api/outgoing-webhook-payload); [Matrix `threading.md`](https://raw.githubusercontent.com/matrix-org/matrix-spec/main/content/client-server-api/modules/threading.md) and MSC3440; [Teams channel conversations](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations) and [Graph list replies](https://learn.microsoft.com/en-us/graph/api/chatmessage-list-replies); [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence), [Mastra threads and resources](https://mastra.ai/docs/memory/threads-and-resources).
- **DorkOS agent-context path** (§4.6): `apps/server/src/services/rooms/room-turn-runner.ts:147-156` (`composeRoomPrompt`), `room-trigger.ts:310-320` (`bindRoomSession` call site), `room-store.ts:558-584` (binding read/write), `room-service.ts:661-668` (`snapshot`), `packages/db/src/schema/rooms.ts:220-229` (`room_sessions`).
- **§3 vendor sources**, all cited inline; the load-bearing ones: [MSC3440](https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/3440-threading-via-relations.md) and [MSC3771](https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/3771-read-receipts-for-threads.md); [Zulip introduction-to-topics](https://zulip.com/help/introduction-to-topics), [update-message](https://zulip.com/api/update-message), [zulip/zulip#1191](https://github.com/zulip/zulip/issues/1191); [Slack retrieving-messages](https://docs.slack.dev/messaging/retrieving-messages/) and the [design retrospective](https://slack.design/articles/threads-in-slack-a-long-design-journey-part-1-of-2/); [Discord threads](https://docs.discord.com/developers/topics/threads) and [channel resource](https://docs.discord.com/developers/resources/channel); [Graph `chatMessage`](https://learn.microsoft.com/en-us/graph/api/resources/chatmessage?view=graph-rest-1.0); [GitHub REST PR comments](https://docs.github.com/en/rest/pulls/comments); [Linear comments](https://linear.app/docs/comment-on-issues).

### Citation caveats — read before quoting onward

Three claims a reader might expect to find and which **do not exist**; none is load-bearing above, and each is stated as structural rather than quoted:

- **No Discord docs sentence says threads cannot be nested.** The constraint is a type constraint on `parent_id`. (Discord's Threads FAQ returned 403 and may contain plain-English wording.)
- **No Slack docs sentence prohibits replies-to-replies.** `chat.postMessage`'s "use its parent instead" is the closest, and the behaviour is normalization, not rejection.
- **No Slack, Discord, or Microsoft engineering post explains the _data-model_ choice** — only design and product rationale. Matrix and Zulip are the only two vendors who wrote down architectural reasoning.

The Zulip "What about threads?" quotes were re-fetched and verified verbatim; a "two-layer organizational hierarchy" phrasing attributed to that page in an earlier draft **could not be confirmed** and has been dropped. Discord's ~1,000-active-threads-per-guild figure is community-sourced and deliberately absent from official docs, so it is not relied on above.
