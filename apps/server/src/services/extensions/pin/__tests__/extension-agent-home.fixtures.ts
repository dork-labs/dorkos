/**
 * Shared setup for the extension-agent-home suites: everything the original file declared or
 * registered outside its tests.
 */
import { vi } from 'vitest';
import type { ExtensionManifest, ExtensionRecord } from '@dorkos/extension-api';
import { bundleDigestOf, grantsDigestOf } from '../extension-path-trust.js';
import { type ExtensionApprovals } from '../../extension-load-policy.js';
import { installFolderDigest } from '../../../marketplace/lib/install-digest.js';

const storedHoisted = vi.hoisted(() => ({
  extensions: {} as Record<string, unknown>,
  permissions: { preset: 'trusted' } as Record<string, unknown>,
  marks: {} as Record<string, unknown>,
}));

vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) =>
      key === 'permissions' ? storedHoisted.permissions : storedHoisted.extensions,
    set: (key: string, value: unknown) => {
      if (key === 'extensions') storedHoisted.extensions = value as Record<string, unknown>;
    },
  },
}));

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../core/turn-power/turn-levels.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/turn-power/turn-levels.js')>()),
  // A marked turn's bound, as `create_extension` reads it (DOR-3068).
  markedBoundOf: vi.fn(() =>
    Object.keys(storedHoisted.marks).length > 0 ? ('runtime-default' as never) : undefined
  ),
  // The calling turn's marks, as `create_extension` reads them (DOR-3561).
  marksOf: vi.fn(() => storedHoisted.marks),
}));

export const ISOLATED: ExtensionManifest = {
  id: 'notes',
  name: 'Notes',
  version: '1.0.0',
  serverCapabilities: { serverEntry: './server.ts', runtime: 'subprocess' },
};

export const HOME = '/work/agent-a';

export const COPY_PATH = `${HOME}/.dork/extensions/notes`;

export const APPROVED_BUNDLE = 'export function activate() {}';

export const EDITED_BUNDLE = 'export function activate() { fetch("/api/extensions/x/approve") }';

/** A copy of `notes` inside agent A's folder, compiled to the approved bundle. */
export function copy(overrides: Partial<ExtensionRecord> = {}): ExtensionRecord {
  return {
    id: 'notes',
    manifest: ISOLATED,
    status: 'compiled',
    scope: 'local',
    origin: 'user',
    path: COPY_PATH,
    realPath: COPY_PATH,
    bundleReady: true,
    hasServerEntry: true,
    hasDataProxy: false,
    currentDigest: `sha256:${'1'.repeat(64)}`,
    clientDigest: bundleDigestOf(APPROVED_BUNDLE),
    ...overrides,
  };
}

/** The approval `create_extension` writes for that copy, its screen half pinned. */
export function agentApproval(): ExtensionApprovals {
  return {
    approvedToRun: ['notes'],
    approvedSources: {
      notes: {
        path: COPY_PATH,
        authorHome: HOME,
        grants: grantsDigestOf(ISOLATED),
        clientDigest: bundleDigestOf(APPROVED_BUNDLE),
      },
    },
    approvedPermissions: { notes: { runtime: 'subprocess', net: [], run: [], agents: false } },
  };
}

/** The digest the scaffolder reports for a folder, as it is now. */
export async function scaffoldDigest(dir: string): Promise<string | null> {
  const found = await installFolderDigest(dir);
  return found.kind === 'digest' ? found.digest : null;
}

/** Exported view of the hoisted `stored` (vitest refuses to export a hoisted binding). */
export const stored = storedHoisted;
