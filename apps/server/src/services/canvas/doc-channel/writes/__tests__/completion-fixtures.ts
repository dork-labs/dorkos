/** Real original approval and physical evidence; common-ingest activation is intentionally absent. */
import fs from 'node:fs/promises';
import {
  CanvasChannelDeclarationSchema,
  CanvasChannelCheckboxRequestSchema,
} from '@dorkos/shared/canvas-channel-schemas';
import { authorityFixture } from './authority-fixtures.js';
import { observedCheckboxIntent } from '../checkbox-evidence.js';
import { prepareCheckboxBytes, rawByteHash } from '../checkbox-bytes.js';
import type { DbTransaction } from '@dorkos/db';
import type { DocWriteIntentRow } from '../../store.js';
import type { OriginalCheckboxCompletionAccess } from '../completion.js';
import type { SynchronousResult } from '../../store-transaction.js';
import { createCheckboxReservationBridge } from '../reservation-bridge.js';
import { DOC_INGEST_LIMITS } from '../../accounting.js';

/** Seed a parser-proven prepared intent against a genuine consumed log-route write approval. */
export async function completionFixture(agentRoute = false) {
  const h = await authorityFixture(
    false,
    false,
    agentRoute,
    agentRoute ? 'md.*' : 'md.task.toggled'
  );
  const before = await fs.readFile(h.path);
  h.input.expectedFileVersion = rawByteHash(before);
  h.input.textHash = rawByteHash(before.subarray(0, before.length - 1));
  const request = CanvasChannelCheckboxRequestSchema.parse(h.input);
  const approved = await h.authority.prepare(request, h.actor);
  const stat = await fs.stat(h.path, { bigint: true });
  const edit = prepareCheckboxBytes(before, request);
  const prepared = observedCheckboxIntent(
    request,
    approved,
    rawByteHash(Buffer.from(JSON.stringify(request))),
    new Date().toISOString(),
    rawByteHash(before),
    { device: String(stat.dev), inode: String(stat.ino) },
    edit
  ).intent as DocWriteIntentRow;
  const currentAccess = async (
    intent: DocWriteIntentRow
  ): Promise<OriginalCheckboxCompletionAccess> => {
    const snapshot = await h.authority.refreshRecoveryCurrent(intent, approved);
    return {
      requireOriginalCompletionAccess(row, tx) {
        h.authority.requireRecoveryCurrent(row, approved, snapshot, tx);
        const channel = h.http.channels.getChannel(row.documentId, tx)!;
        return {
          documentId: row.documentId,
          scope: channel.scope,
          documentLabel: 'Tasks',
          provenance: null,
          routes: [
            {
              route: CanvasChannelDeclarationSchema.parse(channel.declaration).routes[0]!,
              grantId: approved.grantId,
              grantRevision: approved.grantRevision,
            },
          ],
        };
      },
    };
  };
  const replace = async () => {
    h.http.channels.transaction((tx) => h.http.channels.insertWriteIntent(prepared, tx));
    const evidence = prepared.evidence as { tempPath: string };
    await fs.writeFile(evidence.tempPath, edit.after, { flag: 'wx' });
    const replacement = await fs.stat(evidence.tempPath, { bigint: true });
    await fs.rename(evidence.tempPath, h.path);
    h.http.channels.transaction((tx) =>
      h.http.channels.transitionWriteIntent(
        prepared.intentId,
        'prepared',
        {
          status: 'replaced',
          errorCode: null,
          updatedAt: new Date().toISOString(),
          evidence: {
            ...(prepared.evidence as object),
            tempIdentity: {
              device: String(replacement.dev),
              inode: String(replacement.ino),
            },
          },
        },
        tx
      )
    );
    return h.http.channels.getWriteIntent(prepared.intentId)!;
  };
  const bridge = createCheckboxReservationBridge(h.authority, h.http.channels, DOC_INGEST_LIMITS);
  const conversion = async (row: DocWriteIntentRow) => {
    const freshSnapshot = await h.authority.refreshRecoveryCurrent(row, approved);
    const input = {
      intentId: row.intentId,
      subject: { kind: 'recovery' as const, intent: row, approved },
      freshSnapshot,
    };
    return (tx: DbTransaction) => bridge.convertOwnReservationInTransaction(input, tx);
  };
  // This test gate is an explicit caller-handle witness, not the future production ingest port.
  let active: DbTransaction | undefined;
  const transaction = <T>(work: (tx: DbTransaction) => T & SynchronousResult<T>): T =>
    h.authority.transaction<T>((tx) => {
      active = tx;
      try {
        return work(tx);
      } finally {
        active = undefined;
      }
    });
  const requireTransaction = (tx: DbTransaction): undefined => {
    if (tx !== active) throw new Error('Wrong caller transaction');
    return undefined;
  };
  return {
    ...h,
    input: request,
    prepared,
    edit,
    approved,
    currentAccess,
    conversion,
    bridge,
    replace,
    transaction,
    requireTransaction,
  };
}
