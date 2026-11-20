/**
 * A person's yes to a workspace's setup commands, or to its removal commands,
 * runs them, so it waits for the owner to confirm it's them (DOR-4355). A
 * request that runs no commands stays immediate.
 *
 * @vitest-environment node
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import workspaceRoutes from '../workspaces.js';
import { setWorkspaceManager } from '../../services/workspace/index.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

const WORKSPACE = {
  id: 'ws-northwind-1',
  projectKey: 'northwind',
  key: 'w1',
  path: '/made-up/workspaces/northwind/w1',
  provider: 'clone',
  source: '/made-up/northwind.git',
};
const ENSURE = {
  projectKey: 'northwind',
  key: 'w1',
  source: '/made-up/northwind.git',
  provider: 'clone',
};

describe('workspace setup confirmation', () => {
  const manager = {
    ensure: vi.fn(async () => WORKSPACE),
    get: vi.fn(async () => WORKSPACE),
    remove: vi.fn(async () => ({ removed: true })),
  };
  const owner = frontDoorStepUpHarness(() => [
    { path: '/api/workspaces', routes: workspaceRoutes },
  ]);
  beforeAll(() =>
    setWorkspaceManager(manager as unknown as Parameters<typeof setWorkspaceManager>[0])
  );
  beforeEach(() => {
    manager.ensure.mockClear();
    manager.remove.mockClear();
  });

  it('holds making a workspace whose setup commands the person allowed', async () => {
    const held = await owner
      .call('post', '/api/workspaces', 'own-tunnel')
      .send({ ...ENSURE, approvedReviewHash: 'sha256:northwind-review' });
    expect(held.status).toBe(428);
    expect(manager.ensure).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel', true)).body.code).toBe(
      'not-your-action'
    );
    expect(manager.ensure).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
      ok: true,
      status: 201,
    });
    expect(manager.ensure).toHaveBeenCalledOnce();
  });

  it('asks for a workspace with no review hash at once, since nothing runs yet', async () => {
    const res = await owner.call('post', '/api/workspaces', 'own-tunnel').send(ENSURE);
    expect(res.status).toBe(201);
    expect(res.body.heldActionId).toBeUndefined();
    expect(manager.ensure).toHaveBeenCalledOnce();
  });

  it('holds removing a workspace with the removal commands the person allowed', async () => {
    const held = await owner.call(
      'delete',
      `/api/workspaces/${WORKSPACE.id}?approvedRemoveHooks=sha256:northwind-hooks`,
      'own-tunnel'
    );
    expect(held.status).toBe(428);
    expect(manager.remove).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel', true)).body.code).toBe(
      'not-your-action'
    );
    expect(manager.remove).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
      ok: true,
      status: 200,
    });
    expect(manager.remove).toHaveBeenCalledExactlyOnceWith(
      WORKSPACE.id,
      expect.objectContaining({ approvedRemoveHooks: 'sha256:northwind-hooks' })
    );
  });

  it('removes a workspace without its removal commands at once', async () => {
    const res = await owner.call(
      'delete',
      `/api/workspaces/${WORKSPACE.id}?skipRemoveHooks=true`,
      'own-tunnel'
    );
    expect(res.status).toBe(200);
    expect(res.body.heldActionId).toBeUndefined();
    expect(manager.remove).toHaveBeenCalledOnce();
  });
});
