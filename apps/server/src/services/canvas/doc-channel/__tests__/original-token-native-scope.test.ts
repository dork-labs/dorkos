import { sessionMetadata, sql } from '@dorkos/db';
/** Genuine original FILE issuance, native filtering and actorless restart controls. SOURCE UNRUN. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  nativeRoomAuthorityFixture,
  reopenNativeRoomAuthorityFixture,
} from '../writes/__tests__/authority-fixtures.js';
import {
  currentRoomDueServicePort,
  revokeServiceOriginalDocToken,
  readServiceOriginalTokenStreamState,
  openServiceOriginalTokenStream,
  nextServiceOriginalTokenStream,
  closedServiceOriginalTokenStream,
  closeServiceOriginalTokenStream,
  issueServiceOriginalDocToken,
  restoreServiceOriginalTokenScope,
  replayServiceOriginalTokenScope,
  readServiceOriginalTokenEvent,
  submitServiceOriginalTokenIngress,
  submitCurrentDocEvent,
} from '../service.js';
import { stopInstallationFileWrites } from '../writes/installation-file-writes.js';
import {
  DocChannelTokenStore,
  readOriginalNativeDocTokenHeaderByHash,
} from '../tokens/token-store.js';
type Fixture = Awaited<ReturnType<typeof nativeRoomAuthorityFixture>>;
type Fresh = Awaited<ReturnType<typeof reopenNativeRoomAuthorityFixture>>;
async function withNativeToken(
  run: (
    h: Fixture,
    hash: string,
    generation: string,
    reopen: () => Promise<Fresh>
  ) => Promise<void>,
  permissions: ('ingest' | 'replay' | 'stream')[] = ['replay', 'stream']
) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-token-scope-agent-')));
  let h: Fixture | undefined,
    fresh: Fresh | undefined,
    failed = false,
    first: unknown,
    closed = true;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  try {
    h = await nativeRoomAuthorityFixture(
      root,
      'codex',
      'native-token-scope-session',
      'native-token-scope-agent',
      { checkboxFile: true }
    );
    const token = await issueServiceOriginalDocToken(
      h.http.service,
      h.operator,
      {
        documentId: h.documentId,
        allowedTypes: ['md.comment'],
        directions: ['upstream'],
        permissions,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
      [h.granted.grant.grantId]
    );
    const hash = createHash('sha256').update(token.token).digest('hex');
    const header = readOriginalNativeDocTokenHeaderByHash(
      new DocChannelTokenStore(h.db),
      h.db,
      hash
    )!;
    const original = h;
    await run(h, hash, header.generation, async () => {
      let drainFailed = false,
        drainCause: unknown;
      const record = (cause: unknown) => {
        if (!drainFailed) {
          drainFailed = true;
          drainCause = cause;
        }
      };
      await Promise.allSettled([
        Promise.resolve()
          .then(() =>
            stopInstallationFileWrites(
              original.http.fileWrites,
              original.db,
              original.http.channels
            )
          )
          .catch(record),
        Promise.resolve()
          .then(() => currentRoomDueServicePort(original.http.service).stopPump())
          .catch(record),
      ]);
      if (drainFailed) {
        closed = false;
        throw drainCause;
      }
      try {
        original.db.$client.close();
      } catch (cause) {
        closed = false;
        throw cause;
      }
      fresh = await reopenNativeRoomAuthorityFixture(original);
      return fresh;
    });
  } catch (cause) {
    if (!h) closed = false;
    remember(cause);
  } finally {
    if (fresh)
      try {
        await fresh.cleanup();
      } catch (cause) {
        closed = false;
        remember(cause);
      }
    if (closed && h)
      try {
        await h.cleanup();
      } catch (cause) {
        closed = false;
        remember(cause);
      }
    if (closed)
      try {
        await fs.rm(root, { recursive: true, force: true });
      } catch (cause) {
        remember(cause);
      }
  }
  if (failed) throw first;
}
async function accept(h: Fixture, generation: string, type: string) {
  return submitCurrentDocEvent(
    h.http.service,
    h.documentId,
    { v: 1, id: randomUUID(), type, payload: { message: type } },
    h.operator,
    { expectedGeneration: generation }
  );
}
describe('original native persistent document token scopes', () => {
  it('issues again after original FILE grant preparation closes without rebinding its approved source', async () => {
    await withNativeToken(async (h) => {
      const grantId = h.granted.grant.grantId;
      const original = h.http.channels.getGrant(grantId)!;
      expect(original.writeOperation).toMatchObject({
        operation: 'checkbox-toggle',
        canonicalPath: await fs.realpath(h.checkboxPath!),
      });
      const issued = await issueServiceOriginalDocToken(
        h.http.service,
        h.operator,
        {
          documentId: h.documentId,
          allowedTypes: ['md.comment'],
          directions: ['upstream'],
          permissions: ['replay'],
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
        [grantId]
      );
      const hash = createHash('sha256').update(issued.token).digest('hex');
      expect(restoreServiceOriginalTokenScope(h.http.service, hash)).toBeDefined();
      expect(h.http.channels.getGrant(grantId)).toEqual(original);
    });
  });
  it('refuses public lifecycle movement and forged applied-chain DATA without original canonical custody', async () => {
    await withNativeToken(async (h) => {
      const from = h.originalTarget.canonicalSessionId,
        to = randomUUID();
      const document = h.rooms.canvas.open(
        'session:' + from,
        h.authorId,
        { type: 'markdown', content: '- [ ] actual original task\n', sourcePath: h.checkboxPath! },
        {
          tree: {
            resolvedCwd: h.originalTarget.agentPath,
            treeKind: 'agent-cwd',
            sourceLabel: null,
            aheadOfMain: null,
          },
        }
      );
      h.http.grants.configure(
        document.id,
        { routes: [{ id: 'original-token-log', on: 'md.*', to: 'log', turn: { mode: 'none' } }] },
        h.operator,
        h.originalTarget.agentId
      );
      const request = {
        documentId: document.id,
        routeId: 'original-token-log',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
      let granted = await h.http.grantCheckboxRoute(request, h.operator);
      if (granted.kind === 'approval_required') {
        h.approvals.grant(granted.ticket.approvalId);
        granted = await h.http.grantCheckboxRoute(request, h.operator, granted.ticket.token);
      }
      if (granted.kind !== 'granted') throw new Error('Actual original FILE log grant unavailable');
      const issued = await issueServiceOriginalDocToken(
        h.http.service,
        h.operator,
        {
          documentId: document.id,
          allowedTypes: ['md.comment'],
          directions: ['upstream'],
          permissions: ['ingest', 'replay'],
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
        [granted.grant.grantId]
      );
      const hash = createHash('sha256').update(issued.token).digest('hex'),
        store = new DocChannelTokenStore(h.db);
      const before = readOriginalNativeDocTokenHeaderByHash(store, h.db, hash)!;
      const scope = await restoreServiceOriginalTokenScope(h.http.service, hash);
      // Actual native destination facts, using the same fixture's genuine active agent/path/runtime.
      // This controls document lifecycle movement, not an SDK canonical init or a fabricated principal.
      h.db
        .insert(sessionMetadata)
        .values({
          sessionId: to,
          agentPath: h.originalTarget.agentPath,
          runtime: h.originalTarget.runtime,
          createdAt: new Date().toISOString(),
        })
        .run();
      expect(h.rooms.canvasDocuments.rekeyScope('session:' + from, 'session:' + to)).toBe(1);
      await expect(replayServiceOriginalTokenScope(h.http.service, scope)).rejects.toThrow();
      await expect(
        submitServiceOriginalTokenIngress(h.http.service, scope, {
          v: 1,
          id: randomUUID(),
          type: 'md.comment',
          payload: { text: 'unproved destination' },
        })
      ).rejects.toThrow();
      const after = readOriginalNativeDocTokenHeaderByHash(store, h.db, hash)!;
      expect(after.scope).toBe(before.scope);
      expect(after.issuerJson).toBe(before.issuerJson);
      expect(after.tokenId).toBe(before.tokenId);
      expect(after.generation).toBe(before.generation);
      // A raw applied row is insufficient: corrupt its exact source evidence and the old scope refuses.
      const intent = h.db.$client
        .prepare('SELECT intent_id,evidence FROM canvas_doc_identity_intents WHERE document_id=?')
        .get(document.id) as { intent_id: string; evidence: string };
      h.db.$client
        .prepare('UPDATE canvas_doc_identity_intents SET evidence=? WHERE intent_id=?')
        .run(JSON.stringify({ sourceKey: 'foreign-source' }), intent.intent_id);
      await expect(replayServiceOriginalTokenScope(h.http.service, scope)).rejects.toThrow();
      h.db.$client
        .prepare('UPDATE canvas_doc_identity_intents SET evidence=?,status=? WHERE intent_id=?')
        .run(intent.evidence, 'pending', intent.intent_id);
      await expect(replayServiceOriginalTokenScope(h.http.service, scope)).rejects.toThrow();
      h.db.$client
        .prepare('UPDATE canvas_doc_identity_intents SET status=? WHERE intent_id=?')
        .run('applied', intent.intent_id);
      // Even restored plausible applied evidence cannot certify that the arbitrary destination was canonical.
      await expect(replayServiceOriginalTokenScope(h.http.service, scope)).rejects.toThrow();
      const forgedTo = randomUUID();
      h.db
        .insert(sessionMetadata)
        .values({
          sessionId: forgedTo,
          agentPath: h.originalTarget.agentPath,
          runtime: h.originalTarget.runtime,
          createdAt: new Date().toISOString(),
        })
        .run();
      // Pure native DATA tamper: valid-looking destination facts +applied intent and matching scope rows.
      // None of these operations invokes the original canonical native owner.
      h.db.$client
        .prepare('UPDATE canvas_documents SET scope=? WHERE id=?')
        .run('session:' + forgedTo, document.id);
      h.db.$client
        .prepare('UPDATE canvas_doc_channels SET scope=? WHERE document_id=?')
        .run('session:' + forgedTo, document.id);
      h.db.$client
        .prepare('UPDATE canvas_doc_identity_intents SET to_scope=? WHERE intent_id=?')
        .run('session:' + forgedTo, intent.intent_id);
      await expect(restoreServiceOriginalTokenScope(h.http.service, hash)).rejects.toThrow();
      await expect(replayServiceOriginalTokenScope(h.http.service, scope)).rejects.toThrow();
      expect(readOriginalNativeDocTokenHeaderByHash(store, h.db, hash)!.issuerJson).toBe(
        before.issuerJson
      );
    });
  });

  it('returns fresh original delivery DATA after actual postcommit listener mutation', async () => {
    await withNativeToken(
      async (h, hash) => {
        const scope = await restoreServiceOriginalTokenScope(h.http.service, hash);
        const id = randomUUID();
        let observed = false;
        const unsubscribe = h.http.service.onCommittedInput(() => {
          const changed = h.db.$client
            .prepare(
              `UPDATE canvas_doc_deliveries SET reason=?
          WHERE document_id=? AND event_id=?`
            )
            .run('actual postcommit listener DATA', h.documentId, id);
          observed = changed.changes === 1;
        });
        try {
          const result = await submitServiceOriginalTokenIngress(h.http.service, scope, {
            v: 1,
            id,
            type: 'md.comment',
            payload: { text: 'original listener boundary' },
          });
          expect(observed).toBe(true);
          expect(result.receipt.id).toBe(id);
          expect(result.deliveries).toHaveLength(1);
          expect(result.deliveries[0]!.reason).toBe('actual postcommit listener DATA');
        } finally {
          unsubscribe();
        }
      },
      ['ingest']
    );
  });

  it('accepts genuine actorless input once and retains distinct native token producer source', async () => {
    await withNativeToken(
      async (h, hash) => {
        const originalGrant = h.http.channels.getGrant(h.granted.grant.grantId)!;
        expect(originalGrant.writeOperation).toMatchObject({
          canonicalPath: await fs.realpath(h.checkboxPath!),
        });
        const scope = await restoreServiceOriginalTokenScope(h.http.service, hash);
        const input = {
          v: 1 as const,
          id: randomUUID(),
          type: 'md.comment',
          payload: { text: 'actual actorless input' },
        };
        const accepted = await submitServiceOriginalTokenIngress(h.http.service, scope, input);
        expect(accepted.receipt.status).toBe('recorded');
        expect(accepted.receipt.id).toBe(input.id);
        const duplicate = await submitServiceOriginalTokenIngress(h.http.service, scope, input);
        expect(duplicate.receipt).toEqual({ ...accepted.receipt, status: 'duplicate' });
        expect(duplicate.deliveries).toEqual(accepted.deliveries);
        expect(h.http.channels.getGrant(originalGrant.grantId)).toEqual(originalGrant);
        const pending = h.db.get<{
          status: string;
          dueAt: string;
        }>(sql`SELECT status,due_at AS dueAt
          FROM canvas_doc_batches WHERE document_id=${h.documentId}`)!;
        expect(pending.status).toBe('pending');
        const remaining = Date.parse(pending.dueAt) - Date.now();
        if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
        currentRoomDueServicePort(h.http.service).wake();
        const rows = h.db.$client
          .prepare(
            `SELECT room_source_json FROM canvas_doc_batches
        WHERE document_id=? AND room_source_json IS NOT NULL`
          )
          .all(h.documentId) as { room_source_json: string }[];
        expect(rows).toHaveLength(1);
        const source = JSON.parse(rows[0]!.room_source_json);
        expect(source.producerOrigin).toBe('doc_token');
        expect(source.producerBindingId).toBeNull();
        expect(source.producer.kind).toBe('doc_token');
        expect(source.producer.tokenHash).toBe(hash);
        expect(
          source.inputs.map((entry: { original: { eventId: string } }) => entry.original.eventId)
        ).toEqual([input.id]);
        expect(
          (await replayServiceOriginalTokenScope(h.http.service, scope)).rows.map(
            (row) => row.event_id
          )
        ).toEqual([input.id]);
      },
      ['ingest', 'replay']
    );
  });
  it('refuses read-only, forged, non-granted and reserved input without recording native events', async () => {
    await withNativeToken(async (h, hash) => {
      const scope = await restoreServiceOriginalTokenScope(h.http.service, hash);
      const input = {
        v: 1 as const,
        id: randomUUID(),
        type: 'md.comment',
        payload: { text: 'read-only refusal' },
      };
      await expect(
        submitServiceOriginalTokenIngress(h.http.service, scope, input)
      ).rejects.toThrow();
      expect((await replayServiceOriginalTokenScope(h.http.service, scope)).rows).toEqual([]);
    });
    await withNativeToken(
      async (h, hash) => {
        const baseline = h.db.$client
          .prepare('SELECT event_id FROM canvas_doc_events WHERE document_id=? ORDER BY doc_seq')
          .all(h.documentId);
        const scope = await restoreServiceOriginalTokenScope(h.http.service, hash);
        await expect(
          submitServiceOriginalTokenIngress(
            h.http.service,
            { ...scope },
            { v: 1, id: randomUUID(), type: 'md.comment', payload: { text: 'forged' } }
          )
        ).rejects.toThrow();
        for (const type of [
          'md.changed',
          'md.task.toggled',
          'app.ack',
          'state.changed',
          'event.status',
        ])
          await expect(
            submitServiceOriginalTokenIngress(h.http.service, scope, {
              v: 1,
              id: randomUUID(),
              type,
              payload: { text: type },
            })
          ).rejects.toThrow();
        expect((await replayServiceOriginalTokenScope(h.http.service, scope)).rows).toEqual([]);
        const rows = h.db.$client
          .prepare('SELECT event_id FROM canvas_doc_events WHERE document_id=? ORDER BY doc_seq')
          .all(h.documentId);
        expect(rows).toEqual(baseline);
      },
      ['ingest', 'replay']
    );
  });

  it('filters genuine accepted event types and single stream/receipt reads through native scope', async () => {
    await withNativeToken(async (h, hash, generation) => {
      const excluded = await accept(h, generation, 'md.changed');
      const allowed = await accept(h, generation, 'md.comment');
      const scope = await restoreServiceOriginalTokenScope(h.http.service, hash);
      const page = await replayServiceOriginalTokenScope(h.http.service, scope);
      expect(page.rows.map((row) => row.event_id)).toEqual([allowed.receipt.id]);
      expect(
        await readServiceOriginalTokenEvent(h.http.service, scope, excluded.receipt.id, 'replay')
      ).toBeUndefined();
      expect(
        await readServiceOriginalTokenEvent(h.http.service, scope, excluded.receipt.id, 'stream')
      ).toBeUndefined();
      expect(
        (await readServiceOriginalTokenEvent(h.http.service, scope, allowed.receipt.id, 'stream'))
          ?.event_id
      ).toBe(allowed.receipt.id);
      await expect(replayServiceOriginalTokenScope(h.http.service, { ...scope })).rejects.toThrow();
    });
  });
  it('restores through a fresh original same-FILE service without restoring an actor or old scope', async () => {
    await withNativeToken(async (h, hash, generation, reopen) => {
      const accepted = await accept(h, generation, 'md.comment');
      const old = await restoreServiceOriginalTokenScope(h.http.service, hash);
      const fresh = await reopen();
      await expect(replayServiceOriginalTokenScope(fresh.http.service, old)).rejects.toThrow();
      const scope = await restoreServiceOriginalTokenScope(fresh.http.service, hash);
      expect(
        (await replayServiceOriginalTokenScope(fresh.http.service, scope)).rows.map(
          (row) => row.event_id
        )
      ).toEqual([accepted.receipt.id]);
    });
  });
  it('refuses a retained scope after actual native revoke for replay and each stream frame', async () => {
    await withNativeToken(async (h, hash, generation) => {
      const accepted = await accept(h, generation, 'md.comment');
      const scope = await restoreServiceOriginalTokenScope(h.http.service, hash);
      h.db.$client
        .prepare('UPDATE canvas_doc_channel_tokens SET revoked_at=? WHERE token_hash=?')
        .run(new Date().toISOString(), hash);
      await expect(replayServiceOriginalTokenScope(h.http.service, scope)).rejects.toThrow();
      await expect(
        readServiceOriginalTokenEvent(h.http.service, scope, accepted.receipt.id, 'stream')
      ).rejects.toThrow();
    });
  });
  it('revokes through genuine original operator/current source CAS, preserving the token row and memo data', async () => {
    await withNativeToken(async (h, hash) => {
      const scope = await restoreServiceOriginalTokenScope(h.http.service, hash);
      const store = new DocChannelTokenStore(h.db);
      const before = readOriginalNativeDocTokenHeaderByHash(store, h.db, hash)!;
      const result = await revokeServiceOriginalDocToken(
        h.http.service,
        h.operator,
        h.documentId,
        before.tokenId
      );
      expect(result.tokenId).toBe(before.tokenId);
      expect(typeof result.revokedAt).toBe('string');
      const after = readOriginalNativeDocTokenHeaderByHash(store, h.db, hash)!;
      expect(after.tokenHash).toBe(before.tokenHash);
      expect(after.revokedAt).toBe(result.revokedAt);
      expect(after.createdAt).toBe(before.createdAt);
      expect(after.expiresAt).toBe(before.expiresAt);
      await expect(replayServiceOriginalTokenScope(h.http.service, scope)).rejects.toThrow();
      expect(
        await revokeServiceOriginalDocToken(
          h.http.service,
          h.operator,
          h.documentId,
          before.tokenId
        )
      ).toEqual(result);
    });
  });
  it('refuses forged operator proof and foreign document revocation without touching the genuine row', async () => {
    await withNativeToken(async (h, hash) => {
      const store = new DocChannelTokenStore(h.db),
        before = readOriginalNativeDocTokenHeaderByHash(store, h.db, hash)!;
      const forged = { ...h.operator, principal: { ...h.operator.principal } };
      await expect(
        revokeServiceOriginalDocToken(h.http.service, forged, h.documentId, before.tokenId)
      ).rejects.toThrow();
      await expect(
        revokeServiceOriginalDocToken(
          h.http.service,
          h.operator,
          'foreign-document',
          before.tokenId
        )
      ).rejects.toThrow();
      expect(readOriginalNativeDocTokenHeaderByHash(store, h.db, hash)!.revokedAt).toBeNull();
      expect(
        (
          await replayServiceOriginalTokenScope(
            h.http.service,
            await restoreServiceOriginalTokenScope(h.http.service, hash)
          )
        ).documentId
      ).toBe(h.documentId);
    });
  });
  it('refuses actual native owner membership removal', async () => {
    await withNativeToken(async (h, hash) => {
      const scope = await restoreServiceOriginalTokenScope(h.http.service, hash);
      const owner = h.operator.principal.claims.owner;
      const key = owner.kind === 'user' ? 'user:' + owner.userId : 'local';
      const removed = h.db.$client
        .prepare(
          `DELETE FROM room_members WHERE room_id=? AND author_id IN
        (SELECT id FROM authors WHERE kind='human' AND natural_key=?)`
        )
        .run(h.roomId, key);
      expect(removed.changes).toBe(1);
      await expect(replayServiceOriginalTokenScope(h.http.service, scope)).rejects.toThrow();
    });
  });
  it('refuses actual selected grant revocation', async () => {
    await withNativeToken(async (h, hash) => {
      const scope = await restoreServiceOriginalTokenScope(h.http.service, hash);
      h.db.$client
        .prepare('UPDATE canvas_doc_grants SET revoked_at=? WHERE grant_id=?')
        .run(new Date().toISOString(), h.granted.grant.grantId);
      await expect(replayServiceOriginalTokenScope(h.http.service, scope)).rejects.toThrow();
    });
  });
  it('refuses a real source symlink retarget within the same authorized root', async () => {
    await withNativeToken(async (h, hash) => {
      const scope = await restoreServiceOriginalTokenScope(h.http.service, hash);
      const original = h.checkboxPath!;
      const held = original + '.held',
        other = original + '.other';
      await fs.rename(original, held);
      await fs.writeFile(other, 'other genuine file');
      await fs.symlink(other, original);
      await expect(replayServiceOriginalTokenScope(h.http.service, scope)).rejects.toThrow();
    });
  });
  it.skipIf(process.platform === 'win32')(
    'refuses a real FIFO replacement without blocking native scope admission',
    async () => {
      await withNativeToken(async (h, hash) => {
        const scope = await restoreServiceOriginalTokenScope(h.http.service, hash);
        const original = h.checkboxPath!,
          held = original + '.fifo-held';
        await fs.rename(original, held);
        // Actual named FIFO with no writer; the old blocking O_RDONLY acquisition never returns.
        execFileSync('mkfifo', [original]);
        try {
          await expect(replayServiceOriginalTokenScope(h.http.service, scope)).rejects.toThrow();
        } finally {
          await fs.unlink(original);
          await fs.rename(held, original);
        }
        expect((await replayServiceOriginalTokenScope(h.http.service, scope)).documentId).toBe(
          h.documentId
        );
      });
    }
  );

  it('owns stream polling and closes its original stage on actual native revoke', async () => {
    await withNativeToken(async (h, hash, generation) => {
      const accepted = await accept(h, generation, 'md.comment');
      const scope = await restoreServiceOriginalTokenScope(h.http.service, hash);
      const stream = await openServiceOriginalTokenStream(h.http.service, scope);
      expect(
        (await nextServiceOriginalTokenStream(h.http.service, stream))?.rows.map(
          (row) => row.event_id
        )
      ).toEqual([accepted.receipt.id]);
      h.db.$client
        .prepare('UPDATE canvas_doc_channel_tokens SET revoked_at=? WHERE token_hash=?')
        .run(new Date().toISOString(), hash);
      await expect(nextServiceOriginalTokenStream(h.http.service, stream)).rejects.toThrow();
      await closedServiceOriginalTokenStream(h.http.service, stream);
      closeServiceOriginalTokenStream(h.http.service, stream);
    });
  });
  it('cancels the actual original idle stream timer before owning installation drain closes native Db', async () => {
    await withNativeToken(async (h, hash) => {
      const scope = await restoreServiceOriginalTokenScope(h.http.service, hash);
      const stream = await openServiceOriginalTokenStream(h.http.service, scope);
      const pending = nextServiceOriginalTokenStream(h.http.service, stream);
      await expect
        .poll(() => readServiceOriginalTokenStreamState(h.http.service, stream).waiting)
        .toBe(true);
      await currentRoomDueServicePort(h.http.service).stopPump();
      await closedServiceOriginalTokenStream(h.http.service, stream);
      // An admitted in-flight read may settle with closed or refuse retirement; neither owns a later timer/Db read.
      expect(await pending).toBeUndefined();
      expect(readServiceOriginalTokenStreamState(h.http.service, stream)).toEqual({
        waiting: false,
        closed: true,
      });
      expect(h.db.$client.open).toBe(true);
      await expect(openServiceOriginalTokenStream(h.http.service, scope)).rejects.toThrow();
    });
  });
});
