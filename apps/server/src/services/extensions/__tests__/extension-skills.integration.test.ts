/**
 * Running extensions' skills through the real extension manager (DOR-2685,
 * task 4.1): real discovery and compile, the real ledger and plugin roots, a
 * recording delivery. Only the config store and the logger are stand-ins.
 *
 * The property: every change to which extensions run — boot, turning one off
 * and on, withdrawing its approval — republishes the ledger and hands the
 * change to whatever delivers skills, including a change made before delivery
 * was attached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readRunningExtensionSkillsSync } from '@dorkos/harness';
import type { ExtensionsConfig } from '../extension-enable-resolution.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const stored = vi.hoisted(() => ({ value: {} as ExtensionsConfig }));
vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'extensions' ? stored.value : undefined),
    set: (key: string, value: unknown) => {
      if (key === 'extensions') stored.value = value as ExtensionsConfig;
    },
  },
}));

import { ExtensionManager, type ExtensionSkillDelivery } from '../extension-manager.js';

let dorkHome: string;
let project: string;
let manager: ExtensionManager;

/** Write an extension with one skill at `dir`. */
async function writeExtension(dir: string, id: string): Promise<void> {
  await fs.mkdir(path.join(dir, 'skills', 'triage-inbox'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'extension.json'),
    JSON.stringify({ id, name: 'Mail', version: '1.0.0', skills: ['triage-inbox'] })
  );
  await fs.writeFile(path.join(dir, 'index.ts'), 'export function activate() {}\n');
  await fs.writeFile(
    path.join(dir, 'skills', 'triage-inbox', 'SKILL.md'),
    '---\nname: triage-inbox\ndescription: Sort the inbox.\n---\nSort it.\n'
  );
}

/** A delivery that records every call. */
function recordingDelivery() {
  const projects: Array<{ root: string; remaining: boolean }> = [];
  let global = 0;
  const delivery: ExtensionSkillDelivery = {
    projectChanged: ({ root, remaining }) => projects.push({ root, remaining }),
    globalChanged: () => {
      global += 1;
    },
  };
  return { delivery, projects, globals: () => global };
}

beforeEach(async () => {
  dorkHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dor-2685-skills-home-')));
  project = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dor-2685-skills-proj-')));
});

afterEach(async () => {
  await manager?.whenSkillsSettled();
  await fs.rm(dorkHome, { recursive: true, force: true });
  await fs.rm(project, { recursive: true, force: true });
});

describe('extension skills through the extension manager', () => {
  it('publishes a global extension at boot and delivers it once delivery is attached', async () => {
    const dir = path.join(dorkHome, 'extensions', 'mail');
    await writeExtension(dir, 'mail');
    stored.value = {
      enabled: ['mail'],
      disabled: [],
      approvedToRun: ['mail'],
      approvedSources: { mail: { path: dir } },
    };
    manager = new ExtensionManager(dorkHome, []);
    await manager.initialize(null);
    await manager.whenSkillsSettled();
    expect(readRunningExtensionSkillsSync(dorkHome).entries.map((e) => e.id)).toEqual(['mail']);

    const seen = recordingDelivery();
    manager.attachSkillDelivery(seen.delivery);
    await vi.waitFor(() => expect(seen.globals()).toBe(1));

    await manager.disable('mail');
    await manager.whenSkillsSettled();
    expect(readRunningExtensionSkillsSync(dorkHome).entries).toEqual([]);
    await vi.waitFor(() => expect(seen.globals()).toBe(2));
    await expect(
      fs.lstat(path.join(dorkHome, 'cache', 'extensions', 'skill-plugins', 'mail'))
    ).rejects.toThrow();

    await manager.enable('mail');
    await manager.whenSkillsSettled();
    expect(readRunningExtensionSkillsSync(dorkHome).entries.map((e) => e.id)).toEqual(['mail']);
    await vi.waitFor(() => expect(seen.globals()).toBe(3));
  }, 30_000);

  it('projects the project a local extension runs in, and again when its approval goes', async () => {
    const dir = path.join(project, '.dork', 'extensions', 'mail');
    await writeExtension(dir, 'mail');
    stored.value = {
      enabled: ['mail'],
      disabled: [],
      approvedToRun: ['mail'],
      approvedSources: { mail: { path: dir } },
    };
    manager = new ExtensionManager(dorkHome, []);
    const seen = recordingDelivery();
    manager.attachSkillDelivery(seen.delivery);
    await manager.initialize(project);
    await manager.whenSkillsSettled();
    await vi.waitFor(() => expect(seen.projects).toEqual([{ root: project, remaining: true }]));

    await manager.revokeRunApproval('mail');
    await manager.whenSkillsSettled();
    await vi.waitFor(() =>
      expect(seen.projects).toEqual([
        { root: project, remaining: true },
        { root: project, remaining: false },
      ])
    );
    expect(readRunningExtensionSkillsSync(dorkHome).entries).toEqual([]);
  }, 30_000);

  it('lists nothing for an extension nobody approved', async () => {
    const dir = path.join(dorkHome, 'extensions', 'mail');
    await writeExtension(dir, 'mail');
    stored.value = { enabled: ['mail'], disabled: [], approvedToRun: [], approvedSources: {} };
    manager = new ExtensionManager(dorkHome, []);
    await manager.initialize(null);
    await manager.whenSkillsSettled();
    expect(readRunningExtensionSkillsSync(dorkHome).entries).toEqual([]);
  }, 30_000);
});
