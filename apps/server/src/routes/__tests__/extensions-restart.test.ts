/**
 * `POST /api/extensions/:id/restart` (DOR-4785): the Restart on an "is off"
 * notice does exactly what reloading that one extension does, and tells open
 * windows it changed. It never turns on an extension a person turned off.
 *
 * The manager is a narrow fake; the route runs the real shared person bar
 * before calling the reload for the id it was given and answering for it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { ApiEnv } from '../../http/api-chain.js';
import { configManager, initConfigManager } from '../../services/core/config-manager.js';
import type { ReloadExtensionResult } from '../../services/extensions/extension-manager-types.js';
import type { ExtensionRecord } from '@dorkos/extension-api';
import {
  registerExtensionRestartRoute,
  type ExtensionRestartManager,
} from '../extensions-restart.js';

/** The id pattern the extensions router passes in (`SAFE_EXT_ID`). */
const SAFE_EXT_ID = /^[a-z0-9][a-z0-9-]*$/;

let reloaded: string[];
let broadcast: string[][];
let answer: (id: string) => Promise<ReloadExtensionResult>;
/** Whether the copy on disk is one a person approved to run, before and after the reload. */
let approved: { before: boolean; after: boolean };
let serverError: { code: string; message: string } | undefined;
let router: Hono<ApiEnv>;
let user: ApiEnv['Variables']['user'];

// A throwaway config drives the real gate; no application module is mocked.
let configDir: string;
beforeAll(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-restart-route-'));
  initConfigManager(configDir);
});
afterAll(() => fs.rmSync(configDir, { recursive: true, force: true }));

beforeEach(() => {
  configManager.set('auth', { enabled: false });
  user = { userId: 'owner', credential: 'cookie' };
  reloaded = [];
  broadcast = [];
  approved = { before: true, after: true };
  serverError = undefined;
  answer = async (id) => ({ id, status: 'compiled', bundleReady: true, sourceHash: 'h' });
  const manager: ExtensionRestartManager = {
    get: (id) => (id === 'people' ? ({ id, hasServerEntry: true } as ExtensionRecord) : undefined),
    getServerHandler: () => (serverError ? null : async () => new Response('ok')),
    reloadExtension: async (id) => {
      reloaded.push(id);
      return answer(id);
    },
    listPublic: () =>
      [
        {
          id: 'people',
          approvedToRun: reloaded.length > 0 ? approved.after : approved.before,
          serverError: reloaded.length > 0 ? serverError : undefined,
        },
      ] as ReturnType<ExtensionRestartManager['listPublic']>,
  };
  router = new Hono<ApiEnv>();
  router.use(async (c, next) => {
    c.set('user', user);
    await next();
  });
  registerExtensionRestartRoute(router, manager, SAFE_EXT_ID, (ids) => broadcast.push(ids));
});

function restart(id: string, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(
    router.request(
      `/${id}/restart`,
      { method: 'POST', headers },
      {
        incoming: { headers, socket: { remoteAddress: '127.0.0.1' }, method: 'POST' },
      }
    )
  );
}

describe('POST /api/extensions/:id/restart', () => {
  it.each<[string, Record<string, string>]>([
    ['another site', { origin: 'https://other.example' }],
    ['an agent', { 'x-dorkos-agent': 'agent-token' }],
    ['an approval token', { 'x-dorkos-approval': 'approval-token' }],
  ])('refuses %s without reloading or resetting the stop budget', async (_caller, headers) => {
    const res = await restart('people', headers);
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toMatchObject({ code: 'person_only' });
    expect(reloaded).toEqual([]);
    expect(broadcast).toEqual([]);
  });

  it('requires a browser session when the gate asks for one', async () => {
    configManager.set('auth', { enabled: true });
    user = undefined;
    expect((await restart('people')).status).toBe(403);
    user = { userId: 'owner', credential: 'api-key' };
    expect((await restart('people')).status).toBe(403);
    expect(reloaded).toEqual([]);
    user = { userId: 'owner', credential: 'cookie' };
    expect((await restart('people')).status).toBe(200);
    expect(reloaded).toEqual(['people']);
  });

  it('reloads that one extension and tells open windows', async () => {
    const res = await restart('people');
    expect(res.status).toBe(200);
    expect(reloaded).toEqual(['people']);
    expect(broadcast).toEqual([['people']]);
    expect(await res.json()).toMatchObject({ id: 'people', status: 'compiled' });
  });

  it('answers 404 for an extension it does not know, and reloads nothing', async () => {
    const res = await restart('ghost');
    expect(res.status).toBe(404);
    expect(reloaded).toEqual([]);
  });

  it('refuses an id that is not an extension id', async () => {
    const res = await restart('Bad_ID');
    expect(res.status).toBe(400);
    expect(reloaded).toEqual([]);
  });

  it('says why when one turned off since is refused, and turns nothing on', async () => {
    answer = async () => {
      throw new Error("Extension 'people' is turned off, so DorkOS did not reload it.");
    };
    const res = await restart('people');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'conflict', reason: 'restart_refused' });
    expect(JSON.stringify(body)).not.toContain('did not reload it');
    expect(broadcast).toEqual([]);
  });

  it('refuses a copy nobody approved to run, and reloads nothing (Security, DOR-4785)', async () => {
    approved = { before: false, after: false };
    const res = await restart('people');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'needs_approval' });
    expect(reloaded).toEqual([]);
  });

  it('refuses when the reload finds the files changed since the yes, never a success', async () => {
    approved = { before: true, after: false };
    const res = await restart('people');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'needs_approval' });
    // Its card changed (it now waits for a person), so open windows hear of it.
    expect(broadcast).toEqual([['people']]);
  });

  it('says why when it no longer builds, and tells nobody it changed', async () => {
    answer = async (id) => ({
      id,
      status: 'compile_error',
      bundleReady: false,
      error: { code: 'compile_error', message: 'server.ts: Unexpected token' },
    });
    const res = await restart('people');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      code: 'conflict',
      detail: 'It no longer builds. Open Settings to see why.',
      reason: 'compile_error',
    });
    // The build error names files: it stays in the log, never in the answer.
    expect(JSON.stringify(body)).not.toContain('Unexpected token');
    expect(broadcast).toEqual([]);
  });

  it('never reports a restart when compilation worked but the server did not start', async () => {
    serverError = { code: 'server_start_failed', message: 'Couldn’t start the app.' };
    const res = await restart('people');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'conflict', reason: 'server_start_failed' });
    expect(broadcast).toEqual([['people']]);
  });
});
