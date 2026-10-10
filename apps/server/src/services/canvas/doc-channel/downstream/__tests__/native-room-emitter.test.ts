/** Genuine constructor/migrated DB refusal controls; no fake operation earns native authority. */
import { afterEach, expect, it, vi } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { ConnectorRuntimePrincipalService } from '../../../../connectors/principal/runtime-principal-service.js';
import { DocChannelStore } from '../../store.js';
import { DocChannelDownstream } from '../service.js';
import {
  sendOriginalDownstreamRoomInsideFrame,
  type OriginalDownstreamRoomEmitter,
} from '../native-room-emitter.js';
import type { OriginalRoomEmissionStage } from '../../current/current-operation-types.js';
const connections: Db[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) db.$client.close();
});
function fixture() {
  const db = createDb(':memory:');
  connections.push(db);
  runMigrations(db);
  const authorizeTurn = vi.fn(async () => {
    throw new Error('No runtime is opened by a refusal control.');
  });
  const principals = new ConnectorRuntimePrincipalService({
    db,
    authority: { authorizeTurn, revalidateTurn: async () => false },
  });
  const prepare = vi.fn(async () => {});
  const deny = vi.fn(() => {
    throw new Error('No ordinary authority in native refusal controls.');
  });
  const authority = { prepare, requireWriteCurrent: deny, requireResponderCurrent: deny };
  return {
    db,
    principals,
    authority,
    prepare,
    deny,
    authorizeTurn,
    store: new DocChannelStore(db),
  };
}
it('constructor refuses a different genuine native principal database', () => {
  const first = fixture();
  const other = fixture();
  expect(() =>
    DocChannelDownstream.createInstallationDownstream(
      first.db,
      first.store,
      first.authority,
      other.principals
    )
  ).toThrow();
  expect(first.prepare).not.toHaveBeenCalled();
  expect(other.authorizeTurn).not.toHaveBeenCalled();
});
it('actual original child refuses caller SQL and forged stage even while its Db transaction is active', async () => {
  const { db, store, authority, principals, deny } = fixture();
  const owner = DocChannelDownstream.createInstallationDownstream(db, store, authority, principals);
  const raw = {
    documentId: 'absent',
    eventId: '00000000-0000-4000-8000-000000000001',
    type: 'app.reply',
    payload: { inReplyTo: ['absent'] },
    roomId: 'absent',
  };
  store.transaction((tx) => {
    expect(db.$client.inTransaction).toBe(true);
    expect(() =>
      sendOriginalDownstreamRoomInsideFrame(owner.emitter, {} as OriginalRoomEmissionStage, tx, raw)
    ).toThrow('ORIGINAL_DOWNSTREAM_FRAME_REQUIRED');
    expect(() =>
      sendOriginalDownstreamRoomInsideFrame(
        {} as OriginalDownstreamRoomEmitter,
        {} as OriginalRoomEmissionStage,
        tx,
        raw
      )
    ).toThrow('ORIGINAL_DOWNSTREAM_FRAME_REQUIRED');
  });
  expect(store.getEvent('absent', raw.eventId)).toBeUndefined();
  expect(deny).not.toHaveBeenCalled();
  await owner.stop();
});
