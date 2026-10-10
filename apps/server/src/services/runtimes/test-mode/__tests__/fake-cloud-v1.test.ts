import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import ts from 'typescript';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import {
  BalanceSchema,
  EntitlementsSchema,
  InferenceModelsResponseSchema,
  InferenceTokenSchema,
  OffersResponseSchema,
  OrgListResponseSchema,
  SessionSchema,
  UsageResponseSchema,
  V1_ROUTES,
  v1Path,
} from '@dork-labs/cloud-api';
import { CloudApiProblemError, createCloudApiClient } from '@dork-labs/cloud-api/client';

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

    const balance = await api.get(V1_ROUTES.balance, BalanceSchema);
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

  it('answers the reads a linked app makes on its own with empty, valid answers', async () => {
    const api = client();
    const usage = await api.get(V1_ROUTES.usage, UsageResponseSchema, {
      query: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-10T00:00:00.000Z', groupBy: 'day' },
    });
    expect(usage).toMatchObject({ groupBy: 'day', rows: [], from: '2026-10-01T00:00:00.000Z' });
    expect(await api.get(V1_ROUTES.offers, OffersResponseSchema)).toEqual({ offers: [] });
    expect(await api.get(V1_ROUTES.orgs, OrgListResponseSchema)).toEqual({
      items: [],
      nextCursor: null,
    });
    // Nothing to nudge: a described 404, which the app reads as "render nothing".
    const nudge = await api.get(V1_ROUTES.nudge, SessionSchema).catch((error: unknown) => error);
    expect(nudge).toBeInstanceOf(CloudApiProblemError);
    expect((nudge as CloudApiProblemError).problem).toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });

  it('throws on any path it does not script — fail loud, never a silent escape', async () => {
    await expect(client().get(V1_ROUTES.priceList, SessionSchema)).rejects.toThrow(
      'fake cloud /v1: unexpected request GET /v1/price-list'
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

  it('no production module names the fakes or the fetch seam — the structural half of unreachability', () => {
    const production = [
      '../../../core/cloud/v1-client.ts',
      '../../../core/cloud/credits-inference.ts',
      '../../../core/cloud/credits-models.ts',
      '../../../core/cloud/plan.ts',
      '../../../core/auth/cloud-link.ts',
      '../../../../app.ts',
      '../../../../routes/test-control.ts',
      '../../../../routes/cloud.ts',
      '../../doe/doe-runtime.ts',
    ];
    for (const relative of production) {
      const source = fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
      for (const name of ['fake-cloud-v1', 'fake-inference', 'compose-test-cloud']) {
        expect(source, `${relative} names ${name}`).not.toContain(name);
      }
      if (!relative.endsWith('v1-client.ts')) {
        expect(source, `${relative} names setCloudV1Fetch`).not.toContain('setCloudV1Fetch');
      }
    }
  });

  it('index.ts reaches the test-mode Cloud once, through an await import() inside the DORKOS_TEST_RUNTIME branch', () => {
    const file = fileURLToPath(new URL('../../../../index.ts', import.meta.url));
    const text = fs.readFileSync(file, 'utf8');
    expect(text.split('compose-test-cloud').length - 1).toBe(1);

    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0]?.getText(source).includes('compose-test-cloud')
      ) {
        calls.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(ts.isAwaitExpression(call.parent)).toBe(true);

    // Walk up to the nearest `if`; the call must sit in its then-branch, and
    // its condition must be exactly the test-mode flag.
    let child: ts.Node = call;
    let parent: ts.Node | undefined = call.parent;
    while (parent && !ts.isIfStatement(parent)) {
      child = parent;
      parent = parent.parent;
    }
    expect(parent).toBeDefined();
    const branch = parent as ts.IfStatement;
    expect(branch.expression.getText(source)).toBe('env.DORKOS_TEST_RUNTIME');
    expect(branch.thenStatement).toBe(child);
  });
});
