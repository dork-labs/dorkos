/**
 * Pins a protection Dorian kept in the trusted-by-default reset (DOR-2735). If
 * this fails after a default flip, the flip leaked power to outsiders — fix the
 * flip, not this test.
 *
 * The protection: DorkOS is never reachable from beyond this machine — a
 * tunnel, or a non-loopback bind — without a login. Since ADR 261015-125850
 * (rules 2 and 3, DOR-2967) that is two facts rather than one switch: exposure
 * needs an owner account, and every request from another device is asked for
 * that owner's session whatever "Ask for a password on this computer too"
 * says. With agents at full power this matters more, not less: an exposed,
 * login-free instance hands those agents to anyone who finds the address.
 *
 * `exposure-guard.test.ts` covers the predicate over mocked config. This file
 * adds the reset's angle: the guard and the gate read the REAL config store,
 * set to the most permissive agent posture this install can hold (Full
 * autonomy as the standing stop, the acknowledgement on file, the Full preset
 * with every area Allowed), and none of that may stand in for a login.
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

describe('exposure stays behind an owner login, whatever power the agents have', () => {
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
      trustNoticeSeenAt: STAMP,
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

  it('refuses a tunnel and a public bind with no owner account, whatever this computer asks', async () => {
    owner.exists = false;
    for (const askOnThisComputer of [false, true]) {
      await setLogin(askOnThisComputer);
      const { canExpose, checkBindAllowed } = await guard();
      expect(canExpose()).toBe(false);
      expect(
        checkBindAllowed({
          host: '0.0.0.0',
          exposureAllowed: canExpose(),
          allowInsecureBind: false,
        }).allowed
      ).toBe(false);
    }
  });

  it('exposes with an owner and the this-computer password off, but every other device is asked to sign in', async () => {
    // The old switch refused this; the per-request gate is what makes it safe.
    await setLogin(false);
    const { canExpose } = await guard();
    expect(canExpose()).toBe(true);

    const { gateAccessFor } = await import('../gate-policy.js');
    const tunnel = { headers: { host: 'localhost:4242' }, peerAddress: '127.0.0.1' };
    expect(gateAccessFor({ ...tunnel, ingress: 'own-tunnel' })).toBe('credential');
    expect(gateAccessFor({ ...tunnel, ingress: 'managed' })).toBe('credential');
    expect(
      gateAccessFor({
        headers: { host: '192.168.1.20:4243' },
        peerAddress: '192.168.1.31',
        ingress: 'wifi',
      })
    ).toBe('credential');
    expect(
      gateAccessFor({
        headers: { host: '203.0.113.5:4242' },
        peerAddress: '203.0.113.9',
        ingress: 'direct',
      })
    ).toBe('credential');
  });

  it('refuses with the this-computer password on but no owner account', async () => {
    await setLogin(true);
    owner.exists = false;
    const { canExpose } = await guard();
    expect(canExpose()).toBe(false);
  });

  it('allows exposure once an owner exists, the password asked on this computer too (the control)', async () => {
    await setLogin(true);
    const { canExpose } = await guard();
    expect(canExpose()).toBe(true);
  });
});
