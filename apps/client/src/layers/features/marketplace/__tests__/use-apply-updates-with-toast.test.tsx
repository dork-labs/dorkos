/**
 * @vitest-environment jsdom
 *
 * Direct unit tests for `useApplyUpdatesWithToast`. Mocks only `useApplyUpdates`
 * and `sonner`, and drives the mutation's per-call callbacks by hand, so each
 * outcome's toast is pinned exactly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useApplyUpdates } from '@/layers/entities/marketplace';
import type {
  InstallationUpdateCheck,
  InstallationUpdatesResult,
  InstalledPackage,
  InstallResult,
} from '@dorkos/shared/marketplace-schemas';
import type { StaleInstallation } from '../lib/installed-updates';

import { useApplyUpdatesWithToast } from '../model/use-apply-updates-with-toast';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/marketplace', () => ({
  useApplyUpdates: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({
  loading: vi.fn(() => 'toast-id'),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: toastMock }));

const mutate = vi.fn();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCheck(overrides: Partial<InstallationUpdateCheck> = {}): InstallationUpdateCheck {
  return {
    packageName: '@dorkos/reviewer',
    installedVersion: '1.2.0',
    latestVersion: '1.3.0',
    hasUpdate: true,
    marketplace: 'dorkos-community',
    status: 'update-available',
    installPath: '/home/.dork/agents/reviewer',
    type: 'agent',
    scope: 'global',
    ...overrides,
  };
}

function applied(check: InstallationUpdateCheck): InstallationUpdateCheck {
  return {
    ...check,
    applied: { version: check.latestVersion, packageName: check.packageName } as InstallResult,
  };
}

const ALPHA = makeCheck({
  installPath: '/work/alpha/.dork/agents/reviewer',
  scope: 'agent-local',
  agentPath: '/work/alpha',
  agentName: 'Alpha',
});
const FLOW = makeCheck({
  packageName: 'flow',
  installPath: '/home/.dork/plugins/flow',
  installedVersion: '0.7.2',
  latestVersion: '0.7.3',
});

/** The row a check belongs to, as the installed list shows it. */
function stale(check: InstallationUpdateCheck): StaleInstallation {
  const installation: InstalledPackage = {
    name: check.packageName,
    version: check.installedVersion,
    type: check.type,
    installPath: check.installPath,
    scope: check.scope,
    agentPath: check.agentPath,
    agentName: check.agentName,
  };
  return { installation, check };
}

/** Run `apply` for these checks' rows and settle it with `result` (or an error). */
function runApply(
  checks: InstallationUpdateCheck[],
  outcome: { result: InstallationUpdatesResult } | { error: Error }
) {
  const { result } = renderHook(() => useApplyUpdatesWithToast());
  act(() => result.current.apply(checks.map(stale)));
  const [, callbacks] = mutate.mock.calls[0] as [
    unknown,
    { onSuccess: (r: InstallationUpdatesResult) => void; onError: (e: Error) => void },
  ];
  act(() => {
    if ('result' in outcome) callbacks.onSuccess(outcome.result);
    else callbacks.onError(outcome.error);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useApplyUpdates).mockReturnValue({ mutate } as unknown as ReturnType<
    typeof useApplyUpdates
  >);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useApplyUpdatesWithToast', () => {
  it('sends exactly the installations it was given and shows one loading toast', () => {
    // Purpose: the toast names what is being updated, and the request carries
    // those installations and no others.
    const { result } = renderHook(() => useApplyUpdatesWithToast());

    act(() => result.current.apply([makeCheck(), FLOW].map(stale)));

    expect(mutate).toHaveBeenCalledWith(
      { installPaths: ['/home/.dork/agents/reviewer', '/home/.dork/plugins/flow'] },
      expect.any(Object)
    );
    expect(toastMock.loading).toHaveBeenCalledWith('Updating 2 packages…');
  });

  it('sends nothing for an empty list', () => {
    // Purpose: an apply with no named installation must never reach the server.
    const { result } = renderHook(() => useApplyUpdatesWithToast());

    act(() => result.current.apply([]));

    expect(mutate).not.toHaveBeenCalled();
    expect(toastMock.loading).not.toHaveBeenCalled();
  });

  it('reports one applied update with its new version and place', () => {
    runApply([ALPHA], { result: { checks: [applied(ALPHA)] } });

    expect(toastMock.loading).toHaveBeenCalledWith('Updating Reviewer on Alpha…');
    expect(toastMock.success).toHaveBeenCalledWith('Updated Reviewer on Alpha to v1.3.0', {
      id: 'toast-id',
    });
  });

  it('reports one failed reinstall with the reason', () => {
    runApply([makeCheck()], { result: { checks: [makeCheck({ applyError: 'disk full' })] } });

    expect(toastMock.error).toHaveBeenCalledWith("Couldn't update Reviewer: disk full", {
      id: 'toast-id',
    });
  });

  it('says so when the package turned out to be up to date already', () => {
    // Purpose: the click did something visible even though nothing changed.
    runApply([makeCheck()], {
      result: { checks: [makeCheck({ status: 'current', hasUpdate: false })] },
    });

    expect(toastMock.success).toHaveBeenCalledWith('Reviewer is already up to date', {
      id: 'toast-id',
    });
  });

  it('warns, with the reason, when the package could not be checked', () => {
    // Purpose: an unknown answer is never reported as up to date.
    runApply([makeCheck()], {
      result: {
        checks: [
          makeCheck({
            status: 'unknown',
            hasUpdate: false,
            latestVersion: '',
            note: "couldn't reach github.com",
          }),
        ],
      },
    });

    expect(toastMock.warning).toHaveBeenCalledWith(
      "Couldn't check Reviewer for updates: couldn't reach github.com",
      { id: 'toast-id' }
    );
  });

  it('reports several applied updates as one count', () => {
    runApply([makeCheck(), FLOW], { result: { checks: [applied(makeCheck()), applied(FLOW)] } });

    expect(toastMock.success).toHaveBeenCalledWith('Updated 2 packages', { id: 'toast-id' });
  });

  it('warns when only some of several were applied, and points at the rows', () => {
    // Purpose: a partial batch is not a success; each row carries its reason.
    runApply([makeCheck(), FLOW], {
      result: { checks: [applied(makeCheck()), { ...FLOW, applyError: 'disk full' }] },
    });

    expect(toastMock.warning).toHaveBeenCalledWith(
      'Updated 1 of 2 packages. Each package shows what happened.',
      { id: 'toast-id' }
    );
  });

  it('reports an error when none of several were applied', () => {
    runApply([makeCheck(), FLOW], {
      result: {
        checks: [
          { ...makeCheck(), applyError: 'disk full' },
          { ...FLOW, applyError: 'disk full' },
        ],
      },
    });

    expect(toastMock.error).toHaveBeenCalledWith(
      "Couldn't update 2 packages. Each package shows why.",
      { id: 'toast-id' }
    );
  });

  it('counts only the failures when some of several failed and none applied', () => {
    // Purpose: a package that was already current is not a failure.
    runApply([makeCheck(), FLOW], {
      result: {
        checks: [
          { ...makeCheck(), applyError: 'disk full' },
          { ...FLOW, status: 'current', hasUpdate: false },
        ],
      },
    });

    expect(toastMock.error).toHaveBeenCalledWith(
      "Couldn't update 1 of 2 packages. Each package shows why.",
      { id: 'toast-id' }
    );
  });

  it('says so when several turned out to be up to date already', () => {
    runApply([makeCheck(), FLOW], {
      result: {
        checks: [
          { ...makeCheck(), status: 'current', hasUpdate: false },
          { ...FLOW, status: 'current', hasUpdate: false },
        ],
      },
    });

    expect(toastMock.success).toHaveBeenCalledWith('These 2 packages are already up to date', {
      id: 'toast-id',
    });
  });

  it('warns when several changed nothing for mixed reasons', () => {
    // Purpose: a batch that updated nothing must not read as a success.
    runApply([makeCheck(), FLOW], {
      result: {
        checks: [
          { ...makeCheck(), status: 'current', hasUpdate: false },
          { ...FLOW, status: 'unknown', hasUpdate: false, latestVersion: '' },
        ],
      },
    });

    expect(toastMock.warning).toHaveBeenCalledWith(
      'Nothing was updated. Each package shows where it stands.',
      { id: 'toast-id' }
    );
  });

  it('reports a refused or failed request with the server’s message', () => {
    runApply([makeCheck()], { error: new Error('Package not installed: reviewer') });

    expect(toastMock.error).toHaveBeenCalledWith('Update failed: Package not installed: reviewer', {
      id: 'toast-id',
    });
  });
});
