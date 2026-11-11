/**
 * Whether an app's screens run, by the extension manager's records (DOR-3293).
 * The question an "opened by" mark asks before it is written.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue({ approvedToRun: [], approvedSources: {} }) },
}));

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
