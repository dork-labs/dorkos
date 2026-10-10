import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SqliteModelStore, type JsonValue } from '@dorkos/doe';
import type { Session, SessionSettings } from '@dorkos/shared/types';
import { isWithinDirectory } from '@dorkos/shared/paths';
import type { SessionListEvent } from '@dorkos/shared/session-stream';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { deriveSessionTitle } from '../shared/derive-title.js';
import { DoeEventQueue } from './event-queue.js';

/** The engine's independent data directory, outside vendor-owned session stores. */
export function doeSessionsDirectory(): string {
  return path.join(resolveDorkHome(), 'runtimes', 'doe');
}

/** Canonicalize an existing cwd; preserve absolute future project paths. */
export function canonicalDoeCwd(cwd: string): string {
  const absolute = path.resolve(cwd);
  let ancestor = absolute;
  for (;;) {
    try {
      return path.join(realpathSync(ancestor), path.relative(ancestor, absolute));
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

/** Session metadata and immutable inference selection; never a credential value. */
export interface DoeSessionRecord {
  session: Session;
  inference?: JsonValue;
}

/** Durable host metadata, separate from the engine's full model-message database. */
export class DoeSessionStore {
  readonly models: SqliteModelStore;
  private readonly db: Database.Database;
  private readonly listeners = new Set<DoeEventQueue<SessionListEvent>>();
  private closed = false;

  /** Open only the supplied directory; construction resolves no model credentials. */
  constructor(directory = doeSessionsDirectory()) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(directory, 'sessions.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, record TEXT NOT NULL)');
    this.models = new SqliteModelStore(path.join(directory, 'models.sqlite'));
  }

  /** Read metadata without creating a session. */
  get(id: string): DoeSessionRecord | null {
    const row = this.db.prepare('SELECT record FROM sessions WHERE id = ?').get(id) as
      { record: string } | undefined;
    return row ? (JSON.parse(row.record) as DoeSessionRecord) : null;
  }

  /** Read all durable metadata, then scope it by canonical project membership. */
  list(projectDir?: string): Session[] {
    const rows = this.db.prepare('SELECT record FROM sessions ORDER BY id').all() as {
      record: string;
    }[];
    const sessions = rows.map((row) => (JSON.parse(row.record) as DoeSessionRecord).session);
    return projectDir === undefined
      ? sessions
      : sessions.filter((session) => isWithinDirectory(session.cwd, canonicalDoeCwd(projectDir)));
  }

  /** A tracked record belongs only to its cwd subtree; unbound sessions remain reachable by id. */
  belongs(id: string, projectDir: string): boolean {
    const record = this.get(id);
    return (
      record !== null &&
      (record.session.cwd === undefined ||
        isWithinDirectory(record.session.cwd, canonicalDoeCwd(projectDir)))
    );
  }

  /** Ensure idempotently, preserving previously chosen cwd, settings and inference. */
  ensure(id: string, settings: SessionSettings & { cwd?: string }): DoeSessionRecord {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error('Invalid session id.');
    const existing = this.get(id);
    if (existing) return existing;
    const now = new Date().toISOString();
    const record: DoeSessionRecord = {
      session: {
        id,
        title: '',
        createdAt: now,
        updatedAt: now,
        runtime: 'doe',
        permissionMode: settings.permissionMode ?? 'default',
        ...(settings.cwd !== undefined ? { cwd: canonicalDoeCwd(settings.cwd) } : {}),
        ...(settings.model !== undefined ? { model: settings.model } : {}),
      },
    };
    this.save(record);
    this.models.createSession(id);
    return record;
  }

  /** Write metadata before notifying observers; a failed write never claims success. */
  save(record: DoeSessionRecord): void {
    this.db
      .prepare(
        'INSERT INTO sessions(id,record) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record'
      )
      .run(record.session.id, JSON.stringify(record));
    if (record.session.cwd !== undefined) {
      const event: SessionListEvent = { type: 'session_upserted', session: { ...record.session } };
      for (const listener of this.listeners) listener.push(event);
    }
  }

  /** Patch inference against current metadata after asynchronous setup, preserving settings. */
  setInference(id: string, inference: JsonValue): void {
    const record = this.get(id);
    if (!record) throw new Error('Unknown session.');
    record.inference = inference;
    this.save(record);
  }

  /** Persist session choices first; unknown sessions are not invented by PATCH. */
  update(id: string, settings: SessionSettings): boolean {
    const record = this.get(id);
    if (!record) return false;
    Object.assign(
      record.session,
      Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined))
    );
    record.session.updatedAt = new Date().toISOString();
    this.save(record);
    return true;
  }

  /** Record the person's own message and derive a title only once. */
  message(id: string, content: string, cwd: string, title?: string): DoeSessionRecord {
    const record = this.get(id)!;
    if (!record.session.title) record.session.title = title ?? deriveSessionTitle(content);
    record.session.cwd = canonicalDoeCwd(cwd);
    record.session.lastMessagePreview = [...content.split('\n')[0]!].slice(0, 80).join('');
    record.session.updatedAt = new Date().toISOString();
    record.session.userLastMessageAt = record.session.updatedAt;
    this.save(record);
    return record;
  }

  /** Inventory followed by copied updates; return() tears down parked readers. */
  subscribe(): AsyncIterableIterator<SessionListEvent> {
    const queue = new DoeEventQueue<SessionListEvent>();
    for (const session of this.list()) {
      if (session.cwd !== undefined) queue.push({ type: 'session_upserted', session });
    }
    this.listeners.add(queue);
    const finish = queue.return.bind(queue);
    queue.return = () => {
      this.listeners.delete(queue);
      return finish();
    };
    return queue;
  }

  /** Close this runtime's stores and readers exactly once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.listeners) void listener.return();
    this.listeners.clear();
    this.models.close();
    this.db.close();
  }
}
