/** Actual owning Room-main FILE focus; source readers do not issue launch authority. */
import express from 'express';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { canvasDocEvents, canvasDocBatches, eq } from '@dorkos/db';
import { requireServerNativeDatabaseQueryCustody } from '@dorkos/db/internal-server';
import router from '../../../../../routes/canvas-doc-events.js';
import { sessionGate } from '../../../../core/auth/index.js';
import { createOriginalOwnedRoomFixture } from '../../../../rooms/repo/__tests__/room-original-owned-fixture.js';
import {
  readOwnedRoomRepoSource,
  readOwnedRoomRepoTransactionSource,
} from '../../../../rooms/repo/room-repo-store.js';
import { createOriginalDocTokenFileSourceReader } from '../../tokens/token-native-file-source.js';

import { readDocSourceDescriptor } from '../../current/doc-source-policy.js';

const target = swappableServer();
it('keeps genuine Room-main FILE focus current across private repo reads and actual transaction retirement', async () => {
  let own: Awaited<ReturnType<typeof createOriginalOwnedRoomFixture>> | undefined;
  let failed = false,
    first: unknown;
  const restorations: (() => void)[] = [];
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  try {
    own = await createOriginalOwnedRoomFixture({ nativeDatabase: true });
    const h = own;
    requireServerNativeDatabaseQueryCustody(h.db);
    const repo = readOwnedRoomRepoSource(h.repos, h.db, h.roomId);
    expect(repo.row?.roomId).toBe(h.roomId);
    const sourcePath = join(repo.repo, 'ROOM.md');
    const originalBytes = await fs.readFile(sourcePath);
    const doc = h.subsystem.canvas.open(
      'room:' + h.roomId,
      h.operator.id,
      { type: 'file', sourcePath: 'ROOM.md' },
      {
        tree: {
          resolvedCwd: repo.repo,
          treeKind: 'room-main',
          sourceLabel: null,
          aheadOfMain: null,
        },
      }
    );
    const descriptorDeps = { db: h.db, documents: h.subsystem.canvasDocuments, roomRepos: h.repos };
    const originalDescriptor = readDocSourceDescriptor(descriptorDeps, doc.id);
    expect(originalDescriptor.allowedRoot).toBe(repo.repo);
    const reader = createOriginalDocTokenFileSourceReader(h.db, h.repos);
    const before = reader.observe(doc.id);
    expect(before.canonicalFile).toBe(await fs.realpath(sourcePath));
    expect(before.policies.repo).not.toBeNull();
    expect(() => reader.observeCurrentTransaction(doc.id)).toThrow();
    // Public readers are hostile; only the original same-Db private row/root may be used.
    const getRow = vi.spyOn(h.repos, 'getRow');
    restorations.push(getRow.mockRestore.bind(getRow));
    getRow.mockImplementation(() => {
      throw undefined;
    });
    const repoPath = vi.spyOn(h.repos, 'repoPath');
    restorations.push(repoPath.mockRestore.bind(repoPath));
    repoPath.mockImplementation(() => {
      throw new Error('Hostile public repo path');
    });
    expect(readDocSourceDescriptor(descriptorDeps, doc.id)).toEqual(originalDescriptor);
    h.db.transaction((tx) => {
      expect(h.db.$client.inTransaction).toBe(true);
      expect(() => reader.observe(doc.id)).toThrow();
      expect(() => readOwnedRoomRepoSource(h.repos, h.db, h.roomId)).toThrow(
        'Room filesystem ownership cannot await inside SQL.'
      );
      expect(readOwnedRoomRepoTransactionSource(h.repos, h.db, h.roomId)).toEqual(repo);
      expect(reader.observeCurrentTransaction(doc.id)).toEqual(before);
      expect(readDocSourceDescriptor(descriptorDeps, doc.id, tx)).toEqual(originalDescriptor);
    });
    expect(h.db.$client.inTransaction).toBe(false);
    expect(() => reader.observeCurrentTransaction(doc.id)).toThrow();
    expect(reader.observe(doc.id)).toEqual(before);
    const app = express();
    app.use(express.json());
    app.use(sessionGate);
    app.locals.docChannelHttp = h.http;
    app.use('/docs', router);
    const server = target.mount(app),
      path = `/docs/${doc.id}/presence`;
    const mounted = await request(server)
      .post(path)
      .set('Authorization', `Bearer ${h.ownerKey.key}`)
      .send({ action: 'mount' });
    expect(mounted.status).toBe(200);
    const focus = await request(server)
      .post(path)
      .set('Authorization', `Bearer ${h.ownerKey.key}`)
      .send({ action: 'focus', viewerId: mounted.body.viewerId, focused: true });
    expect(focus.status).toBe(200);
    const rows = h.db
      .select()
      .from(canvasDocEvents)
      .where(eq(canvasDocEvents.documentId, doc.id))
      .all();
    expect(rows.map((row) => [row.type, row.payload])).toEqual([
      ['host.opened', { mounts: 1 }],
      ['doc.viewers', { views: 1 }],
      ['host.focus', { focused: true }],
    ]);
    expect(rows.map((row) => [row.direction, row.provenance])).toEqual([
      ['system', { source: 'doc-channel-presence' }],
      ['system', { source: 'doc-channel-presence' }],
      ['upstream', { transport: 'http', trust: 'app_untrusted' }],
    ]);
    expect(
      h.db.select().from(canvasDocBatches).where(eq(canvasDocBatches.documentId, doc.id)).all()
    ).toEqual([]);
    expect(await fs.readFile(sourcePath)).toEqual(originalBytes);
    expect(getRow).not.toHaveBeenCalled();
    expect(repoPath).not.toHaveBeenCalled();
    requireServerNativeDatabaseQueryCustody(h.db);
  } catch (cause) {
    remember(cause);
  }
  // Restore hostile public slots independently before retiring actual owning children.
  for (const restore of restorations) {
    try {
      restore();
    } catch (cause) {
      remember(cause);
    }
  }
  if (own) {
    try {
      await own.close();
    } catch (cause) {
      remember(cause);
    }
  }
  if (failed) throw first;
});
