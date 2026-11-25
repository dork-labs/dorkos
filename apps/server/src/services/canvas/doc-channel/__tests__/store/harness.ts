/**
 * Shared setup for the store suites: everything the original file declared or
 * registered outside its tests.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { DocChannelStore } from '../../store.js';

export const NOW = '2026-10-01T12:00:00.000Z';

export const LATER = '2026-10-01T12:01:00.000Z';

export const connections: Db[] = [];

export const directories: string[] = [];

afterEach(() => {
  for (const db of connections.splice(0)) db.$client.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

export function open(file = ':memory:'): { db: Db; store: DocChannelStore } {
  const db = createDb(file);
  connections.push(db);
  runMigrations(db);
  return { db, store: new DocChannelStore(db) };
}

export function filePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'doc-channel-store-'));
  directories.push(directory);
  return join(directory, 'channel.db');
}

export function channel(store: DocChannelStore, documentId = 'document-1'): void {
  store.initialize({ documentId, scope: 'session:session-1', createdAt: NOW, updatedAt: NOW });
}

export function event(documentId = 'document-1', eventId = 'event-1') {
  return {
    documentId,
    eventId,
    direction: 'upstream' as const,
    type: 'task.comment',
    payload: { text: 'Private content' },
    envelopeHash: 'a'.repeat(64),
    receivedAt: NOW,
    provenance: { transport: 'widget', actorId: 'person-1' },
  };
}

export function grant(documentId = 'document-1') {
  return {
    grantId: `grant-${documentId}`,
    documentId,
    routeId: 'route-1',
    normalizedRoute: { on: 'task.*', to: 'agent:owner' },
    routeHash: 'b'.repeat(64),
    declarationHash: 'c'.repeat(64),
    approvedBy: 'person-1',
    approvalEvidence: { verdict: 'approved' },
    allowedTypes: ['task.comment'],
    limits: { envelopeBytes: 16384, eventsPerMinute: 60, turnsPerHour: 10 },
    createdAt: NOW,
  };
}

export function batch(documentId = 'document-1', batchId = 'batch-1') {
  return {
    batchId,
    documentId,
    scope: 'session:session-1',
    routeId: 'route-1',
    grantId: `grant-${documentId}`,
    grantRevision: 1,
    generation: 'generation-1',
    inputEventIds: ['event-1'],
    effectivePayload: { events: ['event-1'] },
    dueAt: NOW,
    status: 'pending' as const,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

export function seedBatch(store: DocChannelStore): void {
  channel(store);
  store.insertGrant(grant());
  store.appendEvent(event());
  store.insertBatch(batch());
}

export function delivery() {
  return {
    documentId: 'document-1',
    eventId: 'event-1',
    routeId: 'route-1',
    batchId: 'batch-1',
    status: 'pending' as const,
    updatedAt: NOW,
  };
}
