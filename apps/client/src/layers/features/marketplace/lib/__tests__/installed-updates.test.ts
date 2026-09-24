import { describe, it, expect } from 'vitest';
import type { InstallationUpdateCheck, InstalledPackage } from '@dorkos/shared/marketplace-schemas';
import {
  formatCheckVersion,
  indexChecks,
  installationPlace,
  rowUpdateState,
  summarizeUpdates,
} from '../installed-updates';

function makeInstalled(installPath: string, name = 'flow'): InstalledPackage {
  return { name, version: '0.7.2', type: 'plugin', installPath };
}

function makeCheck(
  installPath: string,
  status: InstallationUpdateCheck['status'],
  overrides: Partial<InstallationUpdateCheck> = {}
): InstallationUpdateCheck {
  return {
    packageName: 'flow',
    installedVersion: '0.7.2',
    latestVersion: status === 'unknown' ? '' : '0.7.3',
    hasUpdate: status === 'update-available',
    marketplace: 'dorkos-community',
    status,
    installPath,
    type: 'plugin',
    scope: 'global',
    ...overrides,
  };
}

const NOT_BUSY = { isChecking: false, applying: new Set<string>() };

describe('rowUpdateState', () => {
  it('reads each status from the row’s own check, joined by installPath', () => {
    // Purpose: rows and checks join on installPath, never on name, because the
    // same package in two scopes is two installations with two answers.
    const checks = indexChecks([
      makeCheck('/a', 'update-available'),
      makeCheck('/b', 'current'),
      makeCheck('/c', 'unknown', { note: 'linked install — update its source instead' }),
    ]);

    expect(rowUpdateState(makeInstalled('/a'), checks, NOT_BUSY).kind).toBe('update-available');
    expect(rowUpdateState(makeInstalled('/b'), checks, NOT_BUSY).kind).toBe('current');
    expect(rowUpdateState(makeInstalled('/c'), checks, NOT_BUSY)).toMatchObject({
      kind: 'unknown',
      check: { note: 'linked install — update its source instead' },
    });
  });

  it('calls a row with no check unchecked, never current', () => {
    // Purpose: a row installed after the last check, or a failed check, has no
    // answer, and "no answer" must not read as "up to date".
    expect(rowUpdateState(makeInstalled('/new'), indexChecks([]), NOT_BUSY)).toEqual({
      kind: 'unchecked',
    });
  });

  it('shows a check in flight as pending over any earlier answer', () => {
    // Purpose: a check can wait behind another scan; it is pending, not failed,
    // and an older answer must not be offered as if it were current.
    const checks = indexChecks([makeCheck('/a', 'update-available')]);

    expect(
      rowUpdateState(makeInstalled('/a'), checks, { isChecking: true, applying: new Set() })
    ).toEqual({ kind: 'checking' });
    expect(
      rowUpdateState(makeInstalled('/new'), checks, { isChecking: true, applying: new Set() })
    ).toEqual({ kind: 'checking' });
  });

  it('shows an installation being updated as applying, even while a check runs', () => {
    // Purpose: the row being reinstalled must keep saying so; "checking" there
    // would hide that its files are changing.
    const checks = indexChecks([makeCheck('/a', 'update-available')]);

    expect(
      rowUpdateState(makeInstalled('/a'), checks, { isChecking: true, applying: new Set(['/a']) })
    ).toMatchObject({ kind: 'applying', check: { installPath: '/a' } });
  });
});

describe('summarizeUpdates', () => {
  it('counts only installations still in the list, in list order', () => {
    // Purpose: an uninstalled package drops out of the count as soon as the
    // list refreshes, without another network check, and "Update all" offers
    // the stale rows in the order the person sees them.
    const installed = [makeInstalled('/b'), makeInstalled('/a'), makeInstalled('/c')];
    const checks = indexChecks([
      makeCheck('/a', 'update-available'),
      makeCheck('/b', 'update-available'),
      makeCheck('/c', 'current'),
      makeCheck('/gone', 'update-available'),
      makeCheck('/gone-2', 'unknown'),
    ]);

    const summary = summarizeUpdates(installed, checks);

    expect(summary.available.map((s) => s.check.installPath)).toEqual(['/b', '/a']);
    // Each stale entry carries its row, whose name every label uses.
    expect(summary.available[0]!.installation).toBe(installed[0]);
    expect(summary.current).toBe(1);
    expect(summary.unknown).toBe(0);
  });

  it('counts unknown rows apart from current ones', () => {
    // Purpose: an unknown answer is never counted as up to date.
    const summary = summarizeUpdates(
      [makeInstalled('/a'), makeInstalled('/b')],
      indexChecks([makeCheck('/a', 'unknown'), makeCheck('/b', 'current')])
    );

    expect(summary).toEqual({ available: [], current: 1, unknown: 1 });
  });
});

describe('formatCheckVersion', () => {
  it('prefixes a version with v once', () => {
    // Purpose: the server sends bare semver; some packages declare "v1.2.0".
    expect(formatCheckVersion('1.2.0', 'package')).toBe('v1.2.0');
    expect(formatCheckVersion('v1.2.0', 'index')).toBe('v1.2.0');
    expect(formatCheckVersion('1.2.0')).toBe('v1.2.0');
  });

  it('shortens a commit to seven characters, with no v', () => {
    // Purpose: a package with no version is identified by its commit, and a
    // forty-character hash in a row is noise; "v" before a hash is wrong.
    expect(formatCheckVersion('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', 'commit')).toBe(
      'a1b2c3d'
    );
  });
});

describe('installationPlace', () => {
  it('names no place for a global installation', () => {
    expect(installationPlace({ scope: 'global' })).toBeNull();
    expect(installationPlace({})).toBeNull();
  });

  it('names the agent, else the project folder', () => {
    // Purpose: the same package on two agents must be told apart everywhere
    // (rows, the confirm step, toasts) with one rule.
    expect(
      installationPlace({ scope: 'agent-local', agentName: 'Alpha', agentPath: '/work/alpha' })
    ).toBe('Alpha');
    expect(installationPlace({ scope: 'override', agentPath: '/work/beta/' })).toBe('beta');
    expect(installationPlace({ scope: 'agent-local' })).toBe('agent');
  });
});
