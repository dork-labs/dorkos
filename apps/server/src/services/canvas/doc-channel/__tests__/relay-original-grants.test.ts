/** Genuine constructor/migrated SQLite refusal controls; configured test ports never grant authority. */
import { afterEach, expect, it, vi } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { ApprovalService } from '../../../core/approvals/approval-service.js';
import { DocChannelStore, type DocBatchRow } from '../store.js';
import { DocChannelGrants } from '../grants.js';
import { requireOriginalDocumentRelayGrants } from '../grant-revalidation.js';
const connections: Db[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) db.$client.close();
});
function fixture() {
  const db = createDb(':memory:');
  connections.push(db);
  runMigrations(db);
  const store = new DocChannelStore(db);
  const deny = vi.fn(() => {
    throw new Error('Refusal controls have no route authority.');
  });
  const authority = {
    resolveScope: deny,
    requireCurrent: deny,
    requireGrantedCurrent: deny,
    resolveTarget: deny,
    sourceRoot: deny,
    originCurrent: deny,
  };
  const grants = new DocChannelGrants({ db, store, approvals: new ApprovalService(db), authority });
  return { db, store, grants, deny };
}
it('original background reads cannot be replaced with reflected success methods/services', () => {
  const { db, store, grants, deny } = fixture();
  const original = requireOriginalDocumentRelayGrants(grants, store);
  const refresh = vi.fn();
  const revalidate = vi.fn(() => ({ grant: {}, target: {} }));
  Object.assign(grants, {
    refreshGrantedAuthority: refresh,
    revalidateBatchGrant: revalidate,
    services: {
      db: {},
      store: { getBatch: () => ({}) },
      authority: { requireGrantedCurrent: () => ({}) },
    },
  });
  expect(() => original.refreshGrantedAuthority('absent')).toThrow('GRANT_NOT_FOUND');
  store.transaction((tx) => {
    expect(db.$client.inTransaction).toBe(true);
    expect(() => original.revalidateBatchGrant({ batchId: 'absent' } as DocBatchRow, tx)).toThrow(
      'BATCH_BINDING_CHANGED'
    );
  });
  expect(refresh).not.toHaveBeenCalled();
  expect(revalidate).not.toHaveBeenCalled();
  expect(deny).not.toHaveBeenCalled();
});
it('forged grant objects and a different genuine store cannot replace original constructor custody', () => {
  const { store, grants } = fixture();
  const other = fixture();
  expect(() => requireOriginalDocumentRelayGrants({} as DocChannelGrants, store)).toThrow(
    'DOCUMENT_RELAY_ORIGINAL_GRANTS_REQUIRED'
  );
  expect(() => requireOriginalDocumentRelayGrants(grants, other.store)).toThrow(
    'DOCUMENT_RELAY_ORIGINAL_GRANTS_REQUIRED'
  );
});
