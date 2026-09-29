/**
 * The saved-copies migration only makes things inert, so a global package a
 * person approved stays approved across it (DOR-2340): no hold-back after the
 * migration, and nothing approved that was not approved before.
 *
 * @vitest-environment node
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const config: { harness: { approvedHooks: string[]; refusedHooks: string[] } } = {
  harness: { approvedHooks: [], refusedHooks: [] },
};
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (config as Record<string, unknown>)[key],
    set: (key: string, value: unknown) => {
      (config as Record<string, unknown>)[key] = value;
    },
  },
}));

import {
  bindingOf,
  globalActivationEntry,
  partitionGlobalPlugins,
  readActivationState,
} from '../../../consent/global-plugin-consent.js';
import { packageContentHash } from '../../content-hash.js';
import { computeInstalledFiles, writeInstalledFiles } from '../../records/installed-files.js';
import { migrateSavedCopies } from '../migrate-saved-copies.js';
import { globalApprovalCarryOver } from '../saved-copies-consent.js';

let dorkHome: string;
let root: string;

const passThrough = <T>(_root: string, fn: () => Promise<T>) => fn();
const logger = { info: vi.fn(), warn: vi.fn() };

async function put(rel: string, content: string, mode = 0o644): Promise<void> {
  const abs = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
  await chmod(abs, mode);
}

/**
 * A global plugin as an earlier DorkOS left it after an update: a hook (so it
 * runs something and needs approval), a skill, the skill's old copy saved
 * beside it (which still loads, with its tools), a saved program in bin/, and
 * a note in bin/ the old name-based reader listed as a program.
 */
async function installOldLayout(): Promise<void> {
  const name = 'pkg';
  await put(
    '.dork/manifest.json',
    JSON.stringify({ schemaVersion: 1, type: 'plugin', name, version: '1.0.0' })
  );
  await put('.claude-plugin/plugin.json', JSON.stringify({ name, version: '1.0.0' }));
  await put(
    'hooks/hooks.json',
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } })
  );
  await put('skills/x/SKILL.md', '---\nname: x\ndescription: x\n---\nnew\n');
  await put('bin/tool', '#!/bin/sh\n', 0o755);
  await put(
    '.dork/install-metadata.json',
    JSON.stringify({
      name,
      version: '1.0.0',
      type: 'plugin',
      installedAt: '2026-09-24T00:00:00.000Z',
      contentHash: await packageContentHash(root),
    })
  );
  // As an earlier version wrote it: a record without the saved-copies mark.
  const { savedCopies: _mark, ...older } = await computeInstalledFiles(root, {
    identity: { name, type: 'plugin' },
    userEditable: [],
    npmRan: false,
  });
  await writeInstalledFiles(root, older);
  // What the earlier update saved aside, the old way.
  await put(
    'skills/x.dork-old/SKILL.md',
    '---\nname: x-old\ndescription: old\nallowed-tools: Bash\n---\nold\n'
  );
  await put('bin/tool.dork-old', '#!/bin/sh\n', 0o755);
  await put('bin/README', 'notes');
}

/** Approve the package exactly as it reads now, with `executables` overridden when given. */
async function approveAsItReads(executables?: string[]): Promise<void> {
  const reading = await readActivationState(root);
  if ('unreadable' in reading || reading.subject?.kind !== 'installed')
    throw new Error('unreadable');
  const effects = executables ? { ...reading.effects, executables } : reading.effects;
  config.harness.approvedHooks = [
    globalActivationEntry('pkg', effects, bindingOf(reading.subject)),
  ];
}

const migrate = () =>
  migrateSavedCopies([root], passThrough, logger, globalApprovalCarryOver(dorkHome));

beforeEach(async () => {
  dorkHome = await mkdtemp(path.join(tmpdir(), 'saved-consent-'));
  root = path.join(dorkHome, 'plugins', 'pkg');
  config.harness = { approvedHooks: [], refusedHooks: [] };
  await installOldLayout();
});

afterEach(async () => {
  await rm(dorkHome, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('approval across the saved-copies migration', () => {
  it('keeps an approved global plugin loading after its saved copies are made inert', async () => {
    await approveAsItReads();
    expect((await partitionGlobalPlugins(dorkHome)).activate).toEqual(['pkg']);

    await migrate();

    // What it discloses really changed (the saved skill and program are gone)...
    const after = await readActivationState(root);
    if ('unreadable' in after) throw new Error('unreadable');
    expect(after.effects.executables).toEqual(['tool']);
    // ...and it still loads, without a card.
    expect((await partitionGlobalPlugins(dorkHome)).activate).toEqual(['pkg']);
  });

  it('carries an approval made when bin/ was listed by name', async () => {
    // The pre-DOR-2340 reader listed every file in bin/ as a program.
    await approveAsItReads(['README', 'tool', 'tool.dork-old']);
    await migrate();
    expect((await partitionGlobalPlugins(dorkHome)).activate).toEqual(['pkg']);
  });

  it('approves nothing that was not approved before', async () => {
    await migrate();
    const partition = await partitionGlobalPlugins(dorkHome);
    expect(partition.activate).toEqual([]);
    expect(partition.withheld.map((w) => w.reason)).toEqual(['unasked']);
    expect(config.harness.approvedHooks).toEqual([]);
  });
});
