import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  BrowserActionReceiptSchema,
  BrowserInputRequestSchema,
} from '@dorkos/shared/browser-schemas';
import { parseBrowserResult } from '../../../../../../../packages/browser/src/contracts.js';
import { BrowserInputRoutes } from '../input-routes.js';
import type { BrowserControllerInput } from '../controller-input.js';

const target = swappableServer();

// Actual Express HTTP/finish boundary; constructor ports are controlled unit
// ports. This does not claim native dispatch, cookie verification or ownership.
it.each(['completed', 'rejected', 'aborted', 'uncertain'] as const)(
  'publishes the original %s input outcome once without replay or private envelope',
  async (outcome) => {
    const command = BrowserInputRequestSchema.parse({
      kind: 'input',
      requestId: 'R'.repeat(22),
      binding: {
        browserId: 'B'.repeat(22),
        browserGeneration: 1,
        tabId: 'T'.repeat(22),
        navigationGeneration: 0,
        viewportVersion: 0,
        epoch: 1,
        inputGeneration: 1,
      },
      steps: [{ kind: 'mouseMove', x: 20, y: 30 }],
    });
    const controllerId = 'C'.repeat(22);
    const original = parseBrowserResult(
      outcome === 'completed'
        ? { kind: 'action', requestId: command.requestId, binding: command.binding, outcome }
        : {
            kind: 'action',
            requestId: command.requestId,
            binding: command.binding,
            outcome,
            reason: 'dispatchFailed',
          }
    );
    if (original.kind !== 'action') throw new Error('Original input action result required');
    const input = vi.fn<ReturnType<BrowserControllerInput['capture']>['input']>(
        async () => original
      ),
      closeInput = vi.fn(async () => {});
    const captureInput = vi.fn(() => ({ input }));
    const isCurrent = vi.fn(() => true);
    const authorization = vi.fn(async () => ({ isCurrent }));
    const captureController = vi.fn(() => ({ authorization }));
    type Ports = ConstructorParameters<typeof BrowserInputRoutes>;
    const routes = new BrowserInputRoutes(
      { capture: captureInput, close: closeInput } as unknown as Ports[0],
      { capture: captureController } as unknown as Ports[1],
      () => true
    );
    onTestFinished(() => routes.close());
    const app = express();
    app.use(express.json());
    app.use('/api/browser', routes.router);
    const response = await request(target.mount(app))
      .post('/api/browser/input')
      .set('Host', '127.0.0.1:4242')
      .set('Origin', 'http://127.0.0.1:4242')
      .send({ command, controllerId });
    expect(response.status).toBe(200);
    const receipt = BrowserActionReceiptSchema.parse(response.body);
    expect(receipt).toEqual({
      requestId: command.requestId,
      binding: command.binding,
      outcome,
      ...(outcome === 'completed' ? {} : { reason: { version: 1, reason: 'dispatchFailed' } }),
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.body).not.toHaveProperty('kind');
    expect(captureInput).toHaveBeenCalledOnce();
    expect(input).toHaveBeenCalledOnce();
    expect(input.mock.calls[0]).toEqual([
      command,
      controllerId,
      undefined,
      expect.any(AbortSignal),
    ]);
    expect(captureController).toHaveBeenCalledOnce();
    expect(authorization).toHaveBeenCalledExactlyOnceWith(command.binding, controllerId, undefined);
    expect(isCurrent).toHaveBeenCalledOnce();
    await routes.close();
    expect(closeInput).toHaveBeenCalledOnce();
    expect(input).toHaveBeenCalledOnce();
  }
);
