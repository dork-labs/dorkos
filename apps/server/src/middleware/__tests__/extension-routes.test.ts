import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import express, { Router } from 'express';
import { createExtensionRoutesMiddleware } from '../extension-routes.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

/** Minimal mock matching the ExtensionManager.getServerRouter interface. */
function createMockManager() {
  return {
    getServerRouter: vi.fn<(id: string) => Router | null>().mockReturnValue(null),
  };
}

type MockManager = ReturnType<typeof createMockManager>;

function createApp(manager: MockManager): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/ext/:id',
    createExtensionRoutesMiddleware(
      manager as unknown as Parameters<typeof createExtensionRoutesMiddleware>[0]
    )
  );
  return app;
}

describe('Extension Routes Middleware', () => {
  let app: express.Express;
  let manager: MockManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = createMockManager();
    app = createApp(manager);

    fixtureTarget.mount(app);
  });

  it('returns 404 when extension has no server router', async () => {
    manager.getServerRouter.mockReturnValue(null);

    const res = await request(fixtureServer).get('/api/ext/my-ext/status');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Extension 'my-ext' has no server routes" });
    expect(manager.getServerRouter).toHaveBeenCalledWith('my-ext');
  });

  it('delegates GET requests to extension router', async () => {
    const extRouter = Router();
    extRouter.get('/status', (_req, res) => {
      res.json({ ok: true, data: 'from-extension' });
    });
    manager.getServerRouter.mockReturnValue(extRouter);

    const res = await request(fixtureServer).get('/api/ext/my-ext/status');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: 'from-extension' });
    expect(manager.getServerRouter).toHaveBeenCalledWith('my-ext');
  });

  it('delegates POST requests to extension router', async () => {
    const extRouter = Router();
    extRouter.post('/action', (req, res) => {
      res.json({ received: req.body });
    });
    manager.getServerRouter.mockReturnValue(extRouter);

    const res = await request(fixtureServer)
      .post('/api/ext/test-ext/action')
      .send({ key: 'value' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: { key: 'value' } });
  });

  it('delegates nested paths to extension router', async () => {
    const extRouter = Router();
    extRouter.get('/deep/nested/path', (_req, res) => {
      res.json({ nested: true });
    });
    manager.getServerRouter.mockReturnValue(extRouter);

    const res = await request(fixtureServer).get('/api/ext/my-ext/deep/nested/path');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ nested: true });
  });

  it('handles root path of extension router', async () => {
    const extRouter = Router();
    extRouter.get('/', (_req, res) => {
      res.json({ root: true });
    });
    manager.getServerRouter.mockReturnValue(extRouter);

    const res = await request(fixtureServer).get('/api/ext/my-ext');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ root: true });
  });

  it('returns 404 with correct message for each unique extension ID', async () => {
    manager.getServerRouter.mockReturnValue(null);

    const res = await request(fixtureServer).get('/api/ext/another-ext/anything');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Extension 'another-ext' has no server routes");
    expect(manager.getServerRouter).toHaveBeenCalledWith('another-ext');
  });

  it('isolates requests between different extensions', async () => {
    const extARouter = Router();
    extARouter.get('/data', (_req, res) => {
      res.json({ source: 'ext-a' });
    });

    const extBRouter = Router();
    extBRouter.get('/data', (_req, res) => {
      res.json({ source: 'ext-b' });
    });

    manager.getServerRouter.mockImplementation((id: string) => {
      if (id === 'ext-a') return extARouter;
      if (id === 'ext-b') return extBRouter;
      return null;
    });

    const resA = await request(fixtureServer).get('/api/ext/ext-a/data');
    const resB = await request(fixtureServer).get('/api/ext/ext-b/data');

    expect(resA.body).toEqual({ source: 'ext-a' });
    expect(resB.body).toEqual({ source: 'ext-b' });
  });
});
