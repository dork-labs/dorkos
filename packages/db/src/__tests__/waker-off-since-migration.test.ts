/**
 * The DOR-3641 follow-up: schedules active before the approval receipt get a
 * policy receipt, and `off_since` says when each schedule stopped being able to
 * run, kept by triggers so no writer can forget it.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations } from '../index.js';

/** The journal index of the migration under test, found by its tag so a renumber cannot hide it. */
const MIGRATION_IDX = (
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../drizzle/meta/_journal.json', import.meta.url)),
      'utf8'
    )
  ) as { entries: { idx: number; tag: string }[] }
).entries.find((entry) => entry.tag.endsWith('_dor3641_waker_off_since'))!.idx;

describe('the waker off-since migration (DOR-3641)', () => {
  let directory: string;
  let db: ReturnType<typeof createDb>;

  /** Migrate up to and including one journal index, no further. */
  function migrateThrough(lastIdx: number) {
    const migrations = fileURLToPath(new URL('../../drizzle/', import.meta.url));
    const journal = JSON.parse(readFileSync(join(migrations, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= lastIdx);
    for (const entry of journal.entries)
      copyFileSync(join(migrations, `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
    writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify(journal));
    migrate(db, { migrationsFolder: directory });
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'waker-off-since-'));
    mkdirSync(join(directory, 'meta'));
    db = createDb(':memory:');
  });

  afterEach(() => {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function schedule(id: string, enabled: boolean, status: string) {
    db.$client
      .prepare(
        `INSERT INTO pulse_schedules (id, name, cron, prompt, file_path, created_at, updated_at, enabled, status)
         VALUES (?, ?, '0 3 * * *', 'sweep', '', '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z', ?, ?)`
      )
      .run(id, id, enabled ? 1 : 0, status);
  }

  function row(id: string) {
    return db.$client
      .prepare(
        `SELECT approved_at AS approvedAt, approved_by AS approvedBy, approved_via AS approvedVia,
           off_since AS offSince FROM pulse_schedules WHERE id = ?`
      )
      .get(id) as {
      approvedAt: string | null;
      approvedBy: string | null;
      approvedVia: string | null;
      offSince: string | null;
    };
  }

  function set(id: string, columns: string) {
    db.$client.prepare(`UPDATE pulse_schedules SET ${columns} WHERE id = ?`).run(id);
  }

  it('stamps a policy receipt on every active or granted schedule that has none, and leaves the rest', () => {
    migrateThrough(MIGRATION_IDX - 1);
    schedule('active-blank', true, 'active');
    schedule('active-off', false, 'active');
    schedule('waiting', true, 'pending_approval');
    schedule('approved', true, 'active');
    // Paused with its grant: it comes back live when its file returns.
    schedule('paused-granted', true, 'paused');
    set('paused-granted', `approved_content_key = 'k1'`);
    set(
      'approved',
      `approved_at = '2026-11-03T00:00:00.000Z', approved_by = '{"kind":"person","userId":null,"name":"Dorian"}', approved_via = 'inbox'`
    );

    migrateThrough(MIGRATION_IDX);

    for (const id of ['active-blank', 'active-off', 'paused-granted']) {
      expect(row(id)).toMatchObject({
        approvedAt: '2026-11-02T00:00:00.000Z',
        approvedBy: '{"kind":"policy"}',
        approvedVia: 'unknown',
      });
    }
    expect(row('waiting')).toMatchObject({ approvedAt: null, approvedBy: null, approvedVia: null });
    expect(row('approved')).toMatchObject({
      approvedAt: '2026-11-03T00:00:00.000Z',
      approvedVia: 'inbox',
    });
  });

  it('dates every schedule that is off now from its last write, and leaves a running one blank', () => {
    migrateThrough(MIGRATION_IDX - 1);
    schedule('running', true, 'active');
    schedule('switched-off', false, 'active');
    schedule('waiting', true, 'pending_approval');
    schedule('paused', true, 'paused');

    migrateThrough(MIGRATION_IDX);

    expect(row('running').offSince).toBeNull();
    for (const id of ['switched-off', 'waiting', 'paused']) {
      expect(row(id).offSince).toBe('2026-11-02T00:00:00.000Z');
    }
  });

  it('keeps off_since with every later switch, whoever writes it', () => {
    migrateThrough(MIGRATION_IDX);
    schedule('born-off', false, 'active');
    schedule('born-on', true, 'active');
    expect(row('born-off').offSince).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row('born-on').offSince).toBeNull();

    set('born-on', `status = 'pending_approval'`);
    const parkedAt = row('born-on').offSince;
    expect(parkedAt).not.toBeNull();

    // Still off for another reason: the first time it stopped is what counts.
    set('born-on', `status = 'active', enabled = 0`);
    expect(row('born-on').offSince).toBe(parkedAt);
    // An edit that switches nothing leaves it alone.
    set('born-on', `name = 'renamed'`);
    expect(row('born-on').offSince).toBe(parkedAt);

    set('born-on', `enabled = 1`);
    expect(row('born-on').offSince).toBeNull();
  });

  it('leaves a project copy born off blank, and dates one a person turned on and off', () => {
    migrateThrough(MIGRATION_IDX);
    const projectCopy = (id: string) =>
      db.$client
        .prepare(
          `INSERT INTO pulse_schedules (id, name, cron, prompt, file_path, created_at, updated_at, enabled, status, project_only)
           VALUES (?, ?, '0 3 * * *', 'sweep', '', '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z', 0, 'active', 1)`
        )
        .run(id, id);
    projectCopy('never-on');
    projectCopy('turned-off');

    set('turned-off', 'enabled = 1');
    expect(row('turned-off').offSince).toBeNull();
    set('turned-off', 'enabled = 0');

    expect(row('never-on').offSince).toBeNull();
    expect(row('turned-off').offSince).not.toBeNull();
  });

  it('does not date a project copy that was off before the upgrade', () => {
    migrateThrough(MIGRATION_IDX - 1);
    db.$client
      .prepare(
        `INSERT INTO pulse_schedules (id, name, cron, prompt, file_path, created_at, updated_at, enabled, status, project_only)
         VALUES ('copy', 'copy', '0 3 * * *', 'sweep', '', '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z', 0, 'active', 1)`
      )
      .run();

    migrateThrough(MIGRATION_IDX);

    expect(row('copy').offSince).toBeNull();
  });

  it('still has both triggers after every migration, so a later table rebuild cannot drop them', () => {
    runMigrations(db);
    const triggers = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'pulse_schedules' ORDER BY name"
      )
      .all() as { name: string }[];
    expect(triggers.map((trigger) => trigger.name)).toEqual([
      'pulse_schedules_off_since_insert',
      'pulse_schedules_off_since_update',
    ]);
  });
});
