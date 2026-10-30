/**
 * DOR-3403: a yes to a package's hooks covers the exact script files they run.
 * Edit a script after the yes and, below Full, the yes no longer applies and the
 * person is asked again; on Full nothing new asks.
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

import { _internal, planWithConsent, scanHookRequests } from '../project-with-consent.js';
import { hookPackagesToAskAbout } from '../ask-withheld-hooks.js';
import { summariseHookProjection } from '../hook-approval.js';
import { hookApprovalEntry, recordHookApproval, recordHookRefusal } from '../hook-consent.js';

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

  it('on Full, no card at any point, even after the script changes', () => {
    config.permissions = { preset: 'full' };
    writePackage(pluginDir());
    recordHookApproval(request());
    expect(wouldAsk()).toBe(false);

    editScript('console.log("v2");\n');

    expect(allowed()).toBe(true);
    expect(wouldAsk()).toBe(false);
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
