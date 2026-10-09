/** Original FILE token scope over real HTTP sockets; SOURCE UNRUN. */
import { expect, it } from 'vitest';
import express from 'express';
import { noopLogger } from '@dorkos/shared/logger';
import { composeRegistry } from '../../../core/capabilities/registry.js';
import { createDocChannelManagementCapabilities } from '../management/capabilities.js';
import { createDocChannelGrantCapabilities } from '../grant-capabilities.js';
import { createCanvasDocManagementRouter } from '../../../../routes/canvas-doc-management.js';
import { setRoomService, clearRoomService } from '../../../rooms/index.js';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import ordinaryDocRoutes, { canvasDocJsonParser } from '../../../../routes/canvas-doc-events.js';
import { standaloneDocTokenReadRouter } from '../../../../routes/canvas-doc-token-events.js';
import { nativeRoomAuthorityFixture } from '../writes/__tests__/authority-fixtures.js';
import {
  issueServiceOriginalDocToken,
  revokeServiceOriginalDocToken,
  readServiceOriginalDocManagement,
  submitCurrentDocEvent,
  currentRoomDueServicePort,
} from '../service.js';
import {
  DocChannelTokenStore,
  readOriginalNativeDocTokenHeaderByHash,
} from '../tokens/token-store.js';
type Fixture = Awaited<ReturnType<typeof nativeRoomAuthorityFixture>>;
async function withOriginalHttp(
  run: (
    h: Fixture,
    base: string,
    token: string,
    header: NonNullable<ReturnType<typeof readOriginalNativeDocTokenHeaderByHash>>,
    observed: {
      resetFalse: number;
      eventFalse: number;
      ownedDrainWaits: number;
      requestHost?: string;
    },
    responses: Set<ServerResponse>
  ) => Promise<void>,
  permissions: ('ingest' | 'replay' | 'stream')[] = ['replay', 'stream'],
  options: { fullApp?: boolean; expiresInMs?: number } = {}
) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'original-token-http-')));
  let h: Fixture | undefined,
    failed = false,
    first: unknown,
    nativeClosed = true;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  const sockets = new Set<Socket>(),
    responses = new Set<ServerResponse>();
  const observed: {
    resetFalse: number;
    eventFalse: number;
    ownedDrainWaits: number;
    requestHost?: string;
  } = { resetFalse: 0, eventFalse: 0, ownedDrainWaits: 0 };
  let app = express();
  // A real socket/response high water mark makes these small frames report actual backpressure.
  const server = createServer({ highWaterMark: 1 }, (req, res) => {
    observed.requestHost = req.headers.host;
    responses.add(res);
    res.once('close', () => responses.delete(res));
    const once = res.once;
    res.once = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === 'drain') observed.ownedDrainWaits++;
      return Reflect.apply(once, res, [event, listener]);
    }) as typeof res.once;
    const write = res.write;
    res.write = ((...args: Parameters<typeof res.write>) => {
      const accepted = Reflect.apply(write, res, args);
      if (!accepted) {
        const wire = String(args[0]);
        if (wire.startsWith('event: reset')) observed.resetFalse++;
        if (wire.includes('event: doc.event')) observed.eventFalse++;
      }
      return accepted;
    }) as typeof res.write;
    app(req, res);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  try {
    h = await nativeRoomAuthorityFixture(root, 'codex', randomUUID(), randomUUID(), {
      checkboxFile: true,
    });
    setRoomService(h.rooms.service);
    if (options.fullApp) {
      const { createApp } = await import('../../../../app.js');
      const { MainRequestAdmission } =
        await import('../../../core/lifecycle/main-request-admission.js');
      app = createApp({ admission: new MainRequestAdmission() });
    }
    app.locals.docChannelHttp = h.http;
    if (!options.fullApp) {
      app.use('/api/canvas/token/docs', standaloneDocTokenReadRouter);
      const registry = composeRegistry(
        [
          {
            name: 'ui',
            capabilities: [
              ...createDocChannelGrantCapabilities(),
              ...createDocChannelManagementCapabilities(),
            ],
          },
        ],
        {
          logger: noopLogger,
          docChannelManagementService: h.http.service,
          docChannelManagementFileWrites: h.http.fileWrites,
          docChannelGrantDeps: { service: h.http.grants, authorization: h.http.authorization },
        }
      );
      app.use(
        '/api/canvas/docs',
        canvasDocJsonParser,
        createCanvasDocManagementRouter(registry, h.http),
        ordinaryDocRoutes
      );
    }
    if (options.fullApp) {
      const { finalizeApp } = await import('../../../../app.js');
      finalizeApp(app);
    }
    const token = await issueServiceOriginalDocToken(
      h.http.service,
      h.operator,
      {
        documentId: h.documentId,
        allowedTypes: ['md.comment'],
        directions: ['upstream'],
        permissions,
        expiresAt: new Date(Date.now() + (options.expiresInMs ?? 3600000)).toISOString(),
      },
      [h.granted.grant.grantId]
    );
    const hash = createHash('sha256').update(token.token).digest('hex');
    const header = readOriginalNativeDocTokenHeaderByHash(
      new DocChannelTokenStore(h.db),
      h.db,
      hash
    )!;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Original server address unavailable.');
    await run(h, `http://127.0.0.1:${address.port}`, token.token, header, observed, responses);
  } catch (cause) {
    if (!h) nativeClosed = false;
    remember(cause);
  } finally {
    // Close real transport peers before fixture Db cleanup, attempting every owned socket.
    for (const socket of sockets)
      try {
        socket.destroy();
      } catch (cause) {
        nativeClosed = false;
        remember(cause);
      }
    try {
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      });
    } catch (cause) {
      nativeClosed = false;
      remember(cause);
    }
    if (nativeClosed && h)
      try {
        await h.cleanup();
        clearRoomService(h.rooms.service);
      } catch (cause) {
        nativeClosed = false;
        remember(cause);
      }
    if (nativeClosed)
      try {
        await fs.rm(root, { recursive: true, force: true });
      } catch (cause) {
        remember(cause);
      }
  }
  if (failed) throw first;
}
async function accepted(h: Fixture, generation: string, type: string) {
  return submitCurrentDocEvent(
    h.http.service,
    h.documentId,
    { v: 1, id: randomUUID(), type, payload: { message: type } },
    h.operator,
    { expectedGeneration: generation }
  );
}
it('serves filtered original replay/receipt DATA and restricted CORS without cookie or URL credential fallback', async () => {
  await withOriginalHttp(async (h, base, token, header) => {
    const excluded = await accepted(h, header.generation, 'md.changed'),
      allowed = await accepted(h, header.generation, 'md.comment');
    const path = `${base}/api/canvas/token/docs/${h.documentId}`;
    const response = await fetch(path + '/channel', {
      headers: { Authorization: 'Bearer ' + token, Origin: 'https://standalone.example' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    const body = await response.json();
    expect(body.events.map((event: { id: string }) => event.id)).toEqual([allowed.receipt.id]);
    expect(body).not.toHaveProperty('state');
    expect(body).not.toHaveProperty('viewer');
    expect(body).not.toHaveProperty('scope');
    const receipt = await fetch(path + '/events/' + excluded.receipt.id, {
      headers: { Authorization: 'Bearer ' + token },
    });
    expect(receipt.status).toBe(409);
    expect((await receipt.json()).code).toBe('DOC_TOKEN_EVENT_UNCONFIRMED');
    const mixed: Record<string, string>[] = [
      { Cookie: 'session=unrelated' },
      { Authorization: 'Bearer ' + token, Cookie: 'session=unrelated' },
    ];
    async function status(url: string, options: Parameters<typeof fetch>[1]) {
      const result = await fetch(url, options);
      await result.arrayBuffer();
      return result.status;
    }
    for (const headers of mixed) {
      expect(await status(path + '/channel', { headers })).toBe(401);
    }
    expect(
      await status(path + '/channel?token=' + encodeURIComponent(token), {
        headers: { Authorization: 'Bearer ' + token },
      })
    ).toBe(401);
    const preflight = await fetch(path + '/channel', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://standalone.example',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Authorization',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
    expect(
      await status(path + '/channel', {
        method: 'OPTIONS',
        headers: { 'Access-Control-Request-Method': 'POST' },
      })
    ).toBe(400);
  });
});
it('waits for actual reset and event backpressure then destroys the exact owned SSE response on original stop', async () => {
  await withOriginalHttp(async (h, base, token, header, observed, responses) => {
    const first = await accepted(h, header.generation, 'md.comment'),
      second = await accepted(h, header.generation, 'md.comment');
    // Actual native retention DATA transition; this does not claim original maintenance policy execution.
    h.db.$client
      .prepare('UPDATE canvas_doc_channels SET retention_floor=? WHERE document_id=?')
      .run(second.receipt.docSeq, h.documentId);
    let inbound: IncomingMessage | undefined,
      wire = '',
      failed = false,
      cause: unknown,
      stopping = false;
    const req = request(
      `${base}/api/canvas/token/docs/${h.documentId}/stream?since=0`,
      {
        headers: { Authorization: 'Bearer ' + token },
      },
      (res) => {
        inbound = res;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          wire += chunk;
          if (Buffer.byteLength(wire) > 2097152) {
            if (!failed) {
              failed = true;
              cause = new Error('Original SSE control DATA limit reached.');
            }
            res.destroy();
          }
        });
        res.on('error', (error) => {
          if (!stopping && !failed) {
            failed = true;
            cause = error;
          }
        });
      }
    );
    req.on('error', (error) => {
      if (!stopping && !failed) {
        failed = true;
        cause = error;
      }
    });
    req.end();
    try {
      await expect
        .poll(() => {
          if (failed) throw cause;
          return wire.includes('event: reset') && wire.includes(second.receipt.id);
        })
        .toBe(true);
      expect(wire).not.toContain(first.receipt.id);
      expect(observed.resetFalse).toBeGreaterThan(0);
      expect(observed.eventFalse).toBeGreaterThan(0);
      expect(observed.ownedDrainWaits).toBeGreaterThanOrEqual(2);
      const owned = [...responses];
      expect(owned).toHaveLength(1);
      stopping = true;
      await currentRoomDueServicePort(h.http.service).stopPump();
      await expect.poll(() => owned[0]!.destroyed).toBe(true);
      expect(h.db.$client.open).toBe(true);
    } finally {
      inbound?.destroy();
      req.destroy();
    }
    // ECONNRESET/aborted after the original exact response destroy is expected transport DATA,
    // never classified as native ownership success; the owner stop above supplies that witness.
    if (failed) throw cause;
  });
});

it('uses the original HTTP operator resolver for revoke while refusing bearer promotion', async () => {
  await withOriginalHttp(async (h, base, token, header) => {
    const url = `${base}/api/canvas/docs/${h.documentId}/tokens/${header.tokenId}/revoke`;
    const bearer = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
    });
    expect(bearer.status).toBe(403);
    await bearer.arrayBuffer();
    const read = await fetch(`${base}/api/canvas/token/docs/${h.documentId}/channel`, {
      headers: { Authorization: 'Bearer ' + token },
    });
    expect(read.status).toBe(200);
    await read.arrayBuffer();
    // No actor/issuer injected: actual local-install operator comes from owning HTTP resolver.
    const operator = await fetch(url, { method: 'POST' });
    expect(operator.status).toBe(200);
    const result = await operator.json();
    expect(result.tokenId).toBe(header.tokenId);
    expect(typeof result.revokedAt).toBe('string');
    expect(operator.headers.get('access-control-allow-origin')).toBeNull();
    const refused = await fetch(`${base}/api/canvas/token/docs/${h.documentId}/channel`, {
      headers: { Authorization: 'Bearer ' + token },
    });
    expect(refused.status).toBe(401);
    await refused.arrayBuffer();
  });
});

it('authenticates standalone input before body parsing and records genuine actorless input with restricted CORS', async () => {
  await withOriginalHttp(
    async (h, base, token) => {
      const path = `${base}/api/canvas/token/docs/${h.documentId}/events`;
      const refused = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      });
      expect(refused.status).toBe(401);
      await refused.arrayBuffer();
      const malformed = await fetch(path, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: '{',
      });
      expect(malformed.status).toBe(400);
      await malformed.arrayBuffer();
      const input = {
        v: 1,
        id: randomUUID(),
        type: 'md.comment',
        payload: { text: 'actual standalone token input' },
      };
      const headers = {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        Origin: 'https://standalone.example',
      };
      const accepted = await fetch(path, { method: 'POST', headers, body: JSON.stringify(input) });
      expect(accepted.status).toBe(201);
      expect(accepted.headers.get('access-control-allow-origin')).toBe('*');
      expect(accepted.headers.get('access-control-allow-credentials')).toBeNull();
      const data = await accepted.json();
      expect(data.receipt.id).toBe(input.id);
      expect(data.receipt.status).toBe('recorded');
      const duplicate = await fetch(path, { method: 'POST', headers, body: JSON.stringify(input) });
      expect(duplicate.status).toBe(200);
      expect((await duplicate.json()).receipt.docSeq).toBe(data.receipt.docSeq);
      const reserved = await fetch(path, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...input, id: randomUUID(), type: 'app.ack' }),
      });
      expect(reserved.status).toBe(401);
      await reserved.arrayBuffer();
      const preflight = await fetch(path, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://standalone.example',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-methods')).toBe('POST');
      await preflight.arrayBuffer();
    },
    ['ingest', 'replay']
  );
});

it('mints an exact original operator token over HTTP and refuses bearer promotion or foreign selections', async () => {
  await withOriginalHttp(async (h, base, existingToken) => {
    const scope = {
      documentId: h.documentId,
      allowedTypes: ['md.comment'],
      directions: ['upstream'],
      permissions: ['replay', 'stream'],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    const input = { request: scope, approvedGrantIds: [h.granted.grant.grantId] };
    const url = `${base}/api/canvas/docs/${h.documentId}/tokens`;
    const before = h.db.$client
      .prepare('SELECT count(*) AS count FROM canvas_doc_channel_tokens')
      .get();
    for (const body of [
      { ...input, request: { ...scope, documentId: randomUUID() } },
      { ...input, approvedGrantIds: [h.granted.grant.grantId, h.granted.grant.grantId] },
      { ...input, issuer: { kind: 'operator' } },
    ]) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      await response.arrayBuffer();
    }
    const bearer = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + existingToken },
      body: JSON.stringify(input),
    });
    expect(bearer.status).toBe(403);
    await bearer.arrayBuffer();
    const foreignGrant = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, approvedGrantIds: [randomUUID()] }),
    });
    expect(foreignGrant.status).toBe(403);
    await foreignGrant.arrayBuffer();
    expect(
      h.db.$client.prepare('SELECT count(*) AS count FROM canvas_doc_channel_tokens').get()
    ).toEqual(before);
    // Actual owning HTTP actor and native insertion, without injecting a principal or issuer.
    const issued = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    expect(issued.status).toBe(201);
    expect(issued.headers.get('cache-control')).toBe('no-store');
    expect(issued.headers.get('access-control-allow-origin')).toBeNull();
    const response = await issued.json();
    expect(response).toMatchObject(scope);
    expect(response).not.toHaveProperty('tokenHash');
    const header = readOriginalNativeDocTokenHeaderByHash(
      new DocChannelTokenStore(h.db),
      h.db,
      createHash('sha256').update(response.token).digest('hex')
    );
    expect(header).toMatchObject({ tokenId: response.tokenId, documentId: h.documentId });
    const replay = await fetch(`${base}/api/canvas/token/docs/${h.documentId}/channel`, {
      headers: { Authorization: 'Bearer ' + response.token },
    });
    expect(replay.status).toBe(200);
    await replay.arrayBuffer();
  });
});

it('projects current operator management through private authority without exposing token secrets or native capsules', async () => {
  await withOriginalHttp(async (h, base, token, header) => {
    const requireCurrent = h.http.authorization.requireCurrent;
    h.http.authorization.requireCurrent = () => {
      throw new Error('Hostile reflected authorization.');
    };
    try {
      // The exact original service exposes an internal failure to the test runner, never HTTP logs.
      const original = await readServiceOriginalDocManagement(
        h.http.service,
        h.documentId,
        h.operator
      );
      expect(original.documentId).toBe(h.documentId);
      const url = `${base}/api/canvas/docs/${h.documentId}/management`;
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const text = await response.text();
      expect(text).not.toContain(token);
      expect(text).not.toContain(header.tokenHash);
      expect(text).not.toContain('issuerJson');
      expect(text).not.toContain('incarnationJson');
      const snapshot = JSON.parse(text);
      expect(snapshot).toMatchObject({ documentId: h.documentId, generation: header.generation });
      expect(snapshot.grants).toContainEqual(
        expect.objectContaining({ grantId: h.granted.grant.grantId })
      );
      expect(snapshot.tokens).toContainEqual(
        expect.objectContaining({ tokenId: header.tokenId, revokedAt: null })
      );
      for (const metadata of snapshot.tokens) {
        expect(metadata).not.toHaveProperty('tokenHash');
        expect(metadata).not.toHaveProperty('token');
      }
      const refused = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      expect(refused.status).toBe(403);
      await refused.arrayBuffer();
    } finally {
      h.http.authorization.requireCurrent = requireCurrent;
    }
  });
});

it('uses original operator capability handlers and exact native FILE approval tickets over HTTP', async () => {
  await withOriginalHttp(async (h, base, bearer) => {
    const root = `${base}/api/canvas/docs/${h.documentId}/manage`;
    const post = (operation: string, body: unknown, authorization?: string) =>
      fetch(`${root}/${operation}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: JSON.stringify(body),
      });
    const channel = h.http.channels.getChannel(h.documentId)!;
    const originals = {
      configure: h.http.grants.configure,
      grant: h.http.grants.grant,
      revoke: h.http.grants.revoke,
    };
    h.http.grants.configure = () => {
      throw new Error('Hostile reflected configuration');
    };
    h.http.grants.grant = () => {
      throw new Error('Hostile reflected grant');
    };
    h.http.grants.revoke = () => {
      throw new Error('Hostile reflected revocation');
    };
    try {
      const configured = await post('configure', {
        documentId: h.documentId,
        channel: channel.declaration,
      });
      expect(configured.status).toBe(200);
      expect(await configured.json()).toEqual({ configured: true });
      const request = Object.freeze({
        documentId: h.documentId,
        routeId: h.granted.grant.routeId,
        expiresAt: new Date(Date.now() + 7200000).toISOString(),
      });
      const promoted = await post('approve', request, 'Bearer ' + bearer);
      expect(promoted.status).toBe(403);
      await promoted.arrayBuffer();
      const suppliedWrite = await post('approve', { ...request, write: {} });
      expect(suppliedWrite.status).toBe(400);
      await suppliedWrite.arrayBuffer();
      const pending = await post('approve', request);
      expect(pending.status).toBe(200);
      const decision = await pending.json();
      expect(decision.kind).toBe('approval_required');
      expect(h.approvals.grant(decision.ticket.approvalId)).toBeUndefined();
      // A route ticket must stay bound to the immutable request, independently of tier approval.
      const changed = await post('approve', {
        ...request,
        expiresAt: '2099-01-01T00:00:00Z',
        routeApprovalToken: decision.ticket.token,
      });
      expect(changed.ok).toBe(false);
      await changed.arrayBuffer();
      const accepted = await post('approve', {
        ...request,
        routeApprovalToken: decision.ticket.token,
      });
      expect(accepted.status).toBe(200);
      const granted = await accepted.json();
      expect(granted.kind).toBe('granted');
      expect(Number.isSafeInteger(granted.revision) && granted.revision > 0).toBe(true);
      const actual = h.http.channels.getGrant(granted.grantId)!;
      expect(actual.documentId).toBe(h.documentId);
      expect(actual.expiresAt).toBe(request.expiresAt);
      expect(actual.writeOperation).not.toBeNull();
      const revoked = await post('revoke', { documentId: h.documentId, grantId: granted.grantId });
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toEqual({ revoked: true });
      expect(h.http.channels.getGrant(granted.grantId)?.revokedAt).not.toBeNull();
      // Narrowing the same FILE route to comments cannot silently add checkbox write authority.
      const comments = Object.freeze({ ...request, allowedTypes: ['md.comment'] });
      const commentsPending = await post('approve', comments);
      expect(commentsPending.status).toBe(200);
      const commentsDecision = await commentsPending.json();
      expect(commentsDecision.kind).toBe('approval_required');
      h.approvals.grant(commentsDecision.ticket.approvalId);
      const commentsGranted = await post('approve', {
        ...comments,
        routeApprovalToken: commentsDecision.ticket.token,
      });
      expect(commentsGranted.status).toBe(200);
      const commentResult = await commentsGranted.json();
      expect(commentResult.kind).toBe('granted');
      const commentGrant = h.http.channels.getGrant(commentResult.grantId)!;
      expect(commentGrant.allowedTypes).toEqual(['md.comment']);
      expect(commentGrant.writeOperation).toBeNull();
    } finally {
      h.http.grants.configure = originals.configure;
      h.http.grants.grant = originals.grant;
      h.http.grants.revoke = originals.revoke;
    }
  });
});

it('preserves the actual full-app Host guard on the mounted standalone bearer surface', async () => {
  await withOriginalHttp(
    async (h, base, token, _header, observed) => {
      const path = `${base}/api/canvas/token/docs/${h.documentId}/channel`;
      const positive = await fetch(path, { headers: { Authorization: 'Bearer ' + token } });
      expect(positive.status).toBe(200);
      await positive.arrayBuffer();
      // Raw HTTP owns this exact Host header; fetch's wire behavior is not assumed.
      const refused = await new Promise<{
        status: number | undefined;
        code: unknown;
        allowOrigin: string | string[] | undefined;
      }>((resolve, reject) => {
        const req = request(
          path,
          {
            agent: false,
            headers: { Authorization: 'Bearer ' + token, Host: 'attacker.invalid' },
          },
          (res) => {
            let bytes = 0;
            const chunks: Buffer[] = [];
            res.once('error', reject);
            res.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > 4096) {
                const cause = new Error('Original Host refusal body exceeded its bound');
                reject(cause);
                res.destroy();
                req.destroy();
                return;
              }
              chunks.push(chunk);
            });
            res.once('end', () => {
              try {
                const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                resolve({
                  status: res.statusCode,
                  code:
                    typeof body === 'object' && body !== null && 'code' in body
                      ? body.code
                      : undefined,
                  allowOrigin: res.headers['access-control-allow-origin'],
                });
              } catch (cause) {
                reject(cause);
              }
            });
          }
        );
        req.once('error', reject);
        req.end();
      });
      expect(observed.requestHost).toBe('attacker.invalid');
      expect(refused.status).toBe(403);
      expect(refused.code).toBe('HOST_NOT_ALLOWED');
      expect(refused.allowOrigin).toBeUndefined();
    },
    ['replay', 'stream'],
    { fullApp: true }
  );
});

it('authenticates an oversized unauthenticated body before the full-app standalone parser', async () => {
  await withOriginalHttp(
    async (h, base, token) => {
      const path = `${base}/api/canvas/token/docs/${h.documentId}/events`;
      const body = '{' + ' '.repeat(16 * 1024);
      const before = h.db.$client.prepare('SELECT count(*) AS count FROM canvas_doc_events').get();
      const anonymous = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(anonymous.status).toBe(401);
      await anonymous.arrayBuffer();
      const authenticated = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body,
      });
      expect(authenticated.status).toBe(413);
      await authenticated.arrayBuffer();
      expect(h.db.$client.prepare('SELECT count(*) AS count FROM canvas_doc_events').get()).toEqual(
        before
      );
    },
    ['ingest', 'replay'],
    { fullApp: true }
  );
});

it('closes the exact active full-app SSE socket upon genuine native token expiry without an owner stop', async () => {
  await withOriginalHttp(
    async (h, base, token, header, _observed, responses) => {
      let inbound: IncomingMessage | undefined;
      let owned: ServerResponse | undefined;
      let resolveClosed!: () => void;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      let resolveOpened!: () => void;
      let rejectOpened!: (cause: unknown) => void;
      const opened = new Promise<void>((resolve, reject) => {
        resolveOpened = resolve;
        rejectOpened = reject;
      });
      void opened.catch(() => {});
      const req = request(
        `${base}/api/canvas/token/docs/${h.documentId}/stream`,
        {
          headers: { Authorization: 'Bearer ' + token },
        },
        (res) => {
          inbound = res;
          res.on('error', () => {
            /* Expected transport abort after the positively owned response closes. */
          });
          res.once('close', resolveClosed);
          res.resume();
          if (res.statusCode !== 200) {
            rejectOpened(new Error('Original expiry stream did not open'));
            return;
          }
          const actual = [...responses];
          if (actual.length !== 1 || actual[0]!.destroyed) {
            rejectOpened(new Error('Original expiry response unavailable'));
            return;
          }
          owned = actual[0];
          resolveOpened();
        }
      );
      req.on('error', rejectOpened);
      req.end();
      let failure: { cause: unknown } | undefined;
      const remember = (cause: unknown) => {
        failure ??= { cause };
      };
      try {
        await opened;
        expect(owned!.destroyed).toBe(false);
        expect(Date.now()).toBeLessThan(Date.parse(header.expiresAt));
        await closed;
        expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(header.expiresAt));
        expect(owned!.destroyed).toBe(true);
        expect(h.db.$client.open).toBe(true);
        const expired = await fetch(`${base}/api/canvas/token/docs/${h.documentId}/channel`, {
          headers: { Authorization: 'Bearer ' + token },
        });
        expect(expired.status).toBe(401);
        await expired.arrayBuffer();
      } catch (cause) {
        remember(cause);
      }
      try {
        inbound?.destroy();
      } catch (cause) {
        remember(cause);
      }
      try {
        req.destroy();
      } catch (cause) {
        remember(cause);
      }
      if (failure) throw failure.cause;
    },
    ['replay', 'stream'],
    { fullApp: true, expiresInMs: 1000 }
  );
});

it('refuses wrong document and type, mixed cookies, query credentials and malformed anonymous input through the full application', async () => {
  await withOriginalHttp(
    async (h, base, token) => {
      const path = `${base}/api/canvas/token/docs/${h.documentId}`;
      const baseline = h.db.$client
        .prepare('SELECT * FROM canvas_doc_events ORDER BY document_id,doc_seq')
        .all();
      const denied = async (
        url: string,
        options: Parameters<typeof fetch>[1],
        expectedStatus: number
      ) => {
        const response = await fetch(url, options);
        const body = await response.text();
        expect(response.status).toBe(expectedStatus);
        expect(body.includes(token)).toBe(false);
        expect(
          h.db.$client.prepare('SELECT * FROM canvas_doc_events ORDER BY document_id,doc_seq').all()
        ).toEqual(baseline);
      };
      const authorization = { Authorization: 'Bearer ' + token };
      await denied(
        `${base}/api/canvas/token/docs/${randomUUID()}/channel`,
        { headers: authorization },
        401
      );
      await denied(
        path + '/events',
        {
          method: 'POST',
          headers: { ...authorization, 'Content-Type': 'application/json' },
          body: JSON.stringify({ v: 1, id: randomUUID(), type: 'md.changed', payload: {} }),
        },
        401
      );
      await denied(
        path + '/channel',
        { headers: { ...authorization, Cookie: 'session=unrelated' } },
        401
      );
      await denied(
        path + '/events',
        {
          method: 'POST',
          headers: {
            ...authorization,
            Cookie: 'session=unrelated',
            'Content-Type': 'application/json',
          },
          body: '{',
        },
        401
      );
      await denied(
        path + '/channel?token=' + encodeURIComponent(token),
        { headers: authorization },
        401
      );
      await denied(
        path + '/events',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        },
        401
      );
      await denied(
        path + '/events',
        {
          method: 'POST',
          headers: { ...authorization, 'Content-Type': 'application/json' },
          body: '{',
        },
        400
      );
    },
    ['ingest', 'replay'],
    { fullApp: true }
  );
});

it('enforces native token direction filtering and genuine revocation through the full application', async () => {
  await withOriginalHttp(
    async (h, base, token, header) => {
      const path = `${base}/api/canvas/token/docs/${h.documentId}`;
      const event = {
        v: 1,
        id: randomUUID(),
        type: 'md.comment',
        payload: { text: 'Original direction boundary' },
      };
      const input = await fetch(path + '/events', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });
      expect(input.status).toBe(201);
      expect((await input.json()).receipt.id).toBe(event.id);
      const downstream = await issueServiceOriginalDocToken(
        h.http.service,
        h.operator,
        {
          documentId: h.documentId,
          allowedTypes: ['md.comment'],
          directions: ['downstream'],
          permissions: ['replay'],
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
        [h.granted.grant.grantId]
      );
      const baseline = h.db.$client
        .prepare('SELECT * FROM canvas_doc_events ORDER BY document_id,doc_seq')
        .all();
      const filtered = await fetch(path + '/channel', {
        headers: { Authorization: 'Bearer ' + downstream.token },
      });
      expect(filtered.status).toBe(200);
      const data = await filtered.json();
      expect(data.events).toEqual([]);
      for (const name of ['state', 'viewer', 'scope', 'token'])
        expect(data).not.toHaveProperty(name);
      const serialized = JSON.stringify(data);
      expect(serialized.includes(token)).toBe(false);
      expect(serialized.includes(downstream.token)).toBe(false);
      const wrongDirection = await fetch(path + '/events', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + downstream.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...event, id: randomUUID() }),
      });
      expect(wrongDirection.status).toBe(401);
      expect((await wrongDirection.text()).includes(downstream.token)).toBe(false);
      expect(
        h.db.$client.prepare('SELECT * FROM canvas_doc_events ORDER BY document_id,doc_seq').all()
      ).toEqual(baseline);
      const revoked = await revokeServiceOriginalDocToken(
        h.http.service,
        h.operator,
        h.documentId,
        header.tokenId
      );
      expect(revoked.tokenId).toBe(header.tokenId);
      expect(typeof revoked.revokedAt).toBe('string');
      for (const endpoint of ['channel', 'events']) {
        const response = await fetch(
          path + '/' + endpoint,
          endpoint === 'events'
            ? {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...event, id: randomUUID() }),
              }
            : { headers: { Authorization: 'Bearer ' + token } }
        );
        expect(response.status).toBe(401);
        expect((await response.text()).includes(token)).toBe(false);
        expect(
          h.db.$client.prepare('SELECT * FROM canvas_doc_events ORDER BY document_id,doc_seq').all()
        ).toEqual(baseline);
      }
    },
    ['ingest', 'replay'],
    { fullApp: true }
  );
});
