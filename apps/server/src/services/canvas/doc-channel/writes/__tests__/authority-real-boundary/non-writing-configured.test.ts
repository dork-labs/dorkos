import { cleanups, fixture } from './harness.js';
import fs from 'node:fs';
import { CanvasChannelCheckboxRequestSchema } from '@dorkos/shared/canvas-channel-schemas';
import { expect, it, vi } from 'vitest';
import { canvasDocGrants, canvasDocuments, canvasDocWriteIntents } from '@dorkos/db';
import { authorityFixture } from '../authority-fixtures.js';
import { preEffectCheckboxConflict } from '../../checkbox-evidence.js';
import { rawByteHash } from '../../checkbox-bytes.js';
import { CheckboxAuthorityCallbackError, checkboxAuthoritySync } from '../../authority-snapshot.js';
import type { DocGrantAuthority } from '../../../grant-policy.js';

it('non-writing configured error retains exact cause without fabricating an authority reduction', async () => {
  const h = await fixture();
  const approved = await h.authority.prepare(h.input, h.actor);
  const snapshot = await h.authority.refreshCurrent(h.input, h.actor, approved);
  const ports = (h.grants as unknown as { services: { authority: DocGrantAuthority } }).services
    .authority;
  const original = new Error('Storage unavailable');
  ports.resolveTarget = () => {
    throw original;
  };
  let error: unknown;
  try {
    h.authority.transaction((tx) =>
      h.authority.requireCurrent(h.input, h.actor, approved, snapshot, tx)
    );
  } catch (caught) {
    error = caught;
  }
  expect(error).toBe(original);
  expect(h.authority.isAuthorityRefusal(error)).toBe(false);
});

it('own clock reentry and SQL mutation are refused before access returns', async () => {
  const h = await fixture();
  let tx!: import('@dorkos/db').DbTransaction;
  h.setClock(() => {
    h.db.update(canvasDocGrants).set({ revision: 2 }).run();
    h.authority.requireAccess(h.input.documentId, h.actor, tx);
    return new Date();
  });
  let error: unknown;
  try {
    h.authority.transaction((current) => {
      tx = current;
      h.authority.requireAccess(h.input.documentId, h.actor, current);
    });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(CheckboxAuthorityCallbackError);
  expect(String((error as Error).cause)).toContain('reenter');
  expect(h.db.select().from(canvasDocGrants).get()!.revision).toBe(1);
});

it('returned accessors and proxies are refused before getters or reflection traps execute', () => {
  let calls = 0;
  const accessor = Object.defineProperty({}, 'id', {
    get() {
      calls++;
      throw new Error('Getter');
    },
  });
  expect(() => checkboxAuthoritySync(accessor)).toThrow('accessors');
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        calls++;
        throw new Error('Reflection');
      },
    }
  );
  expect(() => checkboxAuthoritySync({ nested: proxy })).toThrow('inspectable');
  expect(calls).toBe(0);
});

it.each(['live', 'recovery'] as const)(
  'actual agent-owner origin callback writes refuse %s after a genuine consumed approval',
  async (kind) => {
    const h = await authorityFixture(false, false, true);
    cleanups.push(h.cleanup);
    const approved = await h.authority.prepare(h.input, h.actor);
    expect(h.granted.grant.openerAgentId).toBe('a');
    expect(h.granted.grant.targetSessionId).toBe('session-a');
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
    const ports = (h.grants as unknown as { services: { authority: DocGrantAuthority } }).services
      .authority;
    const real = ports.originCurrent;
    let calls = 0;
    ports.originCurrent = (...args) => {
      const result = real(...args);
      calls++;
      h.db.update(canvasDocuments).set({ sourceKey: 'changed-by-origin' }).run();
      return result;
    };
    let error: unknown;
    try {
      h.authority.transaction((tx) => {
        if (kind === 'live') h.authority.requireCurrent(h.input, h.actor, approved, snapshot, tx);
        else h.authority.requireRecoveryCurrent(intent, approved, snapshot, tx);
        fs.writeFileSync(h.path, '- [x] actual task\n');
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CheckboxAuthorityCallbackError);
    expect(calls).toBeGreaterThan(0);
    expect(h.authority.isAuthorityRefusal(error)).toBe(false);
    expect(fs.readFileSync(h.path, 'utf8')).toBe('- [ ] actual task\n');
  }
);

it('actual agent-owner origin rejects an inspectable but nonboolean configured result', async () => {
  const h = await authorityFixture(false, false, true);
  cleanups.push(h.cleanup);
  const approved = await h.authority.prepare(h.input, h.actor);
  const snapshot = await h.authority.refreshCurrent(h.input, h.actor, approved);
  const ports = (h.grants as unknown as { services: { authority: DocGrantAuthority } }).services
    .authority;
  ports.originCurrent = (() => ({ valid: true })) as unknown as DocGrantAuthority['originCurrent'];
  expect(() =>
    h.authority.transaction((tx) =>
      h.authority.requireCurrent(h.input, h.actor, approved, snapshot, tx)
    )
  ).toThrow('boolean');
});

it('inherited proxy/accessor data and nominal rejected promises never become inspectable authority', async () => {
  let traps = 0;
  const prototype = new Proxy(
    {},
    {
      has() {
        traps++;
        throw new Error('Inherited proxy');
      },
    }
  );
  expect(() => checkboxAuthoritySync(Object.create(prototype))).toThrow('plain data');
  const prototypeGetter = Object.create(
    Object.defineProperty({}, 'then', {
      get() {
        traps++;
        throw new Error('Inherited getter');
      },
    })
  );
  expect(() => checkboxAuthoritySync(prototypeGetter)).toThrow('plain data');
  expect(traps).toBe(0);
  expect(() => checkboxAuthoritySync(Promise.reject(new Error('Observed rejection')))).toThrow(
    'synchronous'
  );
  await new Promise((resolve) => setImmediate(resolve));
});

it('configured grant callback phase precedes final fresh rows and uses current expiry', async () => {
  const h = await authorityFixture(false, false, true);
  cleanups.push(h.cleanup);
  const approved = await h.authority.prepare(h.input, h.actor);
  const snapshot = await h.authority.refreshCurrent(h.input, h.actor, approved);
  const services = (
    h.grants as unknown as { services: { now: () => Date; authority: DocGrantAuthority } }
  ).services;
  const trace: string[] = [];
  services.now = () => {
    trace.push('clock');
    return new Date();
  };
  const realScope = services.authority.resolveScope;
  services.authority.resolveScope = (...args) => {
    trace.push('scope');
    return realScope(...args);
  };
  const realTarget = services.authority.resolveTarget;
  services.authority.resolveTarget = (...args) => {
    trace.push('target');
    return realTarget(...args);
  };
  const realOrigin = services.authority.originCurrent;
  services.authority.originCurrent = (...args) => {
    trace.push('origin');
    return realOrigin(...args);
  };
  const realGrant = h.http.channels.getGrant.bind(h.http.channels);
  vi.spyOn(h.http.channels, 'getGrant').mockImplementation((...args) => {
    trace.push('grant');
    return realGrant(...args);
  });
  expect(
    h.authority.transaction((tx) =>
      h.authority.requireCurrent(h.input, h.actor, approved, snapshot, tx)
    )
  ).toEqual(approved);
  expect(trace.filter((event) => event === 'clock')).toHaveLength(1);
  expect(trace.filter((event) => event === 'target')).toHaveLength(1);
  expect(trace.filter((event) => event === 'origin')).toHaveLength(1);
  const lastCallback = Math.max(...trace.map((event, index) => (event === 'grant' ? -1 : index)));
  expect(trace.lastIndexOf('grant')).toBeGreaterThan(lastCallback);
  const next = await h.authority.refreshCurrent(h.input, h.actor, approved);
  services.now = () => new Date(Date.parse(h.granted.grant.expiresAt!) + 1);
  expect(() =>
    h.authority.transaction((tx) =>
      h.authority.requireCurrent(h.input, h.actor, approved, next, tx)
    )
  ).toThrow('GRANT_EXPIRED');
});

it.each(['unchanged', 'write-rollback', 'write-throw'] as const)(
  'preparation selection clock %s cannot return usable authority after a callback write',
  async (kind) => {
    const h = await fixture();
    const original = h.deps.now;
    const before = h.db.select().from(canvasDocGrants).get()!;
    let calls = 0,
      writes = 0,
      result: unknown,
      error: unknown;
    const cause = new Error('Preparation clock failure');
    h.setClock(() => {
      calls++;
      if (calls === 3 && kind !== 'unchanged') {
        writes++;
        h.db.$client.exec('SAVEPOINT preparation_clock');
        h.db.update(canvasDocGrants).set({ revision: 2 }).run();
        h.db.$client.exec('ROLLBACK TO preparation_clock');
        h.db.$client.exec('RELEASE preparation_clock');
        if (kind === 'write-throw') throw cause;
      }
      return original();
    });
    try {
      result = await h.authority.prepare(h.input, h.actor);
    } catch (caught) {
      error = caught;
    }
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(writes).toBe(kind === 'unchanged' ? 0 : 1);
    expect(h.db.select().from(canvasDocGrants).get()).toEqual(before);
    expect(fs.readFileSync(h.path, 'utf8')).toBe('- [ ] actual task\n');
    if (kind === 'unchanged') {
      expect(error).toBeUndefined();
      expect(result).toMatchObject({
        documentId: h.input.documentId,
        grantId: h.granted.grant.grantId,
        grantRevision: 1,
      });
    } else {
      expect(result).toBeUndefined();
      expect(error).toBeInstanceOf(CheckboxAuthorityCallbackError);
      expect(h.authority.isAuthorityRefusal(error)).toBe(false);
      if (kind === 'write-throw') expect((error as Error).cause).toBe(cause);
    }
  }
);

it.each(['unchanged', 'write-rollback', 'write-throw'] as const)(
  'recovery snapshot editor clock %s cannot publish a token after a callback write',
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
    const before = h.db.select().from(canvasDocGrants).get()!;
    const original = h.deps.now;
    const cause = new Error('Recovery snapshot clock failure');
    let calls = 0,
      writes = 0,
      result: unknown,
      error: unknown;
    h.setClock(() => {
      calls++;
      if (calls === 1 && kind !== 'unchanged') {
        writes++;
        h.db.$client.exec('SAVEPOINT recovery_clock');
        h.db.update(canvasDocGrants).set({ revision: 2 }).run();
        h.db.$client.exec('ROLLBACK TO recovery_clock');
        h.db.$client.exec('RELEASE recovery_clock');
        if (kind === 'write-throw') throw cause;
      }
      return original();
    });
    try {
      result = await h.authority.refreshRecoveryCurrent(intent, approved);
    } catch (caught) {
      error = caught;
    }
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(writes).toBe(kind === 'unchanged' ? 0 : 1);
    expect(h.db.select().from(canvasDocGrants).get()).toEqual(before);
    expect(h.deps.store.getWriteIntent(intent.intentId)).toEqual(intent);
    expect(fs.readFileSync(h.path, 'utf8')).toBe('- [ ] actual task\n');
    if (kind === 'unchanged') {
      expect(error).toBeUndefined();
      expect(result).toBeDefined();
    } else {
      expect(result).toBeUndefined();
      expect(error).toBeInstanceOf(CheckboxAuthorityCallbackError);
      expect(h.authority.isAuthorityRefusal(error)).toBe(false);
      if (kind === 'write-throw') expect((error as Error).cause).toBe(cause);
    }
  }
);
