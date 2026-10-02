/** Real committed high watermarks, scope isolation and bounded subscriber teardown. */
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import {
  createServerPrincipal,
  isServerPrincipal,
} from '../../../connectors/principal/server-principal.js';
import { DocChannelStore } from '../store.js';
import { DocChannelLiveBuffer } from '../streams/live-buffer.js';
const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.$client.close();
});
function fixture(limit = 1000) {
  const db = createDb(':memory:');
  databases.push(db);
  runMigrations(db);
  const store = new DocChannelStore(db);
  const actor = {
    surface: 'http' as const,
    principal: createServerPrincipal({
      kind: 'operator',
      owner: { kind: 'local_install', installationId: 'fixture' },
    }),
  };
  let allowed = true;
  const bus = new DocChannelLiveBuffer(
    store,
    {
      resolveScope: (scope) => scope,
      requireScopeCurrent: (scope, caller) => {
        if (
          !allowed ||
          !isServerPrincipal(caller.principal) ||
          caller !== actor ||
          scope !== 'session:one'
        )
          throw new Error('Unavailable');
      },
    },
    limit
  );
  const initialize = (id: string, scope = 'session:one') =>
    store.initialize({
      documentId: id,
      scope,
      createdAt: '2026-10-01T12:00:00Z',
      updatedAt: '2026-10-01T12:00:00Z',
    });
  const append = (id: string) =>
    store.appendEvent({
      documentId: id,
      eventId: randomUUID(),
      direction: 'system',
      type: 'state.changed',
      payload: { stateRev: 1 },
      envelopeHash: 'a'.repeat(64),
      receivedAt: '2026-10-01T12:00:00Z',
      provenance: {},
    });
  return {
    db,
    store,
    actor,
    bus,
    initialize,
    append,
    revoke: () => {
      allowed = false;
    },
  };
}
it('attaches before iteration and coalesces committed wakeups for both viewers', async () => {
  const f = fixture();
  f.initialize('doc');
  const first = f.bus
    .subscribe('session:one', f.actor, new AbortController().signal)
    [Symbol.asyncIterator]();
  const second = f.bus
    .subscribe('session:one', f.actor, new AbortController().signal)
    [Symbol.asyncIterator]();
  f.append('doc');
  f.bus.notifyCommitted('doc');
  f.append('doc');
  f.bus.notifyCommitted('doc');
  const expected = { documentId: 'doc', scope: 'session:one', highWatermark: 2 };
  expect((await first.next()).value).toEqual(expected);
  expect((await second.next()).value).toEqual(expected);
  await first.return?.();
  await second.return?.();
});
it('never discloses another scope and revocation tears down a parked reader', async () => {
  const f = fixture();
  f.initialize('other', 'session:other');
  f.initialize('doc');
  expect(() => f.bus.subscribe('session:other', f.actor, new AbortController().signal)).toThrow(
    'Unavailable'
  );
  const reader = f.bus
    .subscribe('session:one', f.actor, new AbortController().signal)
    [Symbol.asyncIterator]();
  const waiting = reader.next();
  f.append('other');
  f.bus.notifyCommitted('other');
  f.revoke();
  f.append('doc');
  f.bus.notifyCommitted('doc');
  expect((await waiting).done).toBe(true);
});
it('overflow ends the reader instead of silently dropping durable work', async () => {
  const f = fixture(1);
  f.initialize('first');
  f.initialize('second');
  const reader = f.bus
    .subscribe('session:one', f.actor, new AbortController().signal)
    [Symbol.asyncIterator]();
  f.append('first');
  f.bus.notifyCommitted('first');
  f.append('second');
  f.bus.notifyCommitted('second');
  expect((await reader.next()).done).toBe(true);
  expect(f.store.getChannel('first')!.nextDocSeq).toBe(2);
  expect(f.store.getChannel('second')!.nextDocSeq).toBe(2);
});
it('abort and explicit return release parked reads', async () => {
  const f = fixture();
  const controller = new AbortController();
  const reader = f.bus.subscribe('session:one', f.actor, controller.signal)[Symbol.asyncIterator]();
  const pending = reader.next();
  controller.abort();
  expect((await pending).done).toBe(true);
  const other = f.bus
    .subscribe('session:one', f.actor, new AbortController().signal)
    [Symbol.asyncIterator]();
  const second = other.next();
  await other.return?.();
  expect((await second).done).toBe(true);
});
