import { it, expect, vi, onTestFinished } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.101.0';
});
import { ConfigManager } from '../config-manager.js';
import { SERVER_VERSION } from '../../../lib/version.js';
it.each([undefined, true])(
  'persists the new Chrome choice on actual upgrade boot (%s)',
  (choice) => {
    expect(SERVER_VERSION).toBe('0.101.0');
    const dir = mkdtempSync(join(tmpdir(), 'dork-chrome-choice-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        browser: { enabled: false, ...(choice === undefined ? {} : { chromeUserAgent: choice }) },
        __internal__: { migrations: { version: '0.100.0' } },
      })
    );
    new ConfigManager(dir);
    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    expect(persisted.browser).toEqual({ enabled: false, chromeUserAgent: choice === true });
  }
);
