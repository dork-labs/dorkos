import { describe, it, expect } from 'vitest';
import type { InstalledDevLink, InstalledPackage } from '@dorkos/shared/marketplace-schemas';
import {
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
  it('reports a link not in force before any reload', () => {
    // Purpose: a missing folder wins over an old "Reloaded" time.
    expect(devLinkRowStatus({ ...ACTIVE, state: 'folder-missing' }, undefined, AT).kind).toBe(
      'folder-missing'
    );
  });

  it('says it is watching before the first reload', () => {
    expect(devLinkRowStatus(ACTIVE, undefined, undefined)).toEqual({ kind: 'watching' });
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
      AT
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
      LATER
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
  it('matches a project row only to its own project', () => {
    // Purpose: two dev links of one package in two scopes never cross.
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
        projectPath: '/p',
        path: '/b',
        state: 'active',
        parked: null,
        linkedAt: AT,
      },
    ] as const;
    const row = { name: 'flow', agentPath: '/p' } as InstalledPackage;
    expect(findDevLinkStatus([...links], row)?.path).toBe('/b');
    expect(findDevLinkStatus([...links], { name: 'flow' } as InstalledPackage)?.path).toBe('/a');
  });
});
