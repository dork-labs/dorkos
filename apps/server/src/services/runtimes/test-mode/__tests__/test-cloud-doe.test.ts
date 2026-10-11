/**
 * @vitest-environment node
 *
 * The test-mode Cloud end to end (DOR-2783): the DorkOS runtime, on DorkOS
 * credits, mints a token from the fake `/v1` Cloud through the real `/v1`
 * client, reads the fake catalog, and completes a turn against the fake
 * inference stream served from a local listener. Nothing leaves the machine.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { StreamEvent } from '@dorkos/shared/types';
import { UserConfigSchema } from '@dorkos/shared/config-schema';

vi.mock('../../../../env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../env.js')>();
  return { env: { ...actual.env, DORKOS_TEST_RUNTIME: true } };
});
const config = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: (section: string) => config.values[section],
    set: (section: string, value: unknown) => {
      config.values[section] = value;
    },
    onChange: () => () => {},
  },
}));

import { setCloudV1Fetch } from '../../../core/cloud/v1-client.js';
import { __setCreditsStateForTests } from '../../../core/cloud/credits-inference.js';
import { DoeRuntime } from '../../doe/doe-runtime.js';
import { createFakeCloudV1Fetch, FAKE_CLOUD_MODEL } from '../fake-cloud-v1.js';
import { createFakeInferenceRouter, FAKE_INFERENCE_REPLY } from '../fake-inference.js';
import { TEST_MODE_DOE_REFUSAL, testModeDoeOptions } from '../compose-test-cloud.js';
import type { DoeInferenceConfig } from '@dorkos/shared/config-schema';

/** Never listened on: a turn that reached it would fail, so success proves the token's endpoint was used. */
const NEVER_SERVED = 'http://127.0.0.1:9/never-served/v1';

let server: Server;
let base: string;
let root: string;
const seen: Array<{ path: string; authorization: string | undefined }> = [];

beforeAll(async () => {
  const defaults = UserConfigSchema.parse({ version: 1 }) as Record<string, unknown>;
  config.values = {
    ...defaults,
    cloud: { ...(defaults.cloud as object), instanceToken: 'fake-instance-key' },
  };
  const app = express()
    .use(express.json({ limit: '1mb' }))
    .use((req, _res, next) => {
      seen.push({ path: req.path, authorization: req.headers.authorization });
      next();
    })
    .use('/api/test/fake-inference', createFakeInferenceRouter());
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/test/fake-inference/v1`;
  setCloudV1Fetch(createFakeCloudV1Fetch({ inferenceBaseUrl: base }));
  // Anything bound off this machine is a failure, not a request.
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== '127.0.0.1') throw new Error(`left the machine: ${url.href}`);
    return realFetch(input, init);
  });
  __setCreditsStateForTests({ token: null });
  root = await realpath(await mkdtemp(join(tmpdir(), 'test-cloud-doe-')));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  setCloudV1Fetch(undefined);
  __setCreditsStateForTests({ token: null });
  server.close();
  await rm(root, { recursive: true, force: true });
});

function runtimeFor(cwd: string, inference: DoeInferenceConfig): DoeRuntime {
  return new DoeRuntime({
    ...testModeDoeOptions(),
    directory: join(cwd, '..', `runtime-${randomUUID()}`),
    defaultCwd: cwd,
    inference: () => inference,
  });
}

describe('the DorkOS runtime on the test-mode Cloud', () => {
  it('completes a credits turn with the canned reply, paid by the fake token', async () => {
    const cwd = join(root, 'project');
    await mkdir(cwd);
    const runtime = runtimeFor(cwd, {
      source: 'dorkos-credits',
      provider: 'dorkos',
      protocol: 'openai-chat-completions',
      endpoint: NEVER_SERVED,
      model: FAKE_CLOUD_MODEL.id,
      contextWindow: FAKE_CLOUD_MODEL.contextWindow,
      maxOutputTokens: FAKE_CLOUD_MODEL.maxOutputTokens,
    });
    try {
      const id = randomUUID();
      runtime.ensureSession(id, { cwd, permissionMode: 'default' });
      const events: StreamEvent[] = [];
      for await (const event of runtime.sendMessage(id, 'Build me a CRM')) events.push(event);

      const errors = events.filter((event) => event.type === 'error');
      expect(errors).toEqual([]);
      const text = events
        .filter((event) => event.type === 'text_delta')
        .map((event) => (event.data as { text: string }).text)
        .join('');
      expect(text).toBe(FAKE_INFERENCE_REPLY.join(''));
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);

      const completions = seen.filter((entry) => entry.path.endsWith('/v1/chat/completions'));
      expect(completions).toHaveLength(1);
      expect(completions[0]!.authorization).toBe('Bearer fake-inference-token');
    } finally {
      await runtime.shutdown();
    }
  }, 30_000);

  it('refuses a turn on an own key or a local model before anything is sent', async () => {
    const cwd = join(root, 'refused');
    await mkdir(cwd);
    for (const source of ['local', 'api-key'] as const) {
      const before = seen.length;
      const runtime = runtimeFor(cwd, {
        source,
        provider: 'fixture',
        protocol: 'openai-chat-completions',
        endpoint: `${base}`,
        model: FAKE_CLOUD_MODEL.id,
        contextWindow: FAKE_CLOUD_MODEL.contextWindow,
        maxOutputTokens: FAKE_CLOUD_MODEL.maxOutputTokens,
      });
      try {
        const id = randomUUID();
        runtime.ensureSession(id, { cwd, permissionMode: 'default' });
        const events: StreamEvent[] = [];
        for await (const event of runtime.sendMessage(id, 'Hello')) events.push(event);
        const errors = events.filter((event) => event.type === 'error');
        expect(JSON.stringify(errors), source).toContain(TEST_MODE_DOE_REFUSAL);
        expect(
          events.some((event) => event.type === 'text_delta'),
          source
        ).toBe(false);
        expect(seen.length, `${source} reached an endpoint`).toBe(before);
      } finally {
        await runtime.shutdown();
      }
    }
  }, 30_000);
});
