/**
 * Ending live standing permissions at upgrade (spec `agent-permissions` D13,
 * phase 2): the capture before the table is dropped, and the one history line
 * per grant once the Activity log exists.
 *
 * The capture runs against a real SQLite database holding the old
 * `approval_grants` table, created by hand here because the test database has
 * already run the migration that drops it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { sql, type Db } from '@dorkos/db';

import {
  ENDED_STANDING_GRANTS_FILE,
  captureLiveStandingGrants,
  recordEndedStandingGrants,
} from '../ended-standing-grants.js';
import { STANDING_GRANT_ENDED_EVENT, listPermissionHistory } from '../permission-history.js';
import { createPermissionWorld } from './permission-fixtures.js';

const NOW = new Date('2026-09-23T12:00:00.000Z');
const quiet = { warn: () => {} };

/** Recreate the retired table, as it stood before this build. */
function withGrantsTable(db: Db): void {
  db.run(sql`CREATE TABLE approval_grants (
    id text PRIMARY KEY NOT NULL,
    agent_path text NOT NULL,
    capability_id text NOT NULL,
    granted_at text NOT NULL,
    expires_at text NOT NULL,
    granted_by text NOT NULL,
    posture text NOT NULL,
    source_approval_id text,
    revoked_at text
  )`);
}

/** Insert one grant row. */
function grant(
  db: Db,
  row: {
    id: string;
    agentPath: string;
    capabilityId: string;
    expiresAt: string;
    revokedAt?: string;
  }
): void {
  db.run(sql`INSERT INTO approval_grants
    (id, agent_path, capability_id, granted_at, expires_at, granted_by, posture, revoked_at)
    VALUES (${row.id}, ${row.agentPath}, ${row.capabilityId}, ${'2026-09-23T08:00:00.000Z'},
      ${row.expiresAt}, ${'user_owner'}, ${'signed-in-operator'}, ${row.revokedAt ?? null})`);
}

describe('ended standing permissions', () => {
  let dorkHome: string;
  let db: Db;

  beforeEach(() => {
    dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-ended-grants-'));
    db = createTestDb();
  });

  afterEach(() => {
    fs.rmSync(dorkHome, { recursive: true, force: true });
  });

  it('captures nothing, and writes no file, once the table is gone', () => {
    expect(captureLiveStandingGrants(db, dorkHome, quiet, NOW)).toBe(0);
    expect(fs.existsSync(path.join(dorkHome, ENDED_STANDING_GRANTS_FILE))).toBe(false);
  });

  it('captures only the live grants: not expired, not revoked', () => {
    withGrantsTable(db);
    grant(db, {
      id: 'g-live',
      agentPath: '/agents/dorkbot',
      capabilityId: 'marketplace.uninstall',
      expiresAt: '2026-09-23T16:00:00.000Z',
    });
    grant(db, {
      id: 'g-expired',
      agentPath: '/agents/dorkbot',
      capabilityId: 'tasks_delete',
      expiresAt: '2026-09-23T09:00:00.000Z',
    });
    grant(db, {
      id: 'g-revoked',
      agentPath: '/agents/dorkbot',
      capabilityId: 'tasks_delete',
      expiresAt: '2026-09-23T16:00:00.000Z',
      revokedAt: '2026-09-23T10:00:00.000Z',
    });

    expect(captureLiveStandingGrants(db, dorkHome, quiet, NOW)).toBe(1);
    const written = JSON.parse(
      fs.readFileSync(path.join(dorkHome, ENDED_STANDING_GRANTS_FILE), 'utf-8')
    ) as { id: string }[];
    expect(written.map((g) => g.id)).toEqual(['g-live']);
  });

  it('writes one upgrade line per grant, naming the agent and the action, then forgets them', async () => {
    withGrantsTable(db);
    grant(db, {
      id: 'g-1',
      agentPath: '/agents/dorkbot',
      capabilityId: 'marketplace.uninstall',
      expiresAt: '2026-09-23T16:00:00.000Z',
    });
    grant(db, {
      id: 'g-2',
      agentPath: '/agents/gone',
      capabilityId: 'tasks_delete',
      expiresAt: '2026-09-23T16:00:00.000Z',
    });
    captureLiveStandingGrants(db, dorkHome, quiet, NOW);
    const world = createPermissionWorld({
      agents: [
        {
          id: 'agent-dorkbot',
          name: 'dorkbot',
          displayName: 'DorkBot',
          projectPath: '/agents/dorkbot',
        },
      ],
    });
    const deps = {
      dorkHome,
      agents: () => [world.service.agentByPath('/agents/dorkbot')!],
      actionTitle: (id: string) => (id === 'marketplace.uninstall' ? 'Uninstall a package' : id),
      activity: world.activity,
      logger: quiet,
    };

    expect(await recordEndedStandingGrants(deps)).toBe(2);
    const lines = world.events.filter((e) => e.eventType === STANDING_GRANT_ENDED_EVENT);
    expect(lines.map((e) => [e.actorLabel, e.category, e.resourceId, e.summary])).toEqual([
      [
        'Upgrade',
        'permissions',
        'agent-dorkbot',
        'DorkBot: the "stop asking" window for Uninstall a package ended. Always allow replaces it.',
      ],
      [
        'Upgrade',
        'permissions',
        null,
        'gone: the "stop asking" window for tasks_delete ended. Always allow replaces it.',
      ],
    ]);
    expect(lines[0]!.metadata).toMatchObject({ after: null, grantId: 'g-1', surface: 'upgrade' });

    // Idempotent: the file is the record that lines are owed, and it is gone.
    expect(fs.existsSync(path.join(dorkHome, ENDED_STANDING_GRANTS_FILE))).toBe(false);
    expect(await recordEndedStandingGrants(deps)).toBe(0);
    expect(world.events.filter((e) => e.eventType === STANDING_GRANT_ENDED_EVENT)).toHaveLength(2);

    // And it shows in the agent's permission history.
    const history = await listPermissionHistory(world.activity, {
      agentId: 'agent-dorkbot',
      limit: 10,
    });
    expect(history.items.map((i) => i.summary)).toEqual([lines[0]!.summary]);
  });

  it('keeps an unconsumed capture when a second boot captures again', () => {
    withGrantsTable(db);
    grant(db, {
      id: 'g-1',
      agentPath: '/agents/dorkbot',
      capabilityId: 'marketplace.uninstall',
      expiresAt: '2026-09-23T16:00:00.000Z',
    });
    captureLiveStandingGrants(db, dorkHome, quiet, NOW);
    db.run(sql`DELETE FROM approval_grants`);
    grant(db, {
      id: 'g-2',
      agentPath: '/agents/dorkbot',
      capabilityId: 'tasks_delete',
      expiresAt: '2026-09-23T16:00:00.000Z',
    });
    captureLiveStandingGrants(db, dorkHome, quiet, NOW);

    const written = JSON.parse(
      fs.readFileSync(path.join(dorkHome, ENDED_STANDING_GRANTS_FILE), 'utf-8')
    ) as { id: string }[];
    expect(written.map((g) => g.id).sort()).toEqual(['g-1', 'g-2']);
  });
});
