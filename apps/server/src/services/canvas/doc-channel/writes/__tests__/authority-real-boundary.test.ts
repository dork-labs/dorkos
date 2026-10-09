import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { CanvasChannelCheckboxRequestSchema } from '@dorkos/shared/canvas-channel-schemas';
import { afterEach, expect, it, vi } from 'vitest';
import {
  approvals,
  canvasDocGrants,
  canvasDocuments,
  canvasDocChannels,
  sessionMetadata,
  canvasDocWriteIntents,
  roomMembers,
  rooms as roomRows,
  user,
  createDb,
} from '@dorkos/db';
import { authorityFixture } from './authority-fixtures.js';
import { preEffectCheckboxConflict } from '../checkbox-evidence.js';
import { DocCheckboxAuthority } from '../authority.js';
import { hashApprovalInput } from '../../../../core/approvals/approval-input-hash.js';
import { DocChannelNotFoundError } from '../../authorization.js';
import { DocChannelStore } from '../../store.js';
import { rawByteHash } from '../checkbox-bytes.js';
import { CheckboxAuthorityCallbackError, checkboxAuthoritySync } from '../authority-snapshot.js';
import type { DocGrantAuthority } from '../../grant-policy.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(room = false) {
  const h = await authorityFixture(room);
  cleanups.push(h.cleanup);
  let clock = h.deps.now;
  const authority = new DocCheckboxAuthority({ ...h.deps, now: () => clock() });
  return {
    ...h,
    authority,
    setClock: (next: () => Date) => {
      clock = next;
    },
  };
}
it('final gate performs zero FS while SQL is active, including original approval and source root', async () => {
  const h = await fixture();
  const original = await h.authority.prepare(h.input, h.actor);
  const snapshot = await h.authority.refreshCurrent(h.input, h.actor, original);
  let forbiddenReads = 0;
  for (const method of [
    'realpathSync',
    'statSync',
    'lstatSync',
    'openSync',
    'fstatSync',
    'readSync',
    'readFileSync',
    'accessSync',
    'readdirSync',
  ] as const) {
    const real = fs[method];
    vi.spyOn(fs, method).mockImplementation(((...args: unknown[]) => {
      if (h.db.$client.inTransaction) {
        forbiddenReads++;
        throw new Error('FS in SQL');
      }
      return Reflect.apply(real, fs, args);
    }) as never);
  }
  for (const method of [
    'realpath',
    'stat',
    'lstat',
    'open',
    'readFile',
    'access',
    'readdir',
  ] as const) {
    const real = fsp[method];
    vi.spyOn(fsp, method).mockImplementation(((...args: unknown[]) => {
      if (h.db.$client.inTransaction) {
        forbiddenReads++;
        throw new Error('async FS in SQL');
      }
      return Reflect.apply(real, fsp, args);
    }) as never);
  }
  expect(
    h.authority.transaction((tx) =>
      h.authority.requireCurrent(h.input, h.actor, original, snapshot, tx)
    )
  ).toEqual(original);
  expect(forbiddenReads).toBe(0);
  expect(() =>
    h.authority.transaction((tx) =>
      h.grants.revalidateGrant(h.input.documentId, original.grantId, h.actor, tx)
    )
  ).toThrow('LOCAL_SOURCE_UNAVAILABLE');
  expect(forbiddenReads).toBeGreaterThan(0);
});
it.each(['grant', 'owner'] as const)(
  'held actual FS await then second-connection %s change refuses the original grant',
  async (kind) => {
    const h = await fixture();
    const original = await h.authority.prepare(h.input, h.actor);
    const second = createDb(h.file);
    cleanups.push(async () => {
      second.$client.close();
    });
    const real = fsp.realpath;
    let release!: () => void, entered!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let held = false;
    vi.spyOn(fsp, 'realpath').mockImplementation(async (...args: Parameters<typeof real>) => {
      const result = await real(...args);
      if (!held) {
        held = true;
        entered();
        await wait;
      }
      return result;
    });
    const pending = h.authority.refreshCurrent(h.input, h.actor, original);
    await reached;
    if (kind === 'grant')
      second.update(canvasDocGrants).set({ revokedAt: new Date().toISOString() }).run();
    else
      second
        .insert(user)
        .values({
          id: 'different-owner',
          name: 'New',
          email: 'new@example.test',
          updatedAt: new Date(),
        })
        .run();
    release();
    await expect(pending).rejects.toThrow();
    expect(await fsp.readFile(h.path, 'utf8')).toBe('- [ ] actual task\n');
  }
);
it.each(['detail', 'binding', 'hash', 'consumption', 'capability', 'state'] as const)(
  'refuses actual original approval %s corruption',
  async (kind) => {
    const h = await fixture();
    const original = await h.authority.prepare(h.input, h.actor);
    const snapshot = await h.authority.refreshCurrent(h.input, h.actor, original);
    if (kind === 'detail') h.db.update(approvals).set({ detail: '{}' }).run();
    if (kind === 'hash')
      h.db
        .update(approvals)
        .set({ inputHash: 'b'.repeat(64) })
        .run();
    if (kind === 'consumption') h.db.update(approvals).set({ consumedAt: null }).run();
    if (kind === 'capability')
      h.db.update(approvals).set({ capabilityId: 'another.capability' }).run();
    if (kind === 'state') h.db.update(approvals).set({ state: 'denied' }).run();
    if (kind === 'binding')
      h.db
        .update(canvasDocGrants)
        .set({
          approvalEvidence: {
            ...(h.granted.grant.approvalEvidence as object),
            binding: { documentId: 'wrong' },
          },
        })
        .run();
    expect(() =>
      h.authority.transaction((tx) =>
        h.authority.requireCurrent(h.input, h.actor, original, snapshot, tx)
      )
    ).toThrow();
  }
);
it('real room member/operator can write, member runtime cannot bypass PEOPLE_ONLY, and current roster/archive refuse', async () => {
  const h = await fixture(true);
  const approved = await h.authority.prepare(h.input, h.actor);
  expect(approved.grantId).toBe(h.granted.grant.grantId);
  await expect(h.authority.prepare(h.input, h.runtime)).rejects.toMatchObject({
    code: 'PEOPLE_ONLY',
  });
  const snapshot = await h.authority.refreshCurrent(h.input, h.actor, approved);
  h.db.update(roomRows).set({ archived: true }).run();
  expect(() =>
    h.authority.transaction((tx) =>
      h.authority.requireCurrent(h.input, h.actor, approved, snapshot, tx)
    )
  ).toThrow();
  h.db.update(roomRows).set({ archived: false }).run();
  const next = await h.authority.refreshCurrent(h.input, h.actor, approved);
  h.db.delete(roomMembers).run();
  expect(() =>
    h.authority.transaction((tx) =>
      h.authority.requireCurrent(h.input, h.actor, approved, next, tx)
    )
  ).toThrow();
});
it('background uses recorded owner/evidence without a fabricated actor and never substitutes newer authority', async () => {
  const h = await fixture();
  const approved = await h.authority.prepare(h.input, h.actor);
  const data = preEffectCheckboxConflict(
    h.input,
    approved,
    hashApprovalInput(h.input),
    new Date().toISOString()
  );
  // Intent digest is deliberately the actual writer raw request digest, not approval canonicalization.
  const { createHash } = await import('node:crypto');
  data.intent.envelopeHash = createHash('sha256')
    .update(JSON.stringify(CanvasChannelCheckboxRequestSchema.parse(h.input)))
    .digest('hex');
  h.db.insert(canvasDocWriteIntents).values(data.intent).run();
  const intent = h.db.select().from(canvasDocWriteIntents).get()!;
  expect(await h.authority.prepareRecovery(intent)).toEqual(approved);
  const snapshot = await h.authority.refreshRecoveryCurrent(intent, approved);
  h.db
    .insert(user)
    .values({ id: 'new-owner', name: 'New', email: 'new@example.test', updatedAt: new Date() })
    .run();
  expect(() =>
    h.authority.transaction((tx) =>
      h.authority.requireRecoveryCurrent(intent, approved, snapshot, tx)
    )
  ).toThrow('ORIGINAL_OWNER_CHANGED');
  expect(h.db.select().from(canvasDocWriteIntents).get()).toEqual(intent);
});
it('causeful source/recovery failures remain uncertain and nominal sync Promise ports cannot commit', async () => {
  const h = await fixture();
  const approved = await h.authority.prepare(h.input, h.actor);
  const snapshot = await h.authority.refreshCurrent(h.input, h.actor, approved);
  vi.spyOn(h.grants, 'revalidateOriginalWriteGrant').mockImplementation(
    () => Promise.reject(new Error('late refusal')) as never
  );
  expect(() =>
    h.authority.transaction((tx) =>
      h.authority.requireCurrent(h.input, h.actor, approved, snapshot, tx)
    )
  ).toThrow('synchronous');
  await Promise.resolve();
  expect(
    h.authority.isAuthorityRefusal(new DocChannelNotFoundError({ cause: new Error('SQLITE_BUSY') }))
  ).toBe(false);
  const changed = new DocCheckboxAuthority({
    ...h.deps,
    now: () => Promise.resolve(new Date()) as never,
  });
  await expect(changed.prepare(h.input, h.actor)).rejects.toThrow('synchronous');
});
it('last observation detects a manifest appearing during an actual source probe and refuses its original approval', async () => {
  const h = await fixture();
  const original = await h.authority.prepare(h.input, h.actor);
  const real = fsp.realpath;
  let changed = false;
  vi.spyOn(fsp, 'realpath').mockImplementation(async (...args: Parameters<typeof real>) => {
    const result = await real(...args);
    if (!changed && args[0] === h.path) {
      changed = true;
      await fsp.mkdir(`${h.dir}/.dork`, { recursive: true });
      await fsp.writeFile(
        `${h.dir}/.dork/app.json`,
        JSON.stringify({ v: 1, types: { 'md.task.toggled': { type: 'object' } } })
      );
    }
    return result;
  });
  await expect(h.authority.refreshCurrent(h.input, h.actor, original)).rejects.toThrow();
  expect(changed).toBe(true);
  expect(await fsp.readFile(h.path, 'utf8')).toBe('- [ ] actual task\n');
});
it('unknown source IO keeps its original object/cause rather than manufacturing permanent loss', async () => {
  const h = await fixture();
  const original = await h.authority.prepare(h.input, h.actor);
  const error = Object.assign(new Error('actual temporary filesystem refusal'), { code: 'EIO' });
  vi.spyOn(fsp, 'realpath').mockRejectedValueOnce(error);
  await expect(h.authority.refreshCurrent(h.input, h.actor, original)).rejects.toBe(error);
  expect(h.authority.isAuthorityRefusal(error)).toBe(false);
});
it('reentrant final gate, crossed database and changed original grant cannot use a cached snapshot', async () => {
  const h = await fixture();
  const original = await h.authority.prepare(h.input, h.actor);
  const first = await h.authority.refreshCurrent(h.input, h.actor, original);
  const second = await h.authority.refreshCurrent(h.input, h.actor, original);
  const real = h.grants.revalidateOriginalWriteGrant.bind(h.grants);
  vi.spyOn(h.grants, 'revalidateOriginalWriteGrant').mockImplementation((...args) => {
    h.authority.requireCurrent(h.input, h.actor, original, second, args[5]);
    return real(...args);
  });
  expect(() =>
    h.authority.transaction((tx) =>
      h.authority.requireCurrent(h.input, h.actor, original, first, tx)
    )
  ).toThrow('reenter');
  const other = createDb(':memory:');
  try {
    expect(() => new DocCheckboxAuthority({ ...h.deps, db: other })).toThrow(
      'transaction database'
    );
  } finally {
    other.$client.close();
  }
});
it('caller replacement during an actual awaited probe refuses instead of rebinding the observation', async () => {
  const h = await fixture();
  const original = await h.authority.prepare(h.input, h.actor);
  const real = fsp.realpath;
  let changed = false;
  vi.spyOn(fsp, 'realpath').mockImplementation(async (...args: Parameters<typeof real>) => {
    const result = await real(...args);
    if (!changed) {
      changed = true;
      h.actor.surface = 'capability';
    }
    return result;
  });
  await expect(h.authority.refreshCurrent(h.input, h.actor, original)).rejects.toThrow(
    'SNAPSHOT_SUBJECT_CHANGED'
  );
});
it('bounded invalid manifest is a checked refusal retaining its parsing cause', async () => {
  const h = await fixture();
  const original = await h.authority.prepare(h.input, h.actor);
  await fsp.mkdir(`${h.dir}/.dork`, { recursive: true });
  await fsp.writeFile(`${h.dir}/.dork/app.json`, '{invalid');
  const error = await h.authority
    .refreshCurrent(h.input, h.actor, original)
    .catch((error) => error);
  expect(error).toMatchObject({ code: 'MANIFEST_INVALID', cause: expect.any(SyntaxError) });
  expect(h.authority.isAuthorityRefusal(error)).toBe(true);
});
it.each(['live', 'recovery'] as const)(
  'transaction provenance rejects foreign FILE stale grant for %s before actual effect',
  async (kind) => {
    const h = await fixture(),
      approved = await h.authority.prepare(h.input, h.actor);
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
    const clone = `${h.dir}/foreign-${kind}.sqlite`;
    await h.db.$client.backup(clone);
    const foreign = createDb(clone);
    try {
      h.db.update(canvasDocGrants).set({ revokedAt: new Date().toISOString() }).run();
      expect(h.db.select().from(canvasDocGrants).get()!.revokedAt).toBeTruthy();
      expect(foreign.select().from(canvasDocGrants).get()!.revokedAt).toBeNull();
      let effects = 0,
        error: unknown;
      try {
        h.authority.transaction(() =>
          foreign.transaction((tx) => {
            if (kind === 'live')
              h.authority.requireCurrent(h.input, h.actor, approved, snapshot, tx);
            else h.authority.requireRecoveryCurrent(intent, approved, snapshot, tx);
            effects++;
            fs.writeFileSync(h.path, `FOREIGN ${kind} EFFECT`);
          })
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeDefined();
      expect(effects).toBe(0);
      expect(await fsp.readFile(h.path, 'utf8')).toBe('- [ ] actual task\n');
    } finally {
      foreign.$client.close();
    }
  }
);
it('transaction provenance refuses a foreign configured store even when authoritative DB is already active', async () => {
  const h = await fixture(),
    clone = `${h.dir}/foreign-constructor.sqlite`;
  await h.db.$client.backup(clone);
  const foreign = createDb(clone);
  try {
    expect(() =>
      h.http.channels.transaction(
        () =>
          new DocCheckboxAuthority({
            ...h.deps,
            store: new DocChannelStore(foreign),
          })
      )
    ).toThrow();
  } finally {
    foreign.$client.close();
  }
});
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
    let calls = 0,
      effects = 0;
    h.setGrantClock(() => {
      calls++;
      h.db.update(canvasDocGrants).set({ revokedAt: new Date().toISOString() }).run();
      return new Date();
    });
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
    let calls = 0,
      effects = 0;
    h.setGrantClock(() => {
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
    });
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
    let calls = 0;
    h.setGrantClock(() => {
      calls++;
      return new Date();
    });
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
  const trace: string[] = [];
  h.setGrantClock(() => {
    trace.push('clock');
    return new Date();
  });
  h.setGrantTrace((phase) => trace.push(phase));
  // Observe genuine fresh full-row SQL decoding, not a reflected public store method.
  const originalDecode = canvasDocGrants.approvalEvidence.mapFromDriverValue.bind(
    canvasDocGrants.approvalEvidence
  );
  vi.spyOn(canvasDocGrants.approvalEvidence, 'mapFromDriverValue').mockImplementation((value) => {
    trace.push('grant');
    return originalDecode(value);
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
  h.setGrantClock(() => new Date(Date.parse(h.granted.grant.expiresAt!) + 1));
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
