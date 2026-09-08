import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { readManifest } from '@dorkos/shared/manifest';
import {
  testControlRouter,
  type ConnectorRuntimeExecutionProbe,
  type ConnectorRuntimeRequestProbe,
} from '../test-control.js';
import { initBoundary } from '../../lib/boundary.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;
const SESSION_ID = 'b53cc6d0-7b42-42d2-8d90-931573d92239';
let agentPath: string;

beforeAll(async () => {
  agentPath = await initBoundary(await mkdtemp(join(tmpdir(), 'dorkos-connector-request-')));
});

describe('POST /api/test/connectors/execute-read', () => {
  it('validates and delegates an exact read target to the composed internal MCP probe', async () => {
    const probe = vi.fn<ConnectorRuntimeExecutionProbe>().mockResolvedValue({
      content: [{ type: 'text', text: '{"result":{"status":"success"}}' }],
    });
    const app = express();
    app.use(express.json());
    app.locals.connectorRuntimeExecutionProbe = probe;
    app.use('/api/test', testControlRouter);
    fixtureTarget.mount(app);

    const response = await request(fixtureServer)
      .post('/api/test/connectors/execute-read')
      .send({
        sessionId: SESSION_ID,
        agentPath,
        target: {
          connectionId: 'connection-a',
          operationRevisionId: 'revision-a',
          arguments: {},
        },
      });

    expect(response.status).toBe(200);
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        agentPath,
        target: {
          connectionId: 'connection-a',
          operationRevisionId: 'revision-a',
          arguments: {},
        },
        signal: expect.any(AbortSignal),
      })
    );
  });
});

describe('POST /api/test/seed-agent', () => {
  it('registers a stable denied-access principal in its own bounded fixture slot', async () => {
    const syncFromDisk = vi.fn().mockResolvedValue('synced');
    const app = express();
    app.use(express.json());
    app.locals.meshCore = { syncFromDisk };
    app.use('/api/test', testControlRouter);
    fixtureTarget.mount(app);

    const shared = await request(fixtureServer).post('/api/test/seed-agent').send({});
    const denied = await request(fixtureServer)
      .post('/api/test/seed-agent')
      .send({ slot: 'denied-access' });
    const repeated = await request(fixtureServer)
      .post('/api/test/seed-agent')
      .send({ slot: 'denied-access' });

    expect([shared.status, denied.status, repeated.status]).toEqual([200, 200, 200]);
    expect(denied.body).toEqual(repeated.body);
    expect(denied.body.agentId).not.toBe(shared.body.agentId);
    expect(denied.body.agentDir).not.toBe(shared.body.agentDir);
    expect(denied.body.agentDir).toBe(`${shared.body.agentDir}-denied-access`);
    await expect(readManifest(denied.body.agentDir)).resolves.toMatchObject({
      id: denied.body.agentId,
      name: 'E2E Denied Agent',
      runtime: 'codex',
    });
    expect(syncFromDisk).toHaveBeenNthCalledWith(1, shared.body.agentDir);
    expect(syncFromDisk).toHaveBeenNthCalledWith(2, denied.body.agentDir);
    expect(syncFromDisk).toHaveBeenNthCalledWith(3, denied.body.agentDir);
  });

  it('refuses caller-defined fixture slots before writing or registering an agent', async () => {
    const syncFromDisk = vi.fn().mockResolvedValue('synced');
    const app = express();
    app.use(express.json());
    app.locals.meshCore = { syncFromDisk };
    app.use('/api/test', testControlRouter);
    fixtureTarget.mount(app);

    const response = await request(fixtureServer)
      .post('/api/test/seed-agent')
      .send({ slot: '../outside' });

    expect(response.status).toBe(400);
    expect(syncFromDisk).not.toHaveBeenCalled();
  });
});

afterAll(async () => {
  await rm(agentPath, { recursive: true, force: true });
});

describe('POST /api/test/connectors/request', () => {
  it('validates input and delegates the live request to the composed internal MCP probe', async () => {
    const probe = vi.fn<ConnectorRuntimeRequestProbe>().mockResolvedValue({
      content: [{ type: 'text', text: '{"status":"denied"}' }],
    });
    const app = express();
    app.use(express.json());
    app.locals.connectorRuntimeRequestProbe = probe;
    app.use('/api/test', testControlRouter);
    fixtureTarget.mount(app);

    const response = await request(fixtureServer)
      .post('/api/test/connectors/request')
      .send({
        sessionId: SESSION_ID,
        agentPath,
        request: {
          version: 1,
          serviceSlug: 'gmail',
          reason: 'Read new customer messages.',
          requestedOperations: ['GMAIL_FETCH_EMAILS'],
          requestedEvents: ['gmail_new_message'],
        },
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      content: [{ type: 'text', text: '{"status":"denied"}' }],
    });
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        agentPath,
        request: expect.objectContaining({ serviceSlug: 'gmail' }),
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('refuses malformed requests before entering the internal listener', async () => {
    const probe = vi.fn<ConnectorRuntimeRequestProbe>();
    const app = express();
    app.use(express.json());
    app.locals.connectorRuntimeRequestProbe = probe;
    app.use('/api/test', testControlRouter);
    fixtureTarget.mount(app);

    const response = await request(fixtureServer)
      .post('/api/test/connectors/request')
      .send({ sessionId: 'not-a-session', agentPath, request: {} });

    expect(response.status).toBe(400);
    expect(probe).not.toHaveBeenCalled();
  });

  it('cancels the held internal request when the browser response disconnects', async () => {
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let markCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      markCancelled = resolve;
    });
    const probe = vi.fn<ConnectorRuntimeRequestProbe>().mockImplementation(
      ({ signal }) =>
        new Promise((_, reject) => {
          markEntered();
          signal.addEventListener(
            'abort',
            () => {
              markCancelled();
              reject(signal.reason);
            },
            { once: true }
          );
        })
    );
    const app = express();
    app.use(express.json());
    app.locals.connectorRuntimeRequestProbe = probe;
    app.use('/api/test', testControlRouter);
    fixtureTarget.mount(app);

    const browserRequest = request(fixtureServer)
      .post('/api/test/connectors/request')
      .send({
        sessionId: SESSION_ID,
        agentPath,
        request: {
          version: 1,
          serviceSlug: 'gmail',
          reason: 'Read new customer messages.',
          requestedOperations: ['GMAIL_FETCH_EMAILS'],
          requestedEvents: [],
        },
      });
    const completed = new Promise<void>((resolve) => {
      browserRequest.end(() => resolve());
    });
    await entered;
    browserRequest.abort();
    await cancelled;
    void completed;

    expect(probe).toHaveBeenCalledOnce();
  });
});
