/** Native Node/Hono chain fixture with real database-backed credentials. */
import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { frontDoorListener } from '../front-door.js';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { createDb, runMigrations, user } from '@dorkos/db';
import type { Context } from 'hono';
import { createApiApp, type ApiEnv } from '../api-chain.js';
import { readJsonBody } from '../request-body.js';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { initConfigManager, configManager } from '../../services/core/config-manager.js';
import { initAuth, recheckAdmittedRequestAuth } from '../../services/core/auth/index.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/index.js';
import { currentAuditActor } from '../../services/audit/audit-context.js';
import { initAuditTrail, resetAuditTrail, recordAudit } from '../../services/audit/audit-trail.js';
import { AuditLog } from '../../services/audit/audit-log.js';
import { AccountIds } from '../../services/audit/account-ids.js';
import { BoundaryError } from '../../lib/boundary.js';

export const RECORDING_PATH = '/api/chain-probe/records';
export const RAW_PATH = '/api/chain-probe/raw';
export const MIDSTREAM_PATH = '/api/chain-probe/midstream';
export const THROWABLE: Record<string, () => unknown> = {
  plain: () => new Error('the probe broke'),
  'not-an-error': () => 'a thrown string',
  boundary: () => new BoundaryError('outside', 'OUTSIDE_BOUNDARY'),
  'too-large': () => Object.assign(new Error('too big'), { type: 'entity.too.large' }),
};
export interface Probe {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  chunked?: boolean;
}
export interface Answer {
  status: number;
  body: unknown;
  headers: Record<string, string | null>;
  complete: boolean;
  audit: unknown[];
}
const HEADER_NAMES = [
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'x-content-type-options',
  'cache-control',
];

function normalizedHeaders(raw: Record<string, string | string[] | undefined>) {
  const one = (name: string) => {
    const value = raw[name];
    return value === undefined ? null : Array.isArray(value) ? value.join(', ') : value;
  };
  const headers: Record<string, string | null> = {};
  for (const name of HEADER_NAMES) headers[name] = one(name);
  const allowed = headers['access-control-allow-headers'];
  if (allowed) headers['access-control-allow-headers'] = allowed.replace(/\s+/g, '');
  const vary = one('vary');
  headers.vary = vary
    ? [...new Set(vary.split(',').map((v) => v.trim().toLowerCase()))].sort().join(',')
    : null;
  headers['content-type'] = one('content-type')?.split(';')[0]?.trim() ?? null;
  return headers;
}

/** Read a complete raw Node response, including intentional mid-stream cutoff. */
export async function sendProbe(port: number, probe: Probe, recorded: unknown[]): Promise<Answer> {
  const before = recorded.length;
  const answer = await new Promise<Omit<Answer, 'audit'>>((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: probe.method, path: probe.path, headers: probe.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', () => {});
        res.on('close', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown = text;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            /* Raw text remains text. */
          }
          resolve({
            status: res.statusCode ?? 0,
            body,
            headers: normalizedHeaders(res.headers),
            complete: res.complete,
          });
        });
      }
    );
    req.on('error', (error: NodeJS.ErrnoException) =>
      error.code === 'ECONNRESET'
        ? resolve({ status: 0, body: null, headers: {}, complete: false })
        : reject(error)
    );
    if (probe.chunked) req.setHeader('transfer-encoding', 'chunked');
    if (probe.body !== undefined && !probe.chunked)
      req.setHeader('content-length', Buffer.byteLength(probe.body));
    req.end(probe.body);
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { ...answer, audit: recorded.slice(before) };
}

function buildProbeApp(admission: MainRequestAdmission) {
  const app = createApiApp({ admission });
  const probe = async (c: Context<ApiEnv>) => {
    const principal = c.get('user');
    const admitted = c.get('originalAdmittedRequest');
    const scope = currentAuditActor();
    return c.json({
      method: c.req.method,
      body: readJsonBody(c) ?? null,
      user: principal ?? null,
      agent: c.get('agentIdentity')?.agentPath ?? null,
      actor: scope?.actor ?? null,
      surface: scope?.surface ?? null,
      credential: scope?.credential ?? null,
      credentialCurrent: principal
        ? admitted !== undefined && (await recheckAdmittedRequestAuth(admitted, principal))
        : null,
    });
  };
  for (const route of [
    '/api/chain-probe',
    '/api/health/chain-probe',
    '/api/health/deep/chain-probe',
  ])
    app.all(route, probe);
  app.post(RECORDING_PATH, (c) => {
    recordAudit({
      action: 'probe.recorded',
      operation: 'execute',
      outcome: 'ok',
      summary: 'probe',
    });
    return probe(c);
  });
  app.all('/api/chain-probe/throw/:kind', (c) => {
    throw THROWABLE[c.req.param('kind')]!();
  });
  app.get(RAW_PATH, (c) => {
    c.env.outgoing.writeHead(200, { 'content-type': 'text/plain' });
    c.env.outgoing.end('written to the Node response');
    return new Response(null, { headers: RESPONSE_ALREADY_SENT.headers });
  });
  app.get(MIDSTREAM_PATH, (c) => {
    c.env.outgoing.writeHead(200, { 'content-type': 'text/plain' });
    c.env.outgoing.write('partly ');
    throw new Error('failed mid-stream');
  });
  return app;
}

/** Start the real chain and own all database, listener and identity-service cleanup. */
export async function openContractFixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'dorkos-native-chain-contract-'));
  const db = createDb(path.join(home, 'auth.db'));
  let server: Server | undefined;
  try {
    runMigrations(db);
    initConfigManager(home);
    const auth = initAuth(db, home);
    const identity = initAgentIdentityService(db);
    const agentToken = await identity.mint({ agentPath: '/agents/scout', displayName: 'Scout' });
    const signUp = await auth.api.signUpEmail({
      body: { email: 'owner@dork.test', password: 'correct-horse-battery-staple', name: 'Owner' },
      asResponse: true,
    });
    if (signUp.status !== 200) throw new Error(`Real sign-up failed: ${signUp.status}`);
    const cookie = signUp.headers
      .getSetCookie()
      .map((part) => part.split(';')[0])
      .join('; ');
    const ownerId = db.select().from(user).get()!.id;
    const apiKey = (
      await auth.api.createApiKey({ body: { userId: ownerId, name: 'native-contract' } })
    ).key;
    const recorded: unknown[] = [];
    const log = new AuditLog(db);
    log.observe((event) => {
      recorded.push(event);
    });
    const accounts = new AccountIds({
      db,
      installId: 'native-contract',
      readOwnerAccount: () => db.select().from(user).get() ?? null,
    });
    initAuditTrail({ log, accounts });
    const admission = new MainRequestAdmission();
    server = createServer(frontDoorListener(buildProbeApp(admission)));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const listening = server;
    return {
      admission,
      ownerId,
      cookie,
      apiKey,
      agentToken,
      recorded,
      send: (probe: Probe) => sendProbe(port, probe, recorded),
      setLogin: (enabled: boolean) =>
        configManager.set('auth', { ...configManager.get('auth'), enabled }),
      close: async () => {
        await new Promise<void>((resolve) => listening.close(() => resolve()));
        resetAgentIdentityService();
        resetAuditTrail();
        db.$client.close();
        rmSync(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    resetAgentIdentityService();
    resetAuditTrail();
    db.$client.close();
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
}
