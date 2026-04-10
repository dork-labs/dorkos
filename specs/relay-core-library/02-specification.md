---
slug: relay-core-library
number: 50
created: 2026-02-24
status: draft
---

# Specification: Relay Core Library

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-02-24
**Ideation:** [specs/relay-core-library/01-ideation.md](./01-ideation.md)

---

## Overview

Build `@dorkos/relay` — a pure TypeScript library implementing the foundational message bus for DorkOS. Relay is kernel IPC for agents: it moves messages between endpoints reliably using NATS-style hierarchical subjects, Maildir-based persistence, SQLite indexing, budget envelope enforcement, ephemeral signals, and pattern-based access control.

This is a new package at `packages/relay/` with Zod schemas in `packages/shared/src/relay-schemas.ts`. It is a standalone library with no dependency on `apps/server` or `apps/client`.

## Background / Problem Statement

DorkOS needs a universal message transport that all higher-level modules (Mesh, Pulse, Console, external adapters) build on. Currently, Pulse dispatches directly to AgentManager and there is no inter-agent messaging. Relay provides the foundational layer — like D-Bus or Mach ports — that enables reliable message delivery, pub/sub, safety enforcement, and observability for all communication in the system.

## Goals

- Create `packages/relay/` as a new workspace package following existing monorepo conventions
- Implement NATS-style hierarchical subject matching with `*` and `>` wildcards
- Implement endpoint registry for registering and looking up message endpoints
- Implement subscription registry for pattern-based pub/sub
- Implement Maildir-based message storage (tmp/ -> new/ -> cur/ -> failed/) with atomic POSIX rename delivery
- Implement SQLite indexing layer (derived from Maildir, fully rebuildable) using better-sqlite3
- Implement budget envelope enforcement (hop count, max hops, ancestor chain cycle detection, TTL expiry, call budget decrement)
- Implement ephemeral signal mode via EventEmitter (typing, presence, read receipts — never touches disk)
- Implement dead letter queue for rejected/failed messages with rejection reasons
- Implement pattern-based access control rules (allow/deny with priority evaluation, default-allow)
- Create RelayCore class that composes all modules into a single entry point
- Add Zod schemas to `packages/shared/src/relay-schemas.ts`
- Comprehensive unit tests for every module

## Non-Goals

- HTTP routes and Express integration (Spec 2)
- MCP tools for agents (Spec 2)
- Client UI components (Spec 2)
- Rate limiting, circuit breakers, backpressure (Spec 3)
- External adapters — Telegram, Slack, webhooks (Spec 4)
- Pulse migration, Console migration (Spec 5)
- Agent runtime adapter interface (future)
- Global message ordering (only per-endpoint FIFO)

## Technical Dependencies

| Dependency                       | Version   | Purpose                                  | Status                            |
| -------------------------------- | --------- | ---------------------------------------- | --------------------------------- |
| `better-sqlite3`                 | `^11.0.0` | SQLite database (WAL mode)               | Already in monorepo (apps/server) |
| `@types/better-sqlite3`          | `^7.6.0`  | TypeScript types                         | Already in monorepo               |
| `ulidx`                          | `^3.0.0`  | Monotonic ULID generation                | New dependency                    |
| `chokidar`                       | `^4.0.0`  | Filesystem watching for message delivery | Already in monorepo (apps/server) |
| `zod`                            | `^4.3.6`  | Schema validation                        | Already in @dorkos/shared         |
| `@asteasolutions/zod-to-openapi` | `^8.4.0`  | OpenAPI metadata                         | Already in @dorkos/shared         |
| `@dorkos/shared`                 | `*`       | Zod schemas, shared types                | Internal package                  |
| `@dorkos/typescript-config`      | `*`       | tsconfig preset                          | Internal package                  |

**Key decision:** ULID via `ulidx` with `monotonicFactory()` for message IDs (not UUID). Provides monotonic ordering, compact 26-char format, and sequential B-tree inserts for SQLite performance.

## Detailed Design

### Directory Structure

```
packages/relay/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    index.ts                    # Barrel export
    relay-core.ts               # Main RelayCore class
    subject-matcher.ts          # NATS-style subject matching
    endpoint-registry.ts        # Endpoint registration + Maildir setup
    subscription-registry.ts    # Pattern-based pub/sub subscriptions
    maildir-store.ts            # Maildir message storage
    sqlite-index.ts             # SQLite indexing layer
    budget-enforcer.ts          # Budget envelope enforcement
    signal-emitter.ts           # Typed EventEmitter for ephemeral signals
    dead-letter-queue.ts        # Failed message storage
    access-control.ts           # Pattern-based access rules
    types.ts                    # Internal types
    __tests__/
      subject-matcher.test.ts
      endpoint-registry.test.ts
      subscription-registry.test.ts
      maildir-store.test.ts
      sqlite-index.test.ts
      budget-enforcer.test.ts
      signal-emitter.test.ts
      dead-letter-queue.test.ts
      access-control.test.ts
      relay-core.test.ts
```

**Runtime data directory:**

```
~/.dork/relay/
  mailboxes/
    {endpoint-hash}/            # One per registered endpoint
      tmp/                      # In-flight writes
      new/                      # Delivered, unclaimed
      cur/                      # Being processed
      failed/                   # Dead letter queue
  subscriptions.json            # Subscription persistence
  access-rules.json             # Access control rules
  index.db                      # SQLite index (derived, rebuildable)
```

### Package Configuration

**packages/relay/package.json:**

```json
{
  "name": "@dorkos/relay",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "eslint ."
  },
  "dependencies": {
    "@dorkos/shared": "*",
    "better-sqlite3": "^11.0.0",
    "chokidar": "^4.0.0",
    "ulidx": "^3.0.0"
  },
  "devDependencies": {
    "@dorkos/typescript-config": "*",
    "@types/better-sqlite3": "^7.6.0"
  }
}
```

**packages/relay/tsconfig.json:**

```json
{
  "extends": "@dorkos/typescript-config/node.json",
  "compilerOptions": {
    "outDir": "./dist"
  },
  "include": ["src/**/*"]
}
```

### Module Specifications

#### 1. Zod Schemas (`packages/shared/src/relay-schemas.ts`)

New dedicated file following the existing schema pattern with `.openapi()` metadata:

```typescript
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

// === Enums ===
export const PerformativeSchema = z
  .enum(['request', 'inform', 'query', 'propose', 'accept', 'reject', 'cfp', 'failure'])
  .openapi('Performative');
export type Performative = z.infer<typeof PerformativeSchema>;

export const SignalTypeSchema = z
  .enum(['typing', 'presence', 'read_receipt', 'delivery_receipt', 'progress'])
  .openapi('SignalType');
export type SignalType = z.infer<typeof SignalTypeSchema>;

export const ChannelTypeSchema = z
  .enum(['dm', 'group', 'channel', 'thread'])
  .openapi('ChannelType');
export type ChannelType = z.infer<typeof ChannelTypeSchema>;

// === Budget ===
export const RelayBudgetSchema = z
  .object({
    hopCount: z.number().int().min(0),
    maxHops: z.number().int().min(1).default(5),
    ancestorChain: z.array(z.string()),
    ttl: z.number().int().describe('Unix timestamp (ms) expiry'),
    callBudgetRemaining: z.number().int().min(0),
  })
  .openapi('RelayBudget');
export type RelayBudget = z.infer<typeof RelayBudgetSchema>;

// === Envelope ===
export const RelayEnvelopeSchema = z
  .object({
    id: z.string().describe('ULID message ID'),
    subject: z.string(),
    from: z.string(),
    replyTo: z.string().optional(),
    budget: RelayBudgetSchema,
    createdAt: z.string().datetime(),
    payload: z.unknown(),
  })
  .openapi('RelayEnvelope');
export type RelayEnvelope = z.infer<typeof RelayEnvelopeSchema>;

// === Standard Payload ===
export const AttachmentSchema = z
  .object({
    path: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number().int().optional(),
  })
  .openapi('Attachment');
export type Attachment = z.infer<typeof AttachmentSchema>;

export const ResponseContextSchema = z
  .object({
    platform: z.string(),
    maxLength: z.number().int().optional(),
    supportedFormats: z.array(z.string()).optional(),
    instructions: z.string().optional(),
  })
  .openapi('ResponseContext');
export type ResponseContext = z.infer<typeof ResponseContextSchema>;

export const StandardPayloadSchema = z
  .object({
    content: z.string(),
    senderName: z.string().optional(),
    senderAvatar: z.string().optional(),
    channelName: z.string().optional(),
    channelType: ChannelTypeSchema.optional(),
    attachments: z.array(AttachmentSchema).optional(),
    responseContext: ResponseContextSchema.optional(),
    performative: PerformativeSchema.optional(),
    conversationId: z.string().optional(),
    correlationId: z.string().optional(),
    platformData: z.unknown().optional(),
  })
  .openapi('StandardPayload');
export type StandardPayload = z.infer<typeof StandardPayloadSchema>;

// === Signals ===
export const SignalSchema = z
  .object({
    type: SignalTypeSchema,
    state: z.string(),
    endpointSubject: z.string(),
    timestamp: z.string().datetime(),
    data: z.unknown().optional(),
  })
  .openapi('Signal');
export type Signal = z.infer<typeof SignalSchema>;

// === Access Control ===
export const RelayAccessRuleSchema = z
  .object({
    from: z.string().describe('Subject pattern (supports wildcards)'),
    to: z.string().describe('Subject pattern (supports wildcards)'),
    action: z.enum(['allow', 'deny']),
    priority: z.number().int(),
  })
  .openapi('RelayAccessRule');
export type RelayAccessRule = z.infer<typeof RelayAccessRuleSchema>;
```

**Update `packages/shared/package.json` exports:**

```json
"./relay-schemas": {
  "types": "./src/relay-schemas.ts",
  "default": "./dist/relay-schemas.js"
}
```

**Update `packages/shared/src/types.ts`** — add re-exports:

```typescript
export type {
  Performative,
  SignalType,
  ChannelType,
  RelayBudget,
  RelayEnvelope,
  Attachment,
  ResponseContext,
  StandardPayload,
  Signal,
  RelayAccessRule,
} from './relay-schemas.js';
```

#### 2. Subject Matcher (`src/subject-matcher.ts`)

Pure functions, no state, ~50-80 lines.

**Public API:**

```typescript
/** Validate a subject string. Throws on invalid input. */
export function validateSubject(subject: string, allowWildcards?: boolean): void;

/** Check if a concrete subject matches a pattern with wildcards. */
export function matchesPattern(subject: string, pattern: string): boolean;
```

**Validation rules:**

- Subject must be non-empty string
- No whitespace characters
- Dot-delimited tokens; no empty tokens (no consecutive dots, no leading/trailing dots)
- Each token: `/^[a-zA-Z0-9_-]+$/` OR `*` OR `>`
- `*` and `>` are only valid when `allowWildcards` is true
- `>` must be the last token in the pattern
- `*` and `>` must be standalone tokens (not `foo*` or `>bar`)

**Matching algorithm** (linear token scan):

```
1. Split both subject and pattern by '.'
2. For each pattern token at index i:
   a. If token is '>': return true (matches rest) — must be last
   b. If i >= subject tokens length: return false
   c. If token is '*': continue (matches any single token)
   d. If token !== subject token: return false
3. Return subject tokens length === pattern tokens length
```

#### 3. Endpoint Registry (`src/endpoint-registry.ts`)

Manages registered endpoints and their Maildir directory structures.

**Public API:**

```typescript
export interface EndpointInfo {
  subject: string;
  hash: string; // Deterministic hash for filesystem directory
  maildirPath: string; // Absolute path to Maildir root
  registeredAt: string; // ISO timestamp
}

export class EndpointRegistry {
  constructor(dataDir: string);
  registerEndpoint(subject: string): EndpointInfo;
  unregisterEndpoint(subject: string): void;
  getEndpoint(subject: string): EndpointInfo | undefined;
  listEndpoints(): EndpointInfo[];
}
```

**Endpoint hash:** `crypto.createHash('sha256').update(subject).digest('hex').slice(0, 12)` — deterministic, filesystem-safe, short enough for directory names.

**On register:** Creates `mailboxes/{hash}/tmp/`, `mailboxes/{hash}/new/`, `mailboxes/{hash}/cur/`, `mailboxes/{hash}/failed/` with `mode: 0o700`.

#### 4. Subscription Registry (`src/subscription-registry.ts`)

Pattern-based pub/sub with persistence.

**Public API:**

```typescript
export type MessageHandler = (envelope: RelayEnvelope) => void | Promise<void>;
export type Unsubscribe = () => void;

export interface SubscriptionInfo {
  id: string; // ULID
  pattern: string; // Subject pattern with wildcards
  createdAt: string; // ISO timestamp
}

export class SubscriptionRegistry {
  constructor(dataDir: string);
  subscribe(pattern: string, handler: MessageHandler): Unsubscribe;
  getSubscribers(subject: string): MessageHandler[];
  listSubscriptions(): SubscriptionInfo[];
}
```

**Behavior:**

- `subscribe()` validates pattern (wildcards allowed), stores handler in-memory, persists pattern to `subscriptions.json`
- `getSubscribers()` iterates all subscriptions, uses `matchesPattern()` to find matches, returns their handlers
- Unsubscribe function removes handler from memory and updates `subscriptions.json`
- On construction, reads `subscriptions.json` to restore patterns (handlers must be re-registered by consumers)

#### 5. Maildir Store (`src/maildir-store.ts`)

Atomic message storage following the Maildir protocol.

**Public API:**

```typescript
export class MaildirStore {
  constructor(dataDir: string);

  /** Atomic delivery: write to tmp/, rename to new/. Returns ULID filename. */
  deliver(endpointHash: string, envelope: RelayEnvelope): Promise<string>;

  /** Move message from new/ to cur/ (consumer claims it). */
  claim(endpointHash: string, messageId: string): Promise<void>;

  /** Remove message from cur/ (processing complete). */
  complete(endpointHash: string, messageId: string): Promise<void>;

  /** Move message to failed/ with rejection metadata. */
  fail(endpointHash: string, messageId: string, reason: string): Promise<void>;

  /** List unclaimed messages in new/, ordered by ULID (chronological). */
  listNew(endpointHash: string): Promise<string[]>;

  /** Read a message envelope from any status directory. */
  readMessage(endpointHash: string, messageId: string): Promise<RelayEnvelope | null>;

  /** Ensure Maildir directory structure exists. */
  ensureMaildir(endpointHash: string): Promise<void>;
}
```

**Delivery flow:**

1. Generate ULID via `monotonicFactory()` — serves as filename
2. Serialize envelope to JSON
3. Write to `tmp/{ulid}` using `fs.open()` with flags `'wx'` (`O_CREAT | O_EXCL | O_WRONLY`) and `mode: 0o600`
4. `fs.rename(tmp/{ulid}, new/{ulid})` — atomic POSIX rename (same filesystem guaranteed)
5. Return ULID as message ID

**Failure message format** (written to `failed/`):

```json
{
  "envelope": { ... },
  "reason": "cycle detected",
  "failedAt": "2026-02-24T12:00:00.000Z"
}
```

#### 6. SQLite Index (`src/sqlite-index.ts`)

Derived index following the PulseStore pattern. Fully rebuildable from Maildir files.

**Public API:**

```typescript
export interface RelayMetrics {
  totalMessages: number;
  byStatus: Record<string, number>; // new, cur, dlq
  bySubject: Array<{ subject: string; count: number }>;
}

export class SqliteIndex {
  constructor(dataDir: string);

  insertMessage(msg: {
    id: string;
    subject: string;
    fromSubject: string;
    status: string;
    endpointHash: string;
    createdAt: number;
    expiresAt?: number;
  }): void;
  updateStatus(id: string, status: string): void;
  getBySubject(subject: string, limit?: number): MessageRow[];
  getByEndpoint(endpointHash: string, limit?: number): MessageRow[];
  deleteExpired(): number;
  getMetrics(): RelayMetrics;
  rebuild(maildirRoot: string): void;
  close(): void;
}
```

**SQLite configuration** (matching PulseStore):

```typescript
this.db = new Database(path.join(dataDir, 'index.db'));
this.db.pragma('journal_mode = WAL');
this.db.pragma('synchronous = NORMAL');
this.db.pragma('busy_timeout = 5000');
this.db.pragma('temp_store = MEMORY');
this.db.pragma('foreign_keys = ON');
```

**Schema (Migration V1):**

```sql
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  from_subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  endpoint_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_subject ON messages(subject, id);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status, id);
CREATE INDEX IF NOT EXISTS idx_messages_endpoint ON messages(endpoint_hash, id);
CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at) WHERE expires_at IS NOT NULL;
```

**Rebuild:** Scan all `mailboxes/*/new/`, `mailboxes/*/cur/`, `mailboxes/*/failed/` directories. Read each JSON file. Drop and recreate the messages table. Reinsert all messages with appropriate status.

#### 7. Budget Enforcer (`src/budget-enforcer.ts`)

Pure functions for budget validation. Budgets can only shrink, never grow.

**Public API:**

```typescript
export interface BudgetResult {
  allowed: boolean;
  reason?: string; // Present when rejected
  updatedBudget?: RelayBudget; // Present when allowed
}

/** Enforce budget constraints. Returns updated budget if allowed. */
export function enforceBudget(envelope: RelayEnvelope, currentEndpoint: string): BudgetResult;

/** Create a default budget with sensible defaults. */
export function createDefaultBudget(overrides?: Partial<RelayBudget>): RelayBudget;
```

**Enforcement checks (in order):**

| #   | Check                                            | Rejection Reason                                        |
| --- | ------------------------------------------------ | ------------------------------------------------------- |
| 1   | `budget.hopCount >= budget.maxHops`              | `"max hops exceeded (${hopCount}/${maxHops})"`          |
| 2   | `budget.ancestorChain.includes(currentEndpoint)` | `"cycle detected: ${currentEndpoint} already in chain"` |
| 3   | `Date.now() > budget.ttl`                        | `"message expired (TTL)"`                               |
| 4   | `budget.callBudgetRemaining <= 0`                | `"call budget exhausted"`                               |

**When allowed**, return updated budget:

- `hopCount` incremented by 1
- `currentEndpoint` appended to `ancestorChain`
- `callBudgetRemaining` decremented by 1
- All other fields unchanged (budgets only shrink)

**Default budget:** `{ hopCount: 0, maxHops: 5, ancestorChain: [], ttl: Date.now() + 3_600_000, callBudgetRemaining: 10 }`

#### 8. Signal Emitter (`src/signal-emitter.ts`)

Ephemeral signals via typed EventEmitter. Never touches disk.

**Public API:**

```typescript
import { EventEmitter } from 'node:events';

export type SignalHandler = (subject: string, signal: Signal) => void;

interface RelaySignalEvents {
  signal: [subject: string, signal: Signal];
  error: [error: Error];
}

export class SignalEmitter extends EventEmitter<RelaySignalEvents> {
  constructor(maxListeners?: number); // default 100

  /** Emit a signal to all matching subscribers. */
  emitSignal(subject: string, signal: Signal): void;

  /** Subscribe to signals matching a pattern. Returns unsubscribe function. */
  onSignal(pattern: string, handler: SignalHandler): Unsubscribe;
}
```

**Behavior:**

- `emitSignal()` validates subject, then emits `'signal'` event
- `onSignal()` registers a filtered listener that checks `matchesPattern(subject, pattern)` before calling handler
- Returns an `Unsubscribe` function that removes the listener
- Uses `setMaxListeners(100)` by default to avoid warnings in pub/sub scenarios

#### 9. Dead Letter Queue (`src/dead-letter-queue.ts`)

Failed message storage with rejection reasons.

**Public API:**

```typescript
export interface DeadLetter {
  envelope: RelayEnvelope;
  reason: string;
  failedAt: string;       // ISO timestamp
  endpointHash: string;
}

export class DeadLetterQueue {
  constructor(private maildirStore: MaildirStore, private sqliteIndex: SqliteIndex);

  /** Reject a message — write to failed/ and index with status='dlq'. */
  reject(endpointHash: string, envelope: RelayEnvelope, reason: string): Promise<void>;

  /** List dead letters, optionally filtered by endpoint. */
  listDead(endpointHash?: string): Promise<DeadLetter[]>;

  /** Purge dead letters older than given timestamp. Returns count purged. */
  purge(olderThan?: number): Promise<number>;
}
```

**Behavior:**

- `reject()` writes `{ envelope, reason, failedAt }` as JSON to `mailboxes/{hash}/failed/{ulid}`
- Also inserts/updates SQLite index with `status = 'dlq'`
- `listDead()` reads from `failed/` directories (optionally filtered by endpoint hash)
- `purge()` removes files older than threshold and deletes corresponding SQLite rows

#### 10. Access Control (`src/access-control.ts`)

Pattern-based allow/deny rules with default-allow policy.

**Public API:**

```typescript
export interface AccessResult {
  allowed: boolean;
  matchedRule?: RelayAccessRule;
}

export class AccessControl {
  constructor(dataDir: string);

  /** Check if communication from → to is allowed. */
  checkAccess(from: string, to: string): AccessResult;

  /** Add an access rule. */
  addRule(rule: RelayAccessRule): void;

  /** Remove a matching rule. */
  removeRule(from: string, to: string): void;

  /** List all rules. */
  listRules(): RelayAccessRule[];

  /** Stop watching for rule changes. */
  close(): void;
}
```

**Evaluation algorithm:**

1. Sort rules by priority (highest first)
2. For each rule: check if `matchesPattern(from, rule.from)` AND `matchesPattern(to, rule.to)`
3. First match wins — return `{ allowed: rule.action === 'allow', matchedRule: rule }`
4. No match — return `{ allowed: true }` (default-allow)

**Persistence:**

- Rules stored in `access-rules.json` as a JSON array
- Hot-reloaded via chokidar when file changes on disk
- `addRule()`/`removeRule()` write back to file atomically (write tmp + rename)

#### 11. RelayCore Class (`src/relay-core.ts`)

Main entry point that composes all modules.

**Public API:**

```typescript
export interface RelayOptions {
  dataDir?: string; // default: ~/.dork/relay
  maxHops?: number; // default: 5
  defaultTtlMs?: number; // default: 3_600_000 (1 hour)
  defaultCallBudget?: number; // default: 10
}

export interface PublishOptions {
  from: string; // Sender subject
  replyTo?: string; // Response routing
  budget?: Partial<RelayBudget>; // Override default budget
}

export class RelayCore {
  constructor(options?: RelayOptions);

  /** Publish a message to a subject. Returns message ID (ULID). */
  publish(subject: string, payload: unknown, options: PublishOptions): Promise<string>;

  /** Subscribe to messages matching a pattern. */
  subscribe(pattern: string, handler: MessageHandler): Unsubscribe;

  /** Emit an ephemeral signal (never touches disk). */
  signal(subject: string, signalData: Signal): void;

  /** Subscribe to ephemeral signals matching a pattern. */
  onSignal(pattern: string, handler: SignalHandler): Unsubscribe;

  /** Register a new endpoint (creates Maildir). */
  registerEndpoint(subject: string): EndpointInfo;

  /** Unregister an endpoint. */
  unregisterEndpoint(subject: string): void;

  /** Get dead letters, optionally filtered by endpoint. */
  getDeadLetters(endpointHash?: string): Promise<DeadLetter[]>;

  /** Rebuild SQLite index from Maildir files. */
  rebuildIndex(): void;

  /** Graceful shutdown. */
  close(): Promise<void>;
}
```

**Publish pipeline:**

```
1. validateSubject(subject)               — reject invalid subjects
2. accessControl.checkAccess(from, to)    — reject unauthorized
3. enforceBudget(envelope, targetEndpoint) — reject over-budget
4. For each endpoint matching subject:
   a. maildirStore.deliver(hash, envelope) — atomic write
   b. sqliteIndex.insertMessage(...)       — index
5. Return message ID
```

**Subscribe delivery (push via chokidar):**

- When an endpoint is registered, start watching its `new/` directory via chokidar
- On file creation event: read envelope, find matching subscription handlers, invoke them
- After handler returns: `maildirStore.claim()` moves file to `cur/`, then `maildirStore.complete()` removes it

**Graceful shutdown (`close()`):**

1. Stop all chokidar watchers
2. Close SQLite database (with WAL checkpoint)
3. Clear subscription handlers

### Data Flow Diagram

```
Publisher                          Relay                           Subscriber
   │                                │                                │
   │  publish(subject, payload)     │                                │
   │───────────────────────────────>│                                │
   │                                │ 1. Validate subject            │
   │                                │ 2. Check access control        │
   │                                │ 3. Enforce budget              │
   │                                │ 4. Build envelope (ULID)       │
   │                                │ 5. Maildir: tmp/ → new/        │
   │                                │ 6. SQLite: INSERT index        │
   │                                │                                │
   │                                │ [chokidar detects new file]    │
   │                                │                                │
   │                                │  handler(envelope)             │
   │                                │───────────────────────────────>│
   │                                │                                │
   │                                │ 7. Maildir: new/ → cur/        │
   │                                │ 8. Maildir: remove cur/        │
   │                                │ 9. SQLite: UPDATE status       │
   │  <── returns message ID        │                                │
   │                                │                                │

Signal Flow (ephemeral, no disk):

Emitter                           Relay                           Listener
   │                                │                                │
   │  signal(subject, data)         │                                │
   │───────────────────────────────>│                                │
   │                                │ EventEmitter.emit('signal')    │
   │                                │                                │
   │                                │  handler(subject, signal)      │
   │                                │───────────────────────────────>│
```

## User Experience

This is a library package — no direct user interaction. Consumers are other DorkOS modules:

```typescript
import { RelayCore } from '@dorkos/relay';

const relay = new RelayCore({ dataDir: '~/.dork/relay' });

// Register endpoints
relay.registerEndpoint('relay.agent.myproject.backend');
relay.registerEndpoint('relay.agent.myproject.frontend');

// Subscribe to all agent messages in a project
const unsub = relay.subscribe('relay.agent.myproject.*', (envelope) => {
  console.log(`Message from ${envelope.from}: ${envelope.payload}`);
});

// Publish a message
const msgId = await relay.publish(
  'relay.agent.myproject.backend',
  {
    content: 'Deploy completed successfully',
  },
  { from: 'relay.system.pulse' }
);

// Ephemeral signal (no disk)
relay.signal('relay.agent.myproject.backend', {
  type: 'typing',
  state: 'active',
  endpointSubject: 'relay.system.console',
  timestamp: new Date().toISOString(),
});

// Cleanup
unsub();
await relay.close();
```

## Testing Strategy

### Unit Tests

Each module has its own test file in `src/__tests__/`:

**subject-matcher.test.ts:**

- Literal subject match (exact equality)
- `*` wildcard matches exactly one token (`foo.*` matches `foo.bar`, not `foo.bar.baz`)
- `>` wildcard matches one or more tokens (`foo.>` matches `foo.bar` and `foo.bar.baz`)
- `>` must be last token — reject `foo.>.bar`
- Reject empty subjects, empty tokens, consecutive dots
- Reject wildcards when `allowWildcards` is false
- Reject wildcards that aren't standalone tokens (`foo*`, `>bar`)
- Case sensitivity (subjects are case-sensitive)
- Purpose: These tests verify the correctness of the NATS subject matching algorithm, which is the routing foundation — if matching is wrong, messages go to wrong endpoints

**budget-enforcer.test.ts:**

- Hop count exceeds maxHops — reject
- Cycle detection: endpoint already in ancestorChain — reject
- TTL expired — reject
- Call budget exhausted — reject
- All checks pass — return updated budget with incremented hopCount, appended ancestor, decremented callBudget
- Default budget factory with and without overrides
- Edge: hopCount equals maxHops (boundary condition)
- Edge: TTL exactly at current time
- Purpose: Budget enforcement prevents infinite agent loops and runaway costs — the most critical safety mechanism

**maildir-store.test.ts:**

- Use real temp directories (`os.tmpdir()`) for filesystem tests
- Atomic delivery: file appears in `new/`, not in `tmp/` after deliver()
- Claim moves from `new/` to `cur/`
- Complete removes from `cur/`
- Fail moves to `failed/` with reason metadata
- listNew returns sorted ULID filenames
- readMessage reads JSON from any status directory
- Directory creation on first use (ensureMaildir)
- Cleanup temp dirs in afterEach
- Purpose: Validates the Maildir protocol invariants — atomic delivery is the correctness guarantee

**sqlite-index.test.ts:**

- Use temp database files (`:memory:` or temp file)
- Insert and query by subject
- Update status
- Delete expired messages
- Rebuild from Maildir files
- WAL mode is active after construction
- Metrics aggregation
- Purpose: Ensures the derived index stays consistent with Maildir truth

**access-control.test.ts:**

- Allow rule permits communication
- Deny rule blocks communication
- Priority ordering: higher priority evaluated first
- Default-allow when no rules match
- Wildcard patterns in from/to fields
- Add and remove rules
- Purpose: Access control is the authorization layer — must correctly enforce policy

**signal-emitter.test.ts:**

- Emit signal, receive in handler
- Pattern matching filters signals correctly
- Unsubscribe prevents further delivery
- No filesystem writes (verify with spy on fs)
- Multiple subscribers receive same signal
- Purpose: Signals must be purely ephemeral — disk writes would be a bug

**dead-letter-queue.test.ts:**

- Reject writes to failed/ with reason
- ListDead returns all dead letters
- ListDead filters by endpoint hash
- Purge removes old entries
- Purpose: DLQ provides observability into failed messages

**relay-core.test.ts (integration):**

- Full publish -> subscribe flow: publish message, verify subscriber receives it
- Budget enforcement integration: publish with expired TTL, verify rejection + DLQ
- Access control integration: add deny rule, verify message blocked
- Signal mode: emit signal, verify handler called, verify no disk writes
- Graceful shutdown: close(), verify watchers stopped and DB closed
- Multiple endpoints: publish to wildcard, verify fan-out delivery
- Purpose: End-to-end integration validates that all modules compose correctly

### Mocking Strategies

- **Filesystem tests:** Use real temp directories via `os.tmpdir()` with cleanup in `afterEach`. This validates actual atomic rename behavior.
- **SQLite tests:** Use temp file databases (not `:memory:`) to test WAL mode. Cleanup in `afterEach`.
- **Chokidar tests:** May need `vi.mock('chokidar')` for unit tests, but integration tests should use real watchers with short timeouts.
- **Time-dependent tests (TTL):** Use `vi.useFakeTimers()` for budget TTL expiry tests.

## Performance Considerations

| Concern                   | Mitigation                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| SQLite write throughput   | WAL mode + `synchronous=NORMAL` provides ~10,000-50,000 inserts/sec                                                                        |
| ULID sequential inserts   | Eliminate B-tree page splits vs random UUIDs (2-5x improvement)                                                                            |
| Subject matching at scale | Linear scan is O(N) per publish; adequate for <1,000 subscriptions. SubjectMatcher interface allows future trie upgrade.                   |
| Maildir file count        | Per-endpoint directories limit files per directory. Scalability concern at >100K messages per endpoint (mitigated by consumer processing). |
| Chokidar watching         | Native OS APIs (FSEvents/inotify); zero-polling overhead                                                                                   |
| Memory for subscriptions  | In-memory handlers; subscription count bounded by registered patterns                                                                      |

## Security Considerations

| Concern           | Mitigation                                                                          |
| ----------------- | ----------------------------------------------------------------------------------- | ----------------------- |
| Path traversal    | Subject validation rejects special characters; endpoint hash is SHA-256 derived     |
| File permissions  | Directories: `0o700`, files: `0o600`; `O_CREAT                                      | O_EXCL` prevents TOCTOU |
| SQLite injection  | All queries use prepared statements via better-sqlite3 (never string interpolation) |
| Listener flooding | `setMaxListeners(100)` cap; per-endpoint subscription limits possible in future     |
| Budget tampering  | Budgets can only shrink — enforcement is server-side, not client-controlled         |
| Cycle attacks     | Ancestor chain tracking detects loops; maxHops provides hard upper bound            |

## Documentation

- Add `packages/relay/README.md` with basic usage examples
- Update `AGENTS.md` to document the new package in the monorepo structure table
- No external docs needed (Spec 2 adds HTTP API docs)

## Implementation Phases

### Phase 1: Foundation (schemas + pure logic)

1. Create `packages/relay/` package scaffolding (package.json, tsconfig.json, vitest.config.ts)
2. Create `packages/shared/src/relay-schemas.ts` with all Zod schemas
3. Update `packages/shared/package.json` exports and `types.ts` re-exports
4. Implement `subject-matcher.ts` + tests
5. Implement `budget-enforcer.ts` + tests
6. Add `packages/relay` to `vitest.workspace.ts`
7. Verify: `npm run typecheck` and `npm test` pass

### Phase 2: Storage layer

8. Implement `maildir-store.ts` + tests
9. Implement `sqlite-index.ts` + tests (with rebuild from Maildir)
10. Implement `dead-letter-queue.ts` + tests
11. Verify: all storage tests pass with real temp directories

### Phase 3: Routing + access

12. Implement `endpoint-registry.ts` + tests
13. Implement `subscription-registry.ts` + tests
14. Implement `access-control.ts` + tests (with chokidar hot-reload)
15. Implement `signal-emitter.ts` + tests

### Phase 4: Composition + integration

16. Implement `relay-core.ts` composing all modules
17. Implement `index.ts` barrel export
18. Write `relay-core.test.ts` integration tests
19. Verify all verification criteria from spec:
    - RelayCore can be instantiated and send/receive messages
    - Subject matching handles `*`, `>`, and literal subjects
    - Budget enforcement rejects over-limit messages and detects cycles
    - Maildir atomic delivery works (tmp -> new rename)
    - Dead letter queue captures rejected messages with reasons
    - Signals fire via EventEmitter without touching disk
    - SQLite index is rebuildable from Maildir files
20. `npm run typecheck` and `npm test` pass across full monorepo

## Open Questions

No open questions remain. All decisions were resolved during ideation:

1. ~~Message ID format~~ → ULID via `ulidx` with `monotonicFactory()`
2. ~~TTL vs Deadline~~ → TTL only (no `deadline` field in RelayBudget)
3. ~~Delivery mode~~ → Push via chokidar for instant subscriber notification

## Related ADRs

No existing ADRs directly relate to Relay. This spec will likely generate draft ADRs for:

- Subject matching algorithm choice (linear scan with interface for future trie)
- Maildir as message storage (vs append-only log)
- ULID for message IDs (vs UUID)
- Hybrid Maildir + SQLite storage pattern

## References

- [Ideation document](./01-ideation.md) — Discovery and research findings
- [Relay Design Doc](../../plans/2026-02-24-relay-design.md) — Full design decisions and TypeScript interfaces
- [Relay Litepaper](../../meta/modules/relay-litepaper.md) — Vision and architecture
- [Relay Spec Definition](../../plans/relay-specs/01-relay-core-library.md) — Verification criteria
- [Research: Transport Libraries](../../research/20260224_agent_messaging_transport_libraries.md) — Library evaluation
- [Research: Relay Core Library](../../research/20260224_relay_core_library_typescript.md) — Implementation research (Maildir, NATS, ULID, SQLite WAL, EventEmitter)
- [Research: Communication Protocols](../../research/mesh/communication-protocols.md) — FIPA ACL, Maildir mechanics
- [Research: Architecture Analogies](../../research/mesh/architecture-analogies.md) — D-Bus, NATS patterns
- [Research: Access Control](../../research/mesh/access-control-coordination.md) — Budget envelopes, capability model
- [PulseStore Reference](../../apps/server/src/services/pulse-store.ts) — SQLite pattern to follow
- [DJB Maildir Specification](https://cr.yp.to/proto/maildir.html) — Original Maildir protocol
- [NATS Subject-Based Messaging](https://docs.nats.io/nats-concepts/subjects) — Wildcard semantics
