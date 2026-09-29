/**
 * @vitest-environment jsdom
 *
 * Direct unit tests for `useApplyUpdatesWithToast`. Mocks `useApplyUpdates` and
 * `sonner`, and settles each apply's `mutateAsync` promise by hand, so each
 * outcome's toast is pinned exactly. The lifecycle cases (overlapping applies,
 * unmounting mid-apply) run against the real mutation in
 * `use-apply-updates-with-toast.lifecycle.test.tsx`.
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

vi.mock('@/layers/entities/marketplace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/marketplace')>();
  return { settleAppliedCheck: actual.settleAppliedCheck, useApplyUpdates: vi.fn() };
});

const toastMock = vi.hoisted(() => ({
  loading: vi.fn(() => 'toast-id'),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: toastMock }));

/** Each apply's promise, settled by the test. */
let pending: Array<{
  resolve: (r: InstallationUpdatesResult) => void;
  reject: (e: unknown) => void;
}> = [];
const mutateAsync = vi.fn(
  () =>
    new Promise<InstallationUpdatesResult>((resolve, reject) => {
      pending.push({ resolve, reject });
    })
);

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
async function runApply(
  checks: InstallationUpdateCheck[],
  outcome: { result: InstallationUpdatesResult } | { error: unknown }
) {
  const { result } = renderHook(() => useApplyUpdatesWithToast());
  act(() => result.current.apply(checks.map(stale)));
  await act(async () => {
    if ('result' in outcome) pending[0]!.resolve(outcome.result);
    else pending[0]!.reject(outcome.error);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  pending = [];
  vi.mocked(useApplyUpdates).mockReturnValue({ mutateAsync } as unknown as ReturnType<
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

    const runs = {
      hooks: [{ event: 'Stop', matcher: null, command: 'echo hi', source: null }],
      schedules: [],
      mcpServers: [],
      lspServers: [],
      monitors: [],
      executables: [],
      skillTools: [],
      skillCommands: [],
    };
    act(() =>
      result.current.apply(
        [
          makeCheck({ disclosed: runs, contentHash: 'sha256:r' }),
          { ...FLOW, contentHash: 'sha256:f' },
        ].map(stale)
      )
    );

    // Each installation carries the version and disclosure the person was
    // shown, untouched: the server installs only what still matches (DOR-2306).
    // A check with no disclosure sends `null`, which only matches a version
    // that runs nothing.
    expect(mutateAsync).toHaveBeenCalledWith({
      targets: [
        {
          installPath: '/home/.dork/agents/reviewer',
          latestVersion: '1.3.0',
          disclosed: runs,
          contentHash: 'sha256:r',
        },
        {
          installPath: '/home/.dork/plugins/flow',
          latestVersion: '0.7.3',
          disclosed: null,
          contentHash: 'sha256:f',
        },
      ],
    });
    expect(toastMock.loading).toHaveBeenCalledWith('Updating 2 packages…');
  });

  it('sends nothing for an empty list', () => {
    // Purpose: an apply with no named installation must never reach the server.
    const { result } = renderHook(() => useApplyUpdatesWithToast());

    act(() => result.current.apply([]));

    expect(mutateAsync).not.toHaveBeenCalled();
    expect(toastMock.loading).not.toHaveBeenCalled();
  });

  it('reports one applied update with its new version and place', async () => {
    await runApply([ALPHA], { result: { checks: [applied(ALPHA)] } });

    expect(toastMock.loading).toHaveBeenCalledWith('Updating Reviewer on Alpha…');
    expect(toastMock.success).toHaveBeenCalledWith('Updated Reviewer on Alpha to v1.3.0', {
      id: 'toast-id',
    });
  });

  // Purpose (DOR-2322): an update that kept files it could not prove says so
  // right away, in the server's words, under the success line. Fails if the
  // warning is dropped (it was, before: the toast showed only the version).
  it('shows what an update had to say under its success line', async () => {
    const said =
      "DorkOS couldn't download the version of reviewer you had, so it couldn't tell whether 1 file was yours or left over from that version. It kept it: old.md.";
    await runApply([ALPHA], {
      result: {
        checks: [
          {
            ...ALPHA,
            applied: {
              version: '1.3.0',
              packageName: ALPHA.packageName,
              warnings: [said],
              fileNotices: [{ path: 'old.md', outcome: 'kept-unproven' }],
            } as InstallResult,
          },
        ],
      },
    });

    expect(toastMock.success).toHaveBeenCalledWith('Updated Reviewer on Alpha to v1.3.0', {
      id: 'toast-id',
      description: said,
    });
  });

  // Purpose (DOR-2322): several updates collapse to a count, so the toast
  // points at the rows when any of them kept files it could not sort.
  it('points at the rows when one of several kept files it could not sort', async () => {
    const kept = {
      ...applied(FLOW),
      applied: {
        version: '0.7.3',
        packageName: 'flow',
        warnings: ['…'],
        fileNotices: [{ path: 'old.md', outcome: 'kept-unproven' }],
      } as InstallResult,
    };
    await runApply([makeCheck(), FLOW], { result: { checks: [applied(makeCheck()), kept] } });

    expect(toastMock.success).toHaveBeenCalledWith(
      'Updated 2 packages. One or more kept files DorkOS couldn’t sort; their rows say which.',
      { id: 'toast-id' }
    );
  });

  it('reports one failed reinstall with the reason', async () => {
    await runApply([makeCheck()], { result: { checks: [makeCheck({ applyError: 'disk full' })] } });

    expect(toastMock.error).toHaveBeenCalledWith('Couldn’t update Reviewer: disk full', {
      id: 'toast-id',
    });
  });

  it('says so when the package turned out to be up to date already', async () => {
    // Purpose: the click did something visible even though nothing changed.
    await runApply([makeCheck()], {
      result: { checks: [makeCheck({ status: 'current', hasUpdate: false })] },
    });

    expect(toastMock.success).toHaveBeenCalledWith('Reviewer is already up to date', {
      id: 'toast-id',
    });
  });

  it('warns, with the reason, when the package could not be checked', async () => {
    // Purpose: an unknown answer is never reported as up to date.
    await runApply([makeCheck()], {
      result: {
        checks: [
          makeCheck({
            status: 'unknown',
            hasUpdate: false,
            latestVersion: '',
            note: 'couldn’t reach github.com',
          }),
        ],
      },
    });

    expect(toastMock.warning).toHaveBeenCalledWith(
      'Couldn’t check Reviewer for updates: couldn’t reach github.com',
      { id: 'toast-id' }
    );
  });

  it('reports several applied updates as one count', async () => {
    await runApply([makeCheck(), FLOW], {
      result: { checks: [applied(makeCheck()), applied(FLOW)] },
    });

    expect(toastMock.success).toHaveBeenCalledWith('Updated 2 packages', { id: 'toast-id' });
  });

  it('warns when only some of several were applied, and points at the rows', async () => {
    // Purpose: a partial batch is not a success; each row carries its reason.
    await runApply([makeCheck(), FLOW], {
      result: { checks: [applied(makeCheck()), { ...FLOW, applyError: 'disk full' }] },
    });

    expect(toastMock.warning).toHaveBeenCalledWith(
      'Updated 1 of 2 packages. Each package shows what happened.',
      { id: 'toast-id' }
    );
  });

  it('reports an error when none of several were applied', async () => {
    await runApply([makeCheck(), FLOW], {
      result: {
        checks: [
          { ...makeCheck(), applyError: 'disk full' },
          { ...FLOW, applyError: 'disk full' },
        ],
      },
    });

    expect(toastMock.error).toHaveBeenCalledWith(
      'Couldn’t update 2 packages. Each package shows why.',
      { id: 'toast-id' }
    );
  });

  it('counts only the failures when some of several failed and none applied', async () => {
    // Purpose: a package that was already current is not a failure.
    await runApply([makeCheck(), FLOW], {
      result: {
        checks: [
          { ...makeCheck(), applyError: 'disk full' },
          { ...FLOW, status: 'current', hasUpdate: false },
        ],
      },
    });

    expect(toastMock.error).toHaveBeenCalledWith(
      'Couldn’t update 1 of 2 packages. Each package shows why.',
      { id: 'toast-id' }
    );
  });

  it('says so when several turned out to be up to date already', async () => {
    await runApply([makeCheck(), FLOW], {
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

  it('warns when several changed nothing for mixed reasons', async () => {
    // Purpose: a batch that updated nothing must not read as a success.
    await runApply([makeCheck(), FLOW], {
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

  it('reports a failed request once, in the house form, with the reason under it', async () => {
    await runApply([makeCheck()], { error: new Error('Package not installed: reviewer') });

    expect(toastMock.error).toHaveBeenCalledTimes(1);
    expect(toastMock.error).toHaveBeenCalledWith('Couldn’t update Reviewer', {
      id: 'toast-id',
      description: 'Package not installed: reviewer',
    });
  });

  it('explains a batch that needs approval in plain words, with no API route', async () => {
    // Purpose: the server's message names an API route, which a person cannot
    // act on; the refusal's code gets a sentence of its own.
    const refusal = Object.assign(
      new Error('Update them one at a time with POST /api/marketplace/packages/:name/update.'),
      { code: 'batch_update_needs_approval', status: 403 }
    );
    await runApply([makeCheck(), FLOW], { error: refusal });

    const [headline, options] = toastMock.error.mock.calls[0] as unknown as [
      string,
      { description: string },
    ];
    expect(headline).toBe('Couldn’t update 2 packages');
    expect(options.description).toBe(
      'Each of these installs needs your approval first, and DorkOS can’t ask for it here. ' +
        'Update each one from the terminal with `dorkos marketplace update <name> --apply`.'
    );
    expect(options.description).not.toMatch(/\/api\//);
  });

  it('says a package changed what it runs since it was shown, and that nothing changed', async () => {
    // Purpose: the server refused because a new version now runs something the
    // person did not see (DOR-2306). The toast says so in plain words, and
    // points at looking again rather than retrying blind.
    const refusal = Object.assign(new Error('What an update would install is not what was shown'), {
      code: 'disclosure_changed',
      status: 409,
    });
    await runApply([makeCheck()], { error: refusal });

    const [, options] = toastMock.error.mock.calls[0] as unknown as [
      string,
      { description: string },
    ];
    expect(options.description).toBe(
      'This package changed what it runs since you looked, so nothing was updated. Review it again before updating.'
    );
  });

  it('names the command for the one package it refused', async () => {
    // Purpose: the refusal carries its next step, and for one package the
    // command is ready to paste.
    const refusal = Object.assign(new Error('refused'), {
      code: 'batch_update_needs_approval',
      status: 403,
    });
    await runApply([makeCheck()], { error: refusal });

    const [, options] = toastMock.error.mock.calls[0] as unknown as [
      string,
      { description: string },
    ];
    expect(options.description).toMatch(
      /Update it from the terminal with `dorkos marketplace update @dorkos\/reviewer --apply`\.$/
    );
  });

  it('ignores a second apply for an installation already being updated', async () => {
    // Purpose: a double click must not send the same reinstall twice.
    const { result } = renderHook(() => useApplyUpdatesWithToast());

    act(() => result.current.apply([stale(makeCheck())]));
    act(() => result.current.apply([stale(makeCheck())]));
    // A batch naming it plus another sends only the other.
    act(() => result.current.apply([stale(makeCheck()), stale(FLOW)]));

    expect(mutateAsync).toHaveBeenCalledTimes(2);
    expect(mutateAsync).toHaveBeenLastCalledWith({
      targets: [
        {
          installPath: '/home/.dork/plugins/flow',
          latestVersion: '0.7.3',
          disclosed: null,
          contentHash: '',
        },
      ],
    });
    expect(toastMock.loading).toHaveBeenCalledTimes(2);

    // Once it settles, it can be applied again.
    await act(async () => pending[0]!.resolve({ checks: [] }));
    act(() => result.current.apply([stale(makeCheck())]));
    expect(mutateAsync).toHaveBeenCalledTimes(3);
  });
});
