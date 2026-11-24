import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SqliteModelStore, type JsonValue } from '@dorkos/doe';
import type { Session, SessionSettings } from '@dorkos/shared/types';
import { sessionShownToPerson, shownToPerson, titleShownToPerson } from '@dorkos/shared/kickoff';
import { UNTITLED_CHAT_TITLE } from '@dorkos/shared/session-link';
import type { SessionListEvent } from '@dorkos/shared/session-stream';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { deriveSessionTitle } from '../shared/session/derive-title.js';
import { projectMembership } from '../shared/session/project-membership.js';
import {
  sessionMessagePreview,
  TrackedSessionRegistry,
} from '../shared/session/session-registry.js';

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

/** Display legacy rows and new drafts without setting a durable first-message title. */
function displaySession(session: Session): Session {
  const shown = sessionShownToPerson(session);
  return {
    ...shown,
    title: shown.title.trim()
      ? shown.title
      : shown.lastMessagePreview?.trim() || UNTITLED_CHAT_TITLE,
  };
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
  private readonly tracked: TrackedSessionRegistry<never>;
  private closed = false;

  /** Open only the supplied directory; construction resolves no model credentials. */
  constructor(directory = doeSessionsDirectory()) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(directory, 'sessions.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, record TEXT NOT NULL)');
    this.models = new SqliteModelStore(path.join(directory, 'models.sqlite'));
    this.tracked = new TrackedSessionRegistry<never>({
      runtime: 'doe',
      defaultPermissionMode: 'default',
      projectMembership: (projectDir) =>
        projectMembership(projectDir, { resolveStoredProject: canonicalDoeCwd }),
      display: displaySession,
      source: {
        get: (id) => this.get(id)?.session,
        values: () => {
          const rows = this.db.prepare('SELECT record FROM sessions ORDER BY id').all() as {
            record: string;
          }[];
          return rows.map((row) => (JSON.parse(row.record) as DoeSessionRecord).session);
        },
      },
    });
  }

  /** Read metadata without creating a session. */
  get(id: string): DoeSessionRecord | null {
    const row = this.db.prepare('SELECT record FROM sessions WHERE id = ?').get(id) as
      { record: string } | undefined;
    if (!row) return null;
    const record = JSON.parse(row.record) as DoeSessionRecord;
    // A legacy greeting title reads as untitled so a person's message can name the chat.
    return { ...record, session: sessionShownToPerson(record.session) };
  }

  /** Read display metadata without setting a title on the stored record. */
  getForDisplay(id: string): Session | null {
    return this.tracked.get(id);
  }

  /** Scope display metadata by canonical project membership. */
  list(projectDir?: string): Session[] {
    return this.tracked.list(projectDir);
  }

  /** A tracked record belongs only to its cwd subtree; unbound sessions remain reachable by id. */
  belongs(id: string, projectDir: string): boolean {
    const record = this.get(id);
    return (
      record !== null &&
      (record.session.cwd === undefined ||
        projectMembership(projectDir, { resolveStoredProject: canonicalDoeCwd })(
          record.session.cwd
        ))
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
    this.tracked.publishSaved(record.session);
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
    const preview = sessionMessagePreview(content, '');
    if (!record.session.title.trim()) {
      const suppliedTitle = titleShownToPerson(title);
      const firstTitle = suppliedTitle.trim()
        ? suppliedTitle
        : deriveSessionTitle(content) || preview.trim();
      if (firstTitle) record.session.title = firstTitle;
    }
    record.session.cwd = canonicalDoeCwd(cwd);
    record.session.lastMessagePreview = preview;
    record.session.updatedAt = new Date().toISOString();
    // The greeting kickoff does not count as a person's message (DOR-4976).
    if (shownToPerson(content)) record.session.userLastMessageAt = record.session.updatedAt;
    this.save(record);
    return record;
  }

  /** Inventory followed by copied updates; return() tears down parked readers. */
  subscribe(): AsyncIterableIterator<SessionListEvent> {
    return this.tracked.subscribe();
  }

  /** Close this runtime's stores and readers exactly once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.tracked.closeSubscribers();
    this.models.close();
    this.db.close();
  }
}
