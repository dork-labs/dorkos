/**
 * An agent's mini apps live in its own folder (DOR-3068): where
 * `create_extension` puts them, how the author is recorded, why only their
 * server half keeps path trust, and what pins them again.
 *
 * @module services/extensions/pin/__tests__/extension-agent-home
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionManifest, ExtensionRecord } from '@dorkos/extension-api';

const stored = vi.hoisted(() => ({
  extensions: {} as Record<string, unknown>,
  permissions: { preset: 'trusted' } as Record<string, unknown>,
  marks: {} as Record<string, unknown>,
}));
vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'permissions' ? stored.permissions : stored.extensions),
    set: (key: string, value: unknown) => {
      if (key === 'extensions') stored.extensions = value as Record<string, unknown>;
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
    Object.keys(stored.marks).length > 0 ? ('runtime-default' as never) : undefined
  ),
}));

import {
  bundleDigestOf,
  clientPinHolds,
  grantsDigestOf,
  keepsPathTrust,
} from '../extension-path-trust.js';
import {
  mayLoadClientHalf,
  mayRunExtensionCode,
  type ExtensionApprovals,
} from '../../extension-load-policy.js';
import { approveNewScaffold, pinScaffoldClient } from '../extension-scaffold-approval.js';
import { refreshPathTrustRun, runFromSnapshot } from '../extension-snapshot-placement.js';
import { scaffoldExtension } from '../../extension-scaffolder.js';
import { ExtensionDiscovery } from '../../extension-discovery.js';
import {
  isPendingApproval,
  listPendingExtensionApprovals,
  SCREEN_CHANGED,
} from '../../extension-approval-queue.js';
import { testClientExtension } from '../../extension-test-harness.js';
import type { ExtensionCompiler } from '../../extension-compiler.js';
import type { ExtensionManager } from '../../extension-manager.js';
import { knownProjectRootsForExtensions } from '../../../projects/extension-scan-roots.js';
import { findOperatorOnlyPaths } from '../../../core/operator/config-write-policy.js';
import { createCreateExtensionHandler } from '../../../runtimes/claude-code/mcp-tools/extension-tools.js';
import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';

const ISOLATED: ExtensionManifest = {
  id: 'notes',
  name: 'Notes',
  version: '1.0.0',
  serverCapabilities: { serverEntry: './server.ts', runtime: 'subprocess' },
};

const HOME = '/work/agent-a';
const COPY_PATH = `${HOME}/.dork/extensions/notes`;
const APPROVED_BUNDLE = 'export function activate() {}';
const EDITED_BUNDLE = 'export function activate() { fetch("/api/extensions/x/approve") }';

/** A copy of `notes` inside agent A's folder, compiled to the approved bundle. */
function copy(overrides: Partial<ExtensionRecord> = {}): ExtensionRecord {
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
function agentApproval(): ExtensionApprovals {
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

describe('the screen half is always pinned (client digest)', () => {
  it('keeps a server-only edit running, screen half included', () => {
    const serverEdit = copy({ currentDigest: `sha256:${'9'.repeat(64)}` });
    expect(mayRunExtensionCode(serverEdit, agentApproval())).toBe(true);
    expect(mayLoadClientHalf(serverEdit, agentApproval())).toBe(true);
  });

  it('withholds an edited client bundle while the server half keeps running', () => {
    const clientEdit = copy({ clientDigest: bundleDigestOf(EDITED_BUNDLE) });
    expect(mayRunExtensionCode(clientEdit, agentApproval())).toBe(true);
    expect(mayLoadClientHalf(clientEdit, agentApproval())).toBe(false);
    // Judged on the bytes about to be served, not only the last compile.
    expect(mayLoadClientHalf(copy(), agentApproval(), bundleDigestOf(EDITED_BUNDLE))).toBe(false);
  });

  it('raises a card for it (the queue counts it as waiting)', () => {
    const clientEdit = copy({ clientDigest: bundleDigestOf(EDITED_BUNDLE) });
    const approvals = { ...agentApproval(), dismissedApprovals: {} };
    expect(isPendingApproval(clientEdit, approvals)).toBe(true);
    expect(isPendingApproval(copy(), approvals)).toBe(false);
  });

  it('says so on the row in short blocks of its own', async () => {
    for (const sentence of SCREEN_CHANGED.split(/(?<=\.)\s+/)) {
      expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(15);
    }
    stored.extensions = {
      enabled: ['notes'],
      disabled: [],
      dismissedApprovals: {},
      ...agentApproval(),
    };
    const clientEdit = copy({ clientDigest: bundleDigestOf(EDITED_BUNDLE) });
    const [row] = await listPendingExtensionApprovals({
      listRecords: () => [clientEdit],
      onChange: () => () => undefined,
      dorkHome: '/nowhere',
    } as never);
    expect(row!.why).toBe(SCREEN_CHANGED);
    expect(row!.changedFiles).toEqual([]);
  });

  it('loads no screen code under a path-trust approval that pinned none', () => {
    const approvals = agentApproval();
    delete approvals.approvedSources!.notes!.clientDigest;
    expect(mayLoadClientHalf(copy(), approvals)).toBe(false);
  });

  it('leaves a copy pinned by folder digest to that digest alone', () => {
    const source = { path: COPY_PATH, digest: `sha256:${'1'.repeat(64)}` };
    expect(clientPinHolds(bundleDigestOf(EDITED_BUNDLE), source)).toBe(true);
  });

  it('refuses to run an edited client bundle in test_extension, in this process', async () => {
    stored.extensions = { enabled: ['notes'], disabled: [], ...agentApproval() };
    const compiler = {
      compile: vi.fn(async () => ({ code: EDITED_BUNDLE, sourceHash: 'h2' })),
      readBundle: vi.fn(async () => EDITED_BUNDLE),
    } as unknown as ExtensionCompiler;
    const result = await testClientExtension(copy(), compiler);
    expect(result).toMatchObject({ status: 'error', phase: 'approval' });
  });
});

describe('the author is recorded at create, never inferred', () => {
  it('pins a copy moved into another agent’s folder, even with the approval’s path', () => {
    const moved = copy({
      path: '/work/agent-b/.dork/extensions/notes',
      realPath: '/work/agent-b/.dork/extensions/notes',
    });
    const approvals = agentApproval();
    approvals.approvedSources!.notes!.path = moved.path;
    expect(keepsPathTrust(moved, approvals.approvedSources!.notes!)).toBe(false);
    expect(mayRunExtensionCode(moved, approvals)).toBe(false);
  });

  it('pins a copy in its author’s folder but outside .dork/extensions', () => {
    const elsewhere = copy({ realPath: `${HOME}/scratch/notes` });
    expect(keepsPathTrust(elsewhere, agentApproval().approvedSources!.notes!)).toBe(false);
  });

  it('pins a copy promoted or copied to the global folder', () => {
    const promoted = copy({
      scope: 'global',
      path: '/home/me/.dork/extensions/notes',
      realPath: `${HOME}/.dork/extensions/notes`,
    });
    const approvals = agentApproval();
    approvals.approvedSources!.notes!.path = promoted.path;
    expect(keepsPathTrust(promoted, approvals.approvedSources!.notes!)).toBe(false);
    expect(mayRunExtensionCode(promoted, approvals)).toBe(false);
  });

  it('keeps every approval, author included, a setting only a person may write', () => {
    expect(
      findOperatorOnlyPaths({
        extensions: { approvedSources: { notes: { path: COPY_PATH, authorHome: HOME } } },
      })
    ).toContain('extensions.approvedSources');
  });
});

describe('create_extension from an agent', () => {
  function handlerFor(creator: { agentPath?: string; sessionId?: string; ceilinged?: boolean }) {
    const createExtension = vi.fn(async () => ({
      id: 'notes',
      path: COPY_PATH,
      scope: 'local' as const,
      template: 'data-provider',
      status: 'compiled' as const,
      bundleReady: true,
      files: [],
    }));
    const deps = {
      transcriptReader: {},
      defaultCwd: '/test',
      extensionManager: { createExtension } as unknown as ExtensionManager,
    } as unknown as McpToolDeps;
    return { createExtension, handler: createCreateExtensionHandler(deps, () => creator) };
  }

  beforeEach(() => {
    stored.marks = {};
  });

  it('creates it in the agent’s own folder and records the agent as its author', async () => {
    const { createExtension, handler } = handlerFor({ agentPath: HOME, sessionId: 's1' });
    await handler({ name: 'notes', scope: 'global' });
    expect(createExtension).toHaveBeenCalledWith(
      expect.objectContaining({ agentHome: HOME, recordAuthor: true, approveIfTrusted: true })
    );
  });

  it('records no author for a turn that read a stranger’s words', async () => {
    stored.marks = { outsider: true };
    const { createExtension, handler } = handlerFor({ agentPath: HOME, sessionId: 's1' });
    await handler({ name: 'notes' });
    expect(createExtension).toHaveBeenCalledWith(
      expect.objectContaining({ agentHome: HOME, recordAuthor: false })
    );
  });

  it('records no author for a turn under a ceiling', async () => {
    const { createExtension, handler } = handlerFor({ agentPath: HOME, ceilinged: true });
    await handler({ name: 'notes' });
    expect(createExtension).toHaveBeenCalledWith(expect.objectContaining({ recordAuthor: false }));
  });
});

describe('on disk: an agent’s mini app lives in its folder and stays visible', () => {
  let tmp: string;
  let dorkHome: string;
  let agentHome: string;
  let otherFolder: string;

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ext-agent-home-')));
    dorkHome = path.join(tmp, 'dork');
    agentHome = path.join(tmp, 'agents', 'notes-bot');
    otherFolder = path.join(tmp, 'agents', 'other-bot');
    await fs.mkdir(agentHome, { recursive: true });
    await fs.mkdir(otherFolder, { recursive: true });
    stored.extensions = { enabled: [], disabled: [], approvedToRun: [] };
    stored.permissions = { preset: 'trusted' };
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('scaffolds into the agent’s home, and discovery finds it with another folder active', async () => {
    const { targetDir } = await scaffoldExtension({
      name: 'notes',
      template: 'data-provider',
      scope: 'global',
      dorkHome,
      currentCwd: otherFolder,
      agentHome,
    });
    expect(targetDir).toBe(path.join(agentHome, '.dork', 'extensions', 'notes'));

    const records = await new ExtensionDiscovery(dorkHome).discover(
      otherFolder,
      { enabled: [], disabled: [], approvedToRun: [] },
      new Map(),
      [agentHome]
    );
    expect(records.find((r) => r.id === 'notes')).toMatchObject({
      scope: 'local',
      realPath: targetDir,
    });
  });

  it('refuses an agent’s create of an id DorkOS already knows anywhere', async () => {
    await expect(
      scaffoldExtension({
        name: 'notes',
        template: 'dashboard-card',
        scope: 'global',
        dorkHome,
        currentCwd: otherFolder,
        agentHome,
        knownIds: ['notes'],
      })
    ).rejects.toThrow(/already exists/);
  });

  it('scans every registered agent’s folder, not only the registry’s project roots', async () => {
    const registry = { list: async () => [], resolve: async () => null };
    const roots = await knownProjectRootsForExtensions(
      registry as never,
      dorkHome,
      otherFolder,
      () => [agentHome, 'relative/ignored']
    );
    expect(roots).toEqual([agentHome]);
  });

  it('records the author’s real path, even when named through a link', async () => {
    const link = path.join(tmp, 'link-to-home');
    await fs.symlink(agentHome, link);
    const dir = path.join(agentHome, '.dork', 'extensions', 'notes');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(ISOLATED));
    await fs.writeFile(path.join(dir, 'server.ts'), 'export default () => {};');
    await approveNewScaffold('notes', { targetDir: dir, manifest: ISOLATED, scope: 'local' }, link);
    const source = (stored.extensions.approvedSources as Record<string, Record<string, unknown>>)
      .notes!;
    expect(source.authorHome).toBe(agentHome);
    expect(source).not.toHaveProperty('digest');
  });

  it('pins the scaffold’s first bundle only when it was built from a verified snapshot of the scaffold', () => {
    const scaffolded = `sha256:${'5'.repeat(64)}`;
    stored.extensions = {
      approvedToRun: ['notes', 'card'],
      approvedSources: {
        notes: { path: COPY_PATH, authorHome: HOME, grants: grantsDigestOf(ISOLATED) },
        card: { path: '/x/card', digest: `sha256:${'2'.repeat(64)}` },
      },
    };
    const sources = () =>
      stored.extensions.approvedSources as Record<string, Record<string, unknown>>;
    const built = {
      id: 'notes',
      clientDigest: bundleDigestOf(APPROVED_BUNDLE),
      pinnedDigest: scaffolded,
      runPath: '/snapshots/5555/notes',
    };

    // Built from other files (an edit that landed, even one reverted since),
    // or not from a snapshot at all: nothing is pinned.
    pinScaffoldClient({ ...built, pinnedDigest: `sha256:${'6'.repeat(64)}` }, scaffolded);
    pinScaffoldClient({ ...built, runPath: undefined }, scaffolded);
    expect(sources().notes).not.toHaveProperty('clientDigest');

    pinScaffoldClient(built, scaffolded);
    pinScaffoldClient({ ...built, clientDigest: bundleDigestOf(EDITED_BUNDLE) }, scaffolded);
    expect(sources().notes!.clientDigest).toBe(bundleDigestOf(APPROVED_BUNDLE));
    pinScaffoldClient({ ...built, id: 'card' }, scaffolded);
    expect(sources().card).not.toHaveProperty('clientDigest');
  });

  it('builds a path-trust copy from a verified snapshot of its files as they are now', async () => {
    const { targetDir } = await scaffoldExtension({
      name: 'notes',
      template: 'dashboard-card',
      scope: 'global',
      dorkHome,
      currentCwd: null,
      agentHome,
    });
    const approvals = {
      approvedToRun: ['notes'],
      approvedSources: {
        notes: { path: targetDir, authorHome: agentHome, grants: grantsDigestOf(ISOLATED) },
      },
    };
    const record = copy({ path: targetDir, realPath: targetDir, runPath: undefined });
    expect(await refreshPathTrustRun(dorkHome, record, approvals)).toBe(true);
    const first = record.runPath!;
    expect(first.startsWith(path.join(dorkHome, 'extension-snapshots'))).toBe(true);
    expect(await fs.readFile(path.join(first, 'index.ts'), 'utf8')).toBe(
      await fs.readFile(path.join(targetDir, 'index.ts'), 'utf8')
    );

    // An edit is copied and verified before the next build reads it.
    await fs.writeFile(path.join(targetDir, 'index.ts'), 'export function activate() { x(); }');
    await refreshPathTrustRun(dorkHome, record, approvals);
    expect(record.runPath).not.toBe(first);
    expect(await fs.readFile(path.join(record.runPath!, 'index.ts'), 'utf8')).toContain('x();');
    expect(record.pinnedDigest).toBe(record.currentDigest);
  });

  it('refuses to run a copy when its folder no longer holds the files it was checked at', async () => {
    const { targetDir, digest } = await scaffoldExtension({
      name: 'notes',
      template: 'dashboard-card',
      scope: 'global',
      dorkHome,
      currentCwd: null,
      agentHome,
    });
    await fs.writeFile(path.join(targetDir, 'index.ts'), 'export function activate() { x(); }');
    const record = copy({ path: targetDir, realPath: targetDir });
    expect(await runFromSnapshot(dorkHome, record, digest!)).toBe(false);
    expect(record.originProblem).toBe('changed');
    expect(record.runPath).toBeUndefined();
  });

  it('leaves the live record as it was when a refused yes could not snapshot it', async () => {
    const { targetDir, digest } = await scaffoldExtension({
      name: 'notes',
      template: 'dashboard-card',
      scope: 'global',
      dorkHome,
      currentCwd: null,
      agentHome,
    });
    await fs.writeFile(path.join(targetDir, 'index.ts'), 'export function activate() { x(); }');
    const origin = { plugin: 'p', source: 'acme/p' } as never;
    const record = copy({ path: targetDir, realPath: targetDir, trustedOrigin: origin });
    const before = record.currentDigest;
    expect(await runFromSnapshot(dorkHome, record, digest!, false)).toBe(false);
    expect(record.trustedOrigin).toBe(origin);
    expect(record.currentDigest).toBe(before);
    expect(record.originProblem).toBeUndefined();
  });

  it('creates in the global folder, and says so, for an agent whose folder holds the DorkOS home', async () => {
    const home = path.join(tmp, 'home');
    const result = await scaffoldExtension({
      name: 'notes',
      template: 'dashboard-card',
      scope: 'local',
      dorkHome: path.join(home, '.dork'),
      currentCwd: null,
      agentHome: home,
    });
    expect(result.scope).toBe('global');
    // No author is recorded for a global copy, so it is pinned and asks, visibly.
    await approveNewScaffold('notes', result, home);
    const source = (stored.extensions.approvedSources as Record<string, Record<string, unknown>>)
      .notes!;
    expect(source).not.toHaveProperty('authorHome');
    expect(source.digest).toMatch(/^sha256:/);
  });

  it('records no author for a folder no deny rule could name', async () => {
    const odd = path.join(tmp, 'agents', 'odd?bot');
    const dir = path.join(odd, '.dork', 'extensions', 'notes');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(ISOLATED));
    await approveNewScaffold('notes', { targetDir: dir, manifest: ISOLATED, scope: 'local' }, odd);
    const source = (stored.extensions.approvedSources as Record<string, Record<string, unknown>>)
      .notes!;
    expect(source).not.toHaveProperty('authorHome');
    expect(source.digest).toMatch(/^sha256:/);
  });

  it('pins a create made with no author (a marked turn) to its files', async () => {
    const dir = path.join(agentHome, '.dork', 'extensions', 'notes');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(ISOLATED));
    await approveNewScaffold('notes', { targetDir: dir, manifest: ISOLATED });
    const source = (stored.extensions.approvedSources as Record<string, Record<string, unknown>>)
      .notes!;
    expect(source).not.toHaveProperty('authorHome');
    expect(source.digest).toMatch(/^sha256:/);
  });
});
