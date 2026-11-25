import { readFile, stat, chmod, writeFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { canvasDocChannels, canvasDocWriteIntents } from '@dorkos/db';
import { AuthorityRefused } from '../checkbox-fixture.js';
import type { CheckboxRequest } from '../../checkbox-service.js';
import type { DocCheckboxAuthority } from '../../authority.js';
import { recoverCheckboxPage } from '../../write-recovery.js';
import { fixture } from './harness.js';
import { type DbTransaction } from '@dorkos/db';
import { type DocChannelActor } from '../../../authorization.js';
import type { VerifiedCheckboxAuthority } from '../../checkbox-service.js';

it('writes exactly one raw marker, preserves mode/BOM/CRLF and atomically completes original event/outbox/receipt', async () => {
  const h = await fixture();
  await chmod(h.path, 0o640);
  const input = await h.request();
  const before = await readFile(h.path);
  const result = await h.service.toggle(input, h.actor);
  expect(result.status).toBe('changed');
  const after = await readFile(h.path);
  expect([...after].filter((value, index) => value !== before[index])).toHaveLength(1);
  expect(after.toString()).toBe('\ufeff- [x] café😀\r\n- [ ] repeated\r\n');
  expect((await stat(h.path)).mode & 0o777).toBe(0o640);
  expect(h.row().status).toBe('committed');
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  expect(await h.service.toggle(input, h.actor)).toEqual(result);
  expect(await h.service.toggle({ ...input, done: false }, h.actor)).toMatchObject({
    status: 'conflict',
  });
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  expect(h.notices).toEqual([h.documentId]);
});

it('no-op and verified stale version produce durable original receipts and no changed work', async () => {
  const h = await fixture();
  const noOp = await h.request(false);
  expect((await h.service.toggle(noOp, h.actor)).status).toBe('no_op');
  const conflict = { ...(await h.request()), expectedFileVersion: '0'.repeat(64) };
  expect((await h.service.toggle(conflict, h.actor)).status).toBe('conflict');
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});

it('checks current grant/editor lock before effects and rechecks authority after async staging', async () => {
  const h: Awaited<ReturnType<typeof fixture>> = await fixture({
    checkpoint: async (point) => {
      if (point === 'staged') h.revoke();
    },
  });
  const before = await readFile(h.path);
  const input = await h.request();
  await expect(h.service.toggle(input, h.actor)).rejects.toThrow('The document is not available.');
  expect(await readFile(h.path)).toEqual(before);
  expect(h.row().status).toBe('prepared');
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  const other = await fixture();
  other.lock();
  await expect(other.service.toggle(await other.request(), other.actor)).rejects.toThrow(
    'EDITOR_LOCKED'
  );
  expect(other.row()).toBeUndefined();
});

it('post-effect revoked authority retains evidence and fence without completing work', async () => {
  const h: Awaited<ReturnType<typeof fixture>> = await fixture({
    checkpoint: async (point) => {
      if (point === 'verified') h.revoke();
    },
  });
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow(
    'The document is not available.'
  );
  expect((await readFile(h.path)).toString()).toContain('[x]');
  expect(h.row().status).toBe('replaced');
  expect(h.service.fenced(h.path)).toBe(true);
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});

it('completion rollback preserves replaced evidence and recovery commits once without another rename', async () => {
  const h = await fixture();
  h.failCompletion(true);
  const input = await h.request();
  await expect(h.service.toggle(input, h.actor)).rejects.toThrow('completion rollback');
  expect(h.row().status).toBe('replaced');
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  const inode = (await stat(h.path)).ino;
  h.failCompletion(false);
  const [a, b] = await Promise.all([
    h.service.recover(h.row().intentId),
    h.service.recover(h.row().intentId),
  ]);
  expect(a).toEqual(b);
  expect(a.status).toBe('changed');
  expect((await stat(h.path)).ino).toBe(inode);
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
});

it('rejects async genuine authority scopes, retires SQL handles and rolls back late writes', async () => {
  const h = await fixture();
  let late!: Promise<unknown>;
  const callback = (tx: DbTransaction) => {
    late = Promise.resolve().then(() =>
      tx.update(canvasDocChannels).set({ closedAt: new Date().toISOString() }).run()
    );
    return late;
  };
  expect(() =>
    h.authority.transaction(callback as unknown as (tx: DbTransaction) => undefined)
  ).toThrow('synchronous');
  await expect(late).rejects.toThrow();
  expect(h.store.getChannel(h.documentId)?.closedAt).toBeNull();
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});

it('stop drains held FS preparation before DB disposal and prevents completion', async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    start = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const h = await fixture({
    checkpoint: async (point) => {
      if (point === 'prepared') {
        entered();
        await held;
      }
    },
  });
  const operation = h.service.toggle(await h.request(), h.actor);
  const refusal = expect(operation).rejects.toThrow('not available');
  await start;
  let drained = false;
  const stop = h.service.stop().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  release();
  await stop;
  await refusal;
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  await expect(recoverCheckboxPage(h.service)).rejects.toThrow('not available');
});

it('quarantines corrupted evidence and unknown after-state, retaining path fences and zero changed work', async () => {
  const h = await fixture();
  h.failCompletion(true);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow();
  await writeFile(h.path, 'external unknown');
  expect((await h.service.recover(h.row().intentId)).status).toBe('in_doubt');
  expect(h.service.fenced(h.path)).toBe(true);
  h.db.$client.prepare("UPDATE canvas_doc_write_intents SET evidence='{}'").run();
  const page = await recoverCheckboxPage(h.service);
  expect(page).toMatchObject({ selected: 1, verified: 0, retryableFailures: 1, hasMore: false });
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});

it('requires current access before duplicate disclosure without reinterpreting original inputs', async () => {
  const h = await fixture();
  const input = await h.request();
  const original = await h.service.toggle(input, h.actor);
  const hash = h.row().envelopeHash;
  h.db.update(canvasDocChannels).set({ closedAt: new Date().toISOString() }).run();
  await expect(h.service.toggle(input, h.actor)).rejects.toBeInstanceOf(AuthorityRefused);
  expect(h.row().envelopeHash).toBe(hash);
  h.db.update(canvasDocChannels).set({ closedAt: null }).run();
  expect(await h.service.toggle(input, h.actor)).toEqual(original);
  expect(h.row().envelopeHash).toBe(hash);
});

it('retains replaced evidence on transient recovery errors and quarantines only typed authority loss', async () => {
  const h = await fixture();
  h.failCompletion(true);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow();
  const original = h.row();
  h.authority.prepareRecovery = async () => {
    throw new Error('storage unavailable');
  };
  await expect(h.service.recover(original.intentId)).rejects.toThrow('storage unavailable');
  expect(h.row()).toEqual(original);
  h.authority.prepareRecovery = async () => {
    throw h.lostAuthority();
  };
  await expect(h.service.recover(original.intentId)).rejects.toBeInstanceOf(AuthorityRefused);
  expect(h.row().status).toBe('in_doubt');
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});

it('does not invoke a replaced async public authority method or expose its actual SQL handle', async () => {
  const h = await fixture();
  const input = await h.request(),
    before = await readFile(h.path);
  let calls = 0,
    exposed: DbTransaction | undefined;
  h.authority.requireCurrent = (async (
    _request: CheckboxRequest,
    _actor: DocChannelActor,
    _approved: VerifiedCheckboxAuthority,
    _snapshot: Parameters<DocCheckboxAuthority['requireCurrent']>[3],
    tx: DbTransaction
  ) => {
    calls++;
    exposed = tx;
    await Promise.resolve();
    return h.approved;
  }) as unknown as DocCheckboxAuthority['requireCurrent'];
  const receipt = await h.service.toggle(input, h.actor);
  await Promise.resolve();
  expect(calls).toBe(0);
  expect(exposed).toBeUndefined();
  expect(receipt).toMatchObject({ status: 'changed', receipt: { id: input.eventId } });
  const bytes = await readFile(h.path),
    inode = (await stat(h.path)).ino;
  expect([...bytes].filter((value, index) => value !== before[index])).toHaveLength(1);
  expect(bytes).toEqual(Buffer.from('\ufeff- [x] café😀\r\n- [ ] repeated\r\n'));
  expect(h.row()).toMatchObject({
    eventId: input.eventId,
    grantId: h.grantId,
    status: 'committed',
  });
  expect(h.store.getChannel(h.documentId)?.closedAt).toBeNull();
  expect(h.store.getEvent(h.documentId, input.eventId)?.eventId).toBe(input.eventId);
  expect(h.service.validate(h.row()).receipt).toEqual(receipt);
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  expect(await h.service.toggle(input, h.actor)).toEqual(receipt);
  expect(await readFile(h.path)).toEqual(bytes);
  expect((await stat(h.path)).ino).toBe(inode);
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  expect(h.store.getEvent(h.documentId, input.eventId)?.eventId).toBe(input.eventId);
});

it.each(['throw'] as const)(
  'classification %s never destroys retryable recovery evidence',
  async (kind) => {
    const h = await fixture();
    h.failCompletion(true);
    await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow();
    const original = h.row();
    h.authority.prepareRecovery = async () => {
      throw new Error('unavailable');
    };
    h.authority.isAuthorityRefusal = (() => {
      if (kind === 'throw') throw new Error('classifier unavailable');
      if (kind === 'thenable') return Promise.reject(new Error('late classifier'));
      return 'yes';
    }) as unknown as DocCheckboxAuthority['isAuthorityRefusal'];
    await expect(h.service.recover(original.intentId)).rejects.toThrow('unavailable');
    await Promise.resolve();
    expect(h.row()).toEqual(original);
  }
);

it('refuses a newer grant revision after staging and freezes the original approval evidence', async () => {
  const h: Awaited<ReturnType<typeof fixture>> = await fixture({
    checkpoint: async (point) => {
      if (point === 'staged')
        h.db.$client.prepare('UPDATE canvas_doc_grants SET revision=revision+1').run();
    },
  });
  const before = await readFile(h.path);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow();
  expect(await readFile(h.path)).toEqual(before);
  expect(h.row().status).toBe('in_doubt');
  expect(
    h.service.validate(h.store.getWriteIntent(h.row().intentId)!).authority.grantRevision
  ).toBe(1);
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});

it.each(['staged', 'verified'] as const)(
  'external byte changes at %s never produce routable changed work',
  async (point) => {
    const h: Awaited<ReturnType<typeof fixture>> = await fixture({
      checkpoint: async (current) => {
        if (current === point) await writeFile(h.path, 'external source');
      },
    });
    await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow('changed');
    expect(await readFile(h.path, 'utf8')).toBe('external source');
    expect(h.row().status).toBe('in_doubt');
    expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  }
);

it('raw fence reuse still decodes replaced evidence codecs and refuses malformed current JSON', async () => {
  const h = await fixture();
  h.failCompletion(true);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow();
  const own = h.store.getWriteIntent(h.row().intentId)!;
  expect(h.service.writeFence.readiness()).toEqual({ ready: true });
  expect(h.service.writeFence.readiness()).toEqual({ ready: true });
  const first: unknown = undefined;
  const decoder = vi
    .spyOn(canvasDocWriteIntents.evidence, 'mapFromDriverValue')
    .mockImplementation(() => {
      throw first;
    });
  try {
    expect(h.service.writeFence.readiness()).toEqual({ ready: false, reason: 'corrupt' });
    expect(decoder).toHaveBeenCalled();
  } finally {
    decoder.mockRestore();
  }
  expect(h.service.writeFence.readiness()).toEqual({ ready: true });
  h.db.$client
    .prepare("UPDATE canvas_doc_write_intents SET evidence='{' WHERE intent_id=?")
    .run(own.intentId);
  expect(h.service.writeFence.readiness()).toEqual({ ready: false, reason: 'corrupt' });
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});

it('keeps every observed and mutation lifecycle hash strict regardless of an opaque original expected version', async () => {
  const h = await fixture();
  h.failCompletion(true);
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toThrow('completion rollback');
  const row = h.row();
  for (const status of [
    'prepared',
    'replaced',
    'in_doubt',
    'committed',
    'no_op',
    'conflict',
  ] as const) {
    expect(() => h.service.validate({ ...row, status, beforeHash: 'opaque-version' })).toThrow();
    expect(() => h.service.validate({ ...row, status, afterHash: 'opaque-version' })).toThrow();
  }
  expect(h.row()).toEqual(row);
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});
