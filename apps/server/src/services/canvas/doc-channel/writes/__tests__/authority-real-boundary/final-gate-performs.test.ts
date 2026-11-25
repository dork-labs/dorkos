import { cleanups, fixture } from './harness.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { CanvasChannelCheckboxRequestSchema } from '@dorkos/shared/canvas-channel-schemas';
import { expect, it, vi } from 'vitest';
import {
  approvals,
  canvasDocGrants,
  canvasDocWriteIntents,
  roomMembers,
  rooms as roomRows,
  user,
  createDb,
} from '@dorkos/db';
import { preEffectCheckboxConflict } from '../../checkbox-evidence.js';
import { DocCheckboxAuthority } from '../../authority.js';
import { hashApprovalInput } from '../../../../../core/approvals/approval-input-hash.js';
import { DocChannelNotFoundError } from '../../../authorization.js';
import { DocChannelStore } from '../../../store.js';
import { rawByteHash } from '../../checkbox-bytes.js';

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
