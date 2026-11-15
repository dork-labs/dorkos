/**
 * A hand-written config.json carries no migration stamp, and boot must accept it.
 *
 * Regression guard for #3634 (reverted): its upgrade floor refused any readable
 * file without `__internal__.migrations.version`, so a brand-new install whose
 * `config.json` was written before the server first opened it never started.
 * The packaged smoke does exactly that to name a company certificate, and so do
 * people following the company-certificate setup. The re-land of the floor
 * (DOR-4188) must keep this passing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // A release version above the floor: tests otherwise run as 0.0.0, which
  // the floor skips, and this case would pass for the wrong reason.
  process.env.DORKOS_VERSION_OVERRIDE = '0.135.10';
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '../config-manager.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('a config.json written before the server first opens it', () => {
  it('boots and keeps what the person wrote', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-config-unstamped-'));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ network: { extraCaCertsPath: '/tmp/company-ca.pem' } }, null, 2)
    );

    const manager = new ConfigManager(dir);

    expect(manager.get('network').extraCaCertsPath).toBe('/tmp/company-ca.pem');
  });
});
