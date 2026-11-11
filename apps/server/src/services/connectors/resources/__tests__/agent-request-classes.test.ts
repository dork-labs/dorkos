import { beforeEach, describe, expect, it } from 'vitest';
import {
  connectorOperationRevisions,
  connectorProviderInstances,
  createDb,
  runMigrations,
  type Db,
} from '@dorkos/db';
import { appCanOnlyRead } from '../agent-request-classes.js';

const STAMP = '2026-11-11T00:00:00.000Z';

describe('appCanOnlyRead (DOR-4193)', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    db.insert(connectorProviderInstances)
      .values({
        id: 'provider-1',
        type: 'test',
        mode: 'byo',
        displayName: 'Test provider',
        custody: 'self-host',
        capabilityJson: '{}',
        executionConfigGeneration: 1,
        ownerKind: 'local_install',
        ownerId: 'install-1',
        status: 'available',
        createdAt: STAMP,
        updatedAt: STAMP,
      })
      .run();
  });

  function seed(toolkit: string, classes: Array<'read' | 'write' | 'destructive'>) {
    classes.forEach((classification, index) => {
      db.insert(connectorOperationRevisions)
        .values({
          id: `${toolkit}-${index}`,
          providerInstanceId: 'provider-1',
          toolkit,
          operationSlug: `${toolkit}.op${index}`,
          toolkitVersion: '1',
          schemaHash: `hash-${toolkit}-${index}`,
          capabilityClassification: classification,
          retryPolicy: 'never',
          providerRevisionRef: `ref-${toolkit}-${index}`,
          inputSchemaJson: '{}',
          discoveredAt: STAMP,
        })
        .run();
    });
  }

  it('is true for an app whose change actions are all destructive, like Linear', () => {
    seed('linear', ['read', 'destructive']);
    expect(appCanOnlyRead(db, 'provider-1', 'linear')).toBe(true);
  });

  it('is true for an app with reads only', () => {
    seed('neon', ['read']);
    expect(appCanOnlyRead(db, 'provider-1', 'neon')).toBe(true);
  });

  it('is false for an app with a write action, like Gmail', () => {
    seed('gmail', ['read', 'write', 'destructive']);
    expect(appCanOnlyRead(db, 'provider-1', 'gmail')).toBe(false);
  });

  it('is false for an app whose actions were never read', () => {
    expect(appCanOnlyRead(db, 'provider-1', 'slack')).toBe(false);
  });
});
