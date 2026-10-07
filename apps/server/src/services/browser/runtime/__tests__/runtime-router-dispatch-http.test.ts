import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createProductionBrowserRuntimeRoutes } from '../runtime-routes.js';
import { isOriginalStartupRefusal } from '../startup-mode.js';

const target = swappableServer();
const paths = [
  '/diagnostics',
  '/semantic/read',
  '/files/read',
  '/canvas/present',
  '/canvas/share',
  '/viewers/issue',
  '/input',
  '/viewers/next',
  '/viewers/disconnect',
];
// Actual Express HTTP and actual child Router, with explicitly controlled constructor
// selection ports. This proves dispatch, not native custody or signed-in authorization.
it.each(paths)(
  'dispatches %s through the original Express router without registering HTTP BIND',
  async (path) => {
    const child = express.Router();
    expect(child.bind).not.toBe(Function.prototype.bind);
    const childStack = child.stack.length;
    const entered = vi.fn();
    child.post(path, (req, res) => {
      entered(req.body);
      res.json({ dispatched: path });
    });
    const selected = Object.freeze({ router: child });
    const binding = {
      browserId: 'b'.repeat(22),
      browserGeneration: 1,
      tabId: 't'.repeat(22),
      navigationGeneration: 1,
      viewportVersion: 1,
      epoch: 1,
      inputGeneration: 1,
    };
    const originalForBinding = vi.fn(() => selected);
    const originalForTicket = vi.fn(() => selected);
    const originalForAttachment = vi.fn(() => selected);
    const closeMode = vi.fn(async () => {});
    const mode = {
      close: closeMode,
      isOriginalStartupRefusal,
      modeCurrent: () => true,
      captureOwner: async () => Object.assign(() => true, { ownerId: 'fixture-owner' }),
      fenceRequests: vi.fn(),
      originalForBinding,
      originalForTicket,
      originalForAttachment,
      registry: { instances: () => [], instance: () => undefined, stop: async () => {} },
      store: { profiles: () => [] },
    };
    const routes = createProductionBrowserRuntimeRoutes(
      mode as unknown as Parameters<typeof createProductionBrowserRuntimeRoutes>[0]
    );
    onTestFinished(() => routes.close());
    const app = express();
    app.use(express.json());
    app.use('/api/browser', routes.router);
    const body =
      path === '/canvas/share'
        ? { attachmentId: 'a'.repeat(22) }
        : path === '/viewers/next' || path === '/viewers/disconnect'
          ? { ticket: 'x'.repeat(43) }
          : path === '/input'
            ? { command: { binding } }
            : { binding };
    const response = await request(target.mount(app))
      .post('/api/browser' + path)
      .send(body);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ dispatched: path });
    expect(entered).toHaveBeenCalledExactlyOnceWith(body);
    expect(child.stack).toHaveLength(childStack + 1);
    if ('attachmentId' in body)
      expect(originalForAttachment).toHaveBeenCalledExactlyOnceWith(body.attachmentId);
    else if ('ticket' in body)
      expect(originalForTicket).toHaveBeenCalledExactlyOnceWith(body.ticket);
    else expect(originalForBinding).toHaveBeenCalledExactlyOnceWith(binding);
    await routes.close();
    expect(closeMode).toHaveBeenCalledOnce();
  }
);
