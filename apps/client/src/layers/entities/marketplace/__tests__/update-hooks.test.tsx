/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import type {
  InstallationUpdateCheck,
  InstallationUpdatesResult,
  InstallResult,
} from '@dorkos/shared/marketplace-schemas';
import {
  marketplaceKeys,
  settleAppliedCheck,
  useApplyUpdates,
  useApplyingInstallPaths,
  useInstallPackage,
  useInstalledPackages,
  useInstalledUpdates,
} from '../index';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GLOBAL_PATH = '/home/.dork/plugins/flow';
const ALPHA_PATH = '/work/alpha/.dork/plugins/flow';

/** One apply target that runs nothing on its own, as a check would report it. */
const target = (installPath: string) => ({ installPath, latestVersion: '2.0.0', disclosed: null });

function makeCheck(overrides: Partial<InstallationUpdateCheck> = {}): InstallationUpdateCheck {
  return {
    packageName: 'flow',
    installedVersion: '0.7.2',
    latestVersion: '0.7.3',
    hasUpdate: true,
    marketplace: 'dorkos-community',
    status: 'update-available',
    installedVersionSource: 'package',
    latestVersionSource: 'package',
    installPath: GLOBAL_PATH,
    type: 'plugin',
    scope: 'global',
    ...overrides,
  };
}

function makeInstallResult(version: string, installPath = GLOBAL_PATH): InstallResult {
  return {
    ok: true,
    packageName: 'flow',
    version,
    type: 'plugin',
    installPath,
    manifest: { name: 'flow', version, type: 'plugin' },
    warnings: [],
  } as InstallResult;
}

function setup(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { queryClient, wrapper };
}

/**
 * The cached check, read from the client: a `renderHook` result only
 * re-renders for the query fields it read while rendering, so reading `data`
 * afterwards would miss a patch made in between.
 */
function cachedChecks(queryClient: QueryClient): InstallationUpdateCheck[] {
  return queryClient.getQueryData<InstallationUpdatesResult>(marketplaceKeys.updates())!.checks;
}

/** A promise the test settles by hand, to hold a mutation in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// useInstalledUpdates
// ---------------------------------------------------------------------------

describe('useInstalledUpdates', () => {
  it('asks once for every installation, with no project', async () => {
    // Purpose: the check is one request for the whole view, never one per row.
    const transport = createMockTransport();
    const answer: InstallationUpdatesResult = { checks: [makeCheck()] };
    vi.mocked(transport.checkMarketplaceUpdates).mockResolvedValue(answer);
    const { wrapper } = setup(transport);

    const first = renderHook(() => useInstalledUpdates(), { wrapper });
    // A second consumer (the tab count beside the view) shares the same request.
    renderHook(() => useInstalledUpdates(), { wrapper });

    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    expect(first.result.current.data).toEqual(answer);
    expect(transport.checkMarketplaceUpdates).toHaveBeenCalledTimes(1);
    expect(transport.checkMarketplaceUpdates).toHaveBeenCalledWith(undefined);
  });

  it('asks nothing while disabled', async () => {
    // Purpose: with nothing installed there is nothing to check, and the check
    // reaches out to every package source, so it must not run at all.
    const transport = createMockTransport();
    const { wrapper } = setup(transport);

    const { result } = renderHook(() => useInstalledUpdates(undefined, { enabled: false }), {
      wrapper,
    });

    await act(async () => {});
    expect(result.current.fetchStatus).toBe('idle');
    expect(transport.checkMarketplaceUpdates).not.toHaveBeenCalled();
  });

  it('does not retry a failed check behind the person', async () => {
    // Purpose: a failed check is shown with "Try again"; a silent retry would
    // repeat every package's network work without anyone asking.
    const transport = createMockTransport();
    vi.mocked(transport.checkMarketplaceUpdates).mockRejectedValue(new Error('offline'));
    const queryClient = new QueryClient(); // app-like default: retries on
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useInstalledUpdates(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(transport.checkMarketplaceUpdates).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// useApplyUpdates
// ---------------------------------------------------------------------------

describe('useApplyUpdates', () => {
  it('sends exactly the given installations', async () => {
    // Purpose: "Update all" must touch what its confirm step showed, no more.
    const transport = createMockTransport();
    vi.mocked(transport.applyMarketplaceUpdates).mockResolvedValue({ checks: [] });
    const { wrapper } = setup(transport);

    const { result } = renderHook(() => useApplyUpdates(), { wrapper });
    act(() =>
      result.current.mutate({
        targets: [target(GLOBAL_PATH), target(ALPHA_PATH)],
      })
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.applyMarketplaceUpdates).toHaveBeenCalledWith({
      targets: [target(GLOBAL_PATH), target(ALPHA_PATH)],
    });
  });

  it('marks an applied installation current at the version it was updated to', async () => {
    // Purpose: after an apply the row must stop saying "update available"
    // without a second network check; the server's answer is the truth.
    const transport = createMockTransport();
    const before = makeCheck();
    vi.mocked(transport.checkMarketplaceUpdates).mockResolvedValue({
      checks: [before, makeCheck({ installPath: ALPHA_PATH, scope: 'agent-local' })],
    });
    vi.mocked(transport.applyMarketplaceUpdates).mockResolvedValue({
      checks: [{ ...before, note: 'a caveat', applied: makeInstallResult('0.7.3') }],
    });
    const { queryClient, wrapper } = setup(transport);

    const updates = renderHook(() => useInstalledUpdates(), { wrapper });
    await waitFor(() => expect(updates.result.current.isSuccess).toBe(true));
    const apply = renderHook(() => useApplyUpdates(), { wrapper });
    act(() => apply.result.current.mutate({ targets: [target(GLOBAL_PATH)] }));
    await waitFor(() => expect(apply.result.current.isSuccess).toBe(true));

    const [patched, untouched] = cachedChecks(queryClient);
    expect(patched).toMatchObject({
      installPath: GLOBAL_PATH,
      status: 'current',
      hasUpdate: false,
      installedVersion: '0.7.3',
      installedVersionSource: 'package',
    });
    expect(patched.note).toBeUndefined();
    expect(patched.applied).toBeUndefined();
    // An installation the apply did not name keeps its answer.
    expect(untouched).toMatchObject({ installPath: ALPHA_PATH, status: 'update-available' });
    // The patch replaced the check in place: no second request went out.
    expect(transport.checkMarketplaceUpdates).toHaveBeenCalledTimes(1);
  });

  it('records the version the reinstall actually installed, not the one the check named', () => {
    // Purpose: a commit-identified latest whose manifest declares a version
    // installs that version; the row must show what is on disk, and say where
    // the version came from, so it joins the installed list's version.
    const check = makeCheck({
      latestVersion: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      latestVersionSource: 'commit',
    });

    const settled = settleAppliedCheck({ ...check, applied: makeInstallResult('0.8.0') });

    expect(settled).toMatchObject({
      status: 'current',
      installedVersion: '0.8.0',
      installedVersionSource: 'package',
    });
    // When the reinstall installed exactly what the check named, that side's
    // source describes it.
    expect(
      settleAppliedCheck({
        ...check,
        latestVersion: '0.8.0',
        latestVersionSource: 'index',
        applied: makeInstallResult('0.8.0'),
      })
    ).toMatchObject({ installedVersion: '0.8.0', installedVersionSource: 'index' });
  });

  it('leaves the failure report to its caller, so a failure is toasted once', async () => {
    // Purpose: the shared MutationCache toasts every failure unless a mutation
    // opts out; the apply's caller already replaces its own loading toast.
    const transport = createMockTransport();
    vi.mocked(transport.applyMarketplaceUpdates).mockRejectedValue(new Error('nope'));
    const { queryClient, wrapper } = setup(transport);

    const { result } = renderHook(() => useApplyUpdates(), { wrapper });
    act(() => result.current.mutate({ targets: [target(GLOBAL_PATH)] }));
    await waitFor(() => expect(result.current.isError).toBe(true));

    const [mutation] = queryClient.getMutationCache().getAll();
    expect(mutation!.meta).toEqual({ suppressErrorToast: true });
  });

  it('checks again when a new version changed what it runs since the person looked', async () => {
    // Purpose: the server refused because the check the person read is stale
    // (DOR-2306). The check must be asked again, so the next confirm shows what
    // the new version runs now instead of the list that no longer holds.
    const transport = createMockTransport();
    vi.mocked(transport.checkMarketplaceUpdates).mockResolvedValue({ checks: [makeCheck()] });
    vi.mocked(transport.applyMarketplaceUpdates).mockRejectedValue(
      Object.assign(new Error('changed'), { code: 'disclosure_changed', status: 409 })
    );
    const { wrapper } = setup(transport);

    const updates = renderHook(() => useInstalledUpdates(), { wrapper });
    await waitFor(() => expect(updates.result.current.isSuccess).toBe(true));
    expect(transport.checkMarketplaceUpdates).toHaveBeenCalledTimes(1);
    const apply = renderHook(() => useApplyUpdates(), { wrapper });
    act(() => apply.result.current.mutate({ targets: [target(GLOBAL_PATH)] }));
    await waitFor(() => expect(apply.result.current.isError).toBe(true));

    await waitFor(() => expect(transport.checkMarketplaceUpdates).toHaveBeenCalledTimes(2));
  });

  it('keeps a failed reinstall on its row, still offering the update', async () => {
    // Purpose: a failure must stay visible on the installation it belongs to.
    const transport = createMockTransport();
    vi.mocked(transport.checkMarketplaceUpdates).mockResolvedValue({ checks: [makeCheck()] });
    vi.mocked(transport.applyMarketplaceUpdates).mockResolvedValue({
      checks: [makeCheck({ applyError: 'disk full' })],
    });
    const { queryClient, wrapper } = setup(transport);

    const updates = renderHook(() => useInstalledUpdates(), { wrapper });
    await waitFor(() => expect(updates.result.current.isSuccess).toBe(true));
    const apply = renderHook(() => useApplyUpdates(), { wrapper });
    act(() => apply.result.current.mutate({ targets: [target(GLOBAL_PATH)] }));
    await waitFor(() => expect(apply.result.current.isSuccess).toBe(true));

    expect(cachedChecks(queryClient)[0]).toMatchObject({
      status: 'update-available',
      applyError: 'disk full',
    });
  });

  it('stores a fresh answer that is no longer an update as the server gave it', async () => {
    // Purpose: between the check and the click the answer can change (someone
    // else updated it, or the source went away); the row shows the new truth.
    const transport = createMockTransport();
    vi.mocked(transport.checkMarketplaceUpdates).mockResolvedValue({ checks: [makeCheck()] });
    const fresh = makeCheck({
      status: 'unknown',
      hasUpdate: false,
      latestVersion: '',
      note: "couldn't reach github.com",
    });
    vi.mocked(transport.applyMarketplaceUpdates).mockResolvedValue({ checks: [fresh] });
    const { queryClient, wrapper } = setup(transport);

    const updates = renderHook(() => useInstalledUpdates(), { wrapper });
    await waitFor(() => expect(updates.result.current.isSuccess).toBe(true));
    const apply = renderHook(() => useApplyUpdates(), { wrapper });
    act(() => apply.result.current.mutate({ targets: [target(GLOBAL_PATH)] }));
    await waitFor(() => expect(apply.result.current.isSuccess).toBe(true));

    expect(cachedChecks(queryClient)[0]).toEqual(fresh);
  });

  it('refreshes the installed list and the command registry after an applied update', async () => {
    // Purpose: a reinstall changes the listed version and can change slash
    // commands (UX-12), so both must be asked again.
    const transport = createMockTransport();
    vi.mocked(transport.applyMarketplaceUpdates).mockResolvedValue({
      checks: [makeCheck({ applied: makeInstallResult('0.7.3') })],
    });
    const { queryClient, wrapper } = setup(transport);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useApplyUpdates(), { wrapper });
    act(() => result.current.mutate({ targets: [target(GLOBAL_PATH)] }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: marketplaceKeys.installed() });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: marketplaceKeys.installedDetail('flow') });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: marketplaceKeys.packageDetail('flow') });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['commands'] });
  });

  it('stays pending until the installed list shows the new versions', async () => {
    // Purpose: between the patched check (new version) and a list that has not
    // refreshed (old version), the row would read as unchecked; holding the
    // apply until the list lands keeps it on "Updating…" instead.
    const transport = createMockTransport();
    const listed = deferred<never[]>();
    vi.mocked(transport.listInstalledPackages)
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(listed.promise);
    vi.mocked(transport.applyMarketplaceUpdates).mockResolvedValue({
      checks: [makeCheck({ applied: makeInstallResult('0.7.3') })],
    });
    const { wrapper } = setup(transport);

    const list = renderHook(() => useInstalledPackages(), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    const apply = renderHook(() => useApplyUpdates(), { wrapper });
    act(() => apply.result.current.mutate({ targets: [target(GLOBAL_PATH)] }));

    await waitFor(() => expect(transport.listInstalledPackages).toHaveBeenCalledTimes(2));
    expect(apply.result.current.isPending).toBe(true);
    await act(async () => listed.resolve([]));
    await waitFor(() => expect(apply.result.current.isSuccess).toBe(true));
  });

  it('leaves the command registry alone when nothing was applied', async () => {
    // Purpose: an apply that found everything current changed nothing on disk.
    const transport = createMockTransport();
    vi.mocked(transport.applyMarketplaceUpdates).mockResolvedValue({
      checks: [makeCheck({ status: 'current', hasUpdate: false })],
    });
    const { queryClient, wrapper } = setup(transport);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useApplyUpdates(), { wrapper });
    act(() => result.current.mutate({ targets: [target(GLOBAL_PATH)] }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['commands'] });
  });
});

// ---------------------------------------------------------------------------
// useApplyingInstallPaths
// ---------------------------------------------------------------------------

describe('useApplyingInstallPaths', () => {
  it('holds every installation of every apply still in flight', async () => {
    // Purpose: two rows updated one after the other must both show progress;
    // one shared mutation would forget the first.
    const transport = createMockTransport();
    const first = deferred<InstallationUpdatesResult>();
    const second = deferred<InstallationUpdatesResult>();
    vi.mocked(transport.applyMarketplaceUpdates)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { wrapper } = setup(transport);

    const applying = renderHook(() => useApplyingInstallPaths(), { wrapper });
    const a = renderHook(() => useApplyUpdates(), { wrapper });
    const b = renderHook(() => useApplyUpdates(), { wrapper });
    act(() => a.result.current.mutate({ targets: [target(GLOBAL_PATH)] }));
    act(() => b.result.current.mutate({ targets: [target(ALPHA_PATH)] }));

    await waitFor(() =>
      expect([...applying.result.current].sort()).toEqual([GLOBAL_PATH, ALPHA_PATH].sort())
    );

    await act(async () => first.resolve({ checks: [] }));
    await waitFor(() => expect([...applying.result.current]).toEqual([ALPHA_PATH]));

    await act(async () => second.resolve({ checks: [] }));
    await waitFor(() => expect(applying.result.current.size).toBe(0));
  });
});

// ---------------------------------------------------------------------------
// useInstallPackage → the update check
// ---------------------------------------------------------------------------

describe('useInstallPackage and the update check', () => {
  it('marks the check stale without asking again right away', async () => {
    // Purpose: a new installation has no check yet; the next time the view
    // mounts it asks again, but an install must not trigger a network sweep.
    const transport = createMockTransport();
    vi.mocked(transport.installMarketplacePackage).mockResolvedValue(makeInstallResult('1.0.0'));
    const { queryClient, wrapper } = setup(transport);

    const updates = renderHook(() => useInstalledUpdates(), { wrapper });
    await waitFor(() => expect(updates.result.current.isSuccess).toBe(true));
    const install = renderHook(() => useInstallPackage(), { wrapper });
    act(() => install.result.current.mutate({ name: 'flow' }));
    await waitFor(() => expect(install.result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryState(marketplaceKeys.updates())?.isInvalidated).toBe(true);
    expect(transport.checkMarketplaceUpdates).toHaveBeenCalledTimes(1);
  });
});
