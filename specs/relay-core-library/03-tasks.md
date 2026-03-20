# Task Breakdown: Relay Core Library

Generated: 2026-02-24
Source: specs/relay-core-library/02-specification.md
Last Decompose: 2026-02-24

## Overview

Build `@dorkos/relay` -- a pure TypeScript library implementing the foundational message bus for DorkOS. This package provides NATS-style hierarchical subject matching, Maildir-based persistence, SQLite indexing, budget envelope enforcement, ephemeral signals, and pattern-based access control.

14 tasks across 4 phases. Critical path: 1.1 -> 1.2 -> 1.3 -> 2.1 -> 2.2 -> 2.3 -> 4.1 -> 4.2

## Phase 1: Foundation (schemas + pure logic)

### Task 1.1: Create package scaffolding and vitest config

**Description**: Set up the `packages/relay/` package with all configuration files and directory structure.
**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Nothing (blocks all other tasks)

**Technical Requirements**:

- Create `packages/relay/` directory with `src/` and `src/__tests__/` subdirectories
- Create `package.json`, `tsconfig.json`, `vitest.config.ts`
- Add `packages/relay` to root `vitest.workspace.ts`
- Run `npm install` to link workspace

**Implementation Steps**:

1. Create `packages/relay/package.json`:

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

2. Create `packages/relay/tsconfig.json`:

```json
{
  "extends": "@dorkos/typescript-config/node.json",
  "compilerOptions": {
    "outDir": "./dist"
  },
  "include": ["src/**/*"]
}
```

3. Create `packages/relay/vitest.config.ts` following existing patterns (check apps/server/vitest.config.ts for reference).

4. Create placeholder `packages/relay/src/index.ts` with empty barrel export.

5. Update root `vitest.workspace.ts` to add `'packages/relay'` to the workspace array.

6. Run `npm install` from repo root to link the new workspace package.

**Acceptance Criteria**:

- [ ] `packages/relay/package.json` exists with correct name, type, exports, dependencies
- [ ] `packages/relay/tsconfig.json` extends `@dorkos/typescript-config/node.json`
- [ ] `packages/relay/vitest.config.ts` exists
- [ ] `packages/relay/src/index.ts` exists (placeholder)
- [ ] `packages/relay/src/__tests__/` directory exists
- [ ] `vitest.workspace.ts` includes `'packages/relay'`
- [ ] `npm install` succeeds
- [ ] `npm run typecheck` passes

---

### Task 1.2: Create Zod schemas in packages/shared

**Description**: Create `packages/shared/src/relay-schemas.ts` with all Relay Zod schemas, update package.json exports and types.ts re-exports.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Nothing until complete (blocks 1.3, 1.4, 1.5)

**Technical Requirements**:

- Create relay-schemas.ts with all Zod schemas and type exports
- Update packages/shared/package.json to add the new export path
- Update packages/shared/src/types.ts to re-export all relay types

**Implementation Steps**:

1. Create `packages/shared/src/relay-schemas.ts`:

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

2. Update `packages/shared/package.json` exports -- add after the existing `"./roadmap-schemas"` entry:

```json
"./relay-schemas": {
  "types": "./src/relay-schemas.ts",
  "default": "./dist/relay-schemas.js"
}
```

3. Update `packages/shared/src/types.ts` -- add re-exports at the end of the file:

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

**Acceptance Criteria**:

- [ ] `packages/shared/src/relay-schemas.ts` exists with all 12 schemas (Performative, SignalType, ChannelType, RelayBudget, RelayEnvelope, Attachment, ResponseContext, StandardPayload, Signal, RelayAccessRule + types)
- [ ] `packages/shared/package.json` has `"./relay-schemas"` export path
- [ ] `packages/shared/src/types.ts` re-exports all 10 relay types
- [ ] `npm run typecheck` passes across monorepo

---

### Task 1.3: Create internal types module

**Description**: Create `packages/relay/src/types.ts` with all internal type definitions used across relay modules.
**Size**: Small
**Priority**: High
**Dependencies**: Task 1.2
**Can run parallel with**: Task 1.4, Task 1.5

**Technical Requirements**:

- Import shared types from `@dorkos/shared/relay-schemas`
- Define all internal interfaces and type aliases

**Implementation Steps**:

1. Create `packages/relay/src/types.ts`:

```typescript
import type {
  RelayEnvelope,
  RelayBudget,
  Signal,
  RelayAccessRule,
} from '@dorkos/shared/relay-schemas';

export type MessageHandler = (envelope: RelayEnvelope) => void | Promise<void>;
export type SignalHandler = (subject: string, signal: Signal) => void;
export type Unsubscribe = () => void;

export interface EndpointInfo {
  subject: string;
  hash: string;
  maildirPath: string;
  registeredAt: string;
}

export interface SubscriptionInfo {
  id: string;
  pattern: string;
  createdAt: string;
}

export interface BudgetResult {
  allowed: boolean;
  reason?: string;
  updatedBudget?: RelayBudget;
}

export interface AccessResult {
  allowed: boolean;
  matchedRule?: RelayAccessRule;
}

export interface DeadLetter {
  envelope: RelayEnvelope;
  reason: string;
  failedAt: string;
  endpointHash: string;
}

export interface RelayMetrics {
  totalMessages: number;
  byStatus: Record<string, number>;
  bySubject: Array<{ subject: string; count: number }>;
}

export interface RelayOptions {
  dataDir?: string;
  maxHops?: number;
  defaultTtlMs?: number;
  defaultCallBudget?: number;
}

export interface PublishOptions {
  from: string;
  replyTo?: string;
  budget?: Partial<RelayBudget>;
}
```

**Acceptance Criteria**:

- [ ] `packages/relay/src/types.ts` exists with all type definitions
- [ ] Imports from `@dorkos/shared/relay-schemas` resolve correctly
- [ ] All types are exported: MessageHandler, SignalHandler, Unsubscribe, EndpointInfo, SubscriptionInfo, BudgetResult, AccessResult, DeadLetter, RelayMetrics, RelayOptions, PublishOptions
- [ ] `npm run typecheck` passes

---

### Task 1.4: Implement subject matcher + tests

**Description**: Implement `packages/relay/src/subject-matcher.ts` with NATS-style hierarchical subject validation and pattern matching, plus comprehensive unit tests.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.2
**Can run parallel with**: Task 1.3, Task 1.5

**Technical Requirements**:

- Pure functions, no state, ~50-80 lines
- Two exported functions: `validateSubject` and `matchesPattern`
- Dot-delimited hierarchical subjects
- `*` wildcard: matches exactly one token
- `>` wildcard: matches one or more remaining tokens (must be last token)

**Implementation Steps**:

1. Create `packages/relay/src/subject-matcher.ts`:

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

**Matching algorithm (linear token scan):**

```
1. Split both subject and pattern by '.'
2. For each pattern token at index i:
   a. If token is '>': return true (matches rest) -- must be last
   b. If i >= subject tokens length: return false
   c. If token is '*': continue (matches any single token)
   d. If token !== subject token: return false
3. Return subject tokens length === pattern tokens length
```

2. Create `packages/relay/src/__tests__/subject-matcher.test.ts` with these test cases:

- Literal subject match (exact equality)
- `*` wildcard matches exactly one token (`foo.*` matches `foo.bar`, not `foo.bar.baz`)
- `>` wildcard matches one or more tokens (`foo.>` matches `foo.bar` and `foo.bar.baz`)
- `>` must be last token -- reject `foo.>.bar`
- Reject empty subjects, empty tokens, consecutive dots
- Reject wildcards when `allowWildcards` is false
- Reject wildcards that aren't standalone tokens (`foo*`, `>bar`)
- Case sensitivity (subjects are case-sensitive)

**Acceptance Criteria**:

- [ ] `validateSubject('foo.bar.baz')` succeeds
- [ ] `validateSubject('foo.*.baz', true)` succeeds
- [ ] `validateSubject('foo.*')` throws (wildcards not allowed by default)
- [ ] `validateSubject('')` throws
- [ ] `validateSubject('foo..bar')` throws (consecutive dots)
- [ ] `matchesPattern('foo.bar', 'foo.bar')` returns true
- [ ] `matchesPattern('foo.bar', 'foo.*')` returns true
- [ ] `matchesPattern('foo.bar.baz', 'foo.*')` returns false
- [ ] `matchesPattern('foo.bar.baz', 'foo.>')` returns true
- [ ] All tests pass via `npx vitest run packages/relay/src/__tests__/subject-matcher.test.ts`

---

### Task 1.5: Implement budget enforcer + tests

**Description**: Implement `packages/relay/src/budget-enforcer.ts` with pure functions for budget validation and enforcement, plus comprehensive unit tests.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.2
**Can run parallel with**: Task 1.3, Task 1.4

**Technical Requirements**:

- Pure functions for budget validation -- budgets can only shrink, never grow
- Import `RelayBudget` and `RelayEnvelope` from `@dorkos/shared/relay-schemas`
- Import `BudgetResult` from local `types.ts`

**Implementation Steps**:

1. Create `packages/relay/src/budget-enforcer.ts`:

```typescript
import type { RelayEnvelope, RelayBudget } from '@dorkos/shared/relay-schemas';
import type { BudgetResult } from './types.js';

export function enforceBudget(envelope: RelayEnvelope, currentEndpoint: string): BudgetResult;
export function createDefaultBudget(overrides?: Partial<RelayBudget>): RelayBudget;
```

**Enforcement checks (in order):**

| #   | Check                                            | Rejection Reason                                        |
| --- | ------------------------------------------------ | ------------------------------------------------------- |
| 1   | `budget.hopCount >= budget.maxHops`              | `"max hops exceeded (${hopCount}/${maxHops})"`          |
| 2   | `budget.ancestorChain.includes(currentEndpoint)` | `"cycle detected: ${currentEndpoint} already in chain"` |
| 3   | `Date.now() > budget.ttl`                        | `"message expired (TTL)"`                               |
| 4   | `budget.callBudgetRemaining <= 0`                | `"call budget exhausted"`                               |

When allowed, return updated budget:

- `hopCount` incremented by 1
- `currentEndpoint` appended to `ancestorChain`
- `callBudgetRemaining` decremented by 1
- All other fields unchanged (budgets only shrink)

Default budget: `{ hopCount: 0, maxHops: 5, ancestorChain: [], ttl: Date.now() + 3_600_000, callBudgetRemaining: 10 }`

2. Create `packages/relay/src/__tests__/budget-enforcer.test.ts` with these test cases:

- Hop count exceeds maxHops -- reject
- Cycle detection via ancestorChain -- reject
- TTL expired -- reject (use `vi.useFakeTimers()`)
- Call budget exhausted -- reject
- All checks pass -- return updated budget with incremented hopCount, appended ancestor, decremented callBudget
- Default budget factory with and without overrides
- Edge: hopCount equals maxHops (boundary condition)
- Edge: TTL exactly at current time

**Acceptance Criteria**:

- [ ] `enforceBudget` rejects when hop count >= maxHops
- [ ] `enforceBudget` rejects when cycle detected in ancestorChain
- [ ] `enforceBudget` rejects when TTL expired
- [ ] `enforceBudget` rejects when call budget exhausted
- [ ] `enforceBudget` returns updated budget when all checks pass
- [ ] `createDefaultBudget()` returns sensible defaults
- [ ] `createDefaultBudget({ maxHops: 10 })` overrides specific fields
- [ ] All tests pass via `npx vitest run packages/relay/src/__tests__/budget-enforcer.test.ts`

---

## Phase 2: Storage layer

### Task 2.1: Implement Maildir store + tests

**Description**: Implement `packages/relay/src/maildir-store.ts` with atomic Maildir message storage following the DJB Maildir protocol, plus comprehensive unit tests using real temp directories.
**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2, Task 1.3
**Can run parallel with**: Nothing (blocks 2.2 and 2.3)

**Technical Requirements**:

- Atomic delivery: write to `tmp/`, rename to `new/` (POSIX atomic rename)
- ULID message IDs via `monotonicFactory()` from `ulidx`
- File permissions: `0o600` for files, `0o700` for directories
- Use `fs.open()` with flags `'wx'` (O_CREAT | O_EXCL | O_WRONLY) for atomic writes
- Tests use real temp directories (`os.tmpdir()`), not mocks

**Implementation Steps**:

1. Create `packages/relay/src/maildir-store.ts`:

```typescript
import { monotonicFactory } from 'ulidx';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';

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

1. Generate ULID via `monotonicFactory()` -- serves as filename
2. Serialize envelope to JSON
3. Write to `tmp/{ulid}` using `fs.open()` with flags `'wx'` (`O_CREAT | O_EXCL | O_WRONLY`) and `mode: 0o600`
4. `fs.rename(tmp/{ulid}, new/{ulid})` -- atomic POSIX rename (same filesystem guaranteed)
5. Return ULID as message ID

**Failure message format (written to `failed/`):**

```json
{
  "envelope": { "..." },
  "reason": "cycle detected",
  "failedAt": "2026-02-24T12:00:00.000Z"
}
```

**`readMessage` behavior:** Search in order: `new/`, `cur/`, `failed/` directories. Parse JSON and return the envelope. If found in `failed/`, extract the `envelope` field from the wrapper object. Return `null` if not found in any directory.

2. Create `packages/relay/src/__tests__/maildir-store.test.ts` with these test cases:

- Use real temp directories (`os.tmpdir()`) for filesystem tests
- Atomic delivery: file appears in `new/`, not in `tmp/` after `deliver()`
- Claim moves from `new/` to `cur/`
- Complete removes from `cur/`
- Fail moves to `failed/` with reason metadata
- `listNew` returns sorted ULID filenames
- `readMessage` reads JSON from any status directory
- Directory creation on first use (`ensureMaildir`)
- Cleanup temp dirs in `afterEach`

**Acceptance Criteria**:

- [ ] `deliver()` writes atomically (tmp -> new rename)
- [ ] `claim()` moves from new/ to cur/
- [ ] `complete()` removes from cur/
- [ ] `fail()` writes to failed/ with `{ envelope, reason, failedAt }` wrapper
- [ ] `listNew()` returns sorted ULID filenames
- [ ] `readMessage()` finds messages in any status directory
- [ ] `ensureMaildir()` creates tmp/, new/, cur/, failed/ with mode 0o700
- [ ] All tests use real temp directories and clean up in afterEach
- [ ] All tests pass via `npx vitest run packages/relay/src/__tests__/maildir-store.test.ts`

---

### Task 2.2: Implement SQLite index + tests

**Description**: Implement `packages/relay/src/sqlite-index.ts` as a derived index following the PulseStore pattern, fully rebuildable from Maildir files, plus comprehensive unit tests.
**Size**: Large
**Priority**: High
**Dependencies**: Task 2.1
**Can run parallel with**: Nothing (blocks 2.3)

**Technical Requirements**:

- Use `better-sqlite3` with WAL mode
- SQLite config: `WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `temp_store=MEMORY`, `foreign_keys=ON`
- Schema migration via `PRAGMA user_version`
- Rebuild capability from Maildir files

**Implementation Steps**:

1. Create `packages/relay/src/sqlite-index.ts`:

```typescript
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import type { RelayMetrics } from './types.js';

interface MessageRow {
  id: string;
  subject: string;
  from_subject: string;
  status: string;
  endpoint_hash: string;
  created_at: number;
  expires_at: number | null;
}

export class SqliteIndex {
  private db: Database.Database;

  constructor(dataDir: string) {
    this.db = new Database(path.join(dataDir, 'index.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

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

**Metrics aggregation:**

```typescript
getMetrics(): RelayMetrics {
  const total = this.db.prepare('SELECT COUNT(*) as count FROM messages').get();
  const byStatus = this.db.prepare('SELECT status, COUNT(*) as count FROM messages GROUP BY status').all();
  const bySubject = this.db.prepare('SELECT subject, COUNT(*) as count FROM messages GROUP BY subject ORDER BY count DESC LIMIT 20').all();
  return { totalMessages: total.count, byStatus: Object.fromEntries(byStatus.map(r => [r.status, r.count])), bySubject };
}
```

2. Create `packages/relay/src/__tests__/sqlite-index.test.ts` with these test cases:

- Use temp database files (not `:memory:` -- need to test WAL mode)
- Insert and query by subject
- Update status
- Delete expired messages (insert with past `expires_at`, call `deleteExpired`, verify removed)
- Rebuild from Maildir files (create temp Maildir structure, call `rebuild`, verify index contents)
- WAL mode is active after construction (`PRAGMA journal_mode` returns `wal`)
- Metrics aggregation (insert multiple messages, verify counts)
- Cleanup temp files in `afterEach`

**Acceptance Criteria**:

- [ ] `insertMessage` + `getBySubject` round-trips correctly
- [ ] `updateStatus` changes message status
- [ ] `deleteExpired` removes expired messages and returns count
- [ ] `rebuild` reconstructs index from Maildir files
- [ ] WAL mode is active (verified by pragma query)
- [ ] `getMetrics` returns correct aggregations
- [ ] `close` shuts down cleanly
- [ ] All tests pass via `npx vitest run packages/relay/src/__tests__/sqlite-index.test.ts`

---

### Task 2.3: Implement dead letter queue + tests

**Description**: Implement `packages/relay/src/dead-letter-queue.ts` for failed message storage with rejection reasons, plus unit tests.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 2.1, Task 2.2
**Can run parallel with**: Phase 3 tasks (after this completes)

**Technical Requirements**:

- Composes MaildirStore and SqliteIndex (injected via constructor)
- Reject writes to `failed/` directory with reason metadata
- List and purge capabilities
- Import `DeadLetter` type from `./types.ts`

**Implementation Steps**:

1. Create `packages/relay/src/dead-letter-queue.ts`:

```typescript
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { DeadLetter } from './types.js';
import type { MaildirStore } from './maildir-store.js';
import type { SqliteIndex } from './sqlite-index.js';

export class DeadLetterQueue {
  constructor(private maildirStore: MaildirStore, private sqliteIndex: SqliteIndex);

  /** Reject a message -- write to failed/ and index with status='dlq'. */
  reject(endpointHash: string, envelope: RelayEnvelope, reason: string): Promise<void>;

  /** List dead letters, optionally filtered by endpoint. */
  listDead(endpointHash?: string): Promise<DeadLetter[]>;

  /** Purge dead letters older than given timestamp. Returns count purged. */
  purge(olderThan?: number): Promise<number>;
}
```

**Behavior:**

- `reject()` writes `{ envelope, reason, failedAt: new Date().toISOString() }` as JSON to `mailboxes/{hash}/failed/{ulid}`. Also inserts/updates SQLite index with `status = 'dlq'`.
- `listDead()` reads from `failed/` directories (optionally filtered by endpoint hash). Parses each file to reconstruct `DeadLetter` objects.
- `purge()` removes files older than threshold and deletes corresponding SQLite rows. Returns count of purged messages.

2. Create `packages/relay/src/__tests__/dead-letter-queue.test.ts` with these test cases:

- Reject writes to `failed/` with reason
- `listDead` returns all dead letters
- `listDead` filters by endpoint hash
- Purge removes old entries and returns count
- Integration with real MaildirStore and SqliteIndex (using temp dirs)

**Acceptance Criteria**:

- [ ] `reject()` writes to `failed/` with `{ envelope, reason, failedAt }` wrapper
- [ ] `reject()` updates SQLite index with status='dlq'
- [ ] `listDead()` returns all dead letters when no filter
- [ ] `listDead(endpointHash)` filters correctly
- [ ] `purge(olderThan)` removes old entries and returns count
- [ ] All tests pass via `npx vitest run packages/relay/src/__tests__/dead-letter-queue.test.ts`

---

## Phase 3: Routing + Access

### Task 3.1: Implement endpoint registry + tests

**Description**: Implement `packages/relay/src/endpoint-registry.ts` for managing registered endpoints and their Maildir directory structures, plus unit tests.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.4 (subject matcher for validation)
**Can run parallel with**: Task 3.3, Task 3.4

**Technical Requirements**:

- Deterministic endpoint hash via SHA-256: `crypto.createHash('sha256').update(subject).digest('hex').slice(0, 12)`
- Creates Maildir directory structure on registration
- In-memory map of endpoints
- Import `EndpointInfo` from `./types.ts`
- Use `validateSubject()` from `subject-matcher.ts` for subject validation

**Implementation Steps**:

1. Create `packages/relay/src/endpoint-registry.ts`:

```typescript
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateSubject } from './subject-matcher.js';
import type { EndpointInfo } from './types.js';

export class EndpointRegistry {
  private endpoints = new Map<string, EndpointInfo>();

  constructor(private dataDir: string);

  registerEndpoint(subject: string): EndpointInfo;
  unregisterEndpoint(subject: string): void;
  getEndpoint(subject: string): EndpointInfo | undefined;
  listEndpoints(): EndpointInfo[];
}
```

**Endpoint hash:** `crypto.createHash('sha256').update(subject).digest('hex').slice(0, 12)` -- deterministic, filesystem-safe, short enough for directory names.

**On register:**

1. Validate subject via `validateSubject(subject)` (no wildcards)
2. Compute hash
3. Create `mailboxes/{hash}/tmp/`, `mailboxes/{hash}/new/`, `mailboxes/{hash}/cur/`, `mailboxes/{hash}/failed/` with `mode: 0o700`
4. Store EndpointInfo in memory map
5. Return EndpointInfo

**On unregister:**

1. Remove from memory map
2. Do NOT delete Maildir directories (messages may still exist)

3. Create `packages/relay/src/__tests__/endpoint-registry.test.ts` with these test cases:

- Register creates Maildir directories (tmp/, new/, cur/, failed/)
- Get returns registered endpoint info
- List returns all endpoints
- Unregister removes endpoint from registry
- Hash is deterministic for same subject
- Duplicate register is idempotent (returns same info)
- Subject validation rejects invalid subjects

**Acceptance Criteria**:

- [ ] `registerEndpoint()` creates Maildir directories with 0o700 mode
- [ ] `getEndpoint()` returns EndpointInfo with correct hash and maildirPath
- [ ] `listEndpoints()` returns all registered endpoints
- [ ] `unregisterEndpoint()` removes from registry
- [ ] Hash is deterministic (same subject -> same hash)
- [ ] Duplicate registration is idempotent
- [ ] All tests pass via `npx vitest run packages/relay/src/__tests__/endpoint-registry.test.ts`

---

### Task 3.2: Implement subscription registry + tests

**Description**: Implement `packages/relay/src/subscription-registry.ts` for pattern-based pub/sub with persistence, plus unit tests.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.4 (subject matcher), Task 3.1 (endpoint registry pattern)
**Can run parallel with**: Task 3.3, Task 3.4

**Technical Requirements**:

- Pattern-based subscriptions with wildcard support
- In-memory handler storage
- Persistence of subscription patterns to `subscriptions.json`
- Uses `matchesPattern()` from `subject-matcher.ts`
- ULID subscription IDs via `ulidx`

**Implementation Steps**:

1. Create `packages/relay/src/subscription-registry.ts`:

```typescript
import { monotonicFactory } from 'ulidx';
import fs from 'node:fs';
import path from 'node:path';
import { validateSubject, matchesPattern } from './subject-matcher.js';
import type { MessageHandler, Unsubscribe, SubscriptionInfo } from './types.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';

export class SubscriptionRegistry {
  constructor(dataDir: string);

  subscribe(pattern: string, handler: MessageHandler): Unsubscribe;
  getSubscribers(subject: string): MessageHandler[];
  listSubscriptions(): SubscriptionInfo[];
}
```

**Behavior:**

- `subscribe()`: validate pattern with `validateSubject(pattern, true)` (wildcards allowed), generate ULID for subscription ID, store handler in-memory `Map<id, { pattern, handler }>`, persist pattern to `subscriptions.json`, return unsubscribe function
- `getSubscribers(subject)`: iterate all subscriptions, use `matchesPattern(subject, sub.pattern)` to find matches, return their handlers
- Unsubscribe function: remove handler from memory, update `subscriptions.json`
- On construction: read `subscriptions.json` to restore patterns (handlers must be re-registered by consumers)

**subscriptions.json format:**

```json
[
  { "id": "01HXYZ...", "pattern": "relay.agent.*", "createdAt": "2026-02-24T..." },
  { "id": "01HXYZ...", "pattern": "relay.system.>", "createdAt": "2026-02-24T..." }
]
```

2. Create `packages/relay/src/__tests__/subscription-registry.test.ts` with these test cases:

- Subscribe + getSubscribers returns matching handlers
- Pattern matching works with `*` and `>` wildcards
- Unsubscribe removes handler (getSubscribers no longer returns it)
- Persistence to subscriptions.json (verify file written after subscribe)
- Multiple subscribers to same pattern all receive messages
- Non-matching patterns don't return handlers

**Acceptance Criteria**:

- [ ] `subscribe()` stores handler and returns unsubscribe function
- [ ] `getSubscribers()` returns only handlers matching the subject
- [ ] Wildcard patterns (`*`, `>`) work correctly in subscriptions
- [ ] Unsubscribe removes the handler
- [ ] `subscriptions.json` is written on subscribe and updated on unsubscribe
- [ ] All tests pass via `npx vitest run packages/relay/src/__tests__/subscription-registry.test.ts`

---

### Task 3.3: Implement access control + tests

**Description**: Implement `packages/relay/src/access-control.ts` with pattern-based allow/deny rules, default-allow policy, and chokidar hot-reload, plus unit tests.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.4 (subject matcher for pattern matching)
**Can run parallel with**: Task 3.1, Task 3.2, Task 3.4

**Technical Requirements**:

- Priority-ordered rules, first match wins
- Default-allow when no rules match
- Rules persisted in `access-rules.json`
- Hot-reload via chokidar when file changes on disk
- Atomic writes (write to tmp file, rename)
- Import `AccessResult` from `./types.ts`

**Implementation Steps**:

1. Create `packages/relay/src/access-control.ts`:

```typescript
import { watch } from 'chokidar';
import fs from 'node:fs';
import path from 'node:path';
import { matchesPattern } from './subject-matcher.js';
import type { RelayAccessRule } from '@dorkos/shared/relay-schemas';
import type { AccessResult } from './types.js';

export class AccessControl {
  private rules: RelayAccessRule[] = [];
  private watcher: FSWatcher | null = null;

  constructor(dataDir: string);

  /** Check if communication from -> to is allowed. */
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
3. First match wins -- return `{ allowed: rule.action === 'allow', matchedRule: rule }`
4. No match -- return `{ allowed: true }` (default-allow)

**Persistence:**

- Rules stored in `access-rules.json` as a JSON array
- Hot-reloaded via chokidar when file changes on disk
- `addRule()`/`removeRule()` write back to file atomically (write tmp + rename)
- Atomic write: write to `access-rules.json.tmp`, then `fs.renameSync(tmp, target)`

2. Create `packages/relay/src/__tests__/access-control.test.ts` with these test cases:

- Allow rule permits communication
- Deny rule blocks communication
- Priority ordering: higher priority evaluated first
- Default-allow when no rules match
- Wildcard patterns in from/to fields
- Add and remove rules
- Rules persist to access-rules.json
- Close stops chokidar watcher

**Acceptance Criteria**:

- [ ] `checkAccess()` returns `{ allowed: true }` when allow rule matches
- [ ] `checkAccess()` returns `{ allowed: false }` when deny rule matches
- [ ] Higher priority rules evaluated first
- [ ] Default-allow when no rules match
- [ ] Wildcard patterns work in `from` and `to` fields
- [ ] `addRule()` persists to `access-rules.json`
- [ ] `removeRule()` updates `access-rules.json`
- [ ] `close()` stops chokidar watcher
- [ ] All tests pass via `npx vitest run packages/relay/src/__tests__/access-control.test.ts`

---

### Task 3.4: Implement signal emitter + tests

**Description**: Implement `packages/relay/src/signal-emitter.ts` as a typed EventEmitter for ephemeral signals that never touches disk, plus unit tests.
**Size**: Small
**Priority**: High
**Dependencies**: Task 1.4 (subject matcher for pattern matching)
**Can run parallel with**: Task 3.1, Task 3.2, Task 3.3

**Technical Requirements**:

- Extends Node.js EventEmitter with typed events
- Pattern-based signal filtering using `matchesPattern()`
- Never touches disk (verify with spy on fs in tests)
- Default max listeners = 100

**Implementation Steps**:

1. Create `packages/relay/src/signal-emitter.ts`:

```typescript
import { EventEmitter } from 'node:events';
import { matchesPattern, validateSubject } from './subject-matcher.js';
import type { Signal } from '@dorkos/shared/relay-schemas';
import type { SignalHandler, Unsubscribe } from './types.js';

interface RelaySignalEvents {
  signal: [subject: string, signal: Signal];
  error: [error: Error];
}

export class SignalEmitter extends EventEmitter<RelaySignalEvents> {
  constructor(maxListeners?: number) {
    super();
    this.setMaxListeners(maxListeners ?? 100);
  }

  /** Emit a signal to all matching subscribers. */
  emitSignal(subject: string, signal: Signal): void {
    validateSubject(subject);
    this.emit('signal', subject, signal);
  }

  /** Subscribe to signals matching a pattern. Returns unsubscribe function. */
  onSignal(pattern: string, handler: SignalHandler): Unsubscribe {
    validateSubject(pattern, true); // Allow wildcards
    const listener = (subject: string, signal: Signal) => {
      if (matchesPattern(subject, pattern)) {
        handler(subject, signal);
      }
    };
    this.on('signal', listener);
    return () => this.off('signal', listener);
  }
}
```

2. Create `packages/relay/src/__tests__/signal-emitter.test.ts` with these test cases:

- Emit signal, receive in handler
- Pattern matching filters signals correctly (only matching patterns receive)
- Unsubscribe prevents further delivery
- No filesystem writes (verify with `vi.spyOn(fs, ...)` that no fs methods are called)
- Multiple subscribers receive same signal
- Custom maxListeners works
- Invalid subject throws on emit

**Acceptance Criteria**:

- [ ] `emitSignal()` delivers to matching `onSignal()` handlers
- [ ] Pattern matching filters correctly (non-matching patterns don't fire)
- [ ] Unsubscribe function prevents further delivery
- [ ] No filesystem writes (verified by spy on `fs`)
- [ ] Multiple subscribers all receive the same signal
- [ ] `setMaxListeners(100)` is default
- [ ] All tests pass via `npx vitest run packages/relay/src/__tests__/signal-emitter.test.ts`

---

## Phase 4: Composition + Integration

### Task 4.1: Implement RelayCore class + integration tests

**Description**: Implement `packages/relay/src/relay-core.ts` composing all modules into a single entry point, plus comprehensive integration tests.
**Size**: Large
**Priority**: High
**Dependencies**: Task 2.1, Task 2.2, Task 2.3, Task 3.1, Task 3.2, Task 3.3, Task 3.4
**Can run parallel with**: Nothing (blocks 4.2)

**Technical Requirements**:

- Composes: EndpointRegistry, SubscriptionRegistry, MaildirStore, SqliteIndex, DeadLetterQueue, AccessControl, SignalEmitter, budget-enforcer
- Publish pipeline: validate -> access check -> budget check -> deliver to matching endpoints -> index -> return ID
- Push delivery via chokidar: watch `new/` directories, fire handlers, claim + complete
- Graceful shutdown: stop watchers, close SQLite (WAL checkpoint), clear handlers

**Implementation Steps**:

1. Create `packages/relay/src/relay-core.ts`:

```typescript
import path from 'node:path';
import os from 'node:os';
import { watch } from 'chokidar';
import { monotonicFactory } from 'ulidx';
import { validateSubject } from './subject-matcher.js';
import { enforceBudget, createDefaultBudget } from './budget-enforcer.js';
import { EndpointRegistry } from './endpoint-registry.js';
import { SubscriptionRegistry } from './subscription-registry.js';
import { MaildirStore } from './maildir-store.js';
import { SqliteIndex } from './sqlite-index.js';
import { DeadLetterQueue } from './dead-letter-queue.js';
import { AccessControl } from './access-control.js';
import { SignalEmitter } from './signal-emitter.js';
import type { RelayEnvelope, RelayBudget, Signal } from '@dorkos/shared/relay-schemas';
import type {
  RelayOptions,
  PublishOptions,
  MessageHandler,
  SignalHandler,
  Unsubscribe,
  EndpointInfo,
  DeadLetter,
} from './types.js';

export class RelayCore {
  private endpointRegistry: EndpointRegistry;
  private subscriptionRegistry: SubscriptionRegistry;
  private maildirStore: MaildirStore;
  private sqliteIndex: SqliteIndex;
  private deadLetterQueue: DeadLetterQueue;
  private accessControl: AccessControl;
  private signalEmitter: SignalEmitter;
  private watchers = new Map<string, FSWatcher>();
  private ulid = monotonicFactory();
  private options: Required<RelayOptions>;

  constructor(options?: RelayOptions) {
    const dataDir = options?.dataDir ?? path.join(os.homedir(), '.dork', 'relay');
    this.options = {
      dataDir,
      maxHops: options?.maxHops ?? 5,
      defaultTtlMs: options?.defaultTtlMs ?? 3_600_000,
      defaultCallBudget: options?.defaultCallBudget ?? 10,
    };

    // Initialize all sub-modules
    this.endpointRegistry = new EndpointRegistry(dataDir);
    this.subscriptionRegistry = new SubscriptionRegistry(dataDir);
    this.maildirStore = new MaildirStore(dataDir);
    this.sqliteIndex = new SqliteIndex(dataDir);
    this.deadLetterQueue = new DeadLetterQueue(this.maildirStore, this.sqliteIndex);
    this.accessControl = new AccessControl(dataDir);
    this.signalEmitter = new SignalEmitter();
  }

  /** Publish a message to a subject. Returns message ID (ULID). */
  async publish(subject: string, payload: unknown, options: PublishOptions): Promise<string>;

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
  async close(): Promise<void>;
}
```

**Publish pipeline:**

```
1. validateSubject(subject)               -- reject invalid subjects
2. accessControl.checkAccess(from, to)    -- reject unauthorized
3. Build envelope with ULID, budget (default or provided)
4. For each registered endpoint matching subject:
   a. enforceBudget(envelope, targetEndpoint) -- reject over-budget
   b. maildirStore.deliver(hash, envelope)    -- atomic write
   c. sqliteIndex.insertMessage(...)          -- index
5. If no endpoints match, reject to DLQ with reason "no matching endpoints"
6. Return message ID
```

**Subscribe delivery (push via chokidar):**

- When an endpoint is registered via `registerEndpoint()`, start watching its `new/` directory via chokidar
- On file creation event: read envelope, find matching subscription handlers via `subscriptionRegistry.getSubscribers()`, invoke them
- After all handlers return: `maildirStore.claim()` then `maildirStore.complete()`
- On handler error: `maildirStore.fail()` with error reason

**Graceful shutdown (`close()`):**

1. Stop all chokidar watchers (iterate `this.watchers` map)
2. Close AccessControl (stops its watcher)
3. Close SQLite database (with WAL checkpoint)
4. Clear subscription handlers

5. Create `packages/relay/src/__tests__/relay-core.test.ts` with integration tests:

- **Full publish -> subscribe flow**: Register endpoint, subscribe to pattern, publish message, verify subscriber handler is called with correct envelope
- **Budget enforcement integration**: Publish with expired TTL or exceeded hop count, verify message rejected and appears in DLQ
- **Access control integration**: Add deny rule, publish message matching the rule, verify message blocked
- **Signal mode**: Emit signal, verify handler called, verify no disk writes (spy on fs)
- **Graceful shutdown**: Call `close()`, verify watchers stopped and DB closed
- **Multiple endpoints fan-out**: Register multiple endpoints matching a wildcard, publish to wildcard subject, verify all endpoints receive the message
- **Dead letter retrieval**: Reject messages, call `getDeadLetters()`, verify they're returned
- **Index rebuild**: Deliver messages, call `rebuildIndex()`, verify index contents match Maildir

**Acceptance Criteria**:

- [ ] Full publish -> subscribe flow works end-to-end
- [ ] Budget enforcement rejects over-limit messages
- [ ] Budget enforcement detects cycles
- [ ] Access control blocks denied messages
- [ ] Signals fire via EventEmitter without touching disk
- [ ] Multiple endpoints receive fan-out messages
- [ ] `close()` shuts down cleanly (no hanging watchers)
- [ ] Dead letters are retrievable
- [ ] Index rebuild matches Maildir truth
- [ ] All tests pass via `npx vitest run packages/relay/src/__tests__/relay-core.test.ts`

---

### Task 4.2: Create barrel export + verify full monorepo

**Description**: Create `packages/relay/src/index.ts` barrel export, verify typecheck and tests pass across the full monorepo.
**Size**: Small
**Priority**: High
**Dependencies**: Task 4.1
**Can run parallel with**: Nothing (final task)

**Technical Requirements**:

- Export all public types and classes from barrel
- Verify `npm run typecheck` passes across entire monorepo
- Verify `npm test` passes across entire monorepo

**Implementation Steps**:

1. Create `packages/relay/src/index.ts`:

```typescript
/**
 * @dorkos/relay -- Foundational message bus for DorkOS.
 *
 * Provides NATS-style subject matching, Maildir-based persistence,
 * SQLite indexing, budget envelope enforcement, ephemeral signals,
 * and pattern-based access control.
 *
 * @module relay
 */

// Main entry point
export { RelayCore } from './relay-core.js';

// Sub-modules (for advanced usage)
export { EndpointRegistry } from './endpoint-registry.js';
export { SubscriptionRegistry } from './subscription-registry.js';
export { MaildirStore } from './maildir-store.js';
export { SqliteIndex } from './sqlite-index.js';
export { DeadLetterQueue } from './dead-letter-queue.js';
export { AccessControl } from './access-control.js';
export { SignalEmitter } from './signal-emitter.js';

// Pure functions
export { validateSubject, matchesPattern } from './subject-matcher.js';
export { enforceBudget, createDefaultBudget } from './budget-enforcer.js';

// Types
export type {
  MessageHandler,
  SignalHandler,
  Unsubscribe,
  EndpointInfo,
  SubscriptionInfo,
  BudgetResult,
  AccessResult,
  DeadLetter,
  RelayMetrics,
  RelayOptions,
  PublishOptions,
} from './types.js';
```

2. Verify full monorepo:

```bash
npm run typecheck   # All packages type-check
npm test -- --run   # All tests pass
```

3. Verify the relay package specifically:

```bash
npx vitest run --project @dorkos/relay   # All relay tests pass
```

**Acceptance Criteria**:

- [ ] `packages/relay/src/index.ts` exports all public APIs
- [ ] `import { RelayCore } from '@dorkos/relay'` resolves correctly
- [ ] `npm run typecheck` passes across entire monorepo
- [ ] `npm test -- --run` passes across entire monorepo
- [ ] All relay-specific tests pass
- [ ] All verification criteria from spec are met:
  - RelayCore can be instantiated and send/receive messages
  - Subject matching handles `*`, `>`, and literal subjects
  - Budget enforcement rejects over-limit messages and detects cycles
  - Maildir atomic delivery works (tmp -> new rename)
  - Dead letter queue captures rejected messages with reasons
  - Signals fire via EventEmitter without touching disk
  - SQLite index is rebuildable from Maildir files

---

## Dependency Graph

```
Task 1.1 (scaffolding)
  |
  +-> Task 1.2 (schemas)
  |     |
  |     +-> Task 1.3 (internal types)
  |     |
  |     +-> Task 1.4 (subject matcher)  ----+----+----+----+
  |     |                                    |    |    |    |
  |     +-> Task 1.5 (budget enforcer)       |    |    |    |
  |           |                              |    |    |    |
  +-> Task 2.1 (maildir store)              |    |    |    |
        |                                    |    |    |    |
        +-> Task 2.2 (sqlite index)         |    |    |    |
        |     |                              |    |    |    |
        +-> Task 2.3 (dead letter queue)    |    |    |    |
                                             |    |    |    |
  Task 3.1 (endpoint registry) <-------------+    |    |    |
  Task 3.2 (subscription registry) <---------+----+    |    |
  Task 3.3 (access control) <--------------------+    |    |
  Task 3.4 (signal emitter) <-------------------------+    |
                                                            |
  Task 4.1 (relay core) <--- all P2 + P3 tasks            |
        |                                                   |
        +-> Task 4.2 (barrel + verify)                     |
```

## Parallel Execution Opportunities

- **Phase 1**: Tasks 1.3, 1.4, 1.5 can all run in parallel after 1.2 completes
- **Phase 3**: Tasks 3.1, 3.2, 3.3, 3.4 can all run in parallel (they only depend on P1 tasks)
- **Cross-phase**: Phase 3 tasks can start as soon as their P1 dependencies complete, even if P2 is still in progress
- **Critical path**: 1.1 -> 1.2 -> 2.1 -> 2.2 -> 2.3 -> 4.1 -> 4.2

## Summary

| Phase                     | Tasks        | Description                                                              |
| ------------------------- | ------------ | ------------------------------------------------------------------------ |
| Phase 1: Foundation       | 5 tasks      | Package setup, schemas, types, subject matcher, budget enforcer          |
| Phase 2: Storage          | 3 tasks      | Maildir store, SQLite index, dead letter queue                           |
| Phase 3: Routing + Access | 4 tasks      | Endpoint registry, subscription registry, access control, signal emitter |
| Phase 4: Composition      | 2 tasks      | RelayCore class, barrel export + verification                            |
| **Total**                 | **14 tasks** |                                                                          |
