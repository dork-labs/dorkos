import { fixture } from './harness.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { CanvasChannelCheckboxRequestSchema } from '@dorkos/shared/canvas-channel-schemas';
import { expect, it, vi } from 'vitest';
import {
  approvals,
  canvasDocGrants,
  canvasDocuments,
  canvasDocChannels,
  sessionMetadata,
  canvasDocWriteIntents,
  user,
  createDb,
} from '@dorkos/db';
import { preEffectCheckboxConflict } from '../../checkbox-evidence.js';
import { DocCheckboxAuthority } from '../../authority.js';
import { DocChannelStore } from '../../../store.js';
import { rawByteHash } from '../../checkbox-bytes.js';
import { CheckboxAuthorityCallbackError } from '../../authority-snapshot.js';
import type { DocGrantAuthority } from '../../../grant-policy.js';

it('owns access/current transaction scope, rejects closed and nested handles, and permits one genuine current effect', async () => {
  const h = await fixture(),
    approved = await h.authority.prepare(h.input, h.actor);
  const snapshot = await h.authority.refreshCurrent(h.input, h.actor, approved);
  let escaped: import('@dorkos/db').DbTransaction | undefined;
  h.authority.transaction((tx) => {
    escaped = tx;
    expect(h.authority.requireAccess(h.input.documentId, h.actor, tx)).toBeUndefined();
    expect(() => h.authority.transaction(() => undefined)).toThrow('nest');
    h.authority.requireCurrent(h.input, h.actor, approved, snapshot, tx);
    fs.writeFileSync(h.path, '- [x] actual task\n');
  });
  expect(await fsp.readFile(h.path, 'utf8')).toBe('- [x] actual task\n');
  expect(() => h.authority.requireAccess(h.input.documentId, h.actor, escaped!)).toThrow(
    'exact active'
  );
  h.authority.transaction(() => {
    expect(() => h.authority.requireAccess(h.input.documentId, h.actor, escaped!)).toThrow(
      'exact active'
    );
  });
});

it('refuses unchecked same-store access and reentrant public access before receipt disclosure', async () => {
  const h = await fixture();
  expect(() =>
    h.http.channels.transaction((tx) => h.authority.requireAccess(h.input.documentId, h.actor, tx))
  ).toThrow('exact active');
  const original = h.http.authorization.requireCurrent.bind(h.http.authorization);
  vi.spyOn(h.http.authorization, 'requireCurrent').mockImplementation((...args) => {
    h.authority.requireAccess(h.input.documentId, h.actor, args[3]!);
    return original(...args);
  });
  expect(() =>
    h.authority.transaction((tx) => h.authority.requireAccess(h.input.documentId, h.actor, tx))
  ).toThrow('reenter');
});

it('rolls back actual SQL and retires provenance when a transaction callback returns a Promise', async () => {
  const h = await fixture();
  const before = h.db.select().from(canvasDocGrants).get()!;
  let late: unknown;
  const bad = async (tx: import('@dorkos/db').DbTransaction) => {
    tx.update(canvasDocGrants).set({ revokedAt: new Date().toISOString() }).run();
    await Promise.resolve();
    try {
      h.authority.requireAccess(h.input.documentId, h.actor, tx);
    } catch (error) {
      late = error;
    }
    throw new Error('Observed async refusal');
  };
  expect(() =>
    h.authority.transaction(bad as unknown as (tx: import('@dorkos/db').DbTransaction) => undefined)
  ).toThrow('synchronous');
  await new Promise((resolve) => setImmediate(resolve));
  expect(String(late)).toContain('exact active');
  expect(h.db.select().from(canvasDocGrants).get()).toEqual(before);
});

it('rollback consumes the snapshot while retaining actual current database rows', async () => {
  const h = await fixture(),
    approved = await h.authority.prepare(h.input, h.actor);
  const snapshot = await h.authority.refreshCurrent(h.input, h.actor, approved);
  const before = h.db.select().from(canvasDocGrants).get()!;
  expect(() =>
    h.authority.transaction((tx) => {
      h.authority.requireCurrent(h.input, h.actor, approved, snapshot, tx);
      tx.update(canvasDocGrants).set({ revokedAt: new Date().toISOString() }).run();
      throw new Error('Actual rollback');
    })
  ).toThrow('Actual rollback');
  expect(h.db.select().from(canvasDocGrants).get()).toEqual(before);
  expect(() =>
    h.authority.transaction((tx) =>
      h.authority.requireCurrent(h.input, h.actor, approved, snapshot, tx)
    )
  ).toThrow('consumed');
});

it('constructor refuses inactive foreign stores and skips any configured callback when own DB already active', async () => {
  const h = await fixture(),
    clone = `${h.dir}/foreign-constructor-inactive.sqlite`;
  await h.db.$client.backup(clone);
  const foreign = createDb(clone);
  try {
    expect(
      () => new DocCheckboxAuthority({ ...h.deps, store: new DocChannelStore(foreign) })
    ).toThrow('transaction database');
    const callback = vi.spyOn(h.http.channels, 'transaction');
    h.authority.transaction(() => {
      expect(() => new DocCheckboxAuthority(h.deps)).toThrow('inactive');
    });
    expect(callback).not.toHaveBeenCalled();
    expect(new DocCheckboxAuthority(h.deps)).toBeInstanceOf(DocCheckboxAuthority);
  } finally {
    foreign.$client.close();
  }
});

it('rejects native nested and another authority instance handles while the genuine outer scope remains usable', async () => {
  const h = await fixture(),
    second = new DocCheckboxAuthority(h.deps);
  h.authority.transaction((tx) => {
    expect(() =>
      tx.transaction((nested) => h.authority.requireAccess(h.input.documentId, h.actor, nested))
    ).toThrow('exact active');
    expect(() => second.requireAccess(h.input.documentId, h.actor, tx)).toThrow('exact active');
    expect(h.authority.requireAccess(h.input.documentId, h.actor, tx)).toBeUndefined();
  });
});

it.each(['live', 'recovery'] as const)(
  'configured clock callback revocation refuses %s before immediate FILE effect',
  async (kind) => {
    const h = await fixture(),
      original = await h.authority.prepare(h.input, h.actor);
    const terminal = preEffectCheckboxConflict(
      h.input,
      original,
      rawByteHash(Buffer.from(JSON.stringify(CanvasChannelCheckboxRequestSchema.parse(h.input)))),
      new Date().toISOString()
    );
    h.db.insert(canvasDocWriteIntents).values(terminal.intent).run();
    const intent = h.db.select().from(canvasDocWriteIntents).get()!;
    const snapshot =
      kind === 'live'
        ? await h.authority.refreshCurrent(h.input, h.actor, original)
        : await h.authority.refreshRecoveryCurrent(intent, original);
    const services = (h.grants as unknown as { services: { now: () => Date } }).services;
    let calls = 0,
      effects = 0;
    services.now = () => {
      calls++;
      h.db.update(canvasDocGrants).set({ revokedAt: new Date().toISOString() }).run();
      return new Date();
    };
    expect(() =>
      h.authority.transaction((tx) => {
        if (kind === 'live') h.authority.requireCurrent(h.input, h.actor, original, snapshot, tx);
        else h.authority.requireRecoveryCurrent(intent, original, snapshot, tx);
        effects++;
        fs.writeFileSync(h.path, '- [x] actual task\n');
      })
    ).toThrow();
    expect(calls).toBeGreaterThan(0);
    expect(effects).toBe(0);
    expect(fs.readFileSync(h.path, 'utf8')).toBe('- [ ] actual task\n');
  }
);

it.each([
  'revision',
  'consumption',
  'detail',
  'owner',
  'source',
  'birth',
  'closure',
  'editor',
  'runtime',
] as const)(
  'configured clock callback %s cannot invalidate copied authority before effect',
  async (kind) => {
    const h = await fixture();
    const actor = kind === 'runtime' ? h.runtime : h.actor;
    const original = await h.authority.prepare(h.input, actor);
    const snapshot = await h.authority.refreshCurrent(h.input, actor, original);
    const services = (h.grants as unknown as { services: { now: () => Date } }).services;
    let calls = 0,
      effects = 0;
    services.now = () => {
      calls++;
      if (kind === 'revision') h.db.update(canvasDocGrants).set({ revision: 2 }).run();
      if (kind === 'consumption') h.db.update(approvals).set({ consumedAt: null }).run();
      if (kind === 'detail') h.db.update(approvals).set({ detail: '{}' }).run();
      if (kind === 'owner')
        h.db
          .insert(user)
          .values({
            id: 'changed-owner',
            name: 'Changed',
            email: 'changed@example.test',
            updatedAt: new Date(),
          })
          .run();
      if (kind === 'source') h.db.update(canvasDocuments).set({ sourceKey: 'other-source' }).run();
      if (kind === 'birth')
        h.db.update(canvasDocuments).set({ openedAt: '2000-01-01T00:00:00.000Z' }).run();
      if (kind === 'closure')
        h.db.update(canvasDocChannels).set({ closedAt: new Date().toISOString() }).run();
      if (kind === 'editor')
        h.db
          .update(canvasDocuments)
          .set({ editingBy: 'different-editor', editingHeartbeatAt: new Date().toISOString() })
          .run();
      if (kind === 'runtime') h.db.update(sessionMetadata).set({ runtime: 'opencode' }).run();
      return new Date();
    };
    expect(() =>
      h.authority.transaction((tx) => {
        h.authority.requireCurrent(h.input, actor, original, snapshot, tx);
        effects++;
        fs.writeFileSync(h.path, '- [x] actual task\n');
      })
    ).toThrow();
    expect(calls).toBeGreaterThan(0);
    expect(effects).toBe(0);
    expect(fs.readFileSync(h.path, 'utf8')).toBe('- [ ] actual task\n');
  }
);

it.each(['live', 'recovery'] as const)(
  'unchanged configured clock permits %s and caller SQL/effect outside the read-only gate',
  async (kind) => {
    const h = await fixture();
    const approved = await h.authority.prepare(h.input, h.actor);
    const terminal = preEffectCheckboxConflict(
      h.input,
      approved,
      rawByteHash(Buffer.from(JSON.stringify(CanvasChannelCheckboxRequestSchema.parse(h.input)))),
      new Date().toISOString()
    );
    h.db.insert(canvasDocWriteIntents).values(terminal.intent).run();
    const intent = h.db.select().from(canvasDocWriteIntents).get()!;
    const snapshot =
      kind === 'live'
        ? await h.authority.refreshCurrent(h.input, h.actor, approved)
        : await h.authority.refreshRecoveryCurrent(intent, approved);
    const services = (h.grants as unknown as { services: { now: () => Date } }).services;
    let calls = 0;
    services.now = () => {
      calls++;
      return new Date();
    };
    h.authority.transaction((tx) => {
      if (kind === 'live') h.authority.requireCurrent(h.input, h.actor, approved, snapshot, tx);
      else h.authority.requireRecoveryCurrent(intent, approved, snapshot, tx);
      tx.update(canvasDocWriteIntents).set({ updatedAt: '2001-01-01T00:00:00.000Z' }).run();
      fs.writeFileSync(h.path, '- [x] actual task\n');
    });
    expect(calls).toBeGreaterThan(0);
    expect(h.db.select().from(canvasDocWriteIntents).get()!.updatedAt).toBe(
      '2001-01-01T00:00:00.000Z'
    );
    expect(fs.readFileSync(h.path, 'utf8')).toBe('- [x] actual task\n');
  }
);

it.each(['live', 'recovery', 'refresh'] as const)(
  'late resolveScope mutate-and-rollback refuses %s with unchanged durable rows',
  async (kind) => {
    const h = await fixture();
    const approved = await h.authority.prepare(h.input, h.actor);
    const terminal = preEffectCheckboxConflict(
      h.input,
      approved,
      rawByteHash(Buffer.from(JSON.stringify(CanvasChannelCheckboxRequestSchema.parse(h.input)))),
      new Date().toISOString()
    );
    h.db.insert(canvasDocWriteIntents).values(terminal.intent).run();
    const intent = h.db.select().from(canvasDocWriteIntents).get()!;
    const snapshot =
      kind === 'recovery'
        ? await h.authority.refreshRecoveryCurrent(intent, approved)
        : await h.authority.refreshCurrent(h.input, h.actor, approved);
    const ports = (h.grants as unknown as { services: { authority: DocGrantAuthority } }).services
      .authority;
    const real = ports.resolveScope;
    const before = h.db.select().from(canvasDocGrants).get()!;
    let calls = 0,
      effects = 0;
    ports.resolveScope = (...args) => {
      const result = real(...args);
      calls++;
      h.db.$client.exec('SAVEPOINT callback_write');
      h.db.update(canvasDocGrants).set({ revokedAt: new Date().toISOString() }).run();
      h.db.$client.exec('ROLLBACK TO callback_write');
      h.db.$client.exec('RELEASE callback_write');
      return result;
    };
    let error: unknown;
    try {
      if (kind === 'refresh') await h.authority.refreshCurrent(h.input, h.actor, approved);
      else
        h.authority.transaction((tx) => {
          if (kind === 'live') h.authority.requireCurrent(h.input, h.actor, approved, snapshot, tx);
          else h.authority.requireRecoveryCurrent(intent, approved, snapshot, tx);
          effects++;
          fs.writeFileSync(h.path, '- [x] actual task\n');
        });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CheckboxAuthorityCallbackError);
    expect(h.authority.isAuthorityRefusal(error)).toBe(false);
    expect(calls).toBeGreaterThan(0);
    expect(effects).toBe(0);
    expect(h.db.select().from(canvasDocGrants).get()).toEqual(before);
    expect(fs.readFileSync(h.path, 'utf8')).toBe('- [ ] actual task\n');
  }
);

it.each(['resolveTarget', 'requireGrantedCurrent'] as const)(
  'late %s SQL mutation refuses final live authority',
  async (name) => {
    const h = await fixture();
    const approved = await h.authority.prepare(h.input, h.actor);
    const snapshot = await h.authority.refreshCurrent(h.input, h.actor, approved);
    const ports = (h.grants as unknown as { services: { authority: DocGrantAuthority } }).services
      .authority;
    const before = h.db.select().from(canvasDocGrants).get()!;
    let calls = 0;
    if (name === 'resolveTarget') {
      const real = ports.resolveTarget;
      ports.resolveTarget = (...args) => {
        const result = real(...args);
        calls++;
        h.db.update(canvasDocGrants).set({ revision: 2 }).run();
        return result;
      };
    } else {
      const real = ports.requireGrantedCurrent;
      ports.requireGrantedCurrent = (...args) => {
        const result = real(...args);
        calls++;
        h.db.update(approvals).set({ consumedAt: null }).run();
        return result;
      };
    }
    let error: unknown;
    try {
      h.authority.transaction((tx) =>
        h.authority.requireCurrent(h.input, h.actor, approved, snapshot, tx)
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CheckboxAuthorityCallbackError);
    expect(calls).toBeGreaterThan(0);
    expect(h.authority.isAuthorityRefusal(error)).toBe(false);
    expect(h.db.select().from(canvasDocGrants).get()).toEqual(before);
    expect(fs.readFileSync(h.path, 'utf8')).toBe('- [ ] actual task\n');
  }
);

it.each(['error', 'undefined', 'getter'] as const)(
  'callback SQL mutation preserves %s cause, retires snapshot and remains uncertainty',
  async (kind) => {
    const h = await fixture();
    const approved = await h.authority.prepare(h.input, h.actor);
    const snapshot = await h.authority.refreshCurrent(h.input, h.actor, approved);
    const ports = (h.grants as unknown as { services: { authority: DocGrantAuthority } }).services
      .authority;
    const original = kind === 'undefined' ? undefined : new Error('Original configured failure');
    const mutate = () => {
      h.db.update(canvasDocGrants).set({ revokedAt: new Date().toISOString() }).run();
      throw original;
    };
    if (kind === 'getter')
      Object.defineProperty(ports, 'resolveTarget', { configurable: true, get: mutate });
    else ports.resolveTarget = mutate;
    let error: unknown;
    try {
      h.authority.transaction((tx) =>
        h.authority.requireCurrent(h.input, h.actor, approved, snapshot, tx)
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CheckboxAuthorityCallbackError);
    expect(Object.hasOwn(error as object, 'cause')).toBe(true);
    expect((error as Error).cause).toBe(original);
    expect(h.authority.isAuthorityRefusal(error)).toBe(false);
    expect(h.db.select().from(canvasDocGrants).get()!.revokedAt).toBeNull();
    expect(() =>
      h.authority.transaction((tx) =>
        h.authority.requireCurrent(h.input, h.actor, approved, snapshot, tx)
      )
    ).toThrow('consumed');
  }
);
