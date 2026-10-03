/**
 * Harness Sync and dev links (DOR-2696, spec `marketplace-dev-link` §5).
 *
 * A symlinked plugin slot is followed ONLY when a registry record names that
 * exact slot and the slot still resolves to the recorded folder; every other
 * link stays skipped (the containment rule). A followed package is labelled on
 * every projection, and the labels go away when the dev link does.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEV_LINKS_FILE, type DevLinkRecord } from '@dorkos/shared/marketplace-schemas';
import { scanInstalledPlugins } from '../installed.js';
import { readDevLinksSync } from '../dev-links.js';
import { project } from '../../engine.js';
import { applyPlan } from '../../apply/apply.js';
import { formatDropList } from '../../report/drop-list.js';
import {
  GENERATED_COMMAND_MARKER,
  MANAGED_HOOK_SENTINEL_KEY,
} from '../../plan/installed-projector.js';
import { DEV_LINK_MARKER, MANAGED_HOOK_DEV_LINK_KEY } from '../../plan/dev-link-labels.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh real directory (canonical, so `/var` vs `/private/var` never matters). */
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

/** A working folder holding a plugin with one skill, one command and one hook. */
function writeWorkingFolder(name = 'flow'): string {
  const folder = tempDir('devlink-work-');
  mkdirSync(join(folder, '.dork'), { recursive: true });
  writeFileSync(
    join(folder, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name,
      version: '0.0.1',
      type: 'plugin',
      description: 'A plugin in development',
      layers: ['skills', 'commands', 'hooks', 'extensions'],
    })
  );
  mkdirSync(join(folder, 'skills', 'greet'), { recursive: true });
  writeFileSync(join(folder, 'skills', 'greet', 'SKILL.md'), '# greet\n');
  mkdirSync(join(folder, 'commands'), { recursive: true });
  writeFileSync(join(folder, 'commands', 'go.md'), '---\ndescription: Go\n---\nGo now.\n');
  mkdirSync(join(folder, 'hooks'), { recursive: true });
  writeFileSync(
    join(folder, 'hooks', 'hooks.json'),
    JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] })
  );
  return folder;
}

/** A repo enabling Claude Code and Codex. */
function writeRepo(): string {
  const repo = tempDir('devlink-repo-');
  mkdirSync(join(repo, '.agents'), { recursive: true });
  writeFileSync(
    join(repo, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex'] })
  );
  return repo;
}

/** Link `folder` into a plugins root, as DevLinkService does. */
function linkSlot(pluginsRoot: string, name: string, folder: string): string {
  mkdirSync(pluginsRoot, { recursive: true });
  const slot = join(pluginsRoot, name);
  symlinkSync(folder, slot, 'dir');
  return slot;
}

/** The record DevLinkService writes for a link. */
function recordFor(
  slot: string,
  target: string,
  scope: 'global' | 'project',
  projectPath?: string
): DevLinkRecord {
  return {
    name: 'flow',
    type: 'plugin',
    scope,
    ...(projectPath !== undefined && { projectPath }),
    slot,
    target,
    linkedAt: '2026-10-03T00:00:00.000Z',
    linkedVia: 'app',
  };
}

/** Write the registry file under a data directory. */
function writeRegistry(dorkHome: string, links: DevLinkRecord[]): void {
  const file = join(dorkHome, DEV_LINKS_FILE);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, links }));
}

describe('scanInstalledPlugins: which symlinked slots are followed', () => {
  it('skips a symlinked slot no record names, at both scopes', () => {
    // Purpose: the containment rule. A link a repo committed (or anyone made by
    // hand) must never project the folder it points at.
    const folder = writeWorkingFolder();
    const repo = writeRepo();
    const dorkHome = tempDir('devlink-home-');
    linkSlot(join(repo, '.dork', 'plugins'), 'flow', folder);
    linkSlot(join(dorkHome, 'plugins'), 'flow', folder);

    expect(scanInstalledPlugins({ projectRoot: repo, dorkHome })).toEqual([]);
  });

  it('follows a project slot a record names, and labels the package with its folder', () => {
    // Purpose: a registered, matching dev link projects like an install.
    const folder = writeWorkingFolder();
    const repo = writeRepo();
    const dorkHome = tempDir('devlink-home-');
    const slot = linkSlot(join(repo, '.dork', 'plugins'), 'flow', folder);
    writeRegistry(dorkHome, [recordFor(slot, folder, 'project', repo)]);

    const [plugin] = scanInstalledPlugins({ projectRoot: repo, dorkHome });

    expect(plugin?.name).toBe('flow');
    expect(plugin?.location).toEqual({ scope: 'project', relDir: '.dork/plugins/flow' });
    expect(plugin?.devLink).toEqual({ path: folder });
    expect(plugin?.skills.map((s) => s.name)).toEqual(['greet']);
    expect(plugin?.commands.map((c) => c.name)).toEqual(['go']);
  });

  it('follows a global slot a record names', () => {
    // Purpose: the global scope reads the same registry and the same rule.
    const folder = writeWorkingFolder();
    const dorkHome = tempDir('devlink-home-');
    const slot = linkSlot(join(dorkHome, 'plugins'), 'flow', folder);
    writeRegistry(dorkHome, [recordFor(slot, folder, 'global')]);

    const [plugin] = scanInstalledPlugins({ dorkHome });

    expect(plugin?.location).toEqual({ scope: 'global', absDir: slot });
    expect(plugin?.devLink).toEqual({ path: folder });
  });

  it('skips a recorded slot that now points at a different folder', () => {
    // Purpose: `ln -sfn /elsewhere <slot>` by an agent must not inherit the
    // dev link's standing. The record still names the old folder.
    const folder = writeWorkingFolder();
    const elsewhere = writeWorkingFolder();
    const repo = writeRepo();
    const dorkHome = tempDir('devlink-home-');
    const slot = linkSlot(join(repo, '.dork', 'plugins'), 'flow', elsewhere);
    writeRegistry(dorkHome, [recordFor(slot, folder, 'project', repo)]);

    expect(scanInstalledPlugins({ projectRoot: repo, dorkHome })).toEqual([]);
  });

  it('skips a slot whose record is for the other scope', () => {
    // Purpose: a record is about one slot in one scope, never a name anywhere.
    const folder = writeWorkingFolder();
    const dorkHome = tempDir('devlink-home-');
    const slot = linkSlot(join(dorkHome, 'plugins'), 'flow', folder);
    writeRegistry(dorkHome, [recordFor(slot, folder, 'project', '/somewhere')]);

    expect(scanInstalledPlugins({ dorkHome })).toEqual([]);
  });

  it('skips a slot whose record names a different slot with the same package name', () => {
    // Purpose: a project record does not let the same name be followed in
    // another project, or globally.
    const folder = writeWorkingFolder();
    const repo = writeRepo();
    const other = writeRepo();
    const dorkHome = tempDir('devlink-home-');
    linkSlot(join(repo, '.dork', 'plugins'), 'flow', folder);
    const otherSlot = linkSlot(join(other, '.dork', 'plugins'), 'flow', folder);
    writeRegistry(dorkHome, [recordFor(otherSlot, folder, 'project', other)]);

    expect(scanInstalledPlugins({ projectRoot: repo, dorkHome })).toEqual([]);
  });

  it('still refuses a symlink INSIDE a followed dev link', () => {
    // Purpose: following the slot is not following every link under it. A
    // `skills/stolen -> /private` in the working folder stays out.
    const folder = writeWorkingFolder();
    const secret = tempDir('devlink-secret-');
    mkdirSync(join(secret, 'stolen'));
    writeFileSync(join(secret, 'stolen', 'SKILL.md'), '# private\n');
    symlinkSync(join(secret, 'stolen'), join(folder, 'skills', 'stolen'), 'dir');
    const repo = writeRepo();
    const dorkHome = tempDir('devlink-home-');
    const slot = linkSlot(join(repo, '.dork', 'plugins'), 'flow', folder);
    writeRegistry(dorkHome, [recordFor(slot, folder, 'project', repo)]);

    const [plugin] = scanInstalledPlugins({ projectRoot: repo, dorkHome });

    expect(plugin?.skills.map((s) => s.name)).toEqual(['greet']);
  });

  it('follows nothing when the registry cannot be read, or there is no data directory', () => {
    // Purpose: fail closed. A torn registry is never "every link is fine".
    const folder = writeWorkingFolder();
    const repo = writeRepo();
    const dorkHome = tempDir('devlink-home-');
    const slot = linkSlot(join(repo, '.dork', 'plugins'), 'flow', folder);
    mkdirSync(join(dorkHome, 'marketplace'), { recursive: true });
    writeFileSync(join(dorkHome, DEV_LINKS_FILE), '{"version":1,"links":[');

    expect(readDevLinksSync(dorkHome)).toEqual([]);
    expect(scanInstalledPlugins({ projectRoot: repo, dorkHome })).toEqual([]);
    // An offline sync has no registry to read.
    writeRegistry(dorkHome, [recordFor(slot, folder, 'project', repo)]);
    expect(scanInstalledPlugins({ projectRoot: repo })).toEqual([]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'skips a slot it may not look at, rather than stopping the scan',
    () => {
      // Purpose: a plugins root that lists but refuses a stat (EACCES) must not
      // throw out of the scan; the slot is simply not a dev link.
      const folder = writeWorkingFolder();
      const repo = writeRepo();
      const dorkHome = tempDir('devlink-home-');
      const root = join(repo, '.dork', 'plugins');
      const slot = linkSlot(root, 'flow', folder);
      writeRegistry(dorkHome, [recordFor(slot, folder, 'project', repo)]);
      chmodSync(root, 0o444);
      try {
        expect(scanInstalledPlugins({ projectRoot: repo, dorkHome })).toEqual([]);
      } finally {
        chmodSync(root, 0o755);
      }
    }
  );

  it('takes pinned records over the registry file', () => {
    // Purpose: `devLinks` is the injection point; an empty list follows nothing.
    const folder = writeWorkingFolder();
    const repo = writeRepo();
    const dorkHome = tempDir('devlink-home-');
    const slot = linkSlot(join(repo, '.dork', 'plugins'), 'flow', folder);
    writeRegistry(dorkHome, [recordFor(slot, folder, 'project', repo)]);

    expect(scanInstalledPlugins({ projectRoot: repo, dorkHome, devLinks: [] })).toEqual([]);
  });
});

describe('projection of a dev link: labels, and their removal on unlink', () => {
  /** A repo with a project dev link to a working folder, registered. */
  function linkedRepo(): { repo: string; dorkHome: string; folder: string; slot: string } {
    const folder = writeWorkingFolder();
    const repo = writeRepo();
    const dorkHome = tempDir('devlink-home-');
    const slot = linkSlot(join(repo, '.dork', 'plugins'), 'flow', folder);
    writeRegistry(dorkHome, [recordFor(slot, folder, 'project', repo)]);
    return { repo, dorkHome, folder, slot };
  }

  const wrapper = (repo: string): string =>
    readFileSync(join(repo, '.claude', 'commands', 'flow', 'go.md'), 'utf8');
  const managedGroups = (repo: string): Array<Record<string, unknown>> => {
    const settings = JSON.parse(
      readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8')
    ) as { hooks?: Record<string, Array<Record<string, unknown>>> };
    return Object.values(settings.hooks ?? {})
      .flat()
      .filter((group) => typeof group[MANAGED_HOOK_SENTINEL_KEY] === 'string');
  };

  it('marks wrappers, hook groups and every planned action with the folder', () => {
    // Purpose: a person reading any projection can tell it runs from a folder.
    const { repo, dorkHome, folder } = linkedRepo();

    const plan = project(repo, { dorkHome });
    const result = applyPlan(repo, plan, { sweepOrphans: true });
    expect(result.conflicts).toEqual([]);

    expect(wrapper(repo)).toContain(GENERATED_COMMAND_MARKER);
    expect(wrapper(repo)).toContain(`<!-- ${DEV_LINK_MARKER} ${folder} -->`);
    expect(managedGroups(repo)).toEqual([
      expect.objectContaining({
        [MANAGED_HOOK_SENTINEL_KEY]: 'flow',
        [MANAGED_HOOK_DEV_LINK_KEY]: folder,
      }),
    ]);
    // Skill links keep their names: `<pkg>__<name>`.
    expect(existsSync(join(repo, '.agents', 'skills', 'flow__greet'))).toBe(true);
    const fromFlow = [...plan.actions, ...plan.drops].filter(
      (a) => a.name.startsWith('flow') && a.name !== 'plugin-hooks'
    );
    expect(fromFlow.length).toBeGreaterThan(0);
    for (const action of fromFlow) {
      expect(action.devLink).toBe(folder);
      expect(action.reason).toContain(`(dev link: ${folder})`);
    }
    // The drop list names it too (the extensions layer has no harness home).
    expect(formatDropList(plan)).toContain(`(dev link: ${folder})`);
  });

  it('labels the shared .agents/skills link when no enabled harness plans it', () => {
    // Purpose: with Claude Code alone, the canonical link is planned for every
    // package at once; it is matched back to the dev-linked package by source.
    const { repo, dorkHome, folder } = linkedRepo();
    writeFileSync(
      join(repo, '.agents', 'harness.manifest.json'),
      JSON.stringify({ version: 1, harnesses: ['claude-code'] })
    );

    const plan = project(repo, { dorkHome });
    const canonical = plan.actions.find((a) => a.target === '.agents/skills/flow__greet');

    expect(canonical?.devLink).toBe(folder);
    expect(canonical?.reason).toContain(`(dev link: ${folder})`);
  });

  it('drops every projection and marker when the dev link goes and nothing comes back', () => {
    // Purpose: unlink with no installed copy un-projects the package.
    const { repo, dorkHome, slot } = linkedRepo();
    applyPlan(repo, project(repo, { dorkHome }), { sweepOrphans: true });

    unlinkSync(slot);
    writeRegistry(dorkHome, []);
    const result = applyPlan(repo, project(repo, { dorkHome }), { sweepOrphans: true });

    expect(result.conflicts).toEqual([]);
    expect(existsSync(join(repo, '.claude', 'commands', 'flow', 'go.md'))).toBe(false);
    expect(existsSync(join(repo, '.agents', 'skills', 'flow__greet'))).toBe(false);
    expect(managedGroups(repo)).toEqual([]);
  });

  it('rewrites the projections without dev markers when the installed copy comes back', () => {
    // Purpose: unlink that restores the parked copy leaves no dev label behind.
    const { repo, dorkHome, folder, slot } = linkedRepo();
    // The installed copy the link set aside, a byte copy of the folder's package.
    const parked = `${slot}.dorkos-devlink-parked`;
    mkdirSync(parked, { recursive: true });
    for (const rel of ['.dork', 'skills', 'commands', 'hooks']) {
      renameSync(join(writeWorkingFolder(), rel), join(parked, rel));
    }
    applyPlan(repo, project(repo, { dorkHome }), { sweepOrphans: true });
    expect(wrapper(repo)).toContain(DEV_LINK_MARKER);

    unlinkSync(slot);
    renameSync(parked, slot);
    writeRegistry(dorkHome, []);
    const plan = project(repo, { dorkHome });
    const result = applyPlan(repo, plan, { sweepOrphans: true });

    expect(result.conflicts).toEqual([]);
    expect(wrapper(repo)).toContain(GENERATED_COMMAND_MARKER);
    expect(wrapper(repo)).not.toContain(DEV_LINK_MARKER);
    expect(managedGroups(repo)).toEqual([
      expect.not.objectContaining({ [MANAGED_HOOK_DEV_LINK_KEY]: expect.anything() }),
    ]);
    expect(managedGroups(repo)).toHaveLength(1);
    expect(existsSync(join(repo, '.agents', 'skills', 'flow__greet'))).toBe(true);
    expect(JSON.stringify(plan)).not.toContain(folder);
  });
});
