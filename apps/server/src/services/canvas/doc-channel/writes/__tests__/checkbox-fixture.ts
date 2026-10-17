import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, realpath, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canvasDocGrants, canvasDocWriteIntents, eq, createDb } from '@dorkos/db';
import { batchFixture } from '../../__tests__/batch-fixtures.js';
import { CanonicalFileWriteCoordinator } from '../canonical-writer.js';
import {
  DocCheckboxWriteService,
  type CheckboxAuthorityPorts,
  type CheckboxCompletionPorts,
  type CheckboxServiceOptions,
  type VerifiedCheckboxAuthority,
} from '../checkbox-service.js';
import { rawByteHash } from '../checkbox-bytes.js';

export class AuthorityRefused extends Error {}
export async function fixture(
  options: CheckboxServiceOptions = {},
  existing?: { dir: string; documentId: string; grantId: string }
) {
  const dir = existing?.dir ?? (await realpath(await mkdtemp(join(tmpdir(), 'checkbox-service-'))));
  const path = join(dir, 'tasks.md');
  if (!existing) await writeFile(path, '\ufeff- [ ] café😀\r\n- [ ] repeated\r\n');
  const file = join(dir, 'db.sqlite');
  const h = existing
    ? batchFixture(file, null, {
        db: createDb(file),
        documentId: existing.documentId,
        grantId: existing.grantId,
      })
    : batchFixture(file);
  const approved: VerifiedCheckboxAuthority = {
    documentId: h.documentId,
    binding: {
      operation: 'checkbox-toggle',
      sourceIdentity: 'source-1',
      resolvedCwd: dir,
      treeKind: 'agent-cwd',
      canonicalPath: path,
    },
    grantId: h.grantId,
    grantRevision: 1,
    documentGeneration: h.documentId,
    routeId: 'route',
    routeHash: 'a'.repeat(64),
  };
  h.db
    .update(canvasDocGrants)
    .set({ writeOperation: approved.binding })
    .where(eq(canvasDocGrants.grantId, h.grantId))
    .run();
  let valid = true,
    locked = false,
    failCompletion = false;
  const check = () => {
    const grant = h.db
      .select()
      .from(canvasDocGrants)
      .where(eq(canvasDocGrants.grantId, h.grantId))
      .get();
    const channel = h.store.getChannel(h.documentId);
    if (
      !valid ||
      locked ||
      !grant ||
      grant.revokedAt ||
      channel?.closedAt !== null ||
      JSON.stringify(grant.writeOperation) !== JSON.stringify(approved.binding)
    )
      throw new AuthorityRefused('Actual fixture authority refused.');
    return structuredClone(approved);
  };
  // Explicit fixture authority checks real ledger rows. These are not the held production grant/host ports.
  const authority: CheckboxAuthorityPorts = {
    isAuthorityRefusal: (error) => error instanceof AuthorityRefused,
    preflight: async () => {
      check();
    },
    requireAccess: () => {
      if (!h.store.getChannel(h.documentId)) throw new AuthorityRefused();
      return undefined;
    },
    prepare: async () => check(),
    requireCurrent: () => check(),
    prepareRecovery: async () => check(),
    requireRecoveryCurrent: () => check(),
  };
  const notices: string[] = [];
  const completion: CheckboxCompletionPorts = {
    completeVerified: (intent, tx) => {
      const receipt = h.store.appendEvent(
        {
          documentId: intent.documentId,
          eventId: intent.eventId,
          direction: 'system',
          type: 'md.task.toggled',
          payload: intent.input,
          envelopeHash: intent.envelopeHash,
          envelopeBytes: Buffer.byteLength(JSON.stringify(intent.input)),
          receivedAt: intent.updatedAt,
          provenance: { transport: 'host', trust: 'verified-checkbox' },
        },
        tx
      );
      h.store.insertBatch(
        {
          batchId: randomUUID(),
          documentId: intent.documentId,
          scope: h.store.getChannel(intent.documentId, tx)!.scope,
          routeId: approved.routeId!,
          grantId: intent.grantId,
          grantRevision: approved.grantRevision,
          generation: randomUUID(),
          inputEventIds: [intent.eventId],
          effectivePayload: { eventIds: [intent.eventId] },
          dueAt: intent.updatedAt,
          status: 'pending',
          createdAt: intent.updatedAt,
          updatedAt: intent.updatedAt,
        },
        tx
      );
      if (failCompletion) throw new Error('Injected completion rollback');
      return { id: receipt.eventId, status: 'recorded' as const, docSeq: receipt.docSeq };
    },
    notifyCommitted: (id) => {
      if (h.db.$client.inTransaction) throw new Error('Hint inside SQL');
      notices.push(id);
      return undefined;
    },
  };
  const coordinator = new CanonicalFileWriteCoordinator({
    assertOutsideTransaction: () => {
      if (h.db.$client.inTransaction) throw new Error('FS inside SQL');
    },
    resolve: async (path) => {
      const canonicalPath = await realpath(path),
        info = await stat(canonicalPath, { bigint: true });
      return { canonicalPath, device: String(info.dev), inode: String(info.ino) };
    },
  });
  const service = new DocCheckboxWriteService(
    h.db,
    h.store,
    coordinator,
    authority,
    completion,
    options
  );
  const cleanup = async () => {
    await service.stop();
    if (h.db.$client.open) h.db.$client.close();
    await rm(dir, { recursive: true, force: true });
  };
  const request = async (done = true, eventId = randomUUID()) => {
    const bytes = await readFile(path);
    return {
      documentId: h.documentId,
      eventId,
      line: 1,
      textHash: rawByteHash(bytes.subarray(0, bytes.indexOf(13))),
      expectedFileVersion: rawByteHash(bytes),
      done,
    };
  };
  const row = () => h.db.select().from(canvasDocWriteIntents).get()!;
  const counts = () => ({
    events: h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_events').get(),
    batches: h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_batches').get(),
  });
  return {
    ...h,
    cleanup,
    path,
    dir,
    file,
    service,
    request,
    row,
    counts,
    authority,
    approved,
    completion,
    coordinator,
    notices,
    revoke: () => {
      valid = false;
      h.db
        .update(canvasDocGrants)
        .set({ revokedAt: new Date().toISOString() })
        .where(eq(canvasDocGrants.grantId, h.grantId))
        .run();
    },
    lock: () => {
      locked = true;
    },
    failCompletion: (value: boolean) => {
      failCompletion = value;
    },
  };
}
