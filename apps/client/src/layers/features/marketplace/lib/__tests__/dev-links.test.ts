import { describe, it, expect } from 'vitest';
import type { InstalledDevLink, InstalledPackage } from '@dorkos/shared/marketplace-schemas';
import {
  devLinkIdentityOf,
  devLinkRowStatus,
  findDevLinkStatus,
  formatReloadedAgo,
  reloadFailureHeadline,
} from '../dev-links';

const ACTIVE: InstalledDevLink = { path: '/work/flow', state: 'active', parked: false };
const AT = '2026-10-03T12:00:00.000Z';
const LATER = '2026-10-03T12:00:05.000Z';

describe('reloadFailureHeadline', () => {
  it('names the one extension that did not build', () => {
    // Purpose: the server's "<id> didn't build:" sentence becomes the spec's headline.
    expect(reloadFailureHeadline(["flow-dashboard didn't build: Unexpected token"])).toBe(
      'Couldn’t reload: flow-dashboard has a build error.'
    );
  });

  it('says it plainly for anything else', () => {
    // Purpose: no extension name is invented for another kind of failure.
    expect(reloadFailureHeadline(["Extensions couldn't be scanned again: EACCES"])).toBe(
      'Couldn’t reload your last edit.'
    );
    expect(reloadFailureHeadline(["a didn't build: x", "b didn't build: y"])).toBe(
      'Couldn’t reload your last edit.'
    );
  });
});

describe('devLinkRowStatus', () => {
  const LISTED = { linkedAt: AT, lastReloadAt: AT };

  it('reports a link not in force before any reload', () => {
    // Purpose: a missing folder wins over an old "Reloaded" time.
    expect(devLinkRowStatus({ ...ACTIVE, state: 'folder-missing' }, undefined, LISTED).kind).toBe(
      'folder-missing'
    );
  });

  it('says it is watching before the first reload', () => {
    expect(devLinkRowStatus(ACTIVE, undefined, undefined)).toEqual({ kind: 'watching' });
  });

  it('ignores a build error from before the link was made', () => {
    // Purpose: unlink then relink must not show the earlier link's error.
    const status = devLinkRowStatus(
      ACTIVE,
      { name: 'flow', scope: 'global', at: AT, actions: ['extension'], errors: ['old'] },
      { linkedAt: LATER }
    );
    expect(status).toEqual({ kind: 'watching' });
  });

  it('shows a failed reload from the newest event', () => {
    // Purpose: only the event carries errors, so a newer event wins.
    const status = devLinkRowStatus(
      ACTIVE,
      {
        name: 'flow',
        scope: 'global',
        at: LATER,
        actions: ['extension'],
        errors: ["x didn't build: y"],
      },
      LISTED
    );
    expect(status).toMatchObject({
      kind: 'reload-failed',
      at: LATER,
      details: ["x didn't build: y"],
    });
  });

  it('lets a newer clean reload from the listing replace an older failure', () => {
    // Purpose: a failure is not shown forever after a later reload succeeded.
    const status = devLinkRowStatus(
      ACTIVE,
      { name: 'flow', scope: 'global', at: AT, actions: ['extension'], errors: ['boom'] },
      { linkedAt: AT, lastReloadAt: LATER }
    );
    expect(status).toEqual({ kind: 'reloaded', at: LATER });
  });
});

describe('formatReloadedAgo', () => {
  const now = Date.parse(AT);
  it.each([
    [0, 'Reloaded just now'],
    [4_000, 'Reloaded 4s ago'],
    [3 * 60_000, 'Reloaded 3m ago'],
    [2 * 3_600_000, 'Reloaded 2h ago'],
  ])('%i ms ago reads "%s"', (elapsed, expected) => {
    expect(formatReloadedAgo(new Date(now - elapsed).toISOString(), now)).toBe(expected);
  });
});

describe('findDevLinkStatus', () => {
  const links = [
    {
      name: 'flow',
      type: 'plugin',
      scope: 'global',
      path: '/a',
      state: 'active',
      parked: null,
      linkedAt: AT,
    },
    {
      name: 'flow',
      type: 'plugin',
      scope: 'project',
      projectPath: '/private/tmp/app',
      path: '/b',
      state: 'active',
      parked: null,
      linkedAt: AT,
    },
  ] as const;

  it('matches a row by scope and folder, never across scopes', () => {
    // Purpose: two dev links of one package in two scopes never cross.
    const projectRow = {
      name: 'flow',
      agentPath: '/private/tmp/app',
      devLink: { path: '/b', state: 'active', parked: false },
    } as InstalledPackage;
    const globalRow = {
      name: 'flow',
      devLink: { path: '/a', state: 'active', parked: false },
    } as InstalledPackage;
    expect(findDevLinkStatus([...links], projectRow)?.path).toBe('/b');
    expect(findDevLinkStatus([...links], globalRow)?.path).toBe('/a');
  });

  it('finds a project link whose project the row spells through a symbolic link', () => {
    // Purpose: the row's agent path (/tmp/app) and the server's real path
    // (/private/tmp/app) differ on macOS; the folder still identifies the link,
    // and its identity carries the server's spelling for reload events.
    const row = {
      name: 'flow',
      agentPath: '/tmp/app',
      devLink: { path: '/b', state: 'active', parked: false },
    } as InstalledPackage;
    const entry = findDevLinkStatus([...links], row);
    expect(entry?.projectPath).toBe('/private/tmp/app');
    expect(devLinkIdentityOf(row, entry)).toEqual({
      name: 'flow',
      scope: 'project',
      projectPath: '/private/tmp/app',
    });
  });
});
