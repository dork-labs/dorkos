/** Real physical source, migrated FILE SQLite and original consumed operator approval. */
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { canvasDocGrants, canvasDocWriteIntents, eq, sql } from '@dorkos/db';
import { CanonicalFileWriteCoordinator } from '../canonical-writer.js';
import { DocCheckboxWriteService, type CheckboxServiceOptions } from '../checkbox-service.js';
import { authorityFixture } from './authority-fixtures.js';
import { DOC_INGEST_LIMITS } from '../../current/accounting.js';
import { rawByteHash } from '../checkbox-bytes.js';
import { DocCheckboxAuthority } from '../authority.js';
import { DocChannelGrants } from '../../grants.js';
import { readDocSourceDescriptor } from '../../http-composition.js';
import { observeCheckboxSource } from '../authority-snapshot.js';
import { CheckboxAuthorityRefusal } from '../authority-snapshot.js';
export { CheckboxAuthorityRefusal as AuthorityRefused } from '../authority-snapshot.js';

export async function fixture(
  options: CheckboxServiceOptions = {},
  existing?: { dir: string; documentId: string; grantId: string }
) {
  const h = await authorityFixture(false, false, true, 'md.*', {
    content: '\ufeff- [ ] café😀\r\n- [ ] repeated\r\n',
    ...(existing ? { existing } : {}),
  });
  const store = h.http.channels,
    documentId = h.input.documentId,
    grantId = h.granted.grant.grantId;
  const notices: string[] = [];
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
  const delivery = {
    policyLimits: DOC_INGEST_LIMITS,
    notifyCommitted: (id: string) => {
      if (h.db.$client.inTransaction) throw new Error('Hint inside SQL');
      notices.push(id);
      return undefined;
    },
  };
  const service = new DocCheckboxWriteService(
    h.db,
    store,
    coordinator,
    h.authority,
    delivery,
    options
  );
  const request = async (done = true, eventId = randomUUID()) => {
    const bytes = await readFile(h.path);
    const end = bytes.indexOf(13);
    return {
      documentId,
      eventId,
      line: 1,
      textHash: rawByteHash(bytes.subarray(0, end < 0 ? bytes.indexOf(10) : end)),
      expectedFileVersion: rawByteHash(bytes),
      done,
    };
  };
  const approved = await h.authority.prepare(await request(), h.actor);
  const row = () => h.db.select().from(canvasDocWriteIntents).get()!;
  const counts = () => ({
    events: h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_events').get(),
    batches: h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_batches').get(),
  });
  return {
    ...h,
    store,
    documentId,
    grantId,
    service,
    request,
    row,
    counts,
    coordinator,
    approved,
    delivery,
    notices,
    cleanup: async () => {
      await service.stop();
      await h.cleanup();
    },
    revoke: () => {
      h.db
        .update(canvasDocGrants)
        .set({ revokedAt: new Date().toISOString() })
        .where(eq(canvasDocGrants.grantId, grantId))
        .run();
    },
    lock: () => {
      h.rooms.canvas.heartbeat(h.scope, 'other-current-editor', documentId, true);
    },
    failCompletion: (value: boolean) => {
      h.db.run(sql`DROP TRIGGER IF EXISTS refuse_physical_checkbox_outbox`);
      if (value)
        h.db.run(
          sql`CREATE TRIGGER refuse_physical_checkbox_outbox BEFORE INSERT ON canvas_doc_deliveries BEGIN SELECT RAISE(ABORT,'Injected completion rollback'); END`
        );
    },
    approveAlias: async (sourcePath: string) => {
      const doc = h.rooms.canvas.open(
        h.scope,
        'agent',
        { type: 'markdown', content: (await readFile(sourcePath)).toString(), sourcePath },
        {
          tree: { resolvedCwd: h.dir, treeKind: 'agent-cwd', sourceLabel: null, aheadOfMain: null },
          principal: h.runtime.principal,
        }
      );
      const observed = await observeCheckboxSource(
        () =>
          readDocSourceDescriptor(
            { db: h.db, documents: h.rooms.canvasDocuments, roomRepos: h.roomRepos },
            doc.id
          ),
        () => {
          if (h.db.$client.inTransaction) throw new Error('FS inside SQL');
          return undefined;
        }
      );
      const binding = {
        operation: 'checkbox-toggle' as const,
        sourceIdentity: observed.descriptor.sourceIdentity!,
        resolvedCwd: h.dir,
        treeKind: 'agent-cwd' as const,
        canonicalPath: sourcePath,
      };
      const grants = new DocChannelGrants({
        db: h.db,
        store,
        approvals: h.approvals,
        authority: { ...h.http.grantAuthority, resolveWriteBinding: () => binding },
        now: () => new Date(),
      });
      grants.configure(
        doc.id,
        {
          routes: [
            {
              id: 'checkbox',
              on: 'md.*',
              to: 'agent:owner',
              turn: { mode: 'immediate', maxBatch: 1 },
            },
          ],
        },
        h.actor,
        'a'
      );
      const input = {
        documentId: doc.id,
        routeId: 'checkbox',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        write: binding,
      };
      const pending = grants.grant(input, h.actor);
      if (pending.kind !== 'approval_required')
        throw new Error('Alias requires genuine original approval');
      h.approvals.grant(pending.ticket.approvalId);
      const consumed = grants.grant(input, h.actor, pending.ticket.token);
      if (consumed.kind !== 'granted') throw new Error('Alias original approval was not consumed');
      const authority = new DocCheckboxAuthority({ ...h.deps, grants });
      const aliasService = new DocCheckboxWriteService(
        h.db,
        store,
        coordinator,
        authority,
        delivery
      );
      return { documentId: doc.id, grant: consumed.grant, service: aliasService, authority };
    },
    lostAuthority: () => new CheckboxAuthorityRefusal('ORIGINAL_OWNER_CHANGED'),
  };
}
