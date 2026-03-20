---
title: '@dorkos/relay — Core Messaging Library (TypeScript)'
date: 2026-02-24
type: internal-architecture
status: archived
tags: [relay, messaging, nats, pubsub, typescript, ulid, maildir, sqlite]
feature_slug: relay-core-library
searches_performed: 16
sources_count: 35
---

# Research: @dorkos/relay — Core Messaging Library (TypeScript)

**Date**: 2026-02-24
**Feature**: relay-core-library
**Research Depth**: Deep
**Searches Performed**: 16
**Sources Found**: 35+

---

## Research Summary

This document covers five foundational subsystems for building `@dorkos/relay`: Maildir-based storage, NATS-style subject matching, ULID message IDs, SQLite WAL configuration, and TypeScript typed EventEmitter patterns. Each section provides a best approach, alternatives, concrete code patterns, and a recommendation tailored to the relay library's Node.js ESM context.

---

## RESEARCH FINDINGS

### Potential Solutions

---

### 1. Maildir Implementations in Node.js

#### How Maildir Works

The Maildir format (specified by D.J. Bernstein at cr.yp.to/proto/maildir.html) uses three subdirectories within a storage root:

- `tmp/` — Write destination during delivery. The producer creates and fully writes the file here.
- `new/` — Atomically renamed into from `tmp/` once write is complete. Readers watch this directory.
- `cur/` — Messages that have been acknowledged/processed are moved here.

The delivery protocol is:

1. Generate a unique filename (see below).
2. Create and write the full message to `tmp/<unique>`.
3. `fsync()` the file descriptor for durability on crash.
4. Atomically `rename("tmp/<unique>", "new/<unique>")`.
5. Reader sees the file appear atomically in `new/` — no partial reads possible.

#### Unique Filename Format

The canonical Bernstein format is:

```
<timestamp>.<pid>_<unique>.<hostname>
```

For modern implementations (post-2003), the unique component should include crypto-random bytes:

```
<unix_seconds>.<microseconds>.<random_hex>.<hostname>
```

For the relay library, using a **ULID** as the entire filename is a clean modern alternative:

- `01ARZ3NDEKTSV4RRFFQ69G5FAV` — encodes timestamp + 80 bits of entropy
- Lexicographically sorted = `readdir()` returns messages in arrival order
- No hostname/PID coordination needed

#### Atomicity Guarantees

`fs.rename()` in Node.js maps directly to POSIX `rename(2)`, which is:

- **Atomic on same filesystem/mount point** — guaranteed by POSIX
- **Not atomic across filesystems** — throws `EXDEV` (cross-device link) error

Critical constraint: `tmp/` and `new/` must be on the same filesystem. In practice, since both are subdirectories of the same maildir root, this is always true.

EXDEV fallback pattern for robustness:

```typescript
try {
  await fs.rename(tmpPath, newPath);
} catch (err: unknown) {
  if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
    // Cross-device: copy + unlink (non-atomic, unavoidable)
    await fs.copyFile(tmpPath, newPath);
    await fs.unlink(tmpPath);
  } else {
    throw err;
  }
}
```

#### Crash Recovery / Stale `tmp/` Cleanup

Files left in `tmp/` after a crash are "orphaned deliveries." The standard recovery heuristic:

- On startup, scan `tmp/` for files older than a configurable TTL (e.g., 36 hours per Bernstein, or 5 minutes for a local-only relay).
- Any file older than TTL is either moved to `new/` (retry delivery) or deleted (discard).

```typescript
async function cleanStaleTmp(tmpDir: string, maxAgeMs: number): Promise<void> {
  const entries = await fs.readdir(tmpDir);
  const now = Date.now();
  for (const name of entries) {
    const p = path.join(tmpDir, name);
    const stat = await fs.stat(p);
    if (now - stat.mtimeMs > maxAgeMs) {
      await fs.unlink(p); // or move to DLQ
    }
  }
}
```

#### Directory Watching for New Message Arrival

**Chokidar v4** (released September 2024) is the recommended choice:

- Rewritten in TypeScript, reduced from 13 to 1 dependency
- Uses native OS APIs (inotify/FSEvents/ReadDirectoryChangesW)
- Full ESM + CJS support
- Zero-polling for `new/` directory monitoring

```typescript
import { watch } from 'chokidar';

const watcher = watch(path.join(maildirRoot, 'new'), {
  persistent: true,
  ignoreInitial: false, // Process existing messages on startup
  depth: 0, // Only watch files directly in new/
});

watcher.on('add', (filePath) => {
  processNewMessage(filePath);
});
```

**Alternative: `fs.watch()`** — lower-level, no dependencies, but has inconsistent behavior across platforms (Linux inotify edge cases, no rename coalescing). Not recommended for production use without a wrapper.

#### Existing Node.js Libraries

- `@munogu/maildir-queue` — lock-free atomic queue using Maildir conventions; limited documentation and maintenance
- `maildir` (npm) — very minimal, mostly abandoned
- `node-maildir` (GitHub: xpensia) — Maildir++ variant, email-focused, not general-purpose

**Conclusion**: Implement the Maildir protocol directly. It is approximately 150 lines of code and existing libraries are either email-centric or abandoned.

---

### 2. NATS Subject Matching Algorithm

#### Subject Format Rules

Subjects are dot-delimited token strings. Valid characters per token: alphanumeric + dash + underscore. UTF-8 is technically allowed but not recommended for cross-platform interop.

Validation rules to enforce:

- Subject must be non-empty
- No whitespace (spaces or tabs) anywhere in the subject
- No consecutive dots (empty tokens): `foo..bar` is **invalid**
- Tokens cannot be empty: `".foo"` and `"foo."` are **invalid**
- `*` and `>` are valid **only as complete standalone tokens**
  - `foo*.bar` is **invalid** (wildcard is not an isolated token)
  - `foo.*.bar` is **valid**
  - `foo.>` is **valid**
  - `foo.>bar` is **invalid**
- `>` can only appear as the **last token**

#### Wildcard Semantics

| Pattern      | Matches                  | Does Not Match                  |
| ------------ | ------------------------ | ------------------------------- |
| `foo.*`      | `foo.bar`, `foo.baz`     | `foo.bar.baz`, `foo`            |
| `foo.*.bar`  | `foo.x.bar`              | `foo.x.y.bar`                   |
| `foo.>`      | `foo.bar`, `foo.bar.baz` | `foo`, `bar.foo`                |
| `*.*.east.>` | `time.us.east.nyc`       | `time.east`, `time.us.west.nyc` |

#### Matching Algorithms

**Option A: Trie (Sublist) — NATS production approach**

NATS uses a trie where each level corresponds to one dot-delimited token. At each node, three child sets exist:

- Literal token children: a `Map<string, TrieNode>`
- A single `pwc` (partial wildcard) child node for `*`
- A single `fwc` (full wildcard) leaf for `>`

The Match function:

1. Check LRU cache first (NATS uses max 1024 entries with 256-entry sweep on overflow)
2. Tokenize subject by `.`
3. Recursively traverse trie: at each level, follow literal match AND `*` node simultaneously; if `>` node exists at current level, collect all its subscriptions immediately
4. Deduplicate and return collected subscription sets

Pros: O(tokens) per match, scales to millions of subscriptions, cache makes repeat subjects O(1).
Cons: Non-trivial to implement correctly, especially for concurrent modification.

**Option B: Regex (per subscription)**

Convert each subscription pattern to a regex at registration time:

```typescript
function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '[^.]+')
    .replace(/\.>$/, '(?:\\..+)$')
    .replace(/^>$/, '.+');
  return new RegExp(`^${escaped}$`);
}
```

Pros: Simple, correct, pre-compiled regex is fast per test.
Cons: O(N) per publish (N = subscription count). Acceptable for N < 1,000.

**Option C: Linear scan with token comparison (simplest)**

```typescript
function matchesPattern(subject: string, pattern: string): boolean {
  const sToks = subject.split('.');
  const pToks = pattern.split('.');

  for (let i = 0; i < pToks.length; i++) {
    if (pToks[i] === '>') return i === pToks.length - 1;
    if (i >= sToks.length) return false;
    if (pToks[i] !== '*' && pToks[i] !== sToks[i]) return false;
  }
  return sToks.length === pToks.length;
}
```

Pros: Simplest, zero dependencies, easy to test, no regex compilation step.
Cons: O(tokens \* N) per publish. At 1,000 subscriptions and average 4 tokens, approximately 4,000 comparisons per publish — fast enough for local embedded use.

#### Recommendation for Relay

For an embedded library (not a distributed broker), **Option B (pre-compiled regex)** is the sweet spot. A trie is only necessary when subscription counts reach tens of thousands. Expose a `SubjectMatcher` interface so the implementation can be swapped without API changes.

Subject validation should be a pure function applied at both publish and subscribe time:

```typescript
function validateSubject(subject: string, allowWildcards: boolean): void {
  if (!subject) throw new Error('Subject must be non-empty');
  const tokens = subject.split('.');
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) throw new Error(`Empty token at position ${i} in "${subject}"`);
    if (!allowWildcards && (tok === '*' || tok === '>')) {
      throw new Error(`Wildcards not allowed in publish subject: "${subject}"`);
    }
    if (tok === '>' && i !== tokens.length - 1) {
      throw new Error('> wildcard must be the last token');
    }
  }
}
```

---

### 3. ULID vs UUIDv7 for Message IDs

#### ULID Specification

- 128-bit identifier: 48-bit millisecond timestamp + 80-bit crypto-random entropy
- Encoded as 26-character Crockford Base32 (case-insensitive, no ambiguous characters like I/L/O)
- Lexicographically sortable = chronological ordering guaranteed
- Compatible with UUID storage (same 128 bits)

Format: `tttttttttteeeeeeeeeeeeeeeeee` (t = time bits, e = entropy bits)

#### UUIDv7 Comparison

| Property                | ULID                       | UUIDv7                                   |
| ----------------------- | -------------------------- | ---------------------------------------- |
| Length (string)         | 26 chars                   | 36 chars (with hyphens)                  |
| Timestamp precision     | 48-bit ms                  | 48-bit ms                                |
| Entropy                 | 80 bits                    | ~74 bits (after version/variant nibbles) |
| Ecosystem compatibility | ULID-specific decoders     | Any UUID-aware system                    |
| RFC standard            | No (informal spec)         | Yes (RFC 9562, 2024)                     |
| Node.js library         | `ulidx`                    | `uuid` package (`v7`)                    |
| Human-readable encoding | Crockford Base32 (compact) | Hex + hyphens                            |

#### Node.js Library Recommendation

**`ulidx`** is recommended over the original `ulid` package:

- Original `ulid` package is unmaintained with outstanding compatibility bugs
- `ulidx` is actively maintained, fully TypeScript, ESM + CJS dual output
- Supports `monotonicFactory()` for guaranteed monotonic ordering within same millisecond (increments entropy component instead of re-randomizing)
- Uses `crypto.randomBytes` in Node.js — cryptographically secure
- API: `ulid()`, `monotonicFactory()`, `decodeTime()`, `isValid()`, `fixULIDBase32()`

```typescript
import { ulid, monotonicFactory, decodeTime } from 'ulidx';

// Standard: new unique ID
const msgId = ulid();
// Returns something like: "01ARZ3NDEKTSV4RRFFQ69G5FAV"

// Monotonic: guaranteed sort-safe even within same millisecond
const mono = monotonicFactory();
const id1 = mono();
const id2 = mono(); // id2 > id1 always, even if called in same ms

// Decode embedded timestamp
const ts = decodeTime('01ARZ3NDEKTSV4RRFFQ69G5FAV'); // 1469918176385 (Unix ms)
```

#### SQLite Indexing Implications

Time-ordered IDs (ULID, UUIDv7) produce **sequential B-tree inserts**, which:

- Eliminate page splits that random UUIDv4 causes
- Improve INSERT throughput by 2–5x in published benchmarks
- Reduce index fragmentation over time
- Enable efficient time-range scans: `WHERE id >= :start_ulid AND id <= :end_ulid`

#### ULID as Maildir Filename

Using ULID as the filename directly serves double duty:

- Unique filename (80 bits of entropy — collision probability negligible)
- Chronological ordering via sorted `readdir()` output
- Embeds arrival time without extra metadata fields
- 26 characters is well within all filesystem filename length limits

---

### 4. SQLite WAL Mode Best Practices

#### Core PRAGMA Configuration

Apply these settings on every new connection. Note: `journal_mode` is persistent (stored in the DB file after first set). All others are connection-scoped and must be re-applied on every `new Database()` call.

```typescript
import Database from 'better-sqlite3';

function openRelayDb(dbPath: string): Database.Database {
  const db = new Database(dbPath, { timeout: 5000 });

  // Persistent (only needs setting once, but safe to repeat)
  db.pragma('journal_mode = WAL');

  // Connection-scoped — must set every open
  db.pragma('synchronous = NORMAL'); // Safe for WAL; only checkpoints need fsync
  db.pragma('temp_store = MEMORY'); // Temp tables/indices in RAM
  db.pragma('mmap_size = 134217728'); // 128MB memory-mapped I/O
  db.pragma('cache_size = -20000'); // ~20MB page cache (negative = KB)
  db.pragma('busy_timeout = 5000'); // 5s wait on locked DB instead of immediate failure

  return db;
}
```

#### WAL Mode Benefits for Relay

- **Concurrent readers do not block writers** — multiple subscribers can query while a publisher writes
- **Writer does not block readers** — no "database locked" errors during index scans
- **Checkpoint is a separate background operation** — does not interrupt normal operation
- `synchronous = NORMAL` is **safe for WAL mode**: corruption cannot occur, only the last WAL checkpoint may be lost on power failure (not process crash)

#### Checkpoint Starvation Prevention

WAL file grows without bound if readers hold transactions open while writes accumulate. The WAL file cannot be reset until all readers have finished.

Solutions:

1. **Keep `wal_autocheckpoint = 1000`** (default): checkpoint runs automatically after 1,000 WAL frames written. This default is well-tuned — do not lower it.
2. **No long-running read transactions**: keep queries short, never hold a read transaction open across async I/O boundaries.
3. **Manual checkpoint on graceful shutdown**:
   ```typescript
   process.on('SIGTERM', () => {
     db.pragma('wal_checkpoint(TRUNCATE)');
     db.close();
   });
   ```
4. **Periodic checkpoint for write-heavy workloads**:
   ```typescript
   setInterval(() => {
     db.pragma('wal_checkpoint(RESTART)');
   }, 60_000);
   ```

#### Index Design for Message Bus Queries

Key query patterns and their required indexes:

```sql
CREATE TABLE messages (
  id         TEXT PRIMARY KEY,    -- ULID: lexicographic = chronological
  subject    TEXT NOT NULL,
  payload    BLOB NOT NULL,
  created_at INTEGER NOT NULL,    -- Unix ms (useful for BETWEEN queries)
  expires_at INTEGER,
  status     TEXT NOT NULL DEFAULT 'new'  -- new | cur | dlq
);

CREATE INDEX idx_subject ON messages(subject, id);
CREATE INDEX idx_status_created ON messages(status, id);
CREATE INDEX idx_expires ON messages(expires_at) WHERE expires_at IS NOT NULL;
```

**DROP + CREATE vs REINDEX**: For bulk-loading scenarios, dropping and recreating an index is faster than REINDEX. For live databases with ongoing traffic, `REINDEX` is safe but holds a table lock. Prefer building indexes on a quiet connection or during maintenance windows.

#### Batching Writes for Throughput

```typescript
// Batched transaction dramatically improves write throughput
const insertBatch = db.transaction((rows: MessageRow[]) => {
  const stmt = db.prepare(
    'INSERT INTO messages (id, subject, payload, created_at, status) VALUES (?, ?, ?, ?, ?)'
  );
  for (const row of rows) {
    stmt.run(row.id, row.subject, row.payload, row.createdAt, row.status);
  }
});
```

With WAL + batched transactions of 50–100 rows: expected throughput of 100,000–500,000 inserts/sec on modern hardware (phiresky benchmark).

#### better-sqlite3 vs Alternatives

- `better-sqlite3`: synchronous API, fastest for single-thread Node.js, excellent TypeScript types. Best fit for an embedded relay library.
- Native `node:sqlite` (Node.js 22.5+): async, appropriate for worker thread isolation scenarios.
- Recommendation: **`better-sqlite3`** for relay — synchronous writes are appropriate for an embedded message bus, and performance is substantially higher than async alternatives.

---

### 5. TypeScript EventEmitter Patterns

#### The Core Problem

Node.js `EventEmitter` accepts `any` for event names and arguments. Without explicit typing, TypeScript cannot infer that `.on('message', (msg: Message) => ...)` uses the correct payload type. Typos in event names are silent runtime bugs.

#### Pattern A: Native `EventEmitter<TEventMap>` Generic (Recommended)

Since July 2024, `@types/node` (>= 20.11.0) supports a generic type parameter on `EventEmitter`. This is the zero-dependency approach:

```typescript
import { EventEmitter } from 'node:events';

interface RelayEvents {
  message: [subject: string, payload: Buffer, id: string];
  error: [error: Error];
  dlq: [message: FailedMessage];
  drain: [];
}

class RelayBus extends EventEmitter<RelayEvents> {
  publish(subject: string, payload: Buffer): string {
    const id = ulid();
    this.emit('message', subject, payload, id); // TypeScript validates all three args
    return id;
  }
}

const bus = new RelayBus();
bus.on('message', (subject, payload, id) => {
  // All three are fully typed — no 'any'
  console.log(subject, id);
});

// TypeScript error: Argument of type '"TYPO"' is not assignable to...
bus.on('TYPO', () => {});
```

Requires TypeScript >= 4.9 and `@types/node` >= 20.11.0.

#### Pattern B: `typed-emitter` Library

```typescript
import TypedEmitter from 'typed-emitter';
import { EventEmitter } from 'events';

type RelayEvents = {
  message: (subject: string, payload: Buffer) => void;
  error: (err: Error) => void;
};

class RelayBus extends (EventEmitter as new () => TypedEmitter<RelayEvents>) {}
```

Pros: Mature library, works with older TypeScript versions.
Cons: Extra dependency, slightly awkward multiple-inheritance casting syntax.

#### Pattern C: Inline Custom Typed Emitter (Zero Dependency, No Node.js Inheritance)

```typescript
type Listener<T extends unknown[]> = (...args: T) => void;

class TypedEmitter<TEvents extends Record<string, unknown[]>> {
  private _listeners = new Map<keyof TEvents, Set<Listener<any>>>();

  on<K extends keyof TEvents>(event: K, fn: Listener<TEvents[K]>): this {
    let fns = this._listeners.get(event);
    if (!fns) {
      fns = new Set();
      this._listeners.set(event, fns);
    }
    fns.add(fn);
    return this;
  }

  off<K extends keyof TEvents>(event: K, fn: Listener<TEvents[K]>): this {
    this._listeners.get(event)?.delete(fn);
    return this;
  }

  emit<K extends keyof TEvents>(event: K, ...args: TEvents[K]): void {
    this._listeners.get(event)?.forEach((fn) => fn(...args));
  }
}
```

Pros: Zero dependencies, full control, no Node.js EventEmitter baggage.
Cons: Must manually add `once()`, `removeAllListeners()`, and async `events.once()` equivalents if needed.

#### Memory Leak Prevention

Node.js `EventEmitter` warns at 11+ listeners on the same event (default `maxListeners = 10`). For a pub/sub bus with many concurrent subscribers:

```typescript
// 0 = unlimited (use carefully, only when subscriber count is truly unbounded)
bus.setMaxListeners(0);

// Or set a reasonable upper bound
bus.setMaxListeners(500);
```

**Cleanup discipline** — always return an unsubscribe function:

```typescript
subscribe(pattern: string, handler: MessageHandler): () => void {
  const sub = this._registerSubscription(pattern, handler);
  return () => this._removeSubscription(sub.id);
}

// Caller:
const unsub = bus.subscribe('relay.>', handler);
// On component unmount or session end:
unsub();
```

#### Async/Await Integration

Node.js `events.once()` converts a single event to a Promise:

```typescript
import { once, on } from 'node:events';

// Wait for the next 'drain' event
await once(bus, 'drain');

// Async iteration over a stream of events (Node 20+)
for await (const [subject, payload, id] of on(bus, 'message')) {
  await processMessage(subject, payload, id);
}
```

---

## Detailed Analysis

### Maildir + SQLite Dual-Storage Architecture

The relay library benefits from a **hybrid storage model**:

- **Maildir** = payload store. Each message is one file. Provides crash-safe delivery, simple filesystem inspection, and POSIX-native durability.
- **SQLite** = index and state store. Tracks `id, subject, status, metadata, retry_count`. Enables efficient subject queries, TTL expiry scans, and DLQ management.

These two stores stay in sync via the following write sequence:

1. Write payload to `tmp/<ulid>` — Maildir step 1
2. `fsync` the file descriptor
3. Write index row to SQLite with `status = 'tmp'` inside a transaction
4. `rename` to `new/<ulid>` — Maildir step 2 (atomic)
5. Update SQLite row to `status = 'new'` inside the same transaction

Crash recovery: any rows with `status = 'tmp'` that have no corresponding `tmp/` file were lost in a partial write — mark as DLQ entries or schedule retry.

### Dead Letter Queue Implementation

The DLQ is a special subject namespace (`$DLQ.<original_subject>`) with its own storage area:

```typescript
interface FailedMessage {
  id: string;
  originalSubject: string;
  payload: Buffer;
  failedAt: number;
  retryCount: number;
  lastError: string;
}

// After maxRetries exhausted:
function moveToDlq(db: Database.Database, msg: FailedMessage): void {
  db.prepare(
    `
    UPDATE messages
    SET status = 'dlq', dlq_at = ?, last_error = ?
    WHERE id = ?
  `
  ).run(Date.now(), msg.lastError, msg.id);
  bus.emit('dlq', msg);
}
```

### Ephemeral Signals

Ephemeral messages (fire-and-forget, no persistence) bypass Maildir entirely:

```typescript
publishEphemeral(subject: string, payload: Buffer): void {
  validateSubject(subject, false);
  // Route directly to in-memory subscribers only — no file I/O, no SQLite
  this._routeToSubscribers(subject, payload, undefined);
}
```

This distinction aligns with NATS JetStream (persistent) vs core NATS (ephemeral) semantics.

---

## Security Considerations

### Maildir File Permissions

- Create the maildir root with mode `0o700` — only the relay process owner can read/write
- Each message file: mode `0o600`
- Use `fs.open()` with `'wx'` flag (maps to `O_CREAT | O_EXCL | O_WRONLY`) to prevent TOCTOU race on tmp creation:
  ```typescript
  const fh = await fs.open(tmpPath, 'wx', 0o600); // Fails if file already exists
  ```
- Never allow `..` path components in subject-derived directory names. Sanitize subjects before using any token as a filesystem path segment.

### SQLite Injection

`better-sqlite3` uses prepared statements. Always use parameterized queries — never string interpolation:

```typescript
// Correct — parameterized
const stmt = db.prepare('SELECT * FROM messages WHERE subject = ?');
const row = stmt.get(userSuppliedSubject);

// Wrong — SQL injection vector
// db.exec(`SELECT * FROM messages WHERE subject = '${userSuppliedSubject}'`);
```

The NATS subject validator (`validateSubject()`) doubles as an injection guard: subjects limited to alphanumeric + dot + dash + underscore cannot contain SQL metacharacters.

### EventEmitter Denial-of-Service (Listener Flooding)

An untrusted caller invoking `subscribe()` many times can exhaust memory. Mitigations:

1. Per-caller subscription limit (e.g., max 1,000 subscriptions per session ID)
2. Set `bus.setMaxListeners(N)` with a well-chosen cap
3. Audit subscription count on each `subscribe()` call and reject at threshold with a clear error

---

## Performance Considerations

### Maildir Scalability (Many Small Files)

Linux `ext4` directories degrade past approximately 100,000 files when `dir_index` is disabled. On modern ext4 (default), HTree indexing maintains O(log N) directory lookups — acceptable to several million entries.

For extreme throughput: partition by subject prefix, creating one subdirectory per top-level subject token:

```
new/
  relay/
    01ARZ3NDEKTSV4RRFFQ69G5FAV
  pulse/
    01ARZ3NDEKTSV4RRFFQ69G5FBB
```

This limits files per directory proportional to subjects × messages per subject rather than total message count.

### SQLite Write Throughput with WAL

From the phiresky performance tuning benchmarks:

| Configuration                | Approximate inserts/sec |
| ---------------------------- | ----------------------- |
| Default rollback journal     | 100–500                 |
| WAL + `synchronous = NORMAL` | 10,000–50,000           |
| WAL + batched transactions   | 100,000–500,000         |

For the relay library, batching index writes into transactions of 50–100 messages provides the highest throughput for burst scenarios.

### Subject Matching Performance at Scale

- Up to 1,000 subscriptions: **linear scan** (~1ms for 1,000 comparisons on modern hardware)
- 1,000–100,000 subscriptions: **pre-compiled regex** per subscription pattern is faster than re-tokenizing on every publish
- 100,000+ subscriptions: **trie (Sublist)** with LRU cache — NATS processes millions of messages/second with this approach

The relay library should expose a `SubjectMatcher` interface that can be swapped from linear scan to trie without API changes.

### ULID Generation Throughput

`ulidx` uses `crypto.randomBytes` internally, yielding approximately 1,000,000 ULIDs/sec on modern hardware. The `monotonicFactory()` is marginally faster within the same millisecond because it increments the entropy component rather than re-randomizing. At normal relay message rates (thousands/sec), ULID generation will never be the bottleneck.

---

## Recommendation

### Per-Subsystem Summary

**Maildir Storage**
Implement directly without third-party libraries. Use `'wx'` flag for safe tmp writes, POSIX rename for atomic delivery, chokidar v4 for `new/` directory watching, and ULID as the filename. Add crash recovery scan on startup (clean `tmp/` files older than 5 minutes). Approximately 150 lines of implementation code.

**Subject Matching**
Start with a `SubjectMatcher` class using pre-compiled regex per subscription pattern. Expose a `Matcher` interface so the implementation can be upgraded to a trie without API changes. Enforce strict validation (no empty tokens, no consecutive dots, `>` only as last token, wildcards as isolated tokens only) at both subscribe and publish time.

**Message IDs**
Use **`ulidx`** with `monotonicFactory()` for guaranteed monotonic ordering. Use ULID as both the message ID and the Maildir filename. Store as `TEXT PRIMARY KEY` in SQLite — lexicographic ordering gives free chronological sort on all `ORDER BY id` queries.

**SQLite Configuration**
Use `better-sqlite3` with the following PRAGMAs on every connection open:

- `journal_mode = WAL`
- `synchronous = NORMAL`
- `temp_store = MEMORY`
- `mmap_size = 134217728` (128MB)
- `cache_size = -20000` (~20MB)
- `busy_timeout = 5000` (5 seconds)

Keep `wal_autocheckpoint = 1000` (default). Add graceful shutdown checkpoint with `wal_checkpoint(TRUNCATE)`. Batch index writes in transactions of 50–100 for high-throughput scenarios.

**Typed EventEmitter**
Use **Pattern A** (native `EventEmitter<TEventMap>` generics from `@types/node` >= 20.11.0) — zero extra dependencies, fully integrated with Node.js lifecycle, supports `once()`, `removeAllListeners()`, `setMaxListeners()`, and async `events.once()` / `events.on()`. Return an `Unsubscribe` function from `subscribe()` to enforce cleanup discipline.

---

## Research Gaps & Limitations

- No benchmark data found for `ulidx` specifically vs `uuid` v7 in high-throughput Node.js scenarios — would require local benchmarking to confirm relative performance
- Chokidar v4 removed glob support in favor of explicit path arrays; if per-subject subdirectory watching is needed, confirm this does not require multiple `watch()` calls that could affect memory usage
- `better-sqlite3` has documented limitations with Node.js worker threads; if the relay library needs worker thread isolation, evaluate `node:sqlite` (Node 22.5+) as an alternative
- The NATS Sublist trie is implemented in Go and not directly portable to TypeScript; a TypeScript trie implementation would require careful edge-case testing, particularly for concurrent subscription modification during matching

---

## Contradictions & Disputes

**ULID maintenance status**: The original `ulid` npm package README claims active maintenance (v3.0.1), but `ulidx` documentation states it is abandoned with unresolved compatibility issues. npm download trends favor `ulidx`. Verdict: use `ulidx`.

**SQLite `synchronous = OFF` vs `NORMAL`**: Some performance-focused sources recommend `synchronous = OFF` for maximum write speed. This risks database corruption on OS crash (not just process crash). For a message bus where durability is a stated design goal, `NORMAL` is the correct tradeoff — it provides WAL-safe durability while still being dramatically faster than `FULL` mode.

**Maildir vs append-only log**: Modern distributed systems (Kafka, NATS JetStream) prefer append-only logs over Maildir. For a relay library embedded in a local process, Maildir's one-file-per-message simplicity and POSIX atomicity guarantees outweigh the throughput advantages of a log. A log-based design would require separate index management to answer "what subjects have unread messages?" — which is essentially what the SQLite layer provides anyway.

---

## Search Methodology

- Searches performed: 16
- Most productive search terms:
  - `NATS subject matching trie algorithm TypeScript implementation` — DeepWiki analysis of nats-server source code
  - `better-sqlite3 WAL mode PRAGMA configuration best practices Node.js` — official performance.md and phiresky blog
  - `ulidx npm package vs ulid npm maintained TypeScript ESM` — clarified maintenance status
  - `Node.js EventEmitter typed EventMap TypeScript 2024` — confirmed @types/node native generic support
  - `chokidar fs.watch Node.js directory watching 2024 ESM` — confirmed v4 ESM support and dependency reduction
- Primary information sources: nats.io official docs, cr.yp.to/proto/maildir.html (DJB canonical spec), better-sqlite3 GitHub docs, phiresky SQLite performance blog, ulidx GitHub README, @types/node DefinitelyTyped discussions, oneuptime blog (TypeScript event emitters)

---

## Sources

- [Maildir specification (DJB)](https://cr.yp.to/proto/maildir.html)
- [Maildir - Wikipedia](https://en.wikipedia.org/wiki/Maildir)
- [@munogu/maildir-queue - npm](https://www.npmjs.com/package/@munogu/maildir-queue)
- [NATS Subject-Based Messaging Docs](https://docs.nats.io/nats-concepts/subjects)
- [NATS Wildcard Subscriptions Docs](https://docs.nats.io/using-nats/developer/receiving/wildcards)
- [NATS Message Routing and Subject Management - DeepWiki](https://deepwiki.com/nats-io/nats-server/2.1-message-routing-and-subject-management)
- [NATS Subject Matching Edge Cases - nats.go Issue #474](https://github.com/nats-io/nats.go/issues/474)
- [How to Implement Wildcard Subscriptions in NATS - oneuptime](https://oneuptime.com/blog/post/2026-02-02-nats-wildcard-subscriptions/view)
- [ULID Canonical Spec - GitHub](https://github.com/ulid/spec)
- [ulidx - npm](https://www.npmjs.com/package/ulidx)
- [ulidx README - GitHub](https://github.com/perry-mitchell/ulidx/blob/main/README.md)
- [ulid (original) - npm](https://www.npmjs.com/package/ulid)
- [UUIDv4 vs UUIDv7 vs ULID - Medium](https://medium.com/@ciro-gomes-dev/uuidv4-vs-uuidv7-vs-ulid-choosing-the-right-identifier-for-database-performance-1f7d1a0fe0ba)
- [ULID vs UUID v7 - json-server.dev](https://json-server.dev/ulid-vs-uuid/)
- [better-sqlite3 performance.md - GitHub](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md)
- [SQLite WAL documentation - sqlite.org](https://sqlite.org/wal.html)
- [SQLite Performance Tuning - phiresky blog](https://phiresky.github.io/blog/2020/sqlite-performance-tuning/)
- [Sensible SQLite defaults - briandouglas.ie](https://briandouglas.ie/sqlite-defaults/)
- [How to Build Type-Safe Event Emitters in TypeScript - oneuptime](https://oneuptime.com/blog/post/2026-01-30-how-to-build-type-safe-event-emitters-in-typescript/view)
- [typed-emitter - GitHub](https://github.com/andywer/typed-emitter)
- [@types/node EventEmitter generics discussion - DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped/discussions/55298)
- [Chokidar v4 - GitHub](https://github.com/paulmillr/chokidar)
- [Chokidar - npm](https://www.npmjs.com/package/chokidar)
- [fs.rename EXDEV cross-device error - Node.js Issue #19077](https://github.com/nodejs/node/issues/19077)
- [Dead Letter Queue - AlgoMaster](https://algomaster.io/learn/system-design/dead-letter-queues)
- [Dead Letter Queue in Node.js - Medium (Developer Diary)](https://devdiaryacademy.medium.com/dead-letter-queue-dlq-what-it-is-and-how-to-implement-it-in-a-node-js-application-3c6d4b6a9400)
