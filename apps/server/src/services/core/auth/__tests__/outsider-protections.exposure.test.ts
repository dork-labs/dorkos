/**
 * Pins a protection Dorian kept in the trusted-by-default reset (DOR-2735). If
 * this fails after a default flip, the flip leaked power to outsiders — fix the
 * flip, not this test.
 *
 * The protection: DorkOS is never reachable from beyond this machine — a
 * tunnel, or a non-loopback bind — unless login is on AND an owner account
 * exists. With agents at full power this matters more, not less: an exposed,
 * login-free instance hands those agents to anyone who finds the address.
 *
 * `exposure-guard.test.ts` covers the predicate over mocked config. This file
 * adds the reset's angle: the guard reads the REAL config store, set to the
 * most permissive agent posture this install can hold (Full autonomy as the
 * standing stop, the acknowledgement on file, the Full preset with every area
 * Allowed), and none of that may stand in for a login.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PERMISSION_AREA_IDS } from '@dorkos/shared/permissions';

const owner = vi.hoisted(() => ({ exists: true }));

// The one fact read off the auth database: whether an owner account exists.
vi.mock('../index.js', () => ({ hasAnyUser: () => owner.exists }));

const STAMP = '2026-10-06T09:00:00.000Z';

describe('exposure stays behind login, whatever power the agents have', () => {
  let tmpDir: string;

  beforeEach(async () => {
    owner.exists = true;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-outsider-exposure-'));
    process.env.DORK_HOME = tmpDir;
    const config = await import('../../config-manager.js');
    config.initConfigManager(tmpDir);
    const { configManager } = config;
    configManager.set('ui', {
      ...configManager.get('ui'),
      fullPowerDecidedAt: STAMP,
      fullPowerChoice: 'full',
    });
    configManager.set('runtimes', {
      ...configManager.get('runtimes'),
      defaultTrustStop: 'autonomy',
    });
    configManager.set('permissions', {
      ...configManager.get('permissions'),
      preset: 'full',
      defaults: {
        areas: Object.fromEntries(PERMISSION_AREA_IDS.map((area) => [area, 'allowed'])),
        actions: {},
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  async function guard() {
    return import('../exposure-guard.js');
  }

  async function setLogin(enabled: boolean) {
    const { configManager } = await import('../../config-manager.js');
    configManager.set('auth', { ...configManager.get('auth'), enabled });
  }

  it('refuses a tunnel and a public bind with login off, even with an owner on disk', async () => {
    await setLogin(false);
    const { canExpose, checkBindAllowed } = await guard();
    expect(canExpose()).toBe(false);
    expect(
      checkBindAllowed({ host: '0.0.0.0', exposureAllowed: canExpose(), allowInsecureBind: false })
        .allowed
    ).toBe(false);
  });

  it('refuses with login on but no owner account', async () => {
    await setLogin(true);
    owner.exists = false;
    const { canExpose } = await guard();
    expect(canExpose()).toBe(false);
  });

  it('allows exposure once login is on and an owner exists (the control)', async () => {
    await setLogin(true);
    const { canExpose } = await guard();
    expect(canExpose()).toBe(true);
  });
});
