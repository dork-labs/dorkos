/**
 * Whether an app's screens run, by the extension manager's records (DOR-3293).
 * The question an "opened by" mark asks before it is written.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initConfigManager } from '../../services/core/config-manager.js';

// A fresh config: nothing approved to run, so only core apps pass the approval bar.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-app-screen-runs-'));
beforeAll(() => {
  initConfigManager(configDir);
});
afterAll(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

import type { ExtensionManager } from '../../services/extensions/extension-manager.js';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { appScreenRunsIn } from '../app-screen-runs.js';

const record = (id: string, overrides: Partial<ExtensionRecord>): ExtensionRecord =>
  ({
    id,
    origin: 'core',
    status: 'active',
    bundleReady: true,
    manifest: { id, name: id, version: '1.0.0' },
    ...overrides,
  }) as ExtensionRecord;

const records = new Map<string, ExtensionRecord>([
  ['desk', record('desk', {})],
  ['compiled', record('compiled', { status: 'compiled' })],
  ['off', record('off', { status: 'disabled' })],
  ['broken', record('broken', { status: 'compile_error' })],
  ['no-bundle', record('no-bundle', { bundleReady: false })],
  ['unapproved', record('unapproved', { origin: 'user', path: '/x/unapproved' })],
]);
const runs = appScreenRunsIn({ get: (id: string) => records.get(id) } as ExtensionManager);

describe('appScreenRunsIn', () => {
  it('says yes for an app that is on, compiled and allowed to show its screens', () => {
    expect(runs('desk')).toBe(true);
    expect(runs('compiled')).toBe(true);
  });

  it('says no for an app that is missing, off, broken, unbuilt or not approved', () => {
    for (const id of ['no-such-app', 'off', 'broken', 'no-bundle', 'unapproved']) {
      expect(runs(id), id).toBe(false);
    }
  });
});
