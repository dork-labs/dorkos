/**
 * The hub login pin wired through a real `ConfigManager` on a temp directory:
 * every read path reports login on, whatever the file holds, and a write that
 * would turn it off is refused before it reaches the file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const role = vi.hoisted(() => ({ value: 'computer' as 'computer' | 'hub' }));
vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));

import { ConfigManager } from '../../config-manager.js';
import { HUB_LOGIN_ALWAYS_ON } from '../hub-settings.js';

let dir: string;

/** A manager over a fresh directory whose file says login is off. */
function managerWithLoginOff(): ConfigManager {
  const manager = new ConfigManager(dir);
  manager.set('auth', { ...manager.get('auth'), enabled: false });
  role.value = 'hub';
  return manager;
}

describe('the hub login pin through ConfigManager', () => {
  beforeEach(() => {
    role.value = 'computer';
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-settings-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads login as on through get, getDot and getAll at a hub', () => {
    const manager = managerWithLoginOff();
    expect(manager.get('auth').enabled).toBe(true);
    expect(manager.getDot('auth.enabled')).toBe(true);
    expect(manager.getAll().auth.enabled).toBe(true);
  });

  it('reads the file as it is on a person`s own computer', () => {
    const manager = managerWithLoginOff();
    role.value = 'computer';
    expect(manager.get('auth').enabled).toBe(false);
    expect(manager.getDot('auth.enabled')).toBe(false);
    expect(manager.getAll().auth.enabled).toBe(false);
  });

  it('refuses a write turning login off at a hub, and leaves the file alone', () => {
    const manager = new ConfigManager(dir);
    manager.set('auth', { ...manager.get('auth'), enabled: true });
    role.value = 'hub';
    expect(() => manager.setDot('auth.enabled', false)).toThrow(HUB_LOGIN_ALWAYS_ON);
    expect(() => manager.set('auth', { ...manager.get('auth'), enabled: false })).toThrow(
      HUB_LOGIN_ALWAYS_ON
    );
    role.value = 'computer';
    expect(manager.get('auth').enabled).toBe(true);
  });
});
