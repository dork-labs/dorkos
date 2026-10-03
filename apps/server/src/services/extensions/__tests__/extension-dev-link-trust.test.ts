/**
 * No trust crosses between a dev link and an installed copy (DOR-2696 task
 * 1.3, spec `marketplace-dev-link` §3): origin, digest, source trust and path
 * approvals each stay with the kind they were given to.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MARKETPLACE_DEVLINK_PARKED_MARKER } from '@dorkos/shared/marketplace-schemas';
import { ExtensionDiscovery } from '../extension-discovery.js';
import type { CoreExtensionInfo, ExtensionsConfig } from '../extension-enable-resolution.js';
import {
  approvedSourceOf,
  isApprovedByPath,
  mayRunExtensionCode,
  type ExtensionCopy,
} from '../extension-load-policy.js';
import { proveOrigin, readTrustedInstalls } from '../extension-trusted-origin.js';
import { recordProjectInstall } from '../../marketplace/lib/project-install-index.js';
import { updateDevLinks } from '../../marketplace/dev-links/registry.js';
import { scanInstalledPackages } from '../../marketplace/installed-scanner.js';

const NO_CORE = new Map<string, CoreExtensionInfo>();
const SOURCE = 'dork-labs/marketplace';

let tmp: string;
let home: string;
let work: string;

async function writeExtension(pluginRoot: string, id: string): Promise<string> {
  const dir = path.join(pluginRoot, '.dork', 'extensions', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'extension.json'),
    JSON.stringify({ id, name: id, version: '1.0.0' })
  );
  return dir;
}

async function writePlugin(root: string, version = '1.0.0'): Promise<void> {
  await fs.mkdir(path.join(root, '.dork'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.dork', 'manifest.json'),
    JSON.stringify({ name: 'flow', version, type: 'plugin' })
  );
  await writeExtension(root, 'flow-dash');
}

/** Put a dev link for `flow` in a slot and record it. */
async function devLink(slot: string, scope: 'global' | 'project', projectPath?: string) {
  await fs.mkdir(path.dirname(slot), { recursive: true });
  await fs.symlink(work, slot, 'dir');
  await updateDevLinks(home, () => [
    {
      name: 'flow',
      type: 'plugin',
      scope,
      ...(projectPath ? { projectPath } : {}),
      slot,
      target: work,
      linkedAt: '2026-10-03T00:00:00.000Z',
      linkedVia: 'app',
    },
  ]);
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devlink-trust-')));
  home = path.join(tmp, '.dork');
  work = path.join(tmp, 'work', 'flow');
  await fs.mkdir(path.join(home, 'extensions'), { recursive: true });
  await writePlugin(work);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('proveOrigin', () => {
  it('answers dev-link before reading a project record that names the same folder', () => {
    // Purpose: the parked copy's install record (source + digest) must never
    // vouch for the developer's files at the same path.
    const installRoot = '/p/.dork/plugins/flow';
    const copy = {
      path: `${installRoot}/.dork/extensions/flow-dash`,
      scope: 'local' as const,
      sourcePlugin: 'flow',
    };
    const installs = {
      global: [],
      project: [{ installRoot, source: SOURCE, installDigest: 'd1' }],
    };
    const onDisk = { folder: { kind: 'digest' as const, digest: 'd1' } };

    expect(proveOrigin(copy, installs, onDisk).origin).not.toBeNull();
    expect(proveOrigin(copy, installs, onDisk, new Set([installRoot]))).toEqual({
      origin: null,
      problem: 'dev-link',
      pinnedDigest: null,
    });
  });

  it('answers dev-link at global scope too', () => {
    // Purpose: a global plugin's own sidecar must not vouch for a dev link.
    const installRoot = '/home/.dork/plugins/flow';
    const copy = {
      path: `${installRoot}/.dork/extensions/x`,
      scope: 'global' as const,
      sourcePlugin: 'flow',
    };
    const installs = { global: [{ installRoot, source: SOURCE }], project: [] };
    expect(
      proveOrigin(copy, installs, { folder: { kind: 'clean' } }, new Set([installRoot])).problem
    ).toBe('dev-link');
  });
});

describe('path approvals', () => {
  const at = '/home/.dork/plugins/flow/.dork/extensions/flow-dash';
  const installed: ExtensionCopy = {
    id: 'flow-dash',
    origin: 'user',
    path: at,
    sourcePlugin: 'flow',
  };
  const linked: ExtensionCopy = {
    ...installed,
    devLink: { path: '/work/flow' },
    originProblem: 'dev-link',
  };

  it("does not let an installed copy's approval cover a dev link at the same path", () => {
    // Purpose: without this, linking any folder into an approved plugin's slot
    // would run it on the installed copy's yes.
    const approvals = {
      approvedToRun: ['flow-dash'],
      approvedSources: { 'flow-dash': approvedSourceOf(installed) },
    };
    expect(isApprovedByPath(installed, approvals)).toBe(true);
    expect(isApprovedByPath(linked, approvals)).toBe(false);
  });

  it("does not let a dev link's approval cover the installed copy put back after unlink", () => {
    // Purpose: the dev link's yes was for the developer's files, not the package.
    const approvals = {
      approvedToRun: ['flow-dash'],
      approvedSources: { 'flow-dash': approvedSourceOf(linked) },
    };
    expect(approvedSourceOf(linked)).toEqual({ path: at, plugin: 'flow', devLink: '/work/flow' });
    expect(isApprovedByPath(linked, approvals)).toBe(true);
    expect(isApprovedByPath(installed, approvals)).toBe(false);
  });

  it("does not let one dev link's approval cover a link to another folder", () => {
    // Purpose: the yes named an exact folder.
    const approvals = {
      approvedToRun: ['flow-dash'],
      approvedSources: { 'flow-dash': approvedSourceOf(linked) },
    };
    expect(isApprovedByPath({ ...linked, devLink: { path: '/elsewhere' } }, approvals)).toBe(false);
  });
});

describe('discovery of a dev-linked plugin', () => {
  it('marks a project dev link with no origin even when a matching install record and trusted source exist', async () => {
    // Purpose: trusted sources and project install records are about what
    // DorkOS installed; a dev link at that folder runs something else.
    const project = path.join(tmp, 'proj');
    const slot = path.join(project, '.dork', 'plugins', 'flow');
    await recordProjectInstall(home, {
      projectPath: project,
      installRoot: slot,
      name: 'flow',
      source: SOURCE,
      installDigest: 'whatever',
    });
    await devLink(slot, 'project', project);
    const config: ExtensionsConfig = {
      enabled: [],
      disabled: [],
      approvedToRun: [],
      trustedSources: [{ source: SOURCE, trustedAt: '2026-10-03T00:00:00.000Z' }],
    } as ExtensionsConfig;

    const records = await new ExtensionDiscovery(home).discover(project, config, NO_CORE);
    const dash = records.find((r) => r.id === 'flow-dash');
    expect(dash).toMatchObject({ originProblem: 'dev-link', devLink: { path: work } });
    expect(dash?.trustedOrigin).toBeUndefined();
    expect(dash?.currentDigest).toBeUndefined();
    expect(mayRunExtensionCode(dash!, config)).toBe(false);
  });

  it('runs a global dev link on the approval the link recorded, and only that', async () => {
    // Purpose: the one-card behaviour: the link-time yes makes it run, edits
    // never ask (no digest is pinned).
    const slot = path.join(home, 'plugins', 'flow');
    await devLink(slot, 'global');
    const discovered = await new ExtensionDiscovery(home).discover(
      null,
      { enabled: [], disabled: [], approvedToRun: [] },
      NO_CORE
    );
    const dash = discovered.find((r) => r.id === 'flow-dash')!;
    const approvals = {
      approvedToRun: ['flow-dash'],
      approvedSources: { 'flow-dash': approvedSourceOf(dash) },
    };
    expect(approvals.approvedSources['flow-dash']).toEqual({
      path: path.join(slot, '.dork', 'extensions', 'flow-dash'),
      plugin: 'flow',
      devLink: work,
    });
    expect(mayRunExtensionCode(dash, approvals)).toBe(true);
  });

  it('treats a retargeted link as an ordinary link, not a dev link', async () => {
    // Purpose: `ln -sfn /elsewhere <slot>` must drop every dev-link standing.
    const slot = path.join(home, 'plugins', 'flow');
    await devLink(slot, 'global');
    const other = path.join(tmp, 'other', 'flow');
    await writePlugin(other);
    await fs.rm(slot);
    await fs.symlink(other, slot, 'dir');
    const discovered = await new ExtensionDiscovery(home).discover(
      null,
      { enabled: [], disabled: [], approvedToRun: [] },
      NO_CORE
    );
    const dash = discovered.find((r) => r.id === 'flow-dash')!;
    expect(dash.devLink).toBeUndefined();
    expect(dash.originProblem).not.toBe('dev-link');
  });
});

describe('the parked copy', () => {
  it('is invisible to discovery, the trusted-install reader and the installed scanner', async () => {
    // Purpose: the parked copy holds a valid manifest and extension; any
    // reader that saw it would list the package or its extension twice.
    const slot = path.join(home, 'plugins', 'flow');
    const parked = `${slot}${MARKETPLACE_DEVLINK_PARKED_MARKER}`;
    await writePlugin(parked, '0.9.2');
    await devLink(slot, 'global');

    const discovered = await new ExtensionDiscovery(home).discover(
      null,
      { enabled: [], disabled: [], approvedToRun: [] },
      NO_CORE
    );
    expect(discovered.filter((r) => r.id === 'flow-dash').map((r) => r.path)).toEqual([
      path.join(slot, '.dork', 'extensions', 'flow-dash'),
    ]);
    const trusted = await readTrustedInstalls(home);
    expect(trusted.global.map((i) => i.installRoot)).toEqual([slot]);
    const installed = await scanInstalledPackages(home);
    expect(installed.map((p) => p.installPath)).toEqual([slot]);
  });
});

describe('the installed listing', () => {
  it('marks a dev link as one, not as a hand-built link', async () => {
    // Purpose: the badge and the update check read this; `linked` would say
    // "update its source instead", which is the hand-built link's note.
    const slot = path.join(home, 'plugins', 'flow');
    await devLink(slot, 'global');
    const [flow] = await scanInstalledPackages(home);
    expect(flow).toMatchObject({
      name: 'flow',
      devLink: { path: work, state: 'active', parked: false },
    });
    expect(flow?.linked).toBeUndefined();
  });

  it('keeps a hand-built link as linked', async () => {
    // Purpose: regression pin; DOR-2194 links keep today's behaviour.
    const slot = path.join(home, 'plugins', 'flow');
    await fs.mkdir(path.dirname(slot), { recursive: true });
    await fs.symlink(work, slot, 'dir');
    const [flow] = await scanInstalledPackages(home);
    expect(flow).toMatchObject({ linked: true });
    expect(flow?.devLink).toBeUndefined();
  });

  it('still lists a dev link whose folder is gone, from its record', async () => {
    // Purpose: a missing folder is a visible row the person can unlink, never
    // a package that silently vanished.
    const slot = path.join(home, 'plugins', 'flow');
    await devLink(slot, 'global');
    await fs.rm(work, { recursive: true });
    const [flow] = await scanInstalledPackages(home);
    expect(flow).toMatchObject({
      name: 'flow',
      installPath: slot,
      devLink: { path: work, state: 'folder-missing' },
    });
  });
});
