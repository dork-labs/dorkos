import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { canvasDocChannels } from '@dorkos/db';
import { DocCheckboxWriteService } from '../../checkbox-service.js';
import {
  CanonicalFileWriteCoordinator,
  CanonicalFileIdentityChangedError,
} from '../../canonical-writer.js';
import { DocChannelNotFoundError } from '../../../authorization.js';
import type { DocWriteIntentRow } from '../../../store.js';
import { rawByteHash } from '../../checkbox-bytes.js';
import { VerifiedCheckboxAuthoritySchema } from '../../checkbox-evidence.js';
import { observeCheckboxSource } from '../../authority-snapshot.js';
import { readDocSourceDescriptor } from '../../../http-composition.js';
import { cleanups, fixture } from './harness.js';

async function simultaneous(
  kind: 'distinct' | 'same' | 'different-hash' = 'distinct',
  resolveError?: Error,
  expectedFileVersion?: string
) {
  const h = await fixture();
  let release!: () => void, entered!: () => void, queued!: () => void, prepareBoth!: () => void;
  const held = new Promise<void>((r) => {
      release = r;
    }),
    prepared = new Promise<void>((r) => {
      entered = r;
    }),
    pending = new Promise<void>((r) => {
      queued = r;
    }),
    both = new Promise<void>((r) => {
      prepareBoth = r;
    });
  let calls = 0,
    preparations = 0,
    firstEventId = '',
    firstDone = true;
  const prepare = h.authority.prepare.bind(h.authority);
  h.authority.prepare = async (...args) => {
    const result = await prepare(...args);
    if (++preparations === 2) prepareBoth();
    await both;
    if (args[0].eventId !== firstEventId || args[0].done !== firstDone) await prepared;
    return result;
  };
  const coordinator = new CanonicalFileWriteCoordinator({
    assertOutsideTransaction: () => {
      if (h.db.$client.inTransaction) throw new Error('SQL boundary');
    },
    resolve: async (path) => {
      const canonicalPath = await realpath(path),
        info = await stat(path, { bigint: true });
      if (++calls === 3) queued();
      if (calls === 5 && resolveError) throw resolveError;
      return { canonicalPath, device: String(info.dev), inode: String(info.ino) };
    },
  });
  let afterCommit = () => undefined;
  const service = new DocCheckboxWriteService(
    h.db,
    h.store,
    coordinator,
    h.authority,
    {
      ...h.delivery,
      notifyCommitted: (id: string) => {
        h.delivery.notifyCommitted(id);
        afterCommit();
        return undefined;
      },
    },
    {
      checkpoint: async (point) => {
        if (point === 'prepared') {
          entered();
          await held;
        }
      },
    }
  );
  cleanups.unshift(() => service.stop());
  const firstInput = await h.request(),
    secondInput =
      kind === 'distinct'
        ? {
            ...(await h.request()),
            ...(expectedFileVersion === undefined ? {} : { expectedFileVersion }),
          }
        : { ...firstInput, done: kind === 'same' ? firstInput.done : !firstInput.done };
  firstEventId = firstInput.eventId;
  firstDone = firstInput.done;
  const first = service.toggle(firstInput, h.actor);
  const second = service.toggle(secondInput, h.actor).then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error: error as unknown })
  );
  await prepared;
  await pending;
  return {
    ...h,
    service,
    firstInput,
    secondInput,
    release,
    first,
    second,
    afterCommit: (work: () => undefined) => {
      afterCommit = work;
    },
  };
}
it('records a typed durable reload conflict for the exact simultaneous distinct stale-save case', async () => {
  const h = await simultaneous();
  h.release();
  const first = await h.first,
    second = await h.second;
  expect(first.status).toBe('changed');
  expect(second.value).toEqual({
    status: 'conflict',
    eventId: h.secondInput.eventId,
    action: 'reload',
  });
  const row = h.service.find(h.documentId, h.secondInput.eventId)!;
  expect(row).toMatchObject({
    status: 'conflict',
    errorCode: 'identity_changed_before_effect',
    input: h.secondInput,
    expectedVersion: h.secondInput.expectedFileVersion,
  });
  expect(h.service.validate(row)).toMatchObject({
    preEffectRefusal: 'identity_changed',
    markerOffset: null,
    beforeMarker: null,
    tempPath: null,
    tempIdentity: null,
    lineHash: null,
  });
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  const inode = (await stat(h.path)).ino;
  expect(await h.service.toggle(h.secondInput, h.actor)).toEqual(second.value);
  expect(await h.service.recover(row.intentId)).toEqual(second.value);
  expect((await stat(h.path)).ino).toBe(inode);
});
it.each(['same', 'different-hash'] as const)(
  'simultaneous %s identity preserves the original receipt/hash without another intent',
  async (kind) => {
    const h = await simultaneous(kind);
    h.release();
    const first = await h.first,
      second = await h.second;
    expect(second.value).toEqual(
      kind === 'same'
        ? first
        : { status: 'conflict', eventId: h.firstInput.eventId, action: 'reload' }
    );
    expect(
      h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_write_intents').get()
    ).toEqual({ n: 1 });
    expect(h.service.find(h.documentId, h.firstInput.eventId)!.envelopeHash).toBe(
      rawByteHash(Buffer.from(JSON.stringify(h.firstInput)))
    );
    expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  }
);
it.each(['access', 'revoked', 'binding'] as const)(
  'does not turn current %s refusal after waiting into a version conflict',
  async (kind) => {
    const h = await simultaneous();
    h.afterCommit(() => {
      if (kind === 'access')
        h.db.update(canvasDocChannels).set({ closedAt: new Date().toISOString() }).run();
      if (kind === 'revoked') h.revoke();
      if (kind === 'binding')
        h.db.$client
          .prepare(
            "UPDATE canvas_doc_grants SET write_operation=json_set(write_operation,'$.canonicalPath',?)"
          )
          .run(join(h.dir, 'moved.md'));
      return undefined;
    });
    h.release();
    expect((await h.first).status).toBe('changed');
    const refusal = (await h.second).error;
    if (kind === 'binding') expect(refusal).toMatchObject({ code: 'GRANT_EVIDENCE_MISMATCH' });
    else if (kind === 'access') expect(refusal).toMatchObject({ code: 'DOCUMENT_CLOSED' });
    else expect(refusal).toBeInstanceOf(DocChannelNotFoundError);
    expect(h.service.find(h.documentId, h.secondInput.eventId)).toBeUndefined();
    expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  }
);
it('does not launder corrupt original same-ID evidence into a normal hash conflict', async () => {
  const h = await simultaneous('different-hash');
  h.afterCommit(() => {
    expect(h.db.$client.inTransaction).toBe(false);
    h.db.$client.prepare("UPDATE canvas_doc_write_intents SET evidence='{}'").run();
    return undefined;
  });
  h.release();
  expect((await h.first).status).toBe('changed');
  expect((await h.second).error).toBeTruthy();
  expect(h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_write_intents').get()).toEqual({
    n: 1,
  });
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
});

it('rolls back a refused conflict insert without masking its real SQLite storage error', async () => {
  const h = await simultaneous();
  h.db.$client.exec(
    "CREATE TRIGGER refuse_conflict BEFORE INSERT ON canvas_doc_write_intents WHEN NEW.status='conflict' BEGIN SELECT RAISE(ABORT,'conflict storage refused'); END"
  );
  h.release();
  await h.first;
  expect((await h.second).error).toBeTruthy();
  expect(h.service.find(h.documentId, h.secondInput.eventId)).toBeUndefined();
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
});
it('does not reinterpret identity-class errors from an already-entered callback as pre-effect conflicts', async () => {
  const error = new CanonicalFileIdentityChangedError();
  const h = await fixture({
    checkpoint: async (point) => {
      if (point === 'verified') throw error;
    },
  });
  await expect(h.service.toggle(await h.request(), h.actor)).rejects.toBe(error);
  expect(h.row().status).toBe('replaced');
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
});

async function fileBackedFixture() {
  const h = await fixture();
  expect(h.documentId).toMatch(/^[a-f0-9]{32}$/);
  expect(h.rooms.canvasDocuments.lookupIdentity(h.documentId)?.sourceKey).not.toBeNull();
  return h;
}
it('accepts actual file-backed document identifiers through write, original retry and recovery without a second effect', async () => {
  const h = await fileBackedFixture();
  const input = await h.request();
  const before = await readFile(h.path);
  h.failCompletion(true);
  await expect(h.service.toggle(input, h.actor)).rejects.toThrow('completion rollback');
  expect(h.row()).toMatchObject({
    documentId: h.documentId,
    eventId: input.eventId,
    status: 'replaced',
  });
  const after = await readFile(h.path);
  expect([...after].filter((v, i) => v !== before[i])).toHaveLength(1);
  const inode = (await stat(h.path)).ino;
  h.failCompletion(false);
  const receipt = await h.service.recover(h.row().intentId);
  expect(receipt).toMatchObject({ receipt: { id: input.eventId }, status: 'changed' });
  expect(await h.service.toggle(input, h.actor)).toEqual(receipt);
  expect((await stat(h.path)).ino).toBe(inode);
  expect(await readFile(h.path)).toEqual(after);
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  expect(h.store.getEvent(h.documentId, input.eventId)?.eventId).toBe(input.eventId);
  expect(h.notices).toEqual([h.documentId]);
});
it.each(['x'.repeat(201)])(
  'rejects malformed document identity in requests and stored authority: %s',
  async (documentId) => {
    const h = await fixture();
    const input = await h.request();
    expect(VerifiedCheckboxAuthoritySchema.safeParse({ ...h.approved, documentId }).success).toBe(
      false
    );
    await expect(h.service.toggle({ ...input, documentId }, h.actor)).rejects.toThrow();
    expect(h.row()).toBeUndefined();
    expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  }
);

it.each(['opaque-revision:λ'])(
  'preserves opaque request version in unobserved pre-effect refusal through validation, retry and recovery: %s',
  async (version) => {
    const h = await simultaneous('distinct', undefined, version);
    h.release();
    expect((await h.first).status).toBe('changed');
    const second = await h.second;
    expect(second.error).toBeUndefined();
    expect(second.value).toEqual({
      status: 'conflict',
      eventId: h.secondInput.eventId,
      action: 'reload',
    });
    const row = h.service.find(h.documentId, h.secondInput.eventId)!;
    expect(row).toMatchObject({
      beforeHash: version,
      afterHash: version,
      expectedVersion: version,
      input: h.secondInput,
      errorCode: 'identity_changed_before_effect',
    });
    expect(h.service.validate(row)).toMatchObject({
      preEffectRefusal: 'identity_changed',
      markerOffset: null,
      beforeMarker: null,
      lineHash: null,
      tempPath: null,
      tempIdentity: null,
    });
    const before = await readFile(h.path),
      inode = (await stat(h.path)).ino;
    expect(await h.service.toggle(h.secondInput, h.actor)).toEqual(second.value);
    expect(await h.service.recover(row.intentId)).toEqual(second.value);
    expect(h.service.find(h.documentId, h.secondInput.eventId)).toEqual(row);
    expect((await stat(h.path)).ino).toBe(inode);
    expect(await readFile(h.path)).toEqual(before);
    expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
  }
);
it('keeps opaque ordinary observed conflicts valid while requiring real observed hashes', async () => {
  const h = await fixture();
  const input = { ...(await h.request()), expectedFileVersion: 'not-a-sha256' };
  const before = await readFile(h.path),
    inode = (await stat(h.path)).ino;
  const receipt = await h.service.toggle(input, h.actor);
  expect(receipt).toEqual({ status: 'conflict', eventId: input.eventId, action: 'reload' });
  const row = h.row();
  expect(row.beforeHash).toBe(rawByteHash(before));
  expect(row.afterHash).toBe(rawByteHash(before));
  expect(h.service.validate(row).preEffectRefusal).toBeUndefined();
  expect(await h.service.toggle(input, h.actor)).toEqual(receipt);
  expect(await h.service.recover(row.intentId)).toEqual(receipt);
  expect((await stat(h.path)).ino).toBe(inode);
  expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  expect(() =>
    h.service.validate({
      ...row,
      beforeHash: input.expectedFileVersion,
      afterHash: input.expectedFileVersion,
    })
  ).toThrow();
  expect(() =>
    h.service.validate({
      ...row,
      evidence: { ...h.service.validate(row), preEffectRefusal: 'identity_changed' },
    })
  ).toThrow();
});
it.each(['v'.repeat(501)])(
  'refuses versions outside the shared opaque domain before any durable work: %s',
  async (version) => {
    const h = await fixture();
    const input = { ...(await h.request()), expectedFileVersion: version };
    const before = await readFile(h.path);
    await expect(h.service.toggle(input, h.actor)).rejects.toThrow();
    expect(h.row()).toBeUndefined();
    expect(await readFile(h.path)).toEqual(before);
    expect(h.counts()).toEqual({ events: { n: 0 }, batches: { n: 0 } });
  }
);
it('does not let forged terminal flags bypass status, original version, identity or observed proof checks', async () => {
  const h = await simultaneous('distinct', undefined, 'opaque-version');
  h.release();
  await h.first;
  await h.second;
  const row = h.service.find(h.documentId, h.secondInput.eventId)!;
  const evidence = h.service.validate(row);
  const mutations: DocWriteIntentRow[] = [
    { ...row, status: 'prepared' },
    { ...row, status: 'replaced' },
    { ...row, errorCode: 'source_conflict' },
    { ...row, beforeHash: 'different-version' },
    { ...row, afterHash: 'different-version' },
    { ...row, expectedVersion: 'different-version' },
    { ...row, evidence: { ...evidence, preEffectRefusal: undefined } },
    { ...row, evidence: { ...evidence, markerOffset: 5 } },
    { ...row, evidence: { ...evidence, beforeMarker: 32 } },
    { ...row, evidence: { ...evidence, lineHash: 'a'.repeat(64) } },
    { ...row, evidence: { ...evidence, tempPath: h.path } },
    { ...row, evidence: { ...evidence, tempIdentity: { device: '1', inode: '2' } } },
    {
      ...row,
      evidence: {
        ...evidence,
        receipt: { status: 'conflict', eventId: randomUUID(), action: 'reload' },
      },
    },
    {
      ...row,
      evidence: {
        ...evidence,
        receipt: { status: 'no_op', eventId: row.eventId, fileVersion: row.beforeHash },
      },
    },
  ];
  for (const corrupt of mutations) expect(() => h.service.validate(corrupt)).toThrow();
  expect(h.service.find(h.documentId, h.secondInput.eventId)).toEqual(row);
  expect(h.counts()).toEqual({ events: { n: 2 }, batches: { n: 1 } });
});

it('settles the original held manifest peer before propagating an undefined file-stat failure', async () => {
  const h = await fixture();
  const originalStat = fs.stat.bind(fs),
    originalRealpath = fs.realpath.bind(fs);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const manifest = join(h.dir, '.dork', 'app.json');
  const statSpy = vi
    .spyOn(fs, 'stat')
    .mockImplementation((...args) =>
      String(args[0]) === h.path ? Promise.reject(undefined) : originalStat(...args)
    );
  const pathSpy = vi.spyOn(fs, 'realpath').mockImplementation(async (...args) => {
    if (String(args[0]) === manifest) {
      entered();
      await held;
    }
    return originalRealpath(...args);
  });
  let settled = false;
  const observation = observeCheckboxSource(
    () =>
      readDocSourceDescriptor(
        { db: h.db, documents: h.rooms.canvasDocuments, roomRepos: h.roomRepos },
        h.documentId
      ),
    () => undefined
  ).then(
    () => {
      settled = true;
      throw new Error('Unexpected observation success');
    },
    (cause) => {
      settled = true;
      return { cause };
    }
  );
  try {
    await started;
    expect(settled).toBe(false);
    release();
    expect(await observation).toEqual({ cause: undefined });
  } finally {
    release();
    await Promise.allSettled([observation]);
    statSpy.mockRestore();
    pathSpy.mockRestore();
  }
});
it('preserves original non-file refusal before a settled manifest failure', async () => {
  const h = await fixture();
  const originalStat = fs.stat.bind(fs),
    originalRealpath = fs.realpath.bind(fs);
  const manifestFailure = new Error('Original manifest failure');
  const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
    const info = await originalStat(...args);
    if (String(args[0]) === h.path) info.isFile = () => false;
    return info;
  });
  const pathSpy = vi
    .spyOn(fs, 'realpath')
    .mockImplementation((...args) =>
      String(args[0]) === join(h.dir, '.dork', 'app.json')
        ? Promise.reject(manifestFailure)
        : originalRealpath(...args)
    );
  try {
    await expect(
      observeCheckboxSource(
        () =>
          readDocSourceDescriptor(
            { db: h.db, documents: h.rooms.canvasDocuments, roomRepos: h.roomRepos },
            h.documentId
          ),
        () => undefined
      )
    ).rejects.toThrow('WRITE_SOURCE_UNAVAILABLE');
  } finally {
    statSpy.mockRestore();
    pathSpy.mockRestore();
  }
});
