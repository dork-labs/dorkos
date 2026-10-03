/**
 * The dev-link registry file (DOR-2696 task 1.1): what readers make of it and
 * how writes land.
 */
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DevLinkRecordSchema,
  isInstallSiblingName,
  MARKETPLACE_DEVLINK_PARKED_MARKER,
  type DevLinkRecord,
} from '@dorkos/shared/marketplace-schemas';
import {
  activeDevLinks,
  devLinkStateOf,
  devLinksFilePath,
  readDevLinks,
  updateDevLinks,
} from '../registry.js';

let home: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), 'devlink-registry-')));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function record(name: string, overrides: Partial<DevLinkRecord> = {}): DevLinkRecord {
  return {
    name,
    type: 'plugin',
    scope: 'global',
    slot: path.join(home, 'plugins', name),
    target: path.join(home, '..', `work-${name}`),
    linkedAt: '2026-10-03T00:00:00.000Z',
    linkedVia: 'app',
    ...overrides,
  };
}

describe('dev-link registry', () => {
  it('reads back exactly what it wrote', async () => {
    // Purpose: the server, harness and CLI all read this file; a write that
    // drops or reshapes a field would make the readers disagree.
    const flow = record('flow', { restoreApprovals: { extensions: { dash: { path: '/x' } } } });
    await updateDevLinks(home, () => [flow]);
    expect(await readDevLinks(home)).toEqual({ links: [flow] });
  });

  it('reads a missing file as no dev links', async () => {
    // Purpose: a fresh install has no file, and that is not an error.
    expect(await readDevLinks(home)).toEqual({ links: [] });
  });

  it('refuses a file that does not parse, and only the link path moves it aside', async () => {
    // Purpose: a torn write must never read as "no dev links" a writer then
    // writes over; it is refused until a link replaces it, keeping a copy.
    const file = devLinksFilePath(home);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"version":1,"links":[{"name":', 'utf-8');

    expect(await readDevLinks(home)).toHaveProperty('unreadable');
    expect(await activeDevLinks(home)).toEqual([]);
    await expect(updateDevLinks(home, (links) => links)).rejects.toThrow(/make sense/);

    await updateDevLinks(home, () => [record('flow')], { replaceUnreadable: true });
    expect(await readDevLinks(home)).toEqual({ links: [record('flow')] });
    const aside = (await readdir(path.dirname(file))).filter((n) => n.includes('.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(await readFile(path.join(path.dirname(file), aside[0]!), 'utf-8')).toContain('"name":');
  });

  it('serialises concurrent writes so both land', async () => {
    // Purpose: two links made at once must both be recorded; an unserialised
    // read-modify-write would lose one.
    await Promise.all([
      updateDevLinks(home, (links) => [...links, record('alpha')]),
      updateDevLinks(home, (links) => [...links, record('beta')]),
    ]);
    const reading = await readDevLinks(home);
    expect('links' in reading && reading.links.map((l) => l.name).sort()).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('refuses a project record without its project, and a global one with one', () => {
    // Purpose: the slot is computed from projectPath; a project link without
    // one would point at the global slot.
    expect(DevLinkRecordSchema.safeParse(record('flow', { scope: 'project' })).success).toBe(false);
    expect(
      DevLinkRecordSchema.safeParse(record('flow', { projectPath: '/somewhere' })).success
    ).toBe(false);
    expect(
      DevLinkRecordSchema.safeParse(record('flow', { scope: 'project', projectPath: '/p' })).success
    ).toBe(true);
  });

  it('hides the parked copy from every reader that lists packages', () => {
    // Purpose: the set-aside installed copy holds a valid manifest; any reader
    // that saw it would list the package twice.
    expect(MARKETPLACE_DEVLINK_PARKED_MARKER).toBe('.dorkos-devlink-parked');
    expect(isInstallSiblingName(`flow${MARKETPLACE_DEVLINK_PARKED_MARKER}`)).toBe(true);
    expect(isInstallSiblingName('flow')).toBe(false);
  });
});

describe('devLinkStateOf', () => {
  it('reports each state from what is on disk', async () => {
    // Purpose: the listing and doctor depend on telling these apart; unlink's
    // choice of what to touch does too.
    const target = path.join(home, 'work');
    await mkdir(target, { recursive: true });
    const slot = path.join(home, 'plugins', 'flow');
    await mkdir(path.dirname(slot), { recursive: true });
    const rec = { slot, target };

    expect(await devLinkStateOf(rec)).toBe('link-missing');
    await symlink(target, slot, 'dir');
    expect(await devLinkStateOf(rec)).toBe('active');
    await rm(target, { recursive: true });
    expect(await devLinkStateOf(rec)).toBe('folder-missing');
    await rm(slot);
    const elsewhere = path.join(home, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, slot, 'dir');
    expect(await devLinkStateOf(rec)).toBe('link-replaced');
    await rm(slot);
    await mkdir(slot);
    expect(await devLinkStateOf(rec)).toBe('link-replaced');
  });

  it('does not count a retargeted link as active', async () => {
    // Purpose: an agent running `ln -sfn /elsewhere <slot>` must lose every
    // dev-link privilege at once.
    const target = path.join(home, 'work');
    const other = path.join(home, 'other');
    await mkdir(target);
    await mkdir(other);
    const slot = path.join(home, 'plugins', 'flow');
    await mkdir(path.dirname(slot), { recursive: true });
    await symlink(other, slot, 'dir');
    await updateDevLinks(home, () => [record('flow', { slot, target })]);
    expect(await activeDevLinks(home)).toEqual([]);
  });
});
