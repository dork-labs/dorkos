/** Original operator file-save protocol. No page event, route authority or write callback is accepted. */
import {
  captureDocumentSaveOperator,
  captureDocumentSaveSource,
  requireCurrentDocumentSaveSource,
  type DocumentFileSaveDependencies,
  type DocumentFileSaveCaller,
  type Capture,
} from './document-file-save-source.js';
import {
  requireOriginalDocumentFileOwner,
  type InstallationFileWrites,
} from './installation-file-writes.js';
import fs from 'node:fs/promises';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import {
  and,
  eq,
  inArray,
  sql,
  canvasDocFileSaveIntents,
  type DbTransaction,
  type canvasDocEvents,
} from '@dorkos/db';
import {
  WriteFileRequestSchema,
  FileDocumentSaveReceiptSchema,
  type WriteFileRequest,
} from '@dorkos/shared/schemas';
import { StoredPageEventSchema } from '@dorkos/shared/canvas-channel-schemas';
import { resolveWithinCwd, sha256 } from '../../../../lib/file-route-guards.js';
import { parseScope } from '../../scopes.js';
import { DocChannelNotFoundError } from '../authorization.js';
import { sameDocOwnerAuthority } from '../doc-source-policy.js';
import { envelopeIdentity } from '../envelope.js';
import { documentTransaction } from '../store-transaction.js';
import {
  DocChannelStore,
  requireDocChannelStoreDatabase,
  appendConvertedFileSaveEvent,
} from '../store.js';
import {
  CanonicalFileWriteCoordinator,
  CanonicalFileIdentityChangedError,
  type CanonicalFileIdentity,
  type CanonicalWriteLease,
} from './canonical-writer.js';
import type { CheckboxWriteFence } from './checkbox-fence.js';
import { readFileSaveIntent, type FileSaveIntentRow } from './file-save-intents.js';
import { requireDocEventUuidVacant } from './reservation-policy-census.js';
import { sameOriginalFileSaveSource } from './file-save-recovery/applied-source.js';

export type {
  DocumentFileSaveDependencies,
  DocumentFileSaveCaller,
} from './document-file-save-source.js';
type Caller = DocumentFileSaveCaller;
type EventInput = Omit<typeof canvasDocEvents.$inferInsert, 'docSeq'>;
const completions = new WeakMap<DbTransaction, { store: DocChannelStore; event: EventInput }>();

/** The genuine store consumes only the event staged by original verified completion, once. */
export function consumeOriginalFileSaveAppend(
  store: DocChannelStore,
  tx: DbTransaction
): EventInput {
  const pending = completions.get(tx);
  if (!pending || pending.store !== store) throw new Error('No original file save completion');
  completions.delete(tx);
  return pending.event;
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function matches(info: { dev: bigint; ino: bigint }, device: string, inode: string): boolean {
  return String(info.dev) === device && String(info.ino) === inode;
}
function uncertain(): never {
  throw Object.assign(new Error('The original save needs recovery.'), {
    code: 'DOC_SAVE_IN_DOUBT',
    status: 503,
  });
}

/** Constructed only by the owning installation; its coordinator and SQL instances never escape. */
export class DocumentFileSave {
  #stopped = false;
  readonly #active = new Set<Promise<unknown>>();
  readonly #deps: DocumentFileSaveDependencies;
  readonly #coordinator: CanonicalFileWriteCoordinator;
  readonly #fence: CheckboxWriteFence;
  constructor(
    owner: InstallationFileWrites,
    deps: DocumentFileSaveDependencies,
    coordinator: CanonicalFileWriteCoordinator,
    fence: CheckboxWriteFence
  ) {
    requireOriginalDocumentFileOwner(owner, deps.db, deps.channels, coordinator);
    requireDocChannelStoreDatabase(deps.channels, deps.db);
    this.#deps = Object.freeze({ ...deps });
    this.#coordinator = coordinator;
    this.#fence = fence;
  }

  /** Track the whole original request, including pre-gate authorization and final completion. */
  save(raw: unknown, caller: Caller) {
    if (this.#stopped) return Promise.reject(new Error('Document file saves are stopped'));
    const input = Object.freeze(WriteFileRequestSchema.parse(raw));
    const retainedCaller: Caller = Object.freeze({
      headers: Object.freeze({ ...caller.headers }),
      agentIdentity: caller.agentIdentity,
      user: caller.user ? Object.freeze({ ...caller.user }) : undefined,
    });
    const operation = this.#perform(input, retainedCaller);
    this.#active.add(operation);
    void operation.then(
      () => this.#active.delete(operation),
      () => this.#active.delete(operation)
    );
    return operation;
  }

  /** Stop new admission before draining already tracked continuations. */
  async stop(): Promise<void> {
    this.#stopped = true;
    await Promise.allSettled([...this.#active]);
  }

  #current(captured: Capture, tx?: DbTransaction): void {
    requireCurrentDocumentSaveSource(this.#deps, captured, tx);
  }

  async #perform(input: WriteFileRequest, caller: Caller) {
    if (!input.documentSave) throw new DocChannelNotFoundError();
    const operator = captureDocumentSaveOperator(this.#deps, caller);
    const preflight = await this.#deps.authorization.require(
      input.documentSave.documentId,
      operator.actor,
      true
    );
    if (parseScope(preflight.scope).kind !== 'session') throw new DocChannelNotFoundError();
    const { resolved } = await resolveWithinCwd(input.cwd, input.path);
    return this.#coordinator.withFiles([resolved], async ([identity], lease) => {
      const captured = await captureDocumentSaveSource(this.#deps, input, caller, identity!);
      const request = input.documentSave!;
      const expected = input.expectedHash ?? sha256(input.expectedContent!);
      const afterHash = sha256(input.content);
      const requestHash = createHash('sha256')
        .update(
          JSON.stringify([
            1,
            request.documentId,
            request.eventId,
            request.incarnation,
            identity!.canonicalPath,
            expected,
            afterHash,
          ])
        )
        .digest('hex');
      const existing = readFileSaveIntent(this.#deps.db, request.documentId, request.eventId);
      if (existing) {
        if (
          existing.requestHash !== requestHash ||
          !same(existing.incarnation, captured.incarnation) ||
          !sameOriginalFileSaveSource(this.#deps.db, existing.source, captured.source) ||
          !sameDocOwnerAuthority(existing.owner, captured.owner)
        )
          throw Object.assign(new Error('Save operation conflicts with its recorded identity.'), {
            code: 'DOC_SAVE_ID_CONFLICT',
            status: 412,
          });
        this.#fence.assertAdmission(identity!, existing.intentId);
        return this.#replay(existing, captured);
      }
      this.#fence.assertAdmission(identity!);
      const before = await this.#readOriginal(identity!);
      const beforeHash = sha256(before);
      if (beforeHash !== expected)
        return {
          status: 409 as const,
          body: {
            error: 'File changed on disk since it was opened',
            code: 'CONFLICT',
            currentHash: beforeHash,
            currentContent: before,
          },
        };
      const now = new Date().toISOString();
      const row: FileSaveIntentRow = {
        intentId: randomUUID(),
        documentId: request.documentId,
        eventId: request.eventId,
        requestHash,
        incarnation: captured.incarnation,
        source: captured.source,
        owner: captured.owner,
        canonicalPath: identity!.canonicalPath,
        beforeDevice: identity!.device,
        beforeInode: identity!.inode,
        beforeHash,
        afterHash,
        replacementDevice: null,
        replacementInode: null,
        status: beforeHash === afterHash ? 'no_op' : 'prepared',
        docSeq: null,
        createdAt: now,
        updatedAt: now,
      };
      documentTransaction(this.#deps.db, (tx) => {
        this.#current(captured, tx);
        requireDocEventUuidVacant(tx, row.documentId, row.eventId);
        const count = tx.get<{ n: number }>(
          sql`SELECT count(*) AS n FROM canvas_doc_file_save_intents WHERE status NOT IN ('committed','no_op','failed')`
        );
        if (!count || count.n >= 1024) throw new Error('Original save capacity exceeded');
        tx.insert(canvasDocFileSaveIntents).values(row).run();
      });
      if (row.status === 'no_op')
        return { status: 200 as const, body: { ok: true, hash: afterHash, effect: 'no_op' } };
      const attempt = { renameStarted: false, cleanupComplete: true };
      try {
        await this.#replace(row, captured, identity!, lease, input.content, attempt);
        return this.#complete(row, captured, false);
      } catch (error) {
        let status: 'failed' | 'in_doubt' = 'in_doubt';
        if (!attempt.renameStarted && attempt.cleanupComplete) {
          try {
            if (sha256(await this.#readOriginal(identity!)) === row.beforeHash) status = 'failed';
          } catch {
            /* Keep uncertainty. */
          }
        }
        try {
          this.#deps.db
            .update(canvasDocFileSaveIntents)
            .set({
              status,
              ...(status === 'failed' ? { replacementDevice: null, replacementInode: null } : {}),
              updatedAt: new Date().toISOString(),
            })
            .where(
              and(
                eq(canvasDocFileSaveIntents.intentId, row.intentId),
                eq(canvasDocFileSaveIntents.requestHash, row.requestHash),
                inArray(canvasDocFileSaveIntents.status, ['prepared', 'staged'])
              )
            )
            .run();
        } catch {
          /* Durable prepared/staged evidence remains. */
        }
        throw error;
      }
    });
  }

  async #readOriginal(identity: CanonicalFileIdentity): Promise<string> {
    const handle = await fs.open(identity.canonicalPath, 'r');
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || !matches(info, identity.device, identity.inode))
        throw new CanonicalFileIdentityChangedError();
      const content = await handle.readFile('utf8');
      const named = await fs.lstat(identity.canonicalPath, { bigint: true });
      if (!named.isFile() || !matches(named, identity.device, identity.inode))
        throw new CanonicalFileIdentityChangedError();
      return content;
    } finally {
      await handle.close();
    }
  }

  async #replace(
    row: FileSaveIntentRow,
    captured: Capture,
    identity: CanonicalFileIdentity,
    lease: CanonicalWriteLease,
    content: string,
    attempt: { renameStarted: boolean; cleanupComplete: boolean }
  ): Promise<void> {
    this.#current(captured);
    const temporary = `${row.canonicalPath}.${randomBytes(6).toString('hex')}.tmp`;
    const handle = await fs.open(temporary, 'wx');
    attempt.cleanupComplete = false;
    const owned = await handle.stat({ bigint: true }).catch(async (error: unknown) => {
      await handle.close();
      throw error;
    });
    let renamed = false;
    const ownedTemporary = async () => {
      const current = await fs.lstat(temporary, { bigint: true });
      return current.isFile() && current.dev === owned.dev && current.ino === owned.ino;
    };
    try {
      this.#current(captured);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      const reserved = await lease.reserveReplacement(temporary);
      if (
        reserved.canonicalPath !== temporary ||
        !matches(owned, reserved.device, reserved.inode) ||
        !(await ownedTemporary())
      )
        throw new CanonicalFileIdentityChangedError();
      documentTransaction(this.#deps.db, (tx) => {
        this.#current(captured, tx);
        const changed = tx
          .update(canvasDocFileSaveIntents)
          .set({
            status: 'staged',
            replacementDevice: String(owned.dev),
            replacementInode: String(owned.ino),
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(
              eq(canvasDocFileSaveIntents.intentId, row.intentId),
              eq(canvasDocFileSaveIntents.status, 'prepared')
            )
          )
          .run().changes;
        if (changed !== 1) throw new Error('Original save staging changed');
      });
      row.status = 'staged';
      row.replacementDevice = String(owned.dev);
      row.replacementInode = String(owned.ino);
      this.#current(captured);
      const currentPath = await resolveWithinCwd(
        captured.source.resolvedCwd!,
        captured.source.sourcePath!
      );
      const before = await fs.stat(currentPath.resolved, { bigint: true });
      if (
        currentPath.resolved !== row.canonicalPath ||
        !matches(before, identity.device, identity.inode) ||
        sha256(await fs.readFile(row.canonicalPath, 'utf8')) !== row.beforeHash
      )
        throw new CanonicalFileIdentityChangedError();
      this.#fence.assertAdmission(identity, row.intentId);
      if (!(await ownedTemporary())) throw new CanonicalFileIdentityChangedError();
      this.#current(captured);
      attempt.renameStarted = true;
      await fs.rename(temporary, row.canonicalPath);
      renamed = true;
      await this.#effect(row, captured);
    } finally {
      let closed = false;
      try {
        await handle.close();
        closed = true;
      } finally {
        if (!renamed && (await ownedTemporary().catch(() => false))) await fs.unlink(temporary);
        attempt.cleanupComplete = closed;
      }
    }
  }

  async #effect(row: FileSaveIntentRow, captured: Capture): Promise<void> {
    this.#current(captured);
    const path = await resolveWithinCwd(captured.source.resolvedCwd!, captured.source.sourcePath!);
    const handle = await fs.open(path.resolved, 'r');
    try {
      const info = await handle.stat({ bigint: true });
      if (
        path.resolved !== row.canonicalPath ||
        !info.isFile() ||
        !row.replacementDevice ||
        !row.replacementInode ||
        !matches(info, row.replacementDevice, row.replacementInode) ||
        sha256(await handle.readFile('utf8')) !== row.afterHash
      )
        uncertain();
      const named = await fs.lstat(path.resolved, { bigint: true });
      if (!named.isFile() || !matches(named, row.replacementDevice, row.replacementInode))
        uncertain();
      this.#current(captured);
    } finally {
      await handle.close();
    }
  }

  async #replay(row: FileSaveIntentRow, captured: Capture) {
    if (row.status === 'committed') return this.#complete(row, captured, true);
    if (row.status === 'no_op') {
      if (sha256(await fs.readFile(row.canonicalPath, 'utf8')) !== row.afterHash)
        throw new CanonicalFileIdentityChangedError();
      this.#current(captured);
      return { status: 200 as const, body: { ok: true, hash: row.afterHash, effect: 'no_op' } };
    }
    if (row.status === 'failed')
      throw Object.assign(new Error('The original save failed before replacement.'), {
        code: 'DOC_SAVE_FAILED',
        status: 412,
      });
    if (row.status === 'staged' || row.status === 'in_doubt') {
      await this.#effect(row, captured);
      return this.#complete(row, captured, true);
    }
    uncertain(); // Never replay a prepared/failed command or repeat its filesystem effect.
  }

  #complete(row: FileSaveIntentRow, captured: Capture, duplicate: boolean) {
    const event = StoredPageEventSchema.parse({
      v: 1,
      id: row.eventId,
      type: 'doc.saved',
      payload: { previousFileHash: row.beforeHash, fileHash: row.afterHash },
    });
    const identity = envelopeIdentity(event);
    const receipt = documentTransaction(this.#deps.db, (tx) => {
      this.#current(captured, tx);
      if (!sameOriginalFileSaveSource(tx, row.source, captured.source)) uncertain();
      const retained = readFileSaveIntent(tx, row.documentId, row.eventId);
      const immutable: Array<keyof FileSaveIntentRow> = [
        'intentId',
        'documentId',
        'eventId',
        'requestHash',
        'incarnation',
        'source',
        'owner',
        'canonicalPath',
        'beforeDevice',
        'beforeInode',
        'beforeHash',
        'afterHash',
        'replacementDevice',
        'replacementInode',
        'createdAt',
      ];
      if (!retained || immutable.some((key) => !same(retained[key], row[key]))) uncertain();
      let stored = this.#deps.channels.getEvent(row.documentId, row.eventId, tx);
      if (retained.status === 'committed') {
        if (
          !stored ||
          stored.envelopeHash !== identity.hash ||
          stored.docSeq !== retained.docSeq ||
          stored.type !== 'doc.saved' ||
          stored.direction !== 'system' ||
          (stored.payloadPrunedAt === null && !same(stored.payload, event.payload))
        )
          uncertain();
      } else {
        if (
          !['staged', 'in_doubt'].includes(retained.status) ||
          stored ||
          retained.replacementDevice !== row.replacementDevice ||
          retained.replacementInode !== row.replacementInode
        )
          uncertain();
        completions.set(tx, {
          store: this.#deps.channels,
          event: {
            documentId: row.documentId,
            eventId: row.eventId,
            direction: 'system',
            type: 'doc.saved',
            payload: event.payload,
            envelopeHash: identity.hash,
            envelopeBytes: identity.bytes,
            receivedAt: new Date().toISOString(),
            provenance: { transport: 'http', trust: 'host', operation: 'file.save' },
            coalesceKey: null,
            clientTs: null,
            payloadPrunedAt: null,
          },
        });
        try {
          stored = appendConvertedFileSaveEvent(this.#deps.channels, tx);
        } finally {
          completions.delete(tx);
        }
        const changed = tx
          .update(canvasDocFileSaveIntents)
          .set({ status: 'committed', docSeq: stored.docSeq, updatedAt: new Date().toISOString() })
          .where(
            and(
              eq(canvasDocFileSaveIntents.intentId, row.intentId),
              inArray(canvasDocFileSaveIntents.status, ['staged', 'in_doubt'])
            )
          )
          .run().changes;
        if (changed !== 1) throw new Error('Original save completion changed');
      }
      return FileDocumentSaveReceiptSchema.parse({
        documentId: row.documentId,
        eventId: row.eventId,
        incarnation: row.incarnation,
        docSeq: stored!.docSeq,
        fileHash: row.afterHash,
        status: duplicate ? 'duplicate' : 'accepted',
      });
    });
    return {
      status: 200 as const,
      body: {
        ok: true,
        hash: row.afterHash,
        effect: duplicate ? 'no_op' : 'changed',
        documentReceipt: receipt,
      },
    };
  }
}
