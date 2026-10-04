import fs from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import {
  approvals,
  canvasDocChannels,
  canvasDocGrants,
  canvasDocuments,
  eq,
  user,
} from '@dorkos/db';
import { authorityFixture } from './authority-fixtures.js';
import { checkboxDocumentGeneration } from '../authority.js';
import {
  CheckboxAuthorityRefusal,
  CheckboxSnapshotRegistry,
  checkboxAuthoritySync,
} from '../authority-snapshot.js';
import { canvasEditorLockHolder } from '../../../canvas-service.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const h = await authorityFixture();
  cleanups.push(h.cleanup);
  return h;
}
it('uses an actual consumed operator approval and stable file-backed incarnation, not revision/scope', async () => {
  const h = await fixture();
  const original = await h.authority.prepare(h.input, h.actor);
  expect(original.documentId).toMatch(/^[a-f0-9]{32}$/);
  expect(original.grantId).toBe(h.granted.grant.grantId);
  expect(original.binding).toEqual(h.binding);
  expect(
    h.db.select().from(approvals).where(eq(approvals.id, h.granted.grant.approvalId!)).get()
      ?.consumedAt
  ).toBeTruthy();
  const physical = h.db.select().from(canvasDocuments).get()!;
  const channel = h.http.channels.getChannel(h.input.documentId)!;
  expect(original.documentGeneration).toBe(checkboxDocumentGeneration(physical, channel));
  h.db.update(canvasDocuments).set({ rev: 100 }).run();
  expect((await h.authority.prepare(h.input, h.actor)).documentGeneration).toBe(
    original.documentGeneration
  );
  const snapshot = await h.authority.refreshCurrent(h.input, h.actor, original);
  expect(
    h.authority.transaction((tx) =>
      h.authority.requireCurrent(h.input, h.actor, original, snapshot, tx)
    )
  ).toEqual(original);
  expect(() =>
    h.authority.transaction((tx) =>
      h.authority.requireCurrent(h.input, h.actor, original, snapshot, tx)
    )
  ).toThrow('consumed');
  expect(await fs.readFile(h.path, 'utf8')).toBe('- [ ] actual task\n');
});
it.each(['grant', 'approval', 'birth', 'source', 'owner', 'runtime', 'editor'] as const)(
  'refuses current %s change after fresh observation, without mutation',
  async (kind) => {
    const h = await fixture();
    const actor = kind === 'runtime' ? h.runtime : h.actor;
    const original = await h.authority.prepare(h.input, actor);
    const snapshot = await h.authority.refreshCurrent(h.input, actor, original);
    if (kind === 'grant')
      h.db.update(canvasDocGrants).set({ revokedAt: new Date().toISOString() }).run();
    if (kind === 'approval') h.db.update(approvals).set({ detail: '{}' }).run();
    if (kind === 'birth')
      h.db.update(canvasDocChannels).set({ createdAt: '2020-01-01T00:00:00.000Z' }).run();
    if (kind === 'source')
      h.db.update(canvasDocuments).set({ sourceKey: 'different-server-source' }).run();
    if (kind === 'owner')
      h.db
        .insert(user)
        .values({
          id: 'new-owner',
          name: 'Owner',
          email: 'new@example.test',
          updatedAt: new Date(),
        })
        .run();
    if (kind === 'runtime') h.setRuntimeLive(false);
    if (kind === 'editor')
      h.db
        .update(canvasDocuments)
        .set({ editingBy: 'other', editingHeartbeatAt: new Date().toISOString() })
        .run();
    expect(() =>
      h.authority.transaction((tx) =>
        h.authority.requireCurrent(h.input, actor, original, snapshot, tx)
      )
    ).toThrow();
    expect(await fs.readFile(h.path, 'utf8')).toBe('- [ ] actual task\n');
  }
);
it('cannot substitute another request, surface, authority or factory token', async () => {
  const h = await fixture();
  const original = await h.authority.prepare(h.input, h.actor);
  const token = await h.authority.refreshCurrent(h.input, h.actor, original);
  expect(() =>
    h.authority.transaction((tx) =>
      h.authority.requireCurrent({ ...h.input, done: false }, h.actor, original, token, tx)
    )
  ).toThrow('SNAPSHOT_SUBJECT');
  const registry = new CheckboxSnapshotRegistry();
  expect(() => registry.consume(awaitToken())).toThrow('foreign');
  function awaitToken() {
    return token;
  }
});
it('shares exact editor TTL including own holder, equality expiry, future and invalid heartbeat', async () => {
  const h = await fixture();
  const now = Date.now();
  const row = { editingBy: 'other', editingHeartbeatAt: new Date(now - 45000).toISOString() };
  expect(canvasEditorLockHolder(row, now)).toBeNull();
  expect(
    canvasEditorLockHolder({ ...row, editingHeartbeatAt: new Date(now - 44999).toISOString() }, now)
  ).toBe('other');
  expect(canvasEditorLockHolder({ ...row, editingHeartbeatAt: 'invalid' }, now)).toBeNull();
  expect(
    canvasEditorLockHolder({ ...row, editingHeartbeatAt: new Date(now + 1).toISOString() }, now)
  ).toBe('other');
  h.db
    .update(canvasDocuments)
    .set({ editingBy: 'owner', editingHeartbeatAt: new Date().toISOString() })
    .run();
  expect(await h.authority.prepare(h.input, h.actor)).toMatchObject({
    documentId: h.input.documentId,
  });
});
it('observes thenable rejection and preserves unknown/causeful failures', async () => {
  const h = await fixture();
  expect(() => checkboxAuthoritySync(Promise.reject(new Error('late')))).toThrow('synchronous');
  await Promise.resolve();
  expect(h.authority.isAuthorityRefusal(new Error('EIO'))).toBe(false);
  expect(
    h.authority.isAuthorityRefusal(new CheckboxAuthorityRefusal('ORIGINAL_OWNER_CHANGED'))
  ).toBe(true);
});
it('real durable canonical rekey keeps original approval and birth while requiring a new observation', async () => {
  const h = await fixture();
  const original = await h.authority.prepare(h.input, h.actor);
  const stale = await h.authority.refreshCurrent(h.input, h.actor, original);
  const { sessionMetadata } = await import('@dorkos/db');
  h.db
    .insert(sessionMetadata)
    .values({
      sessionId: 'canonical-a',
      agentPath: h.dir,
      runtime: 'codex',
      createdAt: new Date().toISOString(),
    })
    .run();
  h.rooms.canvasDocuments.rekeyScope('session:session-a', 'session:canonical-a');
  expect(() =>
    h.authority.transaction((tx) =>
      h.authority.requireCurrent(h.input, h.actor, original, stale, tx)
    )
  ).toThrow('SOURCE_DESCRIPTOR_CHANGED');
  const fresh = await h.authority.refreshCurrent(h.input, h.actor, original);
  expect(
    h.authority.transaction((tx) =>
      h.authority.requireCurrent(h.input, h.actor, original, fresh, tx)
    )
  ).toEqual(original);
});
it('revoked original grant cannot be rescued by a newer consumed approval, and ambiguity refuses', async () => {
  const h = await fixture();
  const original = await h.authority.prepare(h.input, h.actor);
  const nextRequest = {
    documentId: h.input.documentId,
    routeId: 'checkbox',
    expiresAt: new Date(Date.now() + 7200000).toISOString(),
    write: h.binding,
  };
  const pending = h.grants.grant(nextRequest, h.actor);
  if (pending.kind !== 'approval_required') throw new Error('new exact approval required');
  h.approvals.grant(pending.ticket.approvalId);
  const next = h.grants.grant(nextRequest, h.actor, pending.ticket.token);
  if (next.kind !== 'granted') throw new Error('grant');
  await expect(h.authority.prepare(h.input, h.actor)).rejects.toThrow('AMBIGUOUS');
  h.db
    .update(canvasDocGrants)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(canvasDocGrants.grantId, original.grantId))
    .run();
  await expect(h.authority.refreshCurrent(h.input, h.actor, original)).rejects.toThrow();
  expect((await h.authority.prepare(h.input, h.actor)).grantId).toBe(next.grant.grantId);
});
it('genuine account-owner approval stays usable only for that current original owner', async () => {
  const h = await authorityFixture(false, true);
  cleanups.push(h.cleanup);
  const approved = await h.authority.prepare(h.input, h.actor);
  const snapshot = await h.authority.refreshCurrent(h.input, h.actor, approved);
  expect(
    h.authority.transaction((tx) =>
      h.authority.requireCurrent(h.input, h.actor, approved, snapshot, tx)
    )
  ).toEqual(approved);
  h.db.delete(user).run();
  h.db
    .insert(user)
    .values({ id: 'next-owner', name: 'Next', email: 'next@example.test', updatedAt: new Date() })
    .run();
  await expect(h.authority.refreshCurrent(h.input, h.actor, approved)).rejects.toThrow(
    'ORIGINAL_OWNER_CHANGED'
  );
});
it('incarnation rejects malformed birth timestamps and empty/oversized/mismatched physical IDs', () => {
  const physical = { id: 'a'.repeat(32), openedAt: '2026-10-02T00:00:00.000Z' },
    channel = { documentId: 'a'.repeat(32), createdAt: '2026-10-02T00:00:00.000Z' };
  expect(() => checkboxDocumentGeneration({ ...physical, openedAt: '2026' }, channel)).toThrow();
  for (const id of ['', 'x'.repeat(201), 'different'])
    expect(() => checkboxDocumentGeneration({ ...physical, id }, channel)).toThrow();
});
