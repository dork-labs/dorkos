/**
 * Undoing an agent's access change gives back the access it gave up, so it
 * waits for the owner to confirm it's them (DOR-4355). The change itself only
 * ever narrows, and is made by the agent's own tools, not by this route.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations } from '@dorkos/db';
import { env } from '../../env.js';
import { createConnectorAccessChangeRoutes } from '../connector-access-changes.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

const OWNER = { kind: 'local_install', installationId: 'northwind-install' } as const;
const ORIGIN = `http://localhost:${env.DORKOS_PORT}`;
const UNDO = '/api/connectors/access-changes/change-a/undo';

describe('access change undo confirmation', () => {
  const narrowing = { undo: vi.fn(async () => ({ undoId: 'undo-a' })) };
  const owner = frontDoorStepUpHarness(() => {
    const db = createDb(':memory:');
    runMigrations(db);
    return [
      {
        path: '/api/connectors',
        routes: createConnectorAccessChangeRoutes({
          narrowing,
          db,
          resolveOwner: () => OWNER,
          loginEnabled: () => true,
          trustedOrigins: () => [ORIGIN],
        }),
      },
    ];
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['direct', 'own-tunnel', 'managed'] as const)(
    'holds an undo from %s until the owner confirms',
    async (via) => {
      const held = await owner.call('post', UNDO, via).send({});
      expect(held.status).toBe(428);
      expect(narrowing.undo).not.toHaveBeenCalled();
      expect((await owner.confirm(held.body.heldActionId, via, true)).body.code).toBe(
        'not-your-action'
      );
      expect(narrowing.undo).not.toHaveBeenCalled();
      expect((await owner.confirm(held.body.heldActionId, via)).body).toMatchObject({
        ok: true,
        status: 200,
        result: { changeId: 'change-a', undoId: 'undo-a' },
      });
      expect(narrowing.undo).toHaveBeenCalledExactlyOnceWith(OWNER, 'change-a');
    }
  );

  it('keeps an undo from Wi-Fi refused', async () => {
    const res = await owner.call('post', UNDO, 'wifi').send({});
    expect(res.status).toBe(403);
    expect(res.body.heldActionId).toBeUndefined();
    expect(narrowing.undo).not.toHaveBeenCalled();
  });

  it('reads the changes at once', async () => {
    const res = await owner.call('get', '/api/connectors/access-changes', 'own-tunnel');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ changes: [] });
  });
});
