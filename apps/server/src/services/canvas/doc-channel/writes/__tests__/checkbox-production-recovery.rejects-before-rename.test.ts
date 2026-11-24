import { cleanups, setup } from './checkbox-production-recovery.fixtures.js';
import { readFile, stat } from 'node:fs/promises';
import { canvasDocWriteIntents, user } from '@dorkos/db';
import { DocCheckboxWriteService } from '../checkbox-service.js';
import { expect, it } from 'vitest';
import { fixture } from './checkbox-fixture.js';

// Proposed append to the existing genuine production-recovery test file. UNRUN.
// Uses existing setup/cleanups, real FILE database, consumed approval and original UUID.
it('rejects before rename when the final public transaction wrapper skips a revoked original gate', async () => {
  const h = await setup();
  const input = await h.request();
  const bytes = await readFile(h.path),
    inode = (await stat(h.path)).ino;
  const run = h.authority.transaction.bind(h.authority);
  const refresh = h.authority.refreshCurrent.bind(h.authority);
  let calls = 0,
    refreshes = 0;
  h.authority.refreshCurrent = async (...args) => {
    const snapshot = await refresh(...args);
    if (++refreshes === 3) {
      h.revoke();
      h.authority.transaction = (() => {
        calls++;
        return undefined;
      }) as typeof h.authority.transaction;
    }
    return snapshot;
  };
  try {
    await expect(h.service.toggle(input, h.actor)).rejects.toThrow();
    expect(await readFile(h.path)).toEqual(bytes);
    expect((await stat(h.path)).ino).toBe(inode);
    expect(h.row().eventId).toBe(input.eventId);
    expect(h.row().status).not.toBe('committed');
    expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
    expect(h.store.getGrant(h.grantId)!.revokedAt).not.toBeNull();
    expect(calls).toBe(0);
  } finally {
    h.authority.transaction = run;
  }
});

it('runs the final gate without an after-callback public wrapper', async () => {
  const h: Awaited<ReturnType<typeof setup>> = await setup({
    checkpoint: async (point) => {
      if (point === 'replaced') h.authority.transaction = run;
    },
  });
  const input = await h.request();
  const before = await readFile(h.path),
    inode = (await stat(h.path)).ino;
  const run = h.authority.transaction.bind(h.authority);
  const refresh = h.authority.refreshCurrent.bind(h.authority);
  let calls = 0,
    refreshes = 0;
  h.authority.refreshCurrent = async (...args) => {
    const snapshot = await refresh(...args);
    if (++refreshes === 3)
      h.authority.transaction = (work) =>
        run((tx) => {
          calls++;
          const result = work(tx);
          h.revoke();
          return result;
        });
    return snapshot;
  };
  try {
    const receipt = await h.service.toggle(input, h.actor);
    expect(receipt.status).toBe('changed');
    expect(calls).toBe(0);
    expect(h.store.getGrant(h.grantId)!.revokedAt).toBeNull();
    expect(h.store.getGrant(h.grantId)!.revision).toBe(1);
    expect(await readFile(h.path)).toEqual(Buffer.from('\ufeff- [x] café😀\r\n- [ ] repeated\r\n'));
    expect((await stat(h.path)).ino).not.toBe(inode);
    expect(await readFile(h.path)).not.toEqual(before);
    expect(h.row().eventId).toBe(input.eventId);
    expect(h.row().status).toBe('committed');
    expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  } finally {
    h.authority.transaction = run;
  }
});

// Proposed existing-test import delta: add `user` to its @dorkos/db import.
it('refuses duplicate disclosure through private current access after actual installation-owner loss', async () => {
  const h = await setup();
  const input = await h.request();
  const receipt = await h.service.toggle(input, h.actor);
  const row = structuredClone(h.row());
  const bytes = await readFile(h.path),
    inode = (await stat(h.path)).ino;
  h.db
    .insert(user)
    .values({
      id: 'new-current-owner',
      name: 'New',
      email: 'new@example.test',
      updatedAt: new Date(),
    })
    .run();
  const run = h.authority.transaction.bind(h.authority);
  const access = h.authority.requireAccess.bind(h.authority);
  const preflight = h.authority.preflight.bind(h.authority);
  h.authority.transaction = (() => undefined) as typeof h.authority.transaction;
  h.authority.requireAccess = () => undefined;
  h.authority.preflight = async () => undefined;
  try {
    await expect(h.service.toggle(input, h.actor)).rejects.toThrow();
    expect(h.row()).toEqual(row);
    expect(await readFile(h.path)).toEqual(bytes);
    expect((await stat(h.path)).ino).toBe(inode);
    expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
    expect(receipt.status).toBe('changed');
  } finally {
    h.authority.transaction = run;
    h.authority.requireAccess = access;
    h.authority.preflight = preflight;
  }
});

// Additional proposed controls ONLY. UNRUN, not yet authorized for repository append.
// Uses actual existing fixture, SAME migrated FILE SQLite, original consumed approval.
it('refuses duplicate disclosure when the observable public row read changes the actual owner', async () => {
  const h = await setup();
  const input = await h.request();
  await h.service.toggle(input, h.actor);
  const row = structuredClone(h.row());
  const getter = h.store.getWriteIntent.bind(h.store);
  const access = h.authority.requireAccess.bind(h.authority);
  let changed = false;
  h.store.getWriteIntent = (id, tx) => {
    const actual = getter(id, tx);
    if (!changed && id === row.intentId) {
      changed = true;
      h.db
        .insert(user)
        .values({
          id: 'changed-after-read',
          name: 'New',
          email: 'new@example.test',
          updatedAt: new Date(),
        })
        .run();
    }
    return actual;
  };
  h.authority.requireAccess = () => undefined;
  try {
    await expect(h.service.toggle(input, h.actor)).rejects.toThrow();
    expect(changed).toBe(true);
    expect(getter(row.intentId)).toEqual(row);
    expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  } finally {
    h.store.getWriteIntent = getter;
    h.authority.requireAccess = access;
  }
});

it('uses the actual SQL receipt rather than a valid forged public store DTO', async () => {
  const h = await setup();
  const input = await h.request();
  const receipt = await h.service.toggle(input, h.actor);
  const row = structuredClone(h.row());
  const fake = structuredClone(row);
  const evidence = h.service.validate(fake);
  if (evidence.receipt?.status !== 'changed') throw new Error('Genuine changed receipt expected');
  evidence.receipt.receipt.docSeq += 100;
  fake.evidence = evidence;
  h.service.validate(fake); // valid structurally; the only defect is it is not the actual SQL row.
  const getter = h.store.getWriteIntent.bind(h.store);
  h.store.getWriteIntent = (id, tx) => (id === row.intentId ? fake : getter(id, tx));
  try {
    expect(await h.service.toggle(input, h.actor)).toEqual(receipt);
    expect(getter(row.intentId)).toEqual(row);
    expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  } finally {
    h.store.getWriteIntent = getter;
  }
});

it('requires the service constructor database to own its genuine store before any operation', async () => {
  const owning = await setup(),
    foreign = await setup();
  expect(owning.db.$client.prepare('PRAGMA database_list').all()).not.toEqual(
    foreign.db.$client.prepare('PRAGMA database_list').all()
  );
  const request = await owning.request();
  const before = await readFile(owning.path),
    inode = (await stat(owning.path)).ino;
  const grant = owning.store.getGrant(owning.grantId);
  expect(
    () =>
      new DocCheckboxWriteService(
        foreign.db,
        owning.store,
        owning.coordinator,
        owning.authority,
        owning.delivery
      )
  ).toThrow('Checkbox authority requires its genuine store transaction database.');
  expect(owning.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  expect(foreign.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  expect(owning.db.select().from(canvasDocWriteIntents).all()).toEqual([]);
  expect(foreign.db.select().from(canvasDocWriteIntents).all()).toEqual([]);
  expect(owning.store.getGrant(owning.grantId)).toEqual(grant);
  expect(await readFile(owning.path)).toEqual(before);
  expect((await stat(owning.path)).ino).toBe(inode);
  expect(owning.notices).toEqual([]);
  const receipt = await owning.service.toggle(request, owning.actor);
  expect(receipt).toMatchObject({ status: 'changed', receipt: { id: request.eventId } });
  expect(await owning.service.toggle(request, owning.actor)).toEqual(receipt);
  expect(owning.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  expect(owning.row()).toMatchObject({ eventId: request.eventId, status: 'committed' });
});

it('checks service constructor database provenance before reading delivery configuration', async () => {
  const owning = await setup(),
    foreign = await setup();
  let reads = 0;
  const delivery = {
    get policyLimits() {
      reads++;
      return owning.delivery.policyLimits;
    },
    get notifyCommitted() {
      reads++;
      return owning.delivery.notifyCommitted;
    },
  };
  let failure: unknown;
  try {
    new DocCheckboxWriteService(
      foreign.db,
      owning.store,
      owning.coordinator,
      owning.authority,
      delivery
    );
  } catch (error) {
    failure = error;
  }
  expect(reads).toBe(0);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({
    message: 'Checkbox authority requires its genuine store transaction database.',
  });
  expect(owning.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  expect(owning.db.select().from(canvasDocWriteIntents).all()).toEqual([]);
  expect(owning.notices).toEqual([]);
});
