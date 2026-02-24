# Agent Messaging Transport Libraries for Node.js/TypeScript

**Date:** 2026-02-24
**Mode:** Deep Research
**Objective:** Identify lightweight, embeddable message routing/pub-sub libraries for a local, single-machine, single-user agent messaging system

---

## Research Summary

No single off-the-shelf library satisfies all five requirements (point-to-point + topic pub/sub with NATS-style wildcards + persistence + local-only + embeddable) in a well-maintained package. The landscape splits into two camps: in-memory event emitters with wildcard routing (no persistence) and persistent job queues (no topic routing). The practical recommendation is to compose two components: **EventEmitter2** for in-process pub/sub routing with `.`-delimited wildcard matching, plus **better-sqlite3** (already a DorkOS dependency via `pulse-store.ts`) for durable message storage. Topic matching for NATS/MQTT-style subjects can be covered by a zero-dependency library like `mqtt-pattern`.

---

## Key Findings

### 1. NATS Requires an External Go Binary — No Pure JS Embedding Exists

NATS server is written in Go. There is no way to embed a NATS server inside a Node.js process without spawning a separate Go binary. The official `nats` npm package (~300k weekly downloads, actively maintained as `@nats-io/nats-core` v3.3.0, last published Feb 2026) is a **client library only** — it connects to an already-running NATS server over TCP. JetStream (NATS's persistence layer) also requires the server binary.

The only way to use NATS from Node.js without a user-visible server process is to download a platform-specific `nats-server` binary and spawn it as a child process — which still requires an external process and binary distribution.

No pure JavaScript/TypeScript re-implementation of the NATS server exists in the npm ecosystem.

**Verdict:** NATS is not suitable for an embeddable, in-process solution.

### 2. NATS-Style Wildcard Matching Is Trivially Implementable Without NATS

NATS subject syntax uses `.` as token delimiter, `*` to match one token, and `>` to match one-or-more tokens at the end. This is a ~30-line algorithm. No standalone `nats-match` or `nats-subject` npm package exists, but the algorithm is well-documented in NATS docs and can be written directly.

MQTT uses the same conceptual model with `/` as delimiter, `+` for single-token wildcard, and `#` for multi-token suffix wildcard. The npm package `mqtt-pattern` (MIT, 0 dependencies, ~2,600–3,900 weekly downloads, last commit Dec 2024) implements this cleanly and is actively maintained.

The `wildcard-match` package (~300k weekly downloads, tiny, ESM/CJS/UMD) covers glob-style patterns but is oriented toward file paths, not messaging subjects.

### 3. EventEmitter2 Is the Closest Existing Fit for In-Process Pub/Sub With Wildcards

`eventemitter2` (MIT, ~7.3M weekly downloads, 2.9k GitHub stars) extends Node's EventEmitter with:
- Namespace/wildcard subscriptions using `*` (single segment) and `**` (multi-segment) on `.`-delimited event names
- TTL (times-to-listen), async listeners, `emitAsync()`, `waitFor()`
- Browser + Worker environment compatibility
- Zero external dependencies

The wildcard syntax is `foo.*` and `foo.**`, which maps cleanly onto a NATS-style `agent.*` and `agent.>` model with a trivial token translation. This is **the most viable in-process router** in the ecosystem, with massive adoption proving long-term stability.

**Critical limitation:** No built-in persistence. All subscriptions and events are in-memory. If the process restarts, undelivered events are lost.

### 4. No Library Combines Wildcard Pub/Sub With SQLite Persistence

This is the key gap. After exhaustive searching, there is no npm package that provides all of:
- NATS-style (or MQTT-style) topic/subject routing with wildcards
- Durable message storage (SQLite or file-based)
- Embeddable in a Node.js process
- Actively maintained

The ecosystem has these as separate primitives that must be composed manually.

### 5. SQLite-Based Queue Libraries Exist but Are Job Queues, Not Message Routers

| Package | Downloads/wk | Last Published | External Deps | Notes |
|---|---|---|---|---|
| `liteque` | Low (~65 GitHub stars) | Jan 2025 (v0.8.0) | None (SQLite bundled) | TypeScript, Zod validation, Drizzle ORM, job-queue semantics only |
| `node-persistent-queue` | ~174 | 2 years ago | None (sqlite3) | Simple FIFO queue, no routing |
| `node-sqlite-queue` | Very low | Unmaintained | None (sqlite3) | Similar to above |
| `better-queue-sqlite` | ~175 | 3 years ago | `better-queue` | SQLite store plugin for better-queue |

None of these support topic-based routing. They all implement simple FIFO job queues.

### 6. Job Queues Requiring External Services

These are disqualified for the local-embeddable requirement:

| Package | External Dep | Notes |
|---|---|---|
| `bullmq` | Redis | The standard; ~600k weekly downloads |
| `bee-queue` | Redis | ~15,550 weekly downloads, v2.0.0 published Jan 2026 |
| `agenda` | MongoDB | v6 adds PostgreSQL/Redis backends too |
| `bunqueue` | None (SQLite) | **Bun runtime only** — not compatible with Node.js |

### 7. Actor Model Libraries (Nact, XState)

- **nact** (Apache-2.0, 1.1k GitHub stars): Actor model for Node.js inspired by Akka/Erlang. Supports event sourcing (persistence). Last commit June 2020 — effectively unmaintained. Not recommended.
- **XState + mailbox** (MIT, massive adoption): XState is a state machine/actor library. The `mailbox` package (wraps XState actors with sequential message queuing) is a niche extension. XState itself has no routing or wildcard subscriptions.
- **@morgan-stanley/message-broker** (Apache-2.0, 19 GitHub stars, v2.0.0 Dec 2025): RxJS-based type-safe message broker. No wildcards, no persistence, very low adoption.

### 8. Maildir / File-Based Message Store

No meaningful Node.js Maildir implementation exists for general-purpose use. The `inbox` npm package is an IMAP email client. The `mailbox` npm package is an XState actor mailbox. No file-system-based agent inbox/outbox library exists.

However, the **Maildir format** (one file per message in `new/`, `cur/`, `tmp/` directories) is trivially implementable with Node.js `fs` primitives and provides natural crash recovery without any library dependency.

---

## Detailed Analysis

### Category 1: NATS and NATS-Like

**Can NATS be embedded in Node.js?**

No. The NATS server (`gnatsd`) is a Go binary. Embedding NATS is a Go-only feature — you import `github.com/nats-io/nats-server/v2/server` and start it in a goroutine. There is no equivalent in Node.js.

The approach of spawning a `nats-server` binary via `child_process.spawn()` works technically but requires:
1. Distributing or downloading a platform-specific binary
2. Managing process lifecycle (start, stop, crash recovery)
3. Connecting via TCP (adding latency and socket overhead)

This is effectively "running a separate server process," just managed by the parent Node process.

**nats.js / @nats-io/nats-core**

The official JavaScript NATS client has been restructured into scoped packages:
- `@nats-io/nats-core` — base protocol, pub/sub, request/reply (v3.3.0, last published ~23 days ago as of Feb 2026)
- `@nats-io/jetstream` — JetStream persistence layer client
- `@nats-io/transport-node` — Node.js transport layer

These are client-only packages. They require a running NATS server. JetStream provides durable streams and consumers, but again, only via a running NATS server. The legacy `nats` package (v2.x) has ~300k weekly downloads and is actively maintained.

**Pure JS NATS-compatible servers**

None exist. This has not been attempted in the JavaScript ecosystem.

**Standalone subject-matching libraries**

No dedicated `nats-subject-match` package exists. The subject matching algorithm is simple enough to write inline:

```typescript
function natsMatch(subject: string, pattern: string): boolean {
  const subjectTokens = subject.split('.');
  const patternTokens = pattern.split('.');
  for (let i = 0; i < patternTokens.length; i++) {
    if (patternTokens[i] === '>') return true;
    if (patternTokens[i] === '*') continue;
    if (subjectTokens[i] !== patternTokens[i]) return false;
  }
  return subjectTokens.length === patternTokens.length;
}
```

### Category 2: Lightweight Message Queues for Node.js

**BullMQ** — Requires Redis. ~600k weekly downloads. The ecosystem standard for distributed job queues. Too heavy for local-only use.

**bee-queue** — Requires Redis. ~15,550 weekly downloads. Simpler than BullMQ but still Redis-dependent. v2.0.0 published January 2026 — actively maintained.

**agenda** — Requires MongoDB (v5) or pluggable backends in v6 (PostgreSQL, Redis). Not embeddable without an external database server.

**liteque** — SQLite-based, TypeScript-first, no external services. Uses Drizzle ORM internally. 65 GitHub stars, last commit Jan 2025. The best maintained SQLite queue, but it's a job queue — not a message router. No topic matching.

**node-persistent-queue** — Simple SQLite FIFO queue. ~174 weekly downloads, 2 years since last publish. Works but minimal maintenance.

**better-queue + better-queue-sqlite** — `better-queue` is a flexible queue with pluggable stores. The sqlite store (`better-queue-sqlite`) is 3 years out of date. The combination works but is not actively maintained.

**bunqueue** — SQLite + WAL, no Redis, BullMQ-compatible API, very fast. **Bun runtime only** (`bun:sqlite` native module). Does not work in Node.js. Published to npm as `bunqueue`.

### Category 3: Pub/Sub Libraries

**EventEmitter2** (npm: `eventemitter2`)
- 7.3M weekly downloads
- MIT license
- Wildcard support: `foo.*` (single segment) and `foo.**` (multi-segment)
- Delimiter configurable (default `.` — matches NATS-style subjects out of the box)
- No persistence
- Last commit: actively maintained (master branch shows recent activity)
- Zero dependencies
- **Best existing option for in-process wildcard routing**

**emittery**
- Modern, async-native event emitter
- No wildcard support
- No persistence
- Excellent for simple typed events, not suitable for topic routing

**mitt** (700 bytes, ~1.5M weekly downloads)
- Supports `*` for catch-all only, no hierarchical topics
- No persistence
- Too minimal for subject-based routing

**nanoevents** (107 bytes)
- No wildcards
- No persistence
- Minimal, not suitable

**PubSubJS** (`pubsub-js`)
- Topic-based pub/sub
- Supports hierarchical topics with `/` separator and simple prefix matching
- No wildcards in the NATS sense
- In-memory only
- ~200k weekly downloads, actively maintained

**Pubsub.js** (`pubsub.js` on npm)
- Claims wildcard and inheritance support
- Lower adoption, less well-documented

**@morgan-stanley/message-broker**
- RxJS-based, type-safe channels
- No wildcards
- No persistence
- 19 GitHub stars — very low adoption

### Category 4: Maildir / File-Based Message Store

No meaningful Maildir-format library exists for Node.js in the general-purpose messaging sense. Email-related packages (nodemailer, inbox) are oriented around SMTP/IMAP, not filesystem message stores.

The **Maildir format** is conceptually simple and could be implemented in ~100 lines:
- `~/.dork/agents/{agent-id}/inbox/new/` — new messages (atomic write = rename from tmp/)
- `~/.dork/agents/{agent-id}/inbox/cur/` — processed messages
- `~/.dork/agents/{agent-id}/inbox/tmp/` — staging area for atomic delivery

This pattern guarantees crash safety (rename is atomic on most filesystems) and requires zero dependencies. It is not topic-routed — each agent has a discrete inbox.

### Category 5: Subject/Topic Matching Libraries

**mqtt-pattern** (`mqtt-pattern`)
- MIT license, 0 dependencies
- ~2,600–3,900 weekly downloads
- Last commit: December 17, 2024
- 30 GitHub stars
- Supports MQTT wildcards: `+` (single segment) and `#` (multi-segment suffix)
- Supports named parameters in patterns: `agent/+name/tasks/#rest`
- Can extract parameters from matched topics
- Active but niche

**mqtt-match** (`mqtt-match`)
- MIT, 0 dependencies
- Boolean topic matching only (no parameter extraction)
- 20 dependents
- Less maintained than mqtt-pattern

**wildcard-match** (`wildcard-match`)
- ~300k weekly downloads, very well maintained
- Glob-style patterns (`*`, `**`, `?`)
- Configurable separator for path-style matching
- Not NATS/MQTT semantics natively, but adaptable

**route-trie** (`route-trie`)
- Trie-based URL router
- Designed for HTTP routing, not messaging
- Overkill and wrong abstraction

**pubsub-router** (`pubsub-router`)
- Template-based message routing
- 4 downloads/week — effectively abandoned
- Last published 1 year ago

---

## The Verdict: Build vs. Buy

### What Does Not Exist

There is no actively maintained npm package that provides all of:
1. NATS-style topic routing with `*` and `>` wildcards
2. Durable message persistence (SQLite or file-based)
3. Embeddable in a Node.js process (no separate server)

This combination must be assembled from primitives.

### Recommended Composition

**Option A — EventEmitter2 + better-sqlite3 (Recommended)**

- Use `EventEmitter2` for in-process routing with wildcard subscriptions
- Persist messages to SQLite via `better-sqlite3` (already a DorkOS dependency)
- On startup, replay undelivered messages from SQLite before connecting subscribers
- On delivery, mark messages as delivered (or move to an archive table)
- The wildcard syntax (`foo.*`, `foo.**`) translates directly to NATS-style subjects with a trivial adapter

**Total new dependencies:** 0 (EventEmitter2 only; better-sqlite3 is already in the tree)

**Option B — mqtt-pattern + better-sqlite3**

- Write a thin router class that maintains a subscription trie or list
- Use `mqtt-pattern` for subject matching (MQTT `+`/`#` ≈ NATS `*`/`>`, different chars)
- Persist to better-sqlite3
- More explicit control over the routing logic

**Total new dependencies:** 1 (`mqtt-pattern`, 0 transitive deps, ~4kb)

**Option C — Raw NATS-style matching + better-sqlite3**

- Implement the ~30-line subject matching function inline (no dependency)
- Build a subscription registry (subject → Set<handler>) with the matching loop
- Persist to better-sqlite3

**Total new dependencies:** 0

**Option D — Spawn nats-server + nats.js client (Avoid)**

- Full NATS semantics including JetStream
- But: requires Go binary distribution, process management, TCP overhead
- Overkill for single-machine, single-user use case

---

## Sources & Evidence

- "NATS server embedding is a Go-only feature" — [Embedding NATS in Go](https://dev.to/karanpratapsingh/embedding-nats-in-go-19o) (DEV Community)
- "@nats-io/nats-core v3.3.0, last published 23 days ago" — [@nats-io/nats-core npm](https://www.npmjs.com/package/@nats-io/nats-core)
- "nats npm package" — [nats npm](https://www.npmjs.com/package/nats)
- "eventemitter2 receives 7,331,049 downloads a week" — [eventemitter2 npm](https://www.npmjs.com/package/eventemitter2) via Snyk Advisor
- "EventEmitter2 supports namespaces, wildcards, TTL" — [EventEmitter2 GitHub](https://github.com/EventEmitter2/EventEmitter2)
- "mqtt-pattern: 0 dependencies, last commit Dec 17 2024" — [mqtt-pattern GitHub](https://github.com/RangerMauve/mqtt-pattern)
- "mqtt-pattern 2,624–3,929 weekly downloads" — [mqtt-pattern npm Snyk](https://snyk.io/advisor/npm-package/mqtt-pattern)
- "liteque: TypeScript, Drizzle ORM, last commit Jan 2025" — [liteque GitHub](https://github.com/karakeep-app/liteque)
- "bee-queue v2.0.0, Redis required, ~15,550 weekly downloads" — [bee-queue npm](https://www.npmjs.com/package/bee-queue)
- "better-queue-sqlite last published 3 years ago, ~175 weekly downloads" — [better-queue-sqlite npm](https://www.npmjs.com/package/better-queue-sqlite)
- "bunqueue: Bun-only SQLite queue, BullMQ-compatible API" — [bunqueue GitHub](https://github.com/egeominotti/bunqueue)
- "nact: 1.1k stars, last commit June 2020, Apache-2.0" — [nact GitHub](https://github.com/nactio/nact)
- "@morgan-stanley/message-broker: RxJS-based, 19 stars, no wildcards" — [message-broker GitHub](https://github.com/morganstanley/message-broker)
- "wildcard-match: tiny, ESM/CJS/UMD" — [wildcard-match npm](https://www.npmjs.com/package/wildcard-match)
- "NATS subject wildcard syntax: * and >" — [NATS Wildcard Subscriptions Docs](https://docs.nats.io/using-nats/developer/receiving/wildcards)
- "node-persistent-queue: ~174 weekly downloads, SQLite-backed" — [node-persistent-queue npm](https://www.npmjs.com/package/node-persistent-queue)
- "pubsub-router: 4 downloads/week, last published 1 year ago" — [pubsub-router npm](https://www.npmjs.com/package/pubsub-router?activeTab=versions)
- "bunqueue requires bun:sqlite — Node.js not supported" — [bunqueue DEV article](https://dev.to/egeominotti/i-built-a-job-queue-thats-32x-faster-than-bullmq-no-redis-required-1n5g)
- "liteque README" — [liteque README](https://github.com/karakeep-app/liteque/blob/main/README.md)

---

## Research Gaps & Limitations

- Could not retrieve live npm download stats directly from npmjs.com (403 on WebFetch)
- No deep investigation into whether `nats.js` source code contains extractable subject-matching logic that could be reused without the full client
- Did not explore Rust/WASM-based embedded brokers (e.g., rumqttd via WASM) — theoretically possible but very experimental
- Did not explore Apache Kafka embedded alternatives (too heavy regardless)
- The `fastmq` package (mentioned in search results as a Node.js message broker with Unix domain socket support) was not deeply investigated — could be relevant for IPC between processes

---

## Contradictions & Disputes

- Some sources describe liteque as "actively maintained" but its last commit is Jan 2025 with only 65 stars — adoption is very low
- The BullMQ ecosystem is dominant for Node.js queuing but everything in it requires Redis, which is categorically excluded here
- NATS marketing material emphasizes "lightweight" which creates false impression it could be embedded — it cannot in Node.js

---

## Search Methodology

- Number of searches performed: 18 web searches + 6 page fetches
- Most productive search terms: `"embedded message broker" Node.js TypeScript npm`, `BullMQ alternatives no Redis SQLite embedded`, `NATS embed Node.js TypeScript separate process`, `mqtt-pattern npm`
- Primary information sources: GitHub repository pages, npm registry (via Snyk Advisor, Socket.dev), DEV Community articles, official NATS docs
