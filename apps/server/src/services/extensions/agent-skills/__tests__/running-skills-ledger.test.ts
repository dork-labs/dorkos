/**
 * The running-skills ledger the server publishes (DOR-2685, task 4.1/4.3):
 * which extensions' skills are listed, that the trusted copy is read from its
 * snapshot, that an unchanged set writes nothing, that a deleted ledger comes
 * back, and that every generated plugin root holds exactly the checked skills
 * and nothing anyone planted.
 *
 * Real files in a temporary data directory; the records are built by hand, so
 * each case states exactly which property of a copy it is about.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { readRunningExtensionSkillsSync, runningExtensionSkillsPath } from '@dorkos/harness';
import type { ExtensionsConfig } from '../../extension-enable-resolution.js';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  extensionSkillPluginRoots,
  projectRootOf,
  reconcileRunningSkills,
  selectRunningSkills,
} from '../running-skills-ledger.js';

let dorkHome: string;
let project: string;

beforeEach(async () => {
  dorkHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dor-2685-ledger-home-')));
  project = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dor-2685-ledger-proj-')));
});

afterEach(async () => {
  await fs.rm(dorkHome, { recursive: true, force: true });
  await fs.rm(project, { recursive: true, force: true });
});

/** Write a valid SKILL.md for `name` under `dir/skills`. */
async function writeSkill(dir: string, name: string): Promise<void> {
  await fs.mkdir(path.join(dir, 'skills', name), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: The ${name} skill.\n---\nUse it.\n`
  );
}

/** A record for a copy at `dir` declaring `skills`, running unless overridden. */
function record(dir: string, overrides: Partial<ExtensionRecord> = {}): ExtensionRecord {
  return {
    id: 'mail',
    manifest: { id: 'mail', name: 'Mail', version: '1.2.3', skills: ['triage-inbox'] },
    status: 'compiled',
    scope: 'global',
    origin: 'user',
    path: dir,
    bundleReady: true,
    hasServerEntry: false,
    hasDataProxy: false,
    ...overrides,
  } as ExtensionRecord;
}

/** Config that turns `id` on and approves the copy at `dir`. */
function approving(id: string, dir: string): ExtensionsConfig {
  return {
    enabled: [id],
    disabled: [],
    approvedToRun: [id],
    approvedSources: { [id]: { path: dir } },
  } as ExtensionsConfig;
}

const core = new Map();

describe('which extensions the ledger lists', () => {
  it('lists an enabled, approved extension with a skill on disk', async () => {
    const dir = path.join(dorkHome, 'extensions', 'mail');
    await writeSkill(dir, 'triage-inbox');
    const entries = await selectRunningSkills([record(dir)], {
      config: approving('mail', dir),
      core,
    });
    expect(entries).toEqual([
      {
        id: 'mail',
        scope: 'global',
        skillsDir: path.join(dir, 'skills'),
        skills: ['triage-inbox'],
      },
    ]);
  });

  it('leaves out a copy that is off, not approved, invalid, incompatible or shadowed', async () => {
    const dir = path.join(dorkHome, 'extensions', 'mail');
    await writeSkill(dir, 'triage-inbox');
    const config = approving('mail', dir);
    const ask = (rec: ExtensionRecord, cfg: ExtensionsConfig = config) =>
      selectRunningSkills([rec], { config: cfg, core });
    expect(await ask(record(dir), { ...config, enabled: [] })).toEqual([]);
    expect(await ask(record(dir), { ...config, approvedToRun: [], approvedSources: {} })).toEqual(
      []
    );
    expect(await ask(record(dir, { status: 'invalid' }))).toEqual([]);
    expect(await ask(record(dir, { status: 'incompatible' }))).toEqual([]);
    expect(await ask(record(dir, { status: 'disabled' }))).toEqual([]);
    expect(await ask(record(dir, { shadowedBy: '/elsewhere' }))).toEqual([]);
    // An approval for ANOTHER copy of the id does not cover this one.
    expect(await ask(record(dir), approving('mail', path.join(dorkHome, 'other')))).toEqual([]);
  });

  it('reads a trusted copy from its verified snapshot, never the project folder', async () => {
    const dir = path.join(project, '.dork', 'extensions', 'mail');
    const runPath = path.join(dorkHome, 'extension-snapshots', 'abc', 'mail');
    await writeSkill(runPath, 'triage-inbox');
    await fs.mkdir(dir, { recursive: true });
    const entries = await selectRunningSkills([record(dir, { scope: 'local', runPath })], {
      config: approving('mail', dir),
      core,
    });
    expect(entries).toEqual([
      {
        id: 'mail',
        scope: 'local',
        projectRoot: project,
        skillsDir: path.join(runPath, 'skills'),
        skills: ['triage-inbox'],
      },
    ]);
  });

  it('leaves out a declared skill whose SKILL.md is not on disk', async () => {
    const dir = path.join(dorkHome, 'extensions', 'mail');
    await writeSkill(dir, 'triage-inbox');
    const rec = record(dir, {
      manifest: { id: 'mail', name: 'Mail', version: '1.0.0', skills: ['triage-inbox', 'missing'] },
    });
    const entries = await selectRunningSkills([rec], { config: approving('mail', dir), core });
    expect(entries[0]?.skills).toEqual(['triage-inbox']);
  });

  it('carries a dev link and finds the project of a plugin-carried copy', async () => {
    const dir = path.join(project, '.dork', 'plugins', 'mailer', '.dork', 'extensions', 'mail');
    await writeSkill(dir, 'triage-inbox');
    const rec = record(dir, {
      scope: 'local',
      sourcePlugin: 'mailer',
      devLink: { path: '/work/mailer' },
    });
    const config = {
      ...approving('mail', dir),
      // A dev-linked copy runs only on a yes given to that dev link.
      approvedSources: { mail: { path: dir, plugin: 'mailer', devLink: '/work/mailer' } },
    } as ExtensionsConfig;
    const [entry] = await selectRunningSkills([rec], { config, core });
    expect(entry).toMatchObject({ projectRoot: project, devLink: '/work/mailer' });
  });

  it('refuses to guess the project of a copy found anywhere else', () => {
    expect(projectRootOf({ path: '/x/y/mail' })).toBeUndefined();
    expect(projectRootOf({ path: '/p/.dork/extensions/mail' })).toBe('/p');
    expect(
      projectRootOf({
        path: '/p/.dork/plugins/other/.dork/extensions/mail',
        sourcePlugin: 'mailer',
      })
    ).toBeUndefined();
  });
});

describe('publishing the ledger', () => {
  it('writes only when the set changed, and rewrites a deleted ledger', async () => {
    const dir = path.join(project, '.dork', 'extensions', 'mail');
    await writeSkill(dir, 'triage-inbox');
    const ctx = { dorkHome, config: approving('mail', dir), core };
    const rec = record(dir, { scope: 'local' });

    const first = await reconcileRunningSkills([rec], ctx);
    expect(first.ledgerChanged).toBe(true);
    expect(first.projects).toEqual([{ root: project, ids: ['mail'], remaining: true }]);
    const file = runningExtensionSkillsPath(dorkHome);
    const before = (await fs.stat(file)).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 20));
    const again = await reconcileRunningSkills([rec], ctx);
    expect(again).toEqual({ ledgerChanged: false, projects: [], globalChanged: false });
    expect((await fs.stat(file)).mtimeMs).toBe(before);

    await fs.rm(file);
    const restored = await reconcileRunningSkills([rec], ctx);
    expect(restored.ledgerChanged).toBe(true);
    expect(restored.projects.map((p) => p.root)).toEqual([project]);
    expect(readRunningExtensionSkillsSync(dorkHome).entries.map((e) => e.id)).toEqual(['mail']);
  });

  it('names the project an extension left, with nothing remaining there', async () => {
    const dir = path.join(project, '.dork', 'extensions', 'mail');
    await writeSkill(dir, 'triage-inbox');
    const ctx = { dorkHome, config: approving('mail', dir), core };
    await reconcileRunningSkills([record(dir, { scope: 'local' })], ctx);
    const left = await reconcileRunningSkills([], ctx);
    expect(left.projects).toEqual([{ root: project, ids: ['mail'], remaining: false }]);
    expect(readRunningExtensionSkillsSync(dorkHome)).toEqual({ state: 'read', entries: [] });
  });
});

describe('the generated plugin root of a global extension', () => {
  const rootOf = () => path.join(dorkHome, 'cache', 'extensions', 'skill-plugins', 'mail');

  it('holds plugin.json and one link per checked skill, and nothing undeclared', async () => {
    const dir = path.join(dorkHome, 'extensions', 'mail');
    await writeSkill(dir, 'triage-inbox');
    await writeSkill(dir, 'undeclared');
    const change = await reconcileRunningSkills([record(dir)], {
      dorkHome,
      config: approving('mail', dir),
      core,
    });
    expect(change.globalChanged).toBe(true);
    const root = rootOf();
    expect(
      JSON.parse(await fs.readFile(path.join(root, '.claude-plugin', 'plugin.json'), 'utf-8'))
    ).toEqual({ name: 'mail', version: '1.2.3' });
    expect(await fs.readdir(path.join(root, 'skills'))).toEqual(['triage-inbox']);
    expect(await fs.readlink(path.join(root, 'skills', 'triage-inbox'))).toBe(
      path.join(dir, 'skills', 'triage-inbox')
    );
    expect(await extensionSkillPluginRoots(dorkHome)).toEqual([root]);
  });

  it('links no skill whose folder is a link out of the skills folder', async () => {
    const dir = path.join(dorkHome, 'extensions', 'mail');
    const secret = path.join(project, 'secret');
    await writeSkill(secret, 'triage-inbox');
    await fs.mkdir(path.join(dir, 'skills'), { recursive: true });
    await fs.symlink(
      path.join(secret, 'skills', 'triage-inbox'),
      path.join(dir, 'skills', 'triage-inbox')
    );
    await reconcileRunningSkills([record(dir)], { dorkHome, config: approving('mail', dir), core });
    await expect(fs.readdir(path.join(rootOf(), 'skills'))).rejects.toThrow();
    expect(await extensionSkillPluginRoots(dorkHome)).toEqual([]);
  });

  it('is removed when the extension stops, with anything else planted in the folder', async () => {
    const dir = path.join(dorkHome, 'extensions', 'mail');
    await writeSkill(dir, 'triage-inbox');
    const ctx = { dorkHome, config: approving('mail', dir), core };
    await reconcileRunningSkills([record(dir)], ctx);
    const planted = path.join(dorkHome, 'cache', 'extensions', 'skill-plugins', 'planted');
    await fs.mkdir(planted, { recursive: true });

    const stopped = await reconcileRunningSkills([], ctx);
    expect(stopped.globalChanged).toBe(true);
    await expect(fs.lstat(rootOf())).rejects.toThrow();
    await expect(fs.lstat(planted)).rejects.toThrow();
    expect(await extensionSkillPluginRoots(dorkHome)).toEqual([]);
  });

  it('replaces a link planted where the root belongs, never writing through it', async () => {
    const dir = path.join(dorkHome, 'extensions', 'mail');
    await writeSkill(dir, 'triage-inbox');
    const elsewhere = path.join(project, 'elsewhere');
    await fs.mkdir(elsewhere, { recursive: true });
    await fs.mkdir(path.dirname(rootOf()), { recursive: true });
    await fs.symlink(elsewhere, rootOf());

    await reconcileRunningSkills([record(dir)], { dorkHome, config: approving('mail', dir), core });
    expect((await fs.lstat(rootOf())).isDirectory()).toBe(true);
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });

  it('never clears through a link standing where the folder of roots belongs', async () => {
    // Purpose: with no global extension left, the reconcile lists the folder
    // and removes what is in it; through a link, that would empty its target.
    const outside = path.join(project, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'keep.txt'), 'mine');
    const rootsDir = path.join(dorkHome, 'cache', 'extensions', 'skill-plugins');
    await fs.mkdir(path.dirname(rootsDir), { recursive: true });
    await fs.symlink(outside, rootsDir);

    const change = await reconcileRunningSkills([], {
      dorkHome,
      config: approving('mail', '/none'),
      core,
    });
    expect(change.globalChanged).toBe(true);
    expect(await fs.readdir(outside)).toEqual(['keep.txt']);
    await expect(fs.lstat(rootsDir)).rejects.toThrow();
  });

  it('refuses a folder of roots reached through a link higher up', async () => {
    const dir = path.join(dorkHome, 'extensions', 'mail');
    await writeSkill(dir, 'triage-inbox');
    const outside = path.join(project, 'outside-cache');
    await fs.mkdir(path.join(outside, 'skill-plugins', 'other'), { recursive: true });
    await fs.mkdir(path.join(dorkHome, 'cache'), { recursive: true });
    await fs.symlink(outside, path.join(dorkHome, 'cache', 'extensions'));

    await expect(
      reconcileRunningSkills([record(dir)], { dorkHome, config: approving('mail', dir), core })
    ).rejects.toThrow(/link/);
    expect(await fs.readdir(path.join(outside, 'skill-plugins'))).toEqual(['other']);
  });

  it('rebuilds a root whose links were tampered with', async () => {
    const dir = path.join(dorkHome, 'extensions', 'mail');
    await writeSkill(dir, 'triage-inbox');
    const ctx = { dorkHome, config: approving('mail', dir), core };
    await reconcileRunningSkills([record(dir)], ctx);
    const link = path.join(rootOf(), 'skills', 'triage-inbox');
    await fs.rm(link);
    await fs.symlink(project, link);
    const change = await reconcileRunningSkills([record(dir)], ctx);
    expect(change.globalChanged).toBe(true);
    expect(await fs.readlink(link)).toBe(path.join(dir, 'skills', 'triage-inbox'));
  });

  it('is left out of sessions when a loaded plugin has the same name', async () => {
    const dir = path.join(dorkHome, 'extensions', 'mail');
    await writeSkill(dir, 'triage-inbox');
    await reconcileRunningSkills([record(dir)], { dorkHome, config: approving('mail', dir), core });
    expect(await extensionSkillPluginRoots(dorkHome, new Set(['mail']))).toEqual([]);
  });
});
