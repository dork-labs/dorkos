import Database from 'better-sqlite3';
import { realpathSync } from 'node:fs';
import type {
  BeatResult,
  BeatOutcomeRecord,
  ScopedUsage,
  SessionMetadata,
  CheckpointInput,
  CheckpointRecord,
  ContextScope,
  JsonValue,
  MessageRecord,
  ModelMessage,
  ModelStore,
  ModelUsage,
  RestoredContext,
} from './contracts.js';
function validateId(id: string): void {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))
    throw new Error('Invalid session id');
}
function validateScope(scope: string): void {
  if (
    typeof scope !== 'string' ||
    (scope !== 'main' && !/^(child|beat|summary):[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(scope))
  )
    throw new Error('Invalid context scope');
}
// Reject values JSON would silently discard; completed records must be lossless.
function encode(value: unknown): string {
  const seen = new Set<object>();
  function visit(item: unknown): string {
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    )
      return JSON.stringify(item);
    if (typeof item !== 'object' || item === undefined)
      throw new Error('Record must contain finite JSON values');
    if (seen.has(item)) throw new Error('Record contains a cycle');
    seen.add(item);
    const array = Array.isArray(item);
    if (
      !array &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new Error('Record must be plain JSON');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    for (const key of keys) {
      if (typeof key !== 'string') throw new Error('Record contains a symbol property');
      const descriptor = descriptors[key]!;
      if (!('value' in descriptor)) throw new Error('Record contains an accessor');
      if (array && key === 'length') continue;
      if (!descriptor.enumerable) throw new Error('Record contains a non-enumerable property');
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))
        throw new Error('Record array contains an extra property');
    }
    let encoded: string;
    if (array) {
      const entries: string[] = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor) throw new Error('Record contains a sparse array');
        entries.push(visit(descriptor.value));
      }
      encoded = '[' + entries.join(',') + ']';
    } else
      encoded =
        '{' +
        Object.keys(descriptors)
          .map((key) => JSON.stringify(key) + ':' + visit(descriptors[key]!.value))
          .join(',') +
        '}';
    seen.delete(item);
    return encoded;
  }
  return visit(value);
}
/** SQLite append-only model history; construction touches only the supplied database path. */
export class SqliteModelStore implements ModelStore {
  readonly identity?: string;
  private readonly db: Database.Database;
  /** Open a real SQLite file (or explicitly supplied :memory:) without vendor discovery. */
  constructor(path: string) {
    this.db = new Database(path);
    if (path !== ':memory:') this.identity = realpathSync(path);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS messages(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, scope TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id,scope,seq));
  CREATE TABLE IF NOT EXISTS usage(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, scope TEXT NOT NULL, seq INTEGER NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id,scope,seq), UNIQUE(session_id,request_id));
  CREATE TABLE IF NOT EXISTS outcomes(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, scope TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id,scope,seq));
  CREATE TABLE IF NOT EXISTS checkpoints(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, scope TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id,scope,seq));`);
  }
  private check(id: string, scope: ContextScope): void {
    validateId(id);
    validateScope(scope);
    if (!this.db.prepare('SELECT id FROM sessions WHERE id = ?').get(id))
      throw new Error(`Unknown session: ${id}`);
  }
  private next(
    table: 'messages' | 'usage' | 'checkpoints' | 'outcomes',
    id: string,
    scope: ContextScope
  ): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq),0)+1 AS seq FROM ${table} WHERE session_id = ? AND scope = ?`
      )
      .get(id, scope) as { seq: number };
    return row.seq;
  }
  /** Create idempotent session metadata; existing metadata is not overwritten. */
  createSession(id: string, metadata: JsonValue = {}): void {
    validateId(id);
    this.db
      .prepare('INSERT OR IGNORE INTO sessions(id,metadata) VALUES (?,?)')
      .run(id, encode(metadata));
  }
  /** Read the original host-supplied session metadata. */
  metadata(id: string): JsonValue {
    this.check(id, 'main');
    return JSON.parse(
      (
        this.db.prepare('SELECT metadata FROM sessions WHERE id = ?').get(id) as {
          metadata: string;
        }
      ).metadata
    ) as JsonValue;
  }
  /** Append one complete model message in an immediate transaction. */
  appendMessage(id: string, payload: ModelMessage, scope: ContextScope = 'main'): MessageRecord {
    return this.db
      .transaction(() => {
        this.check(id, scope);
        const seq = this.next('messages', id, scope);
        const encoded = encode(payload);
        this.db.prepare('INSERT INTO messages VALUES (?,?,?,?)').run(id, scope, seq, encoded);
        return { seq, payload: JSON.parse(encoded) as ModelMessage };
      })
      .immediate();
  }
  /** Commit a message batch and its request usage together; failures roll back both. */
  complete(
    id: string,
    messages: readonly ModelMessage[],
    usage: ModelUsage,
    scope: ContextScope = 'main'
  ): readonly MessageRecord[] {
    return this.db
      .transaction(() => {
        this.check(id, scope);
        const records = messages.map((message) => this.appendMessage(id, message, scope));
        this.recordUsage(id, usage, scope);
        return records;
      })
      .immediate();
  }
  /** Record one model request; IDs are unique across all scopes of a session. */
  recordUsage(id: string, usage: ModelUsage, scope: ContextScope = 'main'): void {
    this.db
      .transaction(() => {
        this.check(id, scope);
        const encoded = encode(usage);
        usage = JSON.parse(encoded) as ModelUsage;
        if (!usage.requestId || usage.requestId.length > 256)
          throw new Error('Invalid usage request id');
        this.db
          .prepare('INSERT INTO usage VALUES (?,?,?,?,?)')
          .run(id, scope, this.next('usage', id, scope), usage.requestId, encoded);
      })
      .immediate();
  }
  /** Atomically persist a summary boundary and its model usage without deleting originals. */
  checkpoint(
    id: string,
    checkpoint: CheckpointInput,
    scope: ContextScope = 'main'
  ): CheckpointRecord {
    return this.db
      .transaction(() => {
        this.check(id, scope);
        const encoded = encode(checkpoint);
        checkpoint = JSON.parse(encoded) as CheckpointInput;
        if (checkpoint.usageScope !== undefined) validateScope(checkpoint.usageScope);
        const end = this.next('messages', id, scope);
        if (
          !Number.isSafeInteger(checkpoint.firstRetainedSeq) ||
          checkpoint.firstRetainedSeq < 1 ||
          checkpoint.firstRetainedSeq > end
        )
          throw new Error('Invalid retained message sequence');
        if (
          checkpoint.systemAfterSeq !== undefined &&
          (!checkpoint.currentSystem ||
            !Number.isSafeInteger(checkpoint.systemAfterSeq) ||
            checkpoint.systemAfterSeq < checkpoint.firstRetainedSeq - 1 ||
            checkpoint.systemAfterSeq >= end)
        )
          throw new Error('Invalid system snapshot boundary');
        for (const estimate of [checkpoint.before, checkpoint.after])
          if (
            !Number.isFinite(estimate.tokens) ||
            estimate.tokens < 0 ||
            !['provider', 'estimated'].includes(estimate.source)
          )
            throw new Error('Invalid token estimate');
        const seq = this.next('checkpoints', id, scope);
        const existingUsage = this.db
          .prepare('SELECT scope,payload FROM usage WHERE session_id = ? AND request_id = ?')
          .get(id, checkpoint.usage.requestId) as { scope: string; payload: string } | undefined;
        if (existingUsage) {
          if (
            existingUsage.scope !== (checkpoint.usageScope ?? scope) ||
            existingUsage.payload !== encode(checkpoint.usage)
          )
            throw new Error('Usage request already recorded differently');
        } else this.recordUsage(id, checkpoint.usage, checkpoint.usageScope ?? scope);
        this.db.prepare('INSERT INTO checkpoints VALUES (?,?,?,?)').run(id, scope, seq, encoded);
        return { ...checkpoint, seq };
      })
      .immediate();
  }
  /** Retrieve every original message, including records preceding summaries. */
  archive(id: string, scope: ContextScope = 'main'): readonly MessageRecord[] {
    this.check(id, scope);
    return (
      this.db
        .prepare('SELECT seq,payload FROM messages WHERE session_id = ? AND scope = ? ORDER BY seq')
        .all(id, scope) as { seq: number; payload: string }[]
    ).map((row) => ({ seq: row.seq, payload: JSON.parse(row.payload) as ModelMessage }));
  }
  /** Restore newest summary plus retained originals; summary seq zero is synthetic. */
  restore(id: string, scope: ContextScope = 'main'): RestoredContext {
    this.check(id, scope);
    const row = this.db
      .prepare(
        'SELECT seq,payload FROM checkpoints WHERE session_id = ? AND scope = ? ORDER BY seq DESC LIMIT 1'
      )
      .get(id, scope) as { seq: number; payload: string } | undefined;
    if (!row) return { messages: this.archive(id, scope) };
    const checkpoint = { ...(JSON.parse(row.payload) as CheckpointInput), seq: row.seq };
    const retained = this.archive(id, scope).filter(
      (message) => message.seq >= checkpoint.firstRetainedSeq
    );
    const boundary = checkpoint.systemAfterSeq ?? retained.at(-1)?.seq ?? 0;
    return {
      checkpoint,
      messages: [
        { seq: 0, payload: checkpoint.summary },
        ...retained.filter((message) => message.seq <= boundary),
        ...(checkpoint.currentSystem ? [{ seq: 0, payload: checkpoint.currentSystem }] : []),
        ...retained.filter((message) => message.seq > boundary),
      ],
    };
  }
  /** Retrieve model usage for one scope, ordered by durable sequence. */
  usage(id: string, scope: ContextScope = 'main'): readonly ModelUsage[] {
    this.check(id, scope);
    return (
      this.db
        .prepare('SELECT payload FROM usage WHERE session_id = ? AND scope = ? ORDER BY seq')
        .all(id, scope) as { payload: string }[]
    ).map((row) => JSON.parse(row.payload) as ModelUsage);
  }
  /** Read the newest scope usage through its indexed tail, without loading history. */
  latestUsage(id: string, scope: ContextScope = 'main'): ModelUsage | undefined {
    this.check(id, scope);
    const row = this.db
      .prepare(
        'SELECT payload FROM usage WHERE session_id = ? AND scope = ? ORDER BY seq DESC LIMIT 1'
      )
      .get(id, scope) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as ModelUsage) : undefined;
  }
  /** Read the newest checkpoint without rebuilding the retained conversation. */
  latestCheckpoint(id: string, scope: ContextScope = 'main'): CheckpointRecord | undefined {
    this.check(id, scope);
    const row = this.db
      .prepare(
        'SELECT seq,payload FROM checkpoints WHERE session_id = ? AND scope = ? ORDER BY seq DESC LIMIT 1'
      )
      .get(id, scope) as { seq: number; payload: string } | undefined;
    return row ? { ...(JSON.parse(row.payload) as CheckpointInput), seq: row.seq } : undefined;
  }
  /** A cumulative cost is known only when every actual request has a recorded cost. */
  costTotal(id: string): number | undefined {
    validateId(id);
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS total, COUNT(json_extract(payload,'$.costUsd')) AS known, SUM(json_extract(payload,'$.costUsd')) AS cost FROM usage WHERE session_id = ?"
      )
      .get(id) as { total: number; known: number; cost: number | null };
    return row.total > 0 && row.total === row.known ? (row.cost ?? undefined) : undefined;
  }
  /** Delete precisely this session and its scoped records on explicit host request. */
  deleteSession(id: string): void {
    validateId(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }
  /** List host session metadata without projecting model history. */
  listSessions(): readonly SessionMetadata[] {
    return (
      this.db.prepare('SELECT id,metadata FROM sessions ORDER BY id').all() as {
        id: string;
        metadata: string;
      }[]
    ).map((row) => ({ id: row.id, metadata: JSON.parse(row.metadata) as JsonValue }));
  }
  /** Persist a structured outcome only in a beat namespace. */
  recordOutcome(id: string, result: BeatResult, scope: ContextScope): void {
    this.db
      .transaction(() => {
        this.check(id, scope);
        if (!scope.startsWith('beat:')) throw new Error('Outcomes require a beat scope');
        this.db
          .prepare('INSERT INTO outcomes VALUES (?,?,?,?)')
          .run(id, scope, this.next('outcomes', id, scope), encode(result));
      })
      .immediate();
  }
  /** Read isolated structured beat results after restart. */
  outcomes(id: string, scope: ContextScope): readonly BeatOutcomeRecord[] {
    this.check(id, scope);
    return (
      this.db
        .prepare('SELECT seq,payload FROM outcomes WHERE session_id = ? AND scope = ? ORDER BY seq')
        .all(id, scope) as { seq: number; payload: string }[]
    ).map((row) => ({ seq: row.seq, result: JSON.parse(row.payload) as BeatResult }));
  }
  /** Read each request exactly once across all child and beat scopes. */
  allUsage(id: string): readonly ScopedUsage[] {
    this.check(id, 'main');
    return (
      this.db
        .prepare('SELECT scope,seq,payload FROM usage WHERE session_id = ? ORDER BY scope,seq')
        .all(id) as { scope: ContextScope; seq: number; payload: string }[]
    ).map((row) => ({
      scope: row.scope,
      seq: row.seq,
      usage: JSON.parse(row.payload) as ModelUsage,
    }));
  }
  /** Close this database handle; no history is deleted. */
  close(): void {
    this.db.close();
  }
}
