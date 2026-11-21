/** @vitest-environment node */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { eq, sessionMetadata, type Db } from '@dorkos/db';
import type { DoeInferenceConfig } from '@dorkos/shared/config-schema';

import { composedListener } from '../../http/__tests__/composed-listener.js';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { DoeRuntime } from '../../services/runtimes/doe/doe-runtime.js';
import { initBoundary } from '../../lib/boundary.js';
import { initConfigManager } from '../../services/core/config-manager.js';

const target = swappableServer();
const server = target.server;
const frozen: DoeInferenceConfig = {
  source: 'local',
  provider: 'local',
  protocol: 'openai-chat-completions',
  endpoint: 'http://127.0.0.1:1/v1',
  model: 'conversation-model-a',
  contextWindow: 8192,
  maxOutputTokens: 1024,
};
const current: DoeInferenceConfig = { ...frozen, model: 'current-model-b' };
let directory: string;
let db: Db;
let runtime: DoeRuntime;
const resolveModel = vi.fn(() => {
  throw new Error('Catalog and settings routes must not resolve model credentials or inference.');
});

function openRuntime() {
  runtime = new DoeRuntime({ directory, inference: () => current, resolveModel });
  runtime.setSessionSettings(runtimeRegistry);
  runtimeRegistry.register(runtime);
  runtimeRegistry.setDefault('doe');
}
function stored(id: string) {
  return db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, id)).get();
}
function patch(id: string, model: string) {
  return request(server)
    .patch(`/api/sessions/${id}`)
    .query({ cwd: directory })
    .send({ model, runtime: 'doe' });
}
beforeEach(async () => {
  directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'frozen-model-route-')));
  const dorkHome = path.join(directory, 'dork-home');
  vi.stubEnv('DORK_HOME', dorkHome);
  initConfigManager(dorkHome);
  await initBoundary(directory);
  target.mount(composedListener(new MainRequestAdmission()));
  db = createTestDb();
  runtimeRegistry.setDb(db);
  resolveModel.mockClear();
  openRuntime();
});
afterEach(async () => {
  await runtime.shutdown();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it.each(['warm', 'reopened'] as const)(
  'judges a %s conversation using its durable frozen model, not the current setup',
  async (state) => {
    const id = randomUUID();
    runtime.ensureSession(id, { cwd: directory, model: frozen.model, permissionMode: 'default' });
    // The real durable record written when a first turn freezes its inference.
    runtime.sessions.setInference(id, frozen);
    db.insert(sessionMetadata)
      .values({
        sessionId: id,
        runtime: 'doe',
        model: frozen.model,
        createdAt: new Date().toISOString(),
      })
      .run();
    if (state === 'reopened') {
      await runtime.shutdown();
      openRuntime();
    }

    const menu = await request(server).get('/api/models').query({ sessionId: id }).expect(200);
    expect(menu.body.models.map((model: { value: string }) => model.value)).toEqual([frozen.model]);
    const globalMenu = await request(server).get('/api/models').expect(200);
    expect(globalMenu.body.models.map((model: { value: string }) => model.value)).toEqual([
      current.model,
    ]);

    const accepted = await patch(id, frozen.model);
    expect(accepted.status).toBe(200);
    expect(accepted.body.model).toBe(frozen.model);
    expect(stored(id)?.model).toBe(frozen.model);
    const refused = await patch(id, current.model);
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('UNSUPPORTED_MODEL');
    expect(stored(id)?.model).toBe(frozen.model);
    expect(runtime.sessions.get(id)?.inference).toEqual(frozen);

    await runtime.shutdown();
    openRuntime();
    expect(runtime.sessions.get(id)?.session.model).toBe(frozen.model);
    expect(runtime.sessions.get(id)?.inference).toEqual(frozen);
    expect(await runtime.getCreditsProtocol(id)).toBe('openai-chat-completions');
    expect(await runtime.sessionRunsOnCredits(id)).toBe(false);
    expect(resolveModel).not.toHaveBeenCalled();
  }
);

it('uses the current setup for a new conversation with no frozen inference', async () => {
  const id = randomUUID();
  runtime.ensureSession(id, { cwd: directory, permissionMode: 'default' });
  await runtimeRegistry.saveSessionSettings(id, {});
  const accepted = await patch(id, current.model);
  expect(accepted.status).toBe(200);
  expect(stored(id)?.model).toBe(current.model);
  expect(stored(id)?.runtime).toBeNull();
  const refused = await patch(id, frozen.model);
  expect(refused.status).toBe(400);
  expect(refused.body.code).toBe('UNSUPPORTED_MODEL');
  expect(runtime.sessions.get(id)?.session.model).toBe(current.model);
  expect(runtime.sessions.get(id)?.inference).toBeUndefined();
  expect(resolveModel).not.toHaveBeenCalled();
});
