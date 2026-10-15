/** Real owning composition and raw Node Hono requests; no supplied principal or locals authority. */
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { getRequestListener } from '@hono/node-server';
import request from '@dorkos/test-utils/supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../api-chain.js';
import {
  originalDocHonoRequest,
  originalDocAuthRequest,
  originalDocRequestFacts,
} from '../original-doc-request.js';
import { honoRequestFacts } from '../request-facts.js';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { recheckAdmittedRequestAuth } from '../../services/core/auth/session-gate.js';
import { captureOriginalDocHttpActor } from '../../services/canvas/doc-channel/http-composition.js';
import {
  createOriginalOwnedRoomFixture,
  type OriginalOwnedRoomFixture,
} from '../../services/rooms/repo/__tests__/room-original-owned-fixture.js';

let fixture: OriginalOwnedRoomFixture;
let server: Server;

beforeAll(async () => {
  fixture = await createOriginalOwnedRoomFixture({ nativeDatabase: true });
  const api = createApiApp({ admission: new MainRequestAdmission() });
  api.get('/api/original-doc-owner-probe/:operation', async (c) => {
    const { req, res } = originalDocHonoRequest(c);
    const user = c.get('user');
    const admitted = c.get('originalAdmittedRequest');
    const operation = c.req.param('operation');
    if (operation === 'admission') {
      const exact = originalDocAuthRequest(req);
      const valid = await recheckAdmittedRequestAuth(exact, user);
      const raw = await recheckAdmittedRequestAuth(req, user);
      const copied = await recheckAdmittedRequestAuth({ headers: { ...req.headers } }, user);
      const authorization = req.headers.authorization;
      req.headers.authorization = 'Bearer invalid-after-admission';
      let changed: boolean;
      try {
        changed = await recheckAdmittedRequestAuth(exact, user);
      } finally {
        req.headers.authorization = authorization;
      }
      return c.json({ same: exact === admitted, valid, raw, copied, changed });
    }
    if (operation === 'ownership') {
      const copiedRequest = Object.create(req);
      const copiedResponse = Object.create(res);
      let requestRefused = false;
      let responseRefused = false;
      try {
        originalDocRequestFacts(copiedRequest, res);
      } catch {
        requestRefused = true;
      }
      try {
        originalDocRequestFacts(req, copiedResponse);
      } catch {
        responseRefused = true;
      }
      return c.json({ requestRefused, responseRefused });
    }
    if (operation === 'facts') {
      const facts = originalDocRequestFacts(req, res);
      const expected = honoRequestFacts(c);
      c.set('user', undefined);
      let cleared: boolean;
      try {
        cleared = originalDocRequestFacts(req, res).user === undefined;
      } finally {
        c.set('user', user);
      }
      return c.json({
        sameHeaders: facts.headers === req.headers,
        sameUser: facts.user === user,
        sameAgent: facts.agentIdentity === expected.agentIdentity,
        forwarded: facts.forwardedAddress,
        peer: facts.peerAddress,
        currentFacts: originalDocRequestFacts(req, res).user === user,
        cleared,
      });
    }
    const original = fixture.http;
    const captured = captureOriginalDocHttpActor(original);
    if (operation === 'actor') {
      const actor = captured(honoRequestFacts(c));
      return c.json({ kind: actor.principal.claims.kind, owner: actor.principal.claims.owner });
    }
    let refused = false;
    if (operation === 'copy') {
      try {
        captureOriginalDocHttpActor({ ...original });
      } catch {
        refused = true;
      }
    } else {
      const actor = original.actor,
        service = original.service,
        fileWrites = original.fileWrites;
      try {
        if (operation === 'replace-actor')
          original.actor = (caller) => Reflect.apply(actor, original, [caller]);
        if (operation === 'replace-service') original.service = Object.create(service);
        if (operation === 'replace-writer') original.fileWrites = Object.create(fileWrites);
        try {
          captured(honoRequestFacts(c));
        } catch {
          refused = true;
        }
        let recaptureRefused = false;
        try {
          captureOriginalDocHttpActor(original);
        } catch {
          recaptureRefused = true;
        }
        return c.json({ refused, recaptureRefused });
      } finally {
        original.actor = actor;
        original.service = service;
        original.fileWrites = fileWrites;
      }
    }
    return c.json({ refused });
  });
  server = createServer(getRequestListener(api.fetch));
  // Match the shared listening fixture: one IPv4 listener for this owning scope.
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
}, 120_000);

afterAll(async () => {
  try {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  } finally {
    await fixture?.close();
  }
}, 120_000);

function probe(operation: string) {
  return request(server)
    .get(`/api/original-doc-owner-probe/${operation}`)
    .set('Authorization', `Bearer ${fixture.ownerKey.key}`);
}

describe('original Hono request admission and owning actor', () => {
  it('rechecks only the exact admitted object and rejects changed credentials', async () => {
    const response = await probe('admission');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      same: true,
      valid: true,
      raw: false,
      copied: false,
      changed: false,
    });
  });

  it('keeps raw headers, one-hop forwarded address and current admitted user facts', async () => {
    const response = await probe('facts').set('X-Forwarded-For', '198.51.100.8, 203.0.113.42');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      sameHeaders: true,
      sameUser: true,
      sameAgent: true,
      forwarded: '203.0.113.42',
      currentFacts: true,
      cleared: true,
    });
    expect(response.body.peer).toBeTruthy();
    expect(response.body.peer).not.toBe('203.0.113.42');
  });

  it('refuses copied raw request and response objects before reading caller facts', async () => {
    const response = await probe('ownership');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ requestRefused: true, responseRefused: true });
  });

  it('uses the real installation actor for a genuinely admitted owner', async () => {
    const response = await probe('actor');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      kind: 'operator',
      owner: { kind: 'user', userId: fixture.ownerId },
    });
  });

  it('refuses a copied composition despite carrying the genuine actor and writer', async () => {
    const response = await probe('copy');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ refused: true });
  });

  it.each(['replace-actor', 'replace-service', 'replace-writer'])(
    'refuses %s both after capture and on recapture',
    async (operation) => {
      const response = await probe(operation);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ refused: true, recaptureRefused: true });
      expect((await probe('actor')).status).toBe(200);
    }
  );

  it('refuses the original composition and captured actor after its owning writer closes', async () => {
    const captured = captureOriginalDocHttpActor(fixture.http);
    await fixture.stopWrites();
    expect(() => captureOriginalDocHttpActor(fixture.http)).toThrow();
    // The closure must fail at its owning lifetime check, before inspecting caller facts.
    expect(() => captured({ headers: {}, user: undefined, agentIdentity: undefined })).toThrow();
  });
});
