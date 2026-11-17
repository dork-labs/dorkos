/**
 * Widening where a Claude account may work waits for the owner to confirm it's
 * them (DOR-4355): a project allowed every account again, an account freed for
 * any project, or agents let back onto an account on their own. Narrowing a
 * rule stays immediate.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { createRuntimesRoutes } from '../runtimes.js';
import { initBoundary } from '../../lib/boundary.js';
import { configManager } from '../../services/core/config-manager.js';
import { setAccountUsageStore } from '../../services/core/usage/current-usage-store.js';
import type { AccountUsageStore } from '../../services/core/usage/account-usage-store.js';
import { resetHeldStepUpsForTests } from '../../services/core/auth/step-up/step-up-holds.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

describe('widening an account rule waits for the owner', () => {
  let tmp: string;
  let project: string;
  const owner = frontDoorStepUpHarness(() => [
    { path: '/api/runtimes', routes: createRuntimesRoutes({ activity: undefined }) },
  ]);

  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'acct-step-up-')));
    project = path.join(tmp, 'northwind.app');
    await fs.mkdir(project);
    execFileSync('git', ['init', '-q', project]);
    await initBoundary(tmp);
  });
  afterAll(async () => {
    setAccountUsageStore(undefined);
    await fs.rm(tmp, { recursive: true, force: true });
  });
  beforeEach(() => {
    resetHeldStepUpsForTests();
    setAccountUsageStore({
      listAccounts: () => [
        { id: 'northwind', label: 'Northwind', color: '#111111', implicit: false, routable: true },
        { id: 'default', label: 'Main', color: '#333333', implicit: true, routable: true },
      ],
      usageOfAccount: () => ({ state: 'ok', windows: [] }),
    } as unknown as AccountUsageStore);
    const runtimes = configManager.get('runtimes') as Record<string, unknown>;
    configManager.set('runtimes', {
      ...runtimes,
      claudeCode: {
        ...(runtimes.claudeCode as Record<string, unknown>),
        accounts: [
          {
            id: 'northwind',
            path: '/made-up/claude-northwind',
            label: 'Northwind',
            color: null,
            noAutoMove: true,
          },
        ],
        defaultAccountOnlyProjects: null,
        projectAccounts: {},
      },
    } as unknown as UserConfig['runtimes']);
  });
  const claudeCode = () =>
    (configManager.get('runtimes') as { claudeCode: Record<string, unknown> }).claudeCode;

  it('holds letting a project use every account again until the owner confirms it', async () => {
    const url = '/api/runtimes/claude-code/project-accounts';
    const narrowed = await owner
      .call('put', url, 'own-tunnel')
      .send({ project, allow: ['northwind'] });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    expect(narrowed.body.heldActionId).toBeUndefined();

    const held = await owner.call('put', url, 'own-tunnel').send({ project, allow: null });
    expect(held.status).toBe(428);
    expect(claudeCode().projectAccounts).toMatchObject({ [project]: { allow: ['northwind'] } });
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel', true)).body.code).toBe(
      'not-your-action'
    );
    expect(claudeCode().projectAccounts).toMatchObject({ [project]: { allow: ['northwind'] } });
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
      ok: true,
      status: 200,
      result: { allow: null },
    });
    expect(claudeCode().projectAccounts).not.toHaveProperty(project);
  });

  it('holds freeing an account for any project until the owner confirms it', async () => {
    const url = '/api/runtimes/claude-code/accounts/default/only-projects';
    const narrowed = await owner.call('put', url, 'managed').send({ projects: [project] });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    expect(narrowed.body.heldActionId).toBeUndefined();
    expect(claudeCode().defaultAccountOnlyProjects).toEqual([project]);

    const held = await owner.call('put', url, 'managed').send({ projects: null });
    expect(held.status).toBe(428);
    expect(claudeCode().defaultAccountOnlyProjects).toEqual([project]);
    expect((await owner.confirm(held.body.heldActionId, 'managed', true)).body.code).toBe(
      'not-your-action'
    );
    expect((await owner.confirm(held.body.heldActionId, 'managed')).body).toMatchObject({
      ok: true,
      status: 200,
      result: { onlyProjects: null },
    });
    expect(claudeCode().defaultAccountOnlyProjects ?? null).toBeNull();
  });

  it('holds letting agents move to an account on their own until the owner confirms it', async () => {
    const url = '/api/runtimes/claude-code/accounts/northwind/no-auto-move';
    const flag = () =>
      (claudeCode().accounts as { id: string; noAutoMove?: boolean }[]).find(
        (a) => a.id === 'northwind'
      )?.noAutoMove;
    const held = await owner.call('put', url, 'own-tunnel').send({ noAutoMove: false });
    expect(held.status).toBe(428);
    expect(flag()).toBe(true);
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel', true)).body.code).toBe(
      'not-your-action'
    );
    expect(flag()).toBe(true);
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
      ok: true,
      status: 200,
      result: { noAutoMove: false },
    });
    expect(flag()).toBe(false);

    // Keeping them off it again is immediate.
    const kept = await owner.call('put', url, 'own-tunnel').send({ noAutoMove: true });
    expect(kept.status).toBe(200);
    expect(kept.body.heldActionId).toBeUndefined();
    expect(flag()).toBe(true);
  });

  it('keeps a widening from Wi-Fi refused, with nothing held', async () => {
    const res = await owner
      .call('put', '/api/runtimes/claude-code/accounts/northwind/no-auto-move', 'wifi')
      .send({ noAutoMove: false });
    expect(res.status).toBe(403);
    expect(res.body.heldActionId).toBeUndefined();
  });
});
