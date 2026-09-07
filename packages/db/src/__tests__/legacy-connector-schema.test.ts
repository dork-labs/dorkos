import { describe, expect, it } from 'vitest';
import { createDb, runMigrations } from '../index.js';
import * as publicDb from '../index.js';
import * as runtimeSchema from '../schema/index.js';

const retiredRuntimeNames = [
  'connectedAccounts',
  'agentConnectorAttachments',
  'sessionConnectorAttachments',
] as const;

describe('retired connector schema boundary', () => {
  it.each(retiredRuntimeNames)(
    'does not expose %s through the live schema or package API',
    (name) => {
      expect(runtimeSchema).not.toHaveProperty(name);
      expect(publicDb).not.toHaveProperty(name);
    }
  );

  it('keeps the historical physical tables until the application backfill runs', () => {
    const db = createDb(':memory:');
    runMigrations(db);

    const tables = db.$client
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (?, ?, ?)
         ORDER BY name`
      )
      .all(
        ...retiredRuntimeNames.map((name) => {
          if (name === 'connectedAccounts') return 'connected_accounts';
          if (name === 'agentConnectorAttachments') return 'agent_connector_attachments';
          return 'session_connector_attachments';
        })
      ) as Array<{ name: string }>;

    expect(tables.map((row) => row.name)).toEqual([
      'agent_connector_attachments',
      'connected_accounts',
      'session_connector_attachments',
    ]);
    db.$client.close();
  });
});
