/**
 * DOR-3403: a yes to a package's hooks covers the exact script files they run.
 * Edit a script after the yes and the yes no longer applies: below Full the
 * person is asked again with a card; on Full the package waits in one passive
 * row under Needs you, unless DorkOS installed it unchanged (DOR-3433).
 *
 * Drives the real `@dorkos/harness` scan and plan over a real temporary project.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/** A stateful stand-in for the config store, so a write is visible to the next read. */
const config: {
  harness: { autoSync: boolean; approvedHooks: string[]; refusedHooks: string[] };
  permissions: { preset: string | null };
  runtimes: { default: string };
} = {
  harness: { autoSync: true, approvedHooks: [], refusedHooks: [] },
  permissions: { preset: 'trusted' },
  runtimes: { default: 'claude-code' },
};
vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (config as Record<string, unknown>)[key],
    set: (key: string, value: unknown) => {
      (config as Record<string, unknown>)[key] = value;
    },
  },
}));

import { createTestDb } from '@dorkos/test-utils/db';
import {
  _internal,
  planWithConsent,
  scanHookRequests,
  withProvenInstalls,
} from '../project-with-consent.js';
import { hookPackagesToAskAbout, raisePassiveHookRows } from '../ask-withheld-hooks.js';
import {
  _internal as approvalInternal,
  describeHookProjectionCapability,
  summariseHookProjection,
} from '../hook-approval.js';
import {
  hookApprovalEntry,
  recordHookApproval,
  recordHookRefusal,
  storedHookDecisions,
} from '../hook-consent.js';
import { ApprovalService } from '../../core/approvals/index.js';
import { PASSIVE_APPROVAL_EXPIRES_AT } from '../../core/approvals/passive-approval.js';
import {
  setEscalationService,
  type EscalationService,
} from '../../notifications/escalation-service.js';
import { recordProjectInstall } from '../../marketplace/lib/project-install-index.js';
import { installFolderDigest } from '../../marketplace/lib/install-digest.js';

const COMMAND = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/loop.mjs"';

let repo = '';
let home = '';
let outside = '';

/** Where the staged package's install folder is. */
function pluginDir(): string {
  return join(repo, '.dork', 'plugins', 'acme');
}

/** Write a package into `dir` whose one hook runs `hooks/loop.mjs`. */
function writePackage(dir: string, command = COMMAND): void {
  mkdirSync(join(dir, '.dork'), { recursive: true });
  writeFileSync(
    join(dir, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'acme',
      version: '1.0.0',
      type: 'plugin',
      description: 'A plugin whose hook runs a script',
      layers: ['hooks'],
    })
  );
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(
    join(dir, 'hooks', 'hooks.json'),
    JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command }] }] })
  );
  writeFileSync(join(dir, 'hooks', 'loop.mjs'), 'console.log("v1");\n');
}

/** Rewrite the script the hook runs, as a package update (or an agent) would. */
function editScript(text: string): void {
  writeFileSync(join(pluginDir(), 'hooks', 'loop.mjs'), text);
}

/** The package's one hook request, scanned fresh. */
function request() {
  const [found] = scanHookRequests(repo, home);
  if (!found) throw new Error('the staged package declared no hooks');
  return found;
}

/** Whether a plan right now lets the package's hooks land. */
function allowed(): boolean {
  return planWithConsent(repo, { dorkHome: home }).withheld.length === 0;
}

/** Whether a card would go up right now. */
function wouldAsk(): boolean {
  return hookPackagesToAskAbout(planWithConsent(repo, { dorkHome: home }).withheld).length > 0;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'dor3403-repo-'));
  home = mkdtempSync(join(tmpdir(), 'dor3403-home-'));
  outside = mkdtempSync(join(tmpdir(), 'dor3403-dev-'));
  mkdirSync(join(repo, '.agents'), { recursive: true });
  writeFileSync(
    join(repo, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses: ['claude-code'] })
  );
  config.harness = { autoSync: true, approvedHooks: [], refusedHooks: [] };
  config.permissions = { preset: 'trusted' };
});

afterEach(() => {
  for (const dir of [repo, home, outside]) rmSync(dir, { recursive: true, force: true });
});

describe('a yes to package hooks is pinned to the files they run (DOR-3403)', () => {
  it('pins the script a hook names, by sha256', () => {
    writePackage(pluginDir());
    const scripts = request().scripts ?? [];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.[0]).toBe('.dork/plugins/acme/hooks/loop.mjs');
    expect(scripts[0]?.[1]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps applying while the script is unchanged', () => {
    writePackage(pluginDir());
    recordHookApproval(request());
    expect(allowed()).toBe(true);
    expect(allowed()).toBe(true);
  });

  it('below Full, editing the script after the yes asks again', () => {
    writePackage(pluginDir());
    recordHookApproval(request());
    expect(allowed()).toBe(true);

    editScript('console.log("v2");\n');

    const { withheld } = planWithConsent(repo, { dorkHome: home });
    expect(withheld.map((w) => w.reason)).toEqual(['unasked']);
    // An ordinary card, not a passive row: below Full nothing changed.
    expect(withheld[0]?.notInstalledByDorkos).toBeUndefined();
    expect(wouldAsk()).toBe(true);
  });

  it('a yes to v2 applies to v2 and replaces the yes to v1', () => {
    writePackage(pluginDir());
    recordHookApproval(request());
    editScript('console.log("v2");\n');
    recordHookApproval(request());

    expect(allowed()).toBe(true);
    expect(config.harness.approvedHooks).toEqual([hookApprovalEntry(request())]);
  });

  // Changed on purpose by DOR-3433: on Full a yes used to keep applying after
  // the script changed, so new code ran on an old yes with nobody told.
  it('on Full, an edit after the yes holds the package back in a passive row', () => {
    config.permissions = { preset: 'full' };
    writePackage(pluginDir());
    recordHookApproval(request());
    expect(wouldAsk()).toBe(false);

    editScript('console.log("v2");\n');

    expect(allowed()).toBe(false);
    const { withheld } = planWithConsent(repo, { dorkHome: home });
    expect(withheld).toMatchObject([{ reason: 'unasked', notInstalledByDorkos: true }]);
  });

  it('a yes from before pins applies once and takes today’s files', () => {
    writePackage(pluginDir());
    const { scripts: _scripts, ...unpinned } = request();
    config.harness.approvedHooks = [hookApprovalEntry(unpinned)];

    expect(allowed()).toBe(true);
    expect(config.harness.approvedHooks).toEqual([hookApprovalEntry(request())]);

    editScript('console.log("v2");\n');
    expect(allowed()).toBe(false);
  });

  it('the read-only check path never pins a yes from before pins', () => {
    writePackage(pluginDir());
    const { scripts: _scripts, ...unpinned } = request();
    const legacy = hookApprovalEntry(unpinned);
    config.harness.approvedHooks = [legacy];

    const decisions = { approved: [legacy], refused: [] };
    expect(planWithConsent(repo, { dorkHome: home, decisions }).withheld).toEqual([]);
    expect(config.harness.approvedHooks).toEqual([legacy]);
  });

  it('a no holds after the script changes, so nobody is asked again', () => {
    writePackage(pluginDir());
    recordHookRefusal(request());
    editScript('console.log("v2");\n');

    const { withheld } = planWithConsent(repo, { dorkHome: home });
    expect(withheld.map((w) => w.reason)).toEqual(['refused']);
    expect(wouldAsk()).toBe(false);
  });

  it('the card names the file and a short hash of it', () => {
    writePackage(pluginDir());
    const req = request();
    const hash = req.scripts?.[0]?.[1] ?? '';
    expect(summariseHookProjection(req)).toContain(
      `.dork/plugins/acme/hooks/loop.mjs (sha256 ${hash.slice(0, 12)})`
    );
  });

  it('hooks that name no file keep the entry they always had', () => {
    writePackage(pluginDir(), 'curl -s https://example.com/x.sh | sh');
    const req = request();
    expect(req.scripts).toBeUndefined();
    expect(hookApprovalEntry(req)).toMatch(/^acme@[0-9a-f]{64}$/);
  });

  it('a dev-linked package is not pinned, and any yes for its commands covers it', () => {
    writePackage(pluginDir());
    recordHookApproval(request());
    // The scanner marks a dev link; stand in for its registry record.
    const real = _internal.scanInstalledPlugins;
    const spy = vi
      .spyOn(_internal, 'scanInstalledPlugins')
      .mockImplementation((opts) =>
        real(opts).map((plugin) => ({ ...plugin, devLink: { path: outside } }))
      );
    try {
      expect(request().scripts).toBeUndefined();
      editScript('console.log("v2");\n');
      expect(allowed()).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

/** Record the package as DorkOS's installer does, with the folder's digest. */
async function recordInstall(): Promise<void> {
  const folder = await installFolderDigest(pluginDir());
  if (folder.kind !== 'digest') throw new Error('the staged package did not digest');
  await recordProjectInstall(home, {
    projectPath: repo,
    installRoot: pluginDir(),
    name: 'acme',
    source: 'dork-labs/marketplace',
    installDigest: folder.digest,
  });
}

describe('on Full, a yes covers exactly the files it names (DOR-3433)', () => {
  let approvals: ApprovalService;
  const arm = vi.fn();
  const SHIPPED_POLL_MS = approvalInternal.pollIntervalMs;
  const SHIPPED_SLEEP = approvalInternal.sleep;

  /** Plan the way Sync now does: prove installs, then read the server's own lists. */
  async function plan() {
    const opts = await withProvenInstalls(repo, {
      dorkHome: home,
      decisions: storedHookDecisions(),
    });
    return planWithConsent(repo, opts);
  }

  /** Sync now: plan, then raise the passive rows, and let them reach their first poll. */
  async function sync() {
    const { withheld } = await plan();
    raisePassiveHookRows(withheld, {
      projectPath: repo,
      approvals,
      reproject: async () => (await plan()).withheld,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    return withheld;
  }

  /** The short hash the row shows for the script as it is now. */
  function currentHash(): string {
    return (request().scripts?.[0]?.[1] ?? '').slice(0, 12);
  }

  beforeEach(() => {
    config.permissions = { preset: 'full' };
    approvals = new ApprovalService(createTestDb(), {
      describeCapability: describeHookProjectionCapability,
    });
    arm.mockReset();
    setEscalationService({ arm, stop: vi.fn() } as unknown as EscalationService);
    approvalInternal.pollIntervalMs = 5;
    approvalInternal.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    writePackage(pluginDir());
  });

  afterEach(async () => {
    // End every wait: a no stops the poll. Let each poll hear it before the next
    // test resets the config it would write that no into.
    for (const pending of approvals.listPending()) approvals.deny(pending.approvalId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    approvalInternal.forgetDecisions();
    approvalInternal.pollIntervalMs = SHIPPED_POLL_MS;
    approvalInternal.sleep = SHIPPED_SLEEP;
    setEscalationService(null);
  });

  it('two edits, each synced, leave one passive row, for the latest files', async () => {
    await sync();
    editScript('console.log("v2");\n');
    await sync();
    editScript('console.log("v3");\n');
    await sync();

    const pending = approvals.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.expiresAt).toBe(PASSIVE_APPROVAL_EXPIRES_AT);
    expect(pending[0]?.summary).toContain(currentHash());
    expect(arm).not.toHaveBeenCalled();
    // Closing the older rows recorded no refusal.
    expect(config.harness.refusedHooks).toEqual([]);
  });

  it('a yes on the row runs that version; a later edit withholds again with one row', async () => {
    await sync();
    approvals.grant(approvals.listPending()[0]!.approvalId);
    await vi.waitFor(() =>
      expect(config.harness.approvedHooks).toEqual([hookApprovalEntry(request())])
    );
    expect((await plan()).withheld).toEqual([]);

    editScript('console.log("v2");\n');
    const withheld = await sync();
    expect(withheld).toMatchObject([{ reason: 'unasked', notInstalledByDorkos: true }]);
    const pending = approvals.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.summary).toContain(currentHash());
    expect(arm).not.toHaveBeenCalled();
  });

  it('a stale yes stays withheld, with no card or push, and leaves one row for today’s files', async () => {
    await sync();
    const [stale] = approvals.listPending();
    // The package moves on while its row is open, then the row is allowed.
    editScript('console.log("v2");\n');
    approvals.grant(stale!.approvalId);

    await vi.waitFor(() => {
      const pending = approvals.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.approvalId).not.toBe(stale!.approvalId);
    });
    const [row] = approvals.listPending();
    expect(row?.expiresAt).toBe(PASSIVE_APPROVAL_EXPIRES_AT);
    expect(row?.summary).toContain(currentHash());
    expect((await plan()).withheld).toMatchObject([{ notInstalledByDorkos: true }]);
    expect(arm).not.toHaveBeenCalled();
  });

  it('a yes from before pins is pinned once by the server’s own lists, then an edit withholds', async () => {
    const { scripts: _scripts, ...unpinned } = request();
    config.harness.approvedHooks = [hookApprovalEntry(unpinned)];

    expect((await plan()).withheld).toEqual([]);
    expect(config.harness.approvedHooks).toEqual([hookApprovalEntry(request())]);

    editScript('console.log("v2");\n');
    expect((await plan()).withheld).toMatchObject([{ notInstalledByDorkos: true }]);
  });

  it('a dev link stays exempt: any yes for its commands covers it', async () => {
    const real = _internal.scanInstalledPlugins;
    const spy = vi
      .spyOn(_internal, 'scanInstalledPlugins')
      .mockImplementation((opts) =>
        real(opts).map((plugin) => ({ ...plugin, devLink: { path: outside } }))
      );
    try {
      // No pins (a dev link pins nothing), yet still a row a yes can answer.
      const before = (await plan()).withheld;
      expect(before).toMatchObject([{ notInstalledByDorkos: true }]);
      expect(before[0]?.unpinnable).toBeUndefined();
      recordHookApproval(request());
      editScript('console.log("v2");\n');
      expect((await plan()).withheld).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('a DorkOS install runs while unchanged; edited, it needs a yes for exactly its files', async () => {
    await recordInstall();
    const clean = await plan();
    expect(clean.withheld).toEqual([]);
    expect(clean.allowedAtFull).toHaveLength(1);

    // An edit breaks the install proof, so the yes has to name today's files.
    editScript('console.log("v2");\n');
    expect((await plan()).withheld).toMatchObject([{ notInstalledByDorkos: true }]);
    recordHookApproval(request());
    expect((await plan()).withheld).toEqual([]);

    editScript('console.log("v3");\n');
    expect((await plan()).withheld).toMatchObject([{ notInstalledByDorkos: true }]);
  });
});
