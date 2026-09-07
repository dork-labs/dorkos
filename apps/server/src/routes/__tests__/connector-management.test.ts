/** Caller classification and owner omission tests for connector management routes. */
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createDb, runMigrations } from '@dorkos/db';
import { initAuth } from '../../services/core/auth/index.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { initConfigManager } from '../../services/core/config-manager.js';
import { createConnectorManagementRouter } from '../connector-management.js';
import { ApiError } from '../../../../../packages/cli/src/lib/api-client.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const fixtureTarget = swappableServer();

describe('connector management routes', () => {
  const reviews = {
    create: vi.fn(),
    get: vi.fn(),
    getProgramStatus: vi.fn(),
    list: vi.fn(),
    resolve: vi.fn(),
  };
  const reconciliation = {
    preview: vi.fn(),
    apply: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    reviews.create.mockReturnValue({ reviewRequestId: 'review-a' });
    reviews.get.mockReturnValue({ reviewRequestId: 'review-a' });
    reviews.getProgramStatus.mockReturnValue({
      reviewRequestId: 'review-a',
      reviewUrl: '/connections?review=review-a',
      state: 'pending',
      expiresAt: '2026-09-06T12:15:00.000Z',
    });
    reviews.list.mockReturnValue([]);
    reviews.resolve.mockResolvedValue({ review: { reviewRequestId: 'review-a' } });
    reconciliation.preview.mockResolvedValue({ previewId: 'preview-a' });
    reconciliation.apply.mockResolvedValue({ connectionId: 'connection-a' });
  });

  function buildApp(
    options: {
      user?: RequestUser;
      verifyUser?: RequestUser | null;
      loginEnabled?: boolean;
      migrationFailed?: boolean;
      ownerUnavailable?: boolean;
    } = {}
  ) {
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      if (options.user) res.locals.user = options.user;
      next();
    });
    app.use(
      '/api/connectors',
      createConnectorManagementRouter({
        registry: {
          migrationHealth: () =>
            options.migrationFailed
              ? { status: 'migration_failed', error: 'connector migration failed' }
              : { status: 'ready', migrated: false },
        },
        reviews,
        reconciliation,
        resolveOwner: () => (options.ownerUnavailable ? undefined : OWNER),
        loginEnabled: () => options.loginEnabled ?? false,
        trustedOrigins: () => ['http://localhost:4242'],
        verifyUser: async () => options.verifyUser ?? null,
      })
    );
    return app;
  }

  it('classifies a verified API key as a program and binds the stable credential id', async () => {
    const response = await request(
      fixtureTarget.mount(
        buildApp({
          user: { userId: 'user-a', credential: 'api-key', credentialId: 'credential-a' },
          loginEnabled: true,
        })
      )
    )
      .post('/api/connectors/reviews')
      .set('Authorization', 'Bearer verified')
      .send({
        action: { version: 1, kind: 'pause', connectionId: 'connection-a' },
        idempotencyKey: 'pause-a',
      });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      reviewRequestId: 'review-a',
      reviewUrl: '/connections?review=review-a',
      state: 'pending',
      expiresAt: '2026-09-06T12:15:00.000Z',
    });
    expect(response.body).not.toHaveProperty('context');
    expect(response.body).not.toHaveProperty('action');
    expect(reviews.create).toHaveBeenCalledWith(
      { kind: 'program', requesterId: 'credential-a', owner: OWNER },
      expect.objectContaining({ idempotencyKey: 'pause-a' })
    );
  });

  it('verifies login-off API keys and returns only their requester-bound status', async () => {
    const program = {
      userId: 'user-a',
      credential: 'api-key',
      credentialId: 'credential-a',
    } as const;
    const app = fixtureTarget.mount(buildApp({ verifyUser: program }));
    await request(app)
      .post('/api/connectors/reviews')
      .set('Authorization', 'Bearer verified-login-off')
      .send({
        action: { version: 1, kind: 'pause', connectionId: 'connection-a' },
        idempotencyKey: 'pause-a',
      })
      .expect(201);
    await request(app)
      .get('/api/connectors/program/reviews/review-a')
      .set('Authorization', 'Bearer verified-login-off')
      .expect(200, {
        reviewRequestId: 'review-a',
        reviewUrl: '/connections?review=review-a',
        state: 'pending',
        expiresAt: '2026-09-06T12:15:00.000Z',
      });
    expect(reviews.getProgramStatus).toHaveBeenLastCalledWith(
      { kind: 'program', requesterId: 'credential-a', owner: OWNER },
      'review-a'
    );
  });

  it('refuses invalid and agent-bearing program status calls before reading a review', async () => {
    await request(fixtureTarget.mount(buildApp()))
      .get('/api/connectors/program/reviews/review-a')
      .expect(401, {
        error: 'This program needs a verified API key to request an account change.',
        code: 'connector_program_credential_required',
      });
    await request(fixtureTarget.mount(buildApp()))
      .get('/api/connectors/program/reviews/review-a')
      .set('Authorization', 'Bearer invalid')
      .expect(401);
    await request(
      fixtureTarget.mount(
        buildApp({
          verifyUser: {
            userId: 'user-a',
            credential: 'api-key',
            credentialId: 'credential-a',
          },
        })
      )
    )
      .get('/api/connectors/program/reviews/review-a')
      .set('Authorization', 'Bearer verified')
      .set('X-DorkOS-Agent', 'runtime-agent-token')
      .expect(403);
    expect(reviews.getProgramStatus).not.toHaveBeenCalled();
  });

  it('does not let a program or agent reach owner review and reconciliation methods', async () => {
    const program = fixtureTarget.mount(
      buildApp({
        user: { userId: 'user-a', credential: 'api-key', credentialId: 'credential-a' },
        loginEnabled: true,
      })
    );
    await request(program)
      .get('/api/connectors/reviews')
      .set('Authorization', 'Bearer verified')
      .expect(403);
    await request(fixtureTarget.mount(buildApp()))
      .post('/api/connectors/reconciliation/previews')
      .set('X-DorkOS-Agent', 'agent-a')
      .send({ connectionId: 'connection-a' })
      .expect(403);
    expect(reviews.list).not.toHaveBeenCalled();
    expect(reconciliation.preview).not.toHaveBeenCalled();
  });

  it('allows owner decisions from the app without accepting owner selectors', async () => {
    const list = await request(fixtureTarget.mount(buildApp()))
      .get('/api/connectors/reviews?state=pending')
      .expect(200);
    expect(list.body).toEqual({ reviews: [] });
    expect(reviews.list).toHaveBeenCalledWith(OWNER, 'pending');

    const response = await request(
      fixtureTarget.mount(
        buildApp({
          user: { userId: 'user-a', credential: 'cookie' },
          loginEnabled: true,
        })
      )
    )
      .post('/api/connectors/reviews/review-a/decision')
      .set('Origin', 'http://localhost:4242')
      .send({ decision: 'approved' });
    expect(response.status).toBe(200);
    expect(reviews.resolve).toHaveBeenCalledWith(OWNER, 'review-a', { decision: 'approved' });

    await request(fixtureTarget.mount(buildApp()))
      .post('/api/connectors/reconciliation/apply')
      .send({
        previewId: 'preview-a',
        grants: [],
        ownerId: 'foreign-owner',
      })
      .expect(400);
    expect(reconciliation.apply).not.toHaveBeenCalled();
  });

  it('rejects a missing program credential id and an untrusted browser origin', async () => {
    await request(
      fixtureTarget.mount(
        buildApp({
          user: { userId: 'user-a', credential: 'api-key' },
          loginEnabled: true,
        })
      )
    )
      .post('/api/connectors/reviews')
      .set('Authorization', 'Bearer verified')
      .send({
        action: { version: 1, kind: 'pause', connectionId: 'connection-a' },
        idempotencyKey: 'pause-a',
      })
      .expect(401);
    await request(fixtureTarget.mount(buildApp()))
      .get('/api/connectors/reviews')
      .set('Origin', 'https://evil.example')
      .expect(403);
    expect(reviews.create).not.toHaveBeenCalled();
    expect(reviews.list).not.toHaveBeenCalled();
  });

  it('refuses invalid bearer and approval-token signals before creating a review', async () => {
    const body = {
      action: { version: 1, kind: 'pause', connectionId: 'connection-a' },
      idempotencyKey: 'pause-a',
    };
    await request(fixtureTarget.mount(buildApp()))
      .post('/api/connectors/reviews')
      .set('Authorization', 'Bearer invalid')
      .send(body)
      .expect(401);
    await request(fixtureTarget.mount(buildApp()))
      .post('/api/connectors/reviews')
      .set('x-dorkos-approval', 'approval-token')
      .send(body)
      .expect(403);
    expect(reviews.create).not.toHaveBeenCalled();
  });

  it('puts every owner-action explanation in the field the CLI displays', async () => {
    const app = fixtureTarget.mount(buildApp());
    const reviewInput = {
      action: { version: 1, kind: 'pause', connectionId: 'connection-a' },
      idempotencyKey: 'pause-a',
    };
    const cases = [
      {
        response: await request(app)
          .post('/api/connectors/reviews')
          .set('Origin', 'https://evil.example')
          .send(reviewInput),
        code: 'connector_owner_origin_required',
        explanation: 'Open this account action from the DorkOS app.',
        mirrorsMessage: true,
      },
      {
        response: await request(app)
          .post('/api/connectors/reviews')
          .set('x-dorkos-approval', 'approval-token')
          .send(reviewInput),
        code: 'connector_owner_required',
        explanation: 'An agent or approval token cannot make account decisions.',
        mirrorsMessage: true,
      },
      {
        response: await request(app)
          .get('/api/connectors/reviews')
          .set('Origin', 'https://evil.example'),
        code: 'connector_owner_origin_required',
        explanation: 'Open this account action from the DorkOS app.',
        mirrorsMessage: true,
      },
      {
        response: await request(app)
          .get('/api/connectors/reviews')
          .set('Authorization', 'Bearer program-key'),
        code: 'connector_owner_required',
        explanation: 'Programs and agents cannot make account decisions.',
        mirrorsMessage: true,
      },
      {
        response: await request(fixtureTarget.mount(buildApp({ loginEnabled: true }))).get(
          '/api/connectors/reviews'
        ),
        code: 'operator_cookie_required',
        explanation: 'Sign in to the DorkOS app to make this account decision.',
        mirrorsMessage: true,
      },
      {
        response: await request(fixtureTarget.mount(buildApp({ ownerUnavailable: true }))).get(
          '/api/connectors/reviews'
        ),
        explanation: 'DorkOS could not verify who owns this account.',
      },
      {
        response: await request(app)
          .post('/api/connectors/reviews')
          .set('Authorization', 'Bearer invalid')
          .send(reviewInput),
        code: 'connector_program_credential_required',
        explanation: 'This program needs a verified API key to request an account change.',
      },
      {
        response: await request(
          fixtureTarget.mount(
            buildApp({
              verifyUser: {
                userId: 'user-a',
                credential: 'api-key',
                credentialId: 'credential-a',
              },
              ownerUnavailable: true,
            })
          )
        )
          .post('/api/connectors/reviews')
          .set('Authorization', 'Bearer verified')
          .send(reviewInput),
        explanation: 'DorkOS could not verify who owns this account.',
      },
      {
        response: await request(
          fixtureTarget.mount(
            buildApp({ user: { userId: 'user-a', credential: 'api-key' }, loginEnabled: true })
          )
        )
          .post('/api/connectors/reviews')
          .send(reviewInput),
        code: 'connector_program_credential_required',
        explanation: 'This program needs a verified API key to request an account change.',
      },
      {
        response: await request(app).get('/api/connectors/program/reviews/review-a'),
        code: 'connector_program_credential_required',
        explanation: 'This program needs a verified API key to request an account change.',
      },
    ];

    for (const { response, code, explanation, mirrorsMessage } of cases) {
      expect(response.status).toBe(
        code?.startsWith('connector_owner') || code === 'operator_cookie_required' ? 403 : 401
      );
      expect(response.body).toEqual({
        error: explanation,
        ...(code ? { code } : {}),
        ...(mirrorsMessage ? { message: explanation } : {}),
      });
      expect(new ApiError(response.status, response.body).message).toBe(explanation);
    }
  });

  it('fails closed before every management route when connector migration failed', async () => {
    await request(fixtureTarget.mount(buildApp({ migrationFailed: true })))
      .post('/api/connectors/reviews')
      .send({
        action: { version: 1, kind: 'pause', connectionId: 'connection-a' },
        idempotencyKey: 'pause-a',
      })
      .expect(503, {
        status: 'migration_failed',
        error: 'connector migration failed',
      });
    await request(fixtureTarget.mount(buildApp({ migrationFailed: true })))
      .post('/api/connectors/reconciliation/previews')
      .send({ connectionId: 'connection-a' })
      .expect(503);
    expect(reviews.create).not.toHaveBeenCalled();
    expect(reconciliation.preview).not.toHaveBeenCalled();
  });

  it('binds login-off review requests to a real current Better Auth API key', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-connector-review-auth-'));
    try {
      initConfigManager(tmpDir);
      const db = createDb(path.join(tmpDir, 'review-auth.db'));
      runMigrations(db);
      const auth = initAuth(db, tmpDir);
      const created = await auth.api.createApiKey({
        body: { userId: 'owner-user', name: 'connector-review' },
      });
      const app = express();
      app.use(express.json());
      app.use(
        '/api/connectors',
        createConnectorManagementRouter({
          registry: { migrationHealth: () => ({ status: 'ready', migrated: false }) },
          reviews,
          reconciliation,
          resolveOwner: (user) => (user ? { kind: 'user', userId: user.userId } : undefined),
          loginEnabled: () => false,
          trustedOrigins: () => ['http://localhost:4242'],
        })
      );

      await request(fixtureTarget.mount(app))
        .post('/api/connectors/reviews')
        .set('Authorization', `Bearer ${created.key}`)
        .send({
          action: { version: 1, kind: 'pause', connectionId: 'connection-a' },
          idempotencyKey: 'real-key',
        })
        .expect(201);
      expect(reviews.create).toHaveBeenCalledWith(
        {
          kind: 'program',
          requesterId: created.id,
          owner: { kind: 'user', userId: 'owner-user' },
        },
        expect.objectContaining({ idempotencyKey: 'real-key' })
      );

      reviews.getProgramStatus.mockClear();
      db.$client.prepare('UPDATE apikey SET enabled = 0 WHERE id = ?').run(created.id);
      await request(fixtureTarget.mount(app))
        .get('/api/connectors/program/reviews/review-a')
        .set('Authorization', `Bearer ${created.key}`)
        .expect(401);
      expect(reviews.getProgramStatus).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
