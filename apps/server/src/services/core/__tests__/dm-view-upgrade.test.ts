/**
 * The one-time DM view upgrade (DOR-3074), over a real database and a real
 * config file: the stored `false` the `0.125.0` key wrote turns on unless the
 * audit log says a person set it, Show sessions stays for anyone who opened a
 * chat other than a Direct chat in the last 30 days, and it never runs twice.
 *
 * Assertions read the FILE: `conf` fills defaults into every read copy, so a
 * manager read could pass with nothing written (DOR-1496).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { AuditLog } from '../../audit/audit-log.js';
import { SessionTouchStore } from '../../session/origin/session-touch-store.js';
import { ConfigManager } from '../config-manager.js';
import { CONFIG_WRITE_POLICY } from '../operator/config-write-policy.js';
import { applyDmViewUpgrade, RECENT_OPEN_MS } from '../config/dm-view-upgrade.js';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

let home: string;
let db: Db;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dm-view-upgrade-'));
  db = createTestDb();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A config as `0.130.0` left it: both leaves stored off. */
function seedConfig(ui: Record<string, unknown> = { dmView: false, showSessions: false }) {
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ version: 1, ui, __internal__: { migrations: { version: '0.130.0' } } })
  );
  return new ConfigManager(home);
}

/** The `ui` section as it sits on disk. */
function uiOnDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).ui;
}

/** Record a settings change the way the app does. */
function audit(field: string, before: unknown, after: unknown): void {
  new AuditLog(db).record({
    action: 'config.changed',
    operation: 'modify',
    actor: { kind: 'person', accountId: 'a', name: 'Person' },
    source: { surface: 'app' },
    target: { type: 'config', id: 'config.json', name: 'Settings' },
    outcome: 'ok',
    change: [{ field, before, after }],
    summary: `Changed settings: ${field}`,
  } as never);
}

/** Run it against the seeded config. */
function run(store: ConfigManager, recordWrite = vi.fn()) {
  return {
    recordWrite,
    result: applyDmViewUpgrade({
      doneFile: join(home, 'upgrades', 'dm-view-on.json'),
      db,
      store,
      isDirectChat: (sessionId) => sessionId.startsWith('direct-'),
      recordWrite,
      logger: { info: vi.fn() },
      now: () => NOW,
    }),
  };
}

describe('the DM view upgrade', () => {
  // Any `config.changed` row counts as a choice, the step's own `system` row
  // included, so it must not be filtered by actor. That is safe only while an
  // agent cannot write one: its patch to an operator-only leaf is refused and
  // records nothing. Loosen either verdict and an agent's write reads as a person's.
  it('counts every row as a choice only while agents cannot write these settings', () => {
    expect(CONFIG_WRITE_POLICY['ui.dmView']).toBe('operator-only');
    expect(CONFIG_WRITE_POLICY['ui.showSessions']).toBe('operator-only');
  });

  it('turns on a stored false nobody chose, and records the change', () => {
    const store = seedConfig();
    const { result, recordWrite } = run(store);
    expect(result).toEqual({ dmView: true, showSessions: false });
    expect(uiOnDisk()).toMatchObject({ dmView: true, showSessions: false });
    expect(recordWrite).toHaveBeenCalledOnce();
  });

  it('leaves it off for a person who turned it on and back off', () => {
    audit('ui.dmView', false, true);
    audit('ui.dmView', true, false);
    const { result, recordWrite } = run(seedConfig());
    expect(result).toEqual({ dmView: false, showSessions: false });
    expect(uiOnDisk()).toMatchObject({ dmView: false });
    expect(recordWrite).not.toHaveBeenCalled();
  });

  it('is not fooled by another field that only mentions the name', () => {
    audit('ui.theme', 'ui.dmView', 'dark');
    run(seedConfig());
    expect(uiOnDisk()).toMatchObject({ dmView: true });
  });

  it('keeps Show sessions for someone who opened a chat inside the 30 days', () => {
    new SessionTouchStore(db).recordOpened(
      'chat-1',
      new Date(NOW - RECENT_OPEN_MS + DAY).toISOString()
    );
    const { result } = run(seedConfig());
    expect(result).toEqual({ dmView: true, showSessions: true });
    expect(uiOnDisk()).toMatchObject({ dmView: true, showSessions: true });
  });

  it('does not for someone who only opened Direct chats, which stay where they are', () => {
    new SessionTouchStore(db).recordOpened('direct-1', new Date(NOW).toISOString());
    const { result } = run(seedConfig());
    expect(result).toEqual({ dmView: true, showSessions: false });
    expect(uiOnDisk()).toMatchObject({ dmView: true, showSessions: false });
  });

  it('does for someone with a Direct chat and one other chat opened recently', () => {
    const touches = new SessionTouchStore(db);
    touches.recordOpened('direct-1', new Date(NOW).toISOString());
    touches.recordOpened('chat-2', new Date(NOW - DAY).toISOString());
    run(seedConfig());
    expect(uiOnDisk()).toMatchObject({ showSessions: true });
  });

  it('does not for a chat last opened before the 30 days', () => {
    new SessionTouchStore(db).recordOpened(
      'chat-1',
      new Date(NOW - RECENT_OPEN_MS - DAY).toISOString()
    );
    run(seedConfig());
    expect(uiOnDisk()).toMatchObject({ showSessions: false });
  });

  it('leaves Show sessions off for a person who turned it off, however recent their chats', () => {
    new SessionTouchStore(db).recordOpened('chat-1', new Date(NOW).toISOString());
    audit('ui.showSessions', true, false);
    run(seedConfig());
    expect(uiOnDisk()).toMatchObject({ dmView: true, showSessions: false });
  });

  it('runs once: a person who turns it off afterwards stays off', () => {
    const store = seedConfig();
    run(store);
    store.setDot('ui.dmView', false);
    expect(run(store).result).toBeNull();
    expect(uiOnDisk()).toMatchObject({ dmView: false });
  });

  it('writes nothing for a config already on, and still marks itself done', () => {
    const { result, recordWrite } = run(seedConfig({ dmView: true, showSessions: true }));
    expect(result).toEqual({ dmView: false, showSessions: false });
    expect(recordWrite).not.toHaveBeenCalled();
    expect(existsSync(join(home, 'upgrades', 'dm-view-on.json'))).toBe(true);
  });

  it('writes nothing and stays not done when a record cannot be read', () => {
    const store = seedConfig();
    const broken = {} as Db;
    expect(() =>
      applyDmViewUpgrade({
        doneFile: join(home, 'upgrades', 'dm-view-on.json'),
        db: broken,
        store,
        isDirectChat: () => false,
        recordWrite: vi.fn(),
        logger: { info: vi.fn() },
      })
    ).toThrow();
    expect(uiOnDisk()).toMatchObject({ dmView: false });
    expect(existsSync(join(home, 'upgrades', 'dm-view-on.json'))).toBe(false);
  });
});
