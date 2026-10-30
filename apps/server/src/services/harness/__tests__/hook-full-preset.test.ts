/**
 * DOR-3422: on Full nothing new asks. A package's project hooks that nobody has
 * decided about run, with one Activity line instead of a card. Below Full the
 * card stays, and a no still holds on Full.
 *
 * Drives the real `@dorkos/harness` scan, plan and apply over a real temporary project.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  permissions: { preset: 'full' },
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

import {
  planWithConsent,
  projectWithConsent,
  resetAllowedAtFullReports,
  scanHookRequests,
} from '../project-with-consent.js';
import { hookPackagesToAskAbout } from '../ask-withheld-hooks.js';
import {
  HOOK_PROJECTION_CAPABILITY_ID,
  HOOK_PROJECTION_CAPABILITY_TITLE,
} from '../hook-approval.js';
import { readHookDecisionsFromDisk, recordHookRefusal } from '../hook-consent.js';
import { setMarkedFullActivity } from '../../core/turn-power/full-autonomy.js';

const COMMAND = 'echo done';

let repo = '';
let home = '';
const emit = vi.fn();

/** Stage a project that syncs to Claude Code, with one package whose Stop hook runs a command. */
function stagePackage(): void {
  mkdirSync(join(repo, '.agents'), { recursive: true });
  writeFileSync(
    join(repo, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses: ['claude-code'] })
  );
  const dir = join(repo, '.dork', 'plugins', 'acme');
  mkdirSync(join(dir, '.dork'), { recursive: true });
  writeFileSync(
    join(dir, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'acme',
      version: '1.0.0',
      type: 'plugin',
      description: 'A plugin with a hook',
      layers: ['hooks'],
    })
  );
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(
    join(dir, 'hooks', 'hooks.json'),
    JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: COMMAND }] }] })
  );
}

/** Whether the hook landed in the Claude Code settings file. */
function hookInstalled(): boolean {
  const path = join(repo, '.claude', 'settings.local.json');
  return existsSync(path) && readFileSync(path, 'utf8').includes(COMMAND);
}

/** Project the way a trigger does, and say whether a card would go up after it. */
function project(): { asks: boolean } {
  const { withheld } = projectWithConsent(repo, { dorkHome: home, sweepOrphans: false });
  return { asks: hookPackagesToAskAbout(withheld).length > 0 };
}

/** The `agent.full_action` rows written so far. */
function fullActionRows(): Record<string, unknown>[] {
  return emit.mock.calls
    .map(([event]) => event as Record<string, unknown>)
    .filter((event) => event.eventType === 'agent.full_action');
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'dor3422-repo-'));
  home = mkdtempSync(join(tmpdir(), 'dor3422-home-'));
  config.harness = { autoSync: true, approvedHooks: [], refusedHooks: [] };
  config.permissions = { preset: 'full' };
  emit.mockReset();
  setMarkedFullActivity({ emit });
  resetAllowedAtFullReports();
  stagePackage();
});

afterEach(() => {
  setMarkedFullActivity(undefined);
  for (const dir of [repo, home]) rmSync(dir, { recursive: true, force: true });
});

describe('on Full, package hooks nobody decided about run without a card (DOR-3422)', () => {
  it('runs a never-approved hook on Full, with no card and one Activity line', () => {
    expect(project().asks).toBe(false);
    expect(hookInstalled()).toBe(true);

    const rows = fullActionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: 'agent.full_action',
      category: 'permissions',
      resourceType: 'package',
      resourceId: 'acme',
      resourceLabel: HOOK_PROJECTION_CAPABILITY_TITLE,
      metadata: expect.objectContaining({ actionId: HOOK_PROJECTION_CAPABILITY_ID, count: 1 }),
    });
    expect(String(rows[0]?.summary)).toContain('DorkOS is set to Full');
    // The row carries no command text: a command line can carry a token.
    expect(JSON.stringify(rows[0])).not.toContain(COMMAND);
  });

  it('writes the line once, however often the project is projected again', () => {
    project();
    project();
    project();
    expect(fullActionRows()).toHaveLength(1);
  });

  it('records no yes, so moving below Full puts the card back', () => {
    project();
    expect(config.harness.approvedHooks).toEqual([]);

    config.permissions = { preset: 'trusted' };
    expect(project().asks).toBe(true);
  });

  it.each(['trusted', 'balanced', 'careful', null])('below Full (%s) it still cards', (preset) => {
    config.permissions = { preset };
    expect(project().asks).toBe(true);
    expect(hookInstalled()).toBe(false);
    expect(fullActionRows()).toEqual([]);
  });

  it('a no stays withheld on Full, with no card', () => {
    const [request] = scanHookRequests(repo, home);
    if (!request) throw new Error('the staged package declared no hooks');
    recordHookRefusal(request);

    const { withheld } = projectWithConsent(repo, { dorkHome: home, sweepOrphans: false });
    expect(withheld.map((w) => w.reason)).toEqual(['refused']);
    expect(hookPackagesToAskAbout(withheld)).toEqual([]);
    expect(hookInstalled()).toBe(false);
    expect(fullActionRows()).toEqual([]);
  });

  it('lists passed in say Full themselves: the --check path reads it off disk', () => {
    const notFull = planWithConsent(repo, {
      dorkHome: home,
      decisions: { approved: [], refused: [] },
    });
    expect(notFull.withheld.map((w) => w.reason)).toEqual(['unasked']);

    const full = planWithConsent(repo, {
      dorkHome: home,
      decisions: { approved: [], refused: [], full: true },
    });
    expect(full.withheld).toEqual([]);
    expect(full.allowedAtFull?.map((r) => r.packageName)).toEqual(['acme']);
    // Planning alone writes nothing to Activity.
    expect(fullActionRows()).toEqual([]);
  });

  it('reads Full off config.json for the read-only path', () => {
    const harness = { autoSync: true, approvedHooks: [], refusedHooks: [] };
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ harness, permissions: { preset: 'full' } })
    );
    expect(readHookDecisionsFromDisk(home).full).toBe(true);
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ harness, permissions: { preset: 'trusted' } })
    );
    expect(readHookDecisionsFromDisk(home).full).toBe(false);
  });
});
