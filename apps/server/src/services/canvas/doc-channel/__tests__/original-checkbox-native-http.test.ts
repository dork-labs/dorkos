/** Real ordinary router/socket/FILE writer acceptance; full-app Host/session gates remain app-owned. */
import { expect, it } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from '@dorkos/db';
import { setRoomService, clearRoomService } from '../../../rooms/index.js';
import routes, { canvasDocJsonParser } from '../../../../routes/canvas-doc-events.js';
import { nativeRoomAuthorityFixture } from '../writes/__tests__/authority-fixtures.js';
it('ordinary native checkbox HTTP writes once across response retry and refuses path mismatch and revoked permission', async () => {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-checkbox-http-')));
  let h: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>> | undefined,
    failed = false,
    first: unknown,
    drained = false;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  const app = express(),
    server = createServer(app),
    sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  try {
    h = await nativeRoomAuthorityFixture(dir, 'codex', randomUUID(), randomUUID(), {
      checkboxFile: true,
    });
    setRoomService(h.rooms.service);
    app.locals.docChannelHttp = h.http;
    app.use('/api/canvas/docs', canvasDocJsonParser, routes);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Original listener unavailable.');
    const origin = `http://127.0.0.1:${address.port}`;
    const url = `${origin}/api/canvas/docs/${h.documentId}/checkbox`;
    const request = await h.checkboxRequest(true),
      before = await fs.readFile(h.checkboxPath!);
    const post = (body: unknown) =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const mismatch = await post({ ...request, documentId: randomUUID() });
    expect(mismatch.status).toBe(400);
    await mismatch.arrayBuffer();
    expect(await fs.readFile(h.checkboxPath!)).toEqual(before);
    const result = await post(request);
    expect(result.status).toBe(200);
    const saved = await result.json();
    expect(saved).toMatchObject({
      status: 'changed',
      receipt: { id: request.eventId, status: 'recorded' },
    });
    const after = await fs.readFile(h.checkboxPath!),
      identity = await fs.stat(h.checkboxPath!);
    expect(after.toString('utf8').startsWith('- [x]')).toBe(true);
    const duplicate = await post(request);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual(saved);
    expect(await fs.readFile(h.checkboxPath!)).toEqual(after);
    expect((await fs.stat(h.checkboxPath!)).ino).toBe(identity.ino);
    expect(
      h.db.get<{ n: number }>(
        sql`SELECT count(*) AS n FROM canvas_doc_write_intents WHERE document_id=${h.documentId}`
      )!.n
    ).toBe(1);
    expect(
      h.db.get<{ n: number }>(
        sql`SELECT count(*) AS n FROM canvas_doc_events WHERE document_id=${h.documentId} AND type='md.task.toggled'`
      )!.n
    ).toBe(1);
    expect(h.http.channels.listDeliveries(h.documentId, request.eventId)).toHaveLength(1);
    expect(h.http.channels.listDeliveries(h.documentId, request.eventId)[0]!.ackOutcome).toBeNull();
    const next = await h.checkboxRequest(false);
    h.http.grants.revoke(h.documentId, h.granted.grant.grantId, h.operator);
    const refused = await post(next);
    expect(refused.ok).toBe(false);
    await refused.arrayBuffer();
    expect(await fs.readFile(h.checkboxPath!)).toEqual(after);
    expect(
      h.db.get<{ n: number }>(
        sql`SELECT count(*) AS n FROM canvas_doc_events WHERE document_id=${h.documentId} AND type='md.task.toggled'`
      )!.n
    ).toBe(1);
  } catch (cause) {
    remember(cause);
  } finally {
    for (const socket of sockets)
      try {
        socket.destroy();
      } catch (cause) {
        remember(cause);
      }
    try {
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((cause) => (cause ? reject(cause) : resolve()))
        );
    } catch (cause) {
      remember(cause);
    }
    try {
      if (h) {
        await h.cleanup();
        clearRoomService(h.rooms.service);
        drained = true;
      }
    } catch (cause) {
      remember(cause);
    }
    if (drained)
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (cause) {
        remember(cause);
      }
  }
  if (failed) throw first;
});
