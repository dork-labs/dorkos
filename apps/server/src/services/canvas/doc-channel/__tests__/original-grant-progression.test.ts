import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeRoomAuthorityFixture } from '../writes/__tests__/authority-fixtures.js';
import { captureServiceCurrentDocument, requireServiceCurrentDocument } from '../service.js';

type Fixture = Awaited<ReturnType<typeof nativeRoomAuthorityFixture>>;
async function withOriginalFile(run: (h: Fixture) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-grant-progression-')));
  let h: Fixture | undefined,
    failed = false,
    first: unknown,
    closed = false;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  try {
    h = await nativeRoomAuthorityFixture(root, 'codex', randomUUID(), randomUUID(), {
      checkboxFile: true,
    });
    await run(h);
  } catch (cause) {
    remember(cause);
  } finally {
    if (h)
      try {
        await h.cleanup();
        closed = true;
      } catch (cause) {
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

describe('original FILE grant transaction progression', () => {
  it('permits the exact approved insertion but invalidates an older empty-selection authority', async () => {
    await withOriginalFile(async (h) => {
      const old = await captureServiceCurrentDocument(h.http.service, h.documentId, h.operator, []);
      const before = h.db.$client
        .prepare('SELECT * FROM canvas_doc_grants WHERE document_id=? ORDER BY grant_id')
        .all(h.documentId);
      const request = {
        documentId: h.documentId,
        routeId: 'native-room',
        expiresAt: new Date(Date.now() + 7200000).toISOString(),
      };
      const pending = await h.http.grantCheckboxRoute(request, h.operator);
      expect(pending.kind).toBe('approval_required');
      if (pending.kind !== 'approval_required')
        throw new Error('Original operator approval missing');
      h.approvals.grant(pending.ticket.approvalId);
      const granted = await h.http.grantCheckboxRoute(request, h.operator, pending.ticket.token);
      expect(granted.kind).toBe('granted');
      if (granted.kind !== 'granted') throw new Error('Original grant insertion missing');
      expect(granted.grant.grantId).not.toBe(h.granted.grant.grantId);
      const after = h.db.$client
        .prepare('SELECT * FROM canvas_doc_grants WHERE document_id=? ORDER BY grant_id')
        .all(h.documentId) as { grant_id: string }[];
      expect(after.filter((row) => row.grant_id !== granted.grant.grantId)).toEqual(before);
      expect(after).toHaveLength(before.length + 1);
      await expect(requireServiceCurrentDocument(h.http.service, old.authority)).rejects.toThrow();
    });
  });
  it('retains unrelated original grant corruption refusal with no selected grants', async () => {
    await withOriginalFile(async (h) => {
      const old = await captureServiceCurrentDocument(h.http.service, h.documentId, h.operator, []);
      const original = h.db.$client
        .prepare('SELECT normalized_route FROM canvas_doc_grants WHERE grant_id=?')
        .get(h.granted.grant.grantId) as { normalized_route: string };
      try {
        h.db.$client
          .prepare('UPDATE canvas_doc_grants SET normalized_route=? WHERE grant_id=?')
          .run('{invalid-json', h.granted.grant.grantId);
        await expect(
          requireServiceCurrentDocument(h.http.service, old.authority)
        ).rejects.toThrow();
      } finally {
        h.db.$client
          .prepare('UPDATE canvas_doc_grants SET normalized_route=? WHERE grant_id=?')
          .run(original.normalized_route, h.granted.grant.grantId);
      }
    });
  });
});
