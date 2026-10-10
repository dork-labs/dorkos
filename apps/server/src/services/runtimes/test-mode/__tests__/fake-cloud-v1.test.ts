import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import {
  BalanceSchema,
  EntitlementsSchema,
  InferenceModelsResponseSchema,
  InferenceTokenSchema,
  SessionSchema,
  V1_ROUTES,
  v1Path,
} from '@dork-labs/cloud-api';
import { createCloudApiClient } from '@dork-labs/cloud-api/client';

const mockEnv = vi.hoisted(() => ({ DORKOS_TEST_RUNTIME: true }));
vi.mock('../../../../env.js', () => ({ env: mockEnv }));

import { createFakeCloudV1Fetch, FAKE_CLOUD_MODEL } from '../fake-cloud-v1.js';
import { createFakeInferenceRouter, FAKE_INFERENCE_REPLY } from '../fake-inference.js';

const INFERENCE_BASE = 'http://localhost:7242/api/test/fake-inference/v1';
const client = () =>
  createCloudApiClient({
    baseUrl: 'https://cloud.example.invalid',
    token: 'fake-instance-key',
    fetch: createFakeCloudV1Fetch({ inferenceBaseUrl: INFERENCE_BASE }),
  });

describe('the test-mode /v1 Cloud', () => {
  const listener = swappableServer();
  beforeEach(() => {
    mockEnv.DORKOS_TEST_RUNTIME = true;
  });

  it('refuses to exist outside test mode', () => {
    mockEnv.DORKOS_TEST_RUNTIME = false;
    expect(() => createFakeCloudV1Fetch({ inferenceBaseUrl: INFERENCE_BASE })).toThrow(
      'createFakeCloudV1Fetch is test-mode only (DORKOS_TEST_RUNTIME)'
    );
    expect(() => createFakeInferenceRouter()).toThrow(
      'createFakeInferenceRouter is test-mode only (DORKOS_TEST_RUNTIME)'
    );
  });

  it('answers the session, the free entitlement and a balance with a card on file', async () => {
    const api = client();
    const session = await api.get(V1_ROUTES.session, SessionSchema);
    expect(session).toMatchObject({ authenticated: true, instanceId: 'capture-instance' });
    const entitlements = await api.get(V1_ROUTES.entitlements, EntitlementsSchema);
    expect(entitlements.planId).toBe('free');

    // Read raw, since the contract may not carry the field yet and would strip it.
    const raw = await createFakeCloudV1Fetch({ inferenceBaseUrl: INFERENCE_BASE })(
      `https://cloud.example.invalid${V1_ROUTES.balance}`
    );
    const balance = (await raw.json()) as Record<string, unknown>;
    expect(BalanceSchema.safeParse(balance).success).toBe(true);
    expect(balance.paymentMethodOnFile).toBe(true);
  });

  it('mints a token that serves the chat format at the local fake inference stream', async () => {
    const token = await client().post(V1_ROUTES.inferenceTokens, InferenceTokenSchema, {
      body: { instanceId: 'capture-instance' },
    });
    expect(token.served).toEqual(['openaiChat']);
    expect(token.endpoints.openaiChat).toBe(INFERENCE_BASE);
    expect(Date.parse(token.expiresAt)).toBeGreaterThan(Date.now() + 30 * 60_000);
    const revoked = await client().post(
      v1Path.inferenceTokenRevoke(token.tokenId),
      (await import('@dork-labs/cloud-api')).InferenceTokenRevokeResponseSchema,
      { body: {} }
    );
    expect(revoked).toEqual({ revoked: true });
  });

  it('lists one model, recommended on the served format', async () => {
    const catalog = await client().get(V1_ROUTES.inferenceModels, InferenceModelsResponseSchema);
    expect(catalog.models).toEqual([
      expect.objectContaining({
        ...FAKE_CLOUD_MODEL,
        protocols: ['openaiChat'],
        recommendedOn: ['openaiChat'],
      }),
    ]);
  });

  it('throws on any path it does not script — fail loud, never a silent escape', async () => {
    await expect(client().get(V1_ROUTES.usage, SessionSchema)).rejects.toThrow(
      'fake cloud /v1: unexpected request GET /v1/usage'
    );
  });

  it('the fake inference stream answers models and a streamed chat completion with usage', async () => {
    const app = express().use(express.json()).use('/fake', createFakeInferenceRouter());
    const models = await request(listener.mount(app)).get('/fake/v1/models');
    expect(models.body.data[0].id).toBe(FAKE_CLOUD_MODEL.id);

    const reply = await request(listener.mount(app))
      .post('/fake/v1/chat/completions')
      .send({ model: FAKE_CLOUD_MODEL.id, stream: true, messages: [] });
    expect(reply.headers['content-type']).toContain('text/event-stream');
    const events = reply.text
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: ') && !frame.includes('[DONE]'))
      .map((frame) => JSON.parse(frame.slice(6)));
    const text = events.map((event) => event.choices[0].delta.content ?? '').join('');
    expect(text).toBe(FAKE_INFERENCE_REPLY.join(''));
    expect(events.at(-1)).toMatchObject({
      choices: [{ finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 8 },
    });
    expect(reply.text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('no production module names the fakes — the structural half of unreachability', () => {
    const production = [
      '../../../core/cloud/v1-client.ts',
      '../../../core/cloud/credits-inference.ts',
      '../../../core/cloud/credits-models.ts',
      '../../../../app.ts',
      '../../../../routes/test-control.ts',
      '../../doe/doe-runtime.ts',
    ];
    for (const relative of production) {
      const source = fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
      for (const name of ['fake-cloud-v1', 'fake-inference', 'compose-test-cloud']) {
        expect(source, `${relative} names ${name}`).not.toContain(name);
      }
    }
    const index = fs.readFileSync(
      fileURLToPath(new URL('../../../../index.ts', import.meta.url)),
      'utf8'
    );
    // index.ts reaches the test-mode Cloud only through one gated dynamic import.
    expect(index).not.toMatch(/^import .*compose-test-cloud/m);
    expect(index).toContain("await import('./services/runtimes/test-mode/compose-test-cloud.js')");
  });
});
