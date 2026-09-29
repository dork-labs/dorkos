import {
  createServer,
  request,
  type IncomingMessage,
  type RequestListener,
  type Server,
} from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { WebSocket } from 'ws';
import { MainRequestAdmission } from '../main-request-admission.js';
import { startMainListener } from '../main-listener.js';
import { terminalAdmission } from '../../../../middleware/terminal-admission.js';
import { attachUpgradeRouter } from '../../streams/upgrade-router.js';
import { WorkspaceReconciler } from '../../../workspace/workspace-reconciler.js';
import { WorkspaceReconcilerLifecycle } from '../../../workspace/workspace-reconciler-lifecycle.js';
import { WorkspaceService } from '../../../workspace/workspace-service.js';
import type { WorkspaceStore } from '../../../workspace/workspace-store.js';

vi.mock('../../config-manager.js', () => ({
  configManager: { get: vi.fn(() => ({ enabled: false })) },
}));
vi.mock('../../tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));

const servers: Server[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function makeServer(handler?: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  return server;
}
function get(server: Server, pathname: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    request(
      { host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: pathname },
      resolve
    )
      .on('error', reject)
      .end();
  });
}
async function body(response: IncomingMessage) {
  let text = '';
  for await (const chunk of response) text += chunk;
  return text;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    })
  );
});

describe('main listener acquisition under terminal admission', () => {
  // A5: terminal state before acquisition must make zero listen/announcement calls.
  it('does not acquire a listener when admission was already closed', () => {
    const admission = new MainRequestAdmission();
    admission.close();
    const listen = vi.fn(() => makeServer());
    const onListening = vi.fn();
    expect(startMainListener({ admission, listen, onListening })).toBeUndefined();
    expect(listen).not.toHaveBeenCalled();
    expect(onListening).not.toHaveBeenCalled();
  });

  // A5 positive control: one real listener announces once; closing admission later preserves active work.
  it('runs the open listener callback once and leaves an already-listening server bound', async () => {
    const admission = new MainRequestAdmission();
    const app = express();
    app.use(terminalAdmission(admission));
    const entered = deferred<void>();
    const release = deferred<void>();
    app.get('/held', async (_req, res) => {
      entered.resolve();
      await release.promise;
      res.send('completed');
    });
    const onListening = vi.fn();
    const listen = vi.fn(() => {
      const server = makeServer(app);
      server.listen(0, '127.0.0.1');
      return server;
    });
    const server = startMainListener({ admission, listen, onListening })!;
    await once(server, 'listening');
    expect(listen).toHaveBeenCalledTimes(1);
    expect(onListening).toHaveBeenCalledExactlyOnceWith(server);
    const held = get(server, '/held');
    await entered.promise;
    admission.close();
    expect(server.listening).toBe(true);
    const refused = await get(server, '/held');
    expect(refused.statusCode).toBe(503);
    await body(refused);
    release.resolve();
    expect(await body(await held)).toBe('completed');
  });

  // A5: closure after listen started but before its event suppresses the whole callback and releases the late listener.
  it('closes a pending listener on listening without running startup registrations', async () => {
    const admission = new MainRequestAdmission();
    const onListening = vi.fn();
    const server = startMainListener({
      admission,
      listen: () => {
        const pending = makeServer();
        pending.listen(0, '127.0.0.1');
        return pending;
      },
      onListening,
    })!;
    const closed = once(server, 'close');
    admission.close();
    await closed;
    expect(server.listening).toBe(false);
    expect(onListening).not.toHaveBeenCalled();
  });

  // A5: listen acquisition can synchronously observe terminal transition; cleanup must not await close completion.
  it('requests close immediately for terminal acquisition without blocking the workspace fence', async () => {
    const admission = new MainRequestAdmission();
    const server = makeServer();
    const close = vi.spyOn(server, 'close').mockReturnValue(server);
    const onListening = vi.fn();
    const read = deferred<boolean>();
    vi.spyOn(WorkspaceService, 'checkoutExists').mockReturnValueOnce(read.promise);
    const removeRow = vi.fn();
    const reconciler = new WorkspaceReconciler({
      list: () => [{ id: 'held', path: '/held' }],
      removeRow,
    } as unknown as WorkspaceStore);
    const owner = new WorkspaceReconcilerLifecycle();
    owner.start(reconciler);
    const pass = reconciler.reconcile();
    startMainListener({
      admission,
      listen: () => {
        admission.close();
        return server;
      },
      onListening,
    });
    expect(close).toHaveBeenCalledTimes(1);
    // Real root order: gate close then synchronous invocation of workspace disposal.
    admission.close();
    const disposal = owner.dispose();
    expect(() => reconciler.start()).toThrow(/disposed/i);
    read.resolve(false);
    await pass;
    await expect(disposal).resolves.toEqual({ status: 'drained' });
    expect(removeRow).not.toHaveBeenCalled();
    expect(onListening).not.toHaveBeenCalled();
    close.mockRestore();
  });

  // A5: late-created ingress surfaces consume the already-terminal shared state, not fresh defaults.
  it('keeps late HTTP middleware and upgrade attachment closed on the same instance', async () => {
    const admission = new MainRequestAdmission();
    admission.close();
    const app = express();
    app.use(terminalAdmission(admission));
    const httpHandler = vi.fn();
    app.get('/probe', (_req, res) => {
      httpHandler();
      res.end();
    });
    const server = makeServer(app);
    const authorize = vi.fn();
    attachUpgradeRouter(
      server,
      [{ name: 'probe', pattern: /^\/probe$/, credential: 'bearer-of-id', authorize }],
      admission
    );
    // Test-only transport to exercise late attachment; production startMainListener would refuse listen.
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const response = await get(server, '/probe');
    expect(response.statusCode).toBe(503);
    await body(response);
    expect(httpHandler).not.toHaveBeenCalled();
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/probe`);
    ws.on('error', () => {});
    const [, refusal] = await once(ws, 'unexpected-response');
    expect(refusal.statusCode).toBe(503);
    refusal.resume();
    ws.terminate();
    expect(authorize).not.toHaveBeenCalled();
  });
});
