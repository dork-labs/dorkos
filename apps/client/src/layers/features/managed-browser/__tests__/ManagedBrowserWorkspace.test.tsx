// @vitest-environment jsdom
import { act, fireEvent, render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, onTestFinished } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import type {
  BrowserProductionTransport,
  BrowserInputTransport,
  BrowserViewerTransport,
} from '@dorkos/shared/transport';
import type {
  BrowserProductionStatus,
  BrowserProductionOpenReceipt,
  BrowserOpenRequest,
  BrowserBinding,
  BrowserControl,
  BrowserInstance,
} from '@dorkos/shared/browser-schemas';
import type { ManagedBrowserViewerProps } from '../ui/ManagedBrowserViewer';
import { ManagedBrowserWorkspace } from '../ui/ManagedBrowserWorkspace';
// Semantic HTTP-port and viewer component doubles only; no native/auth/readiness acceptance.
const renders = vi.hoisted(() => [] as ManagedBrowserViewerProps[]);
vi.mock('../ui/ManagedBrowserViewer', () => ({
  ManagedBrowserViewer: (props: ManagedBrowserViewerProps) => {
    renders.push(props);
    return <div data-testid="viewer" />;
  },
}));
const binding = {
  browserId: 'browser_original_000000000001',
  browserGeneration: 1,
  tabId: 'tab_original_reference_000001',
  navigationGeneration: 0,
  viewportVersion: 0,
  epoch: 0,
  inputGeneration: 0,
};
const workspaceId = 'workspace_owned_reference_00001';
function fixture() {
  renders.length = 0;
  const loss = new AbortController();
  const production: BrowserProductionTransport = {
    createBrowserProfile: vi.fn(),
    setBrowserRuntimeEnabled: vi.fn(),
    readBrowserRuntimeStatus: vi.fn(async (): Promise<BrowserProductionStatus> => ({
      state: 'ready',
      enabled: true,
      workspaces: [{ workspaceId, label: 'My workspace' }],
    })),
    openBrowserRuntime: vi.fn(
      async (
        _workspace: string,
        request: BrowserOpenRequest
      ): Promise<BrowserProductionOpenReceipt> => ({
        requestId: request.requestId,
        instance: {
          browserId: binding.browserId,
          browserGeneration: 1,
          mode: 'ephemeral',
          status: 'running',
        },
        binding,
      })
    ),
    getBrowserBindings: vi.fn(async (): Promise<BrowserBinding[]> => [binding]),
    takeBrowserControl: vi.fn(async (): Promise<BrowserControl> => ({
      binding: { ...binding, epoch: 1, inputGeneration: 1 },
      controllerId: 'controller_original_reference_001',
      status: 'ready',
    })),
  };
  const input: BrowserInputTransport = { inputBrowser: vi.fn() };
  const viewer: BrowserViewerTransport = {
    issueBrowserViewer: vi.fn(),
    nextBrowserViewerFrame: vi.fn(),
    disconnectBrowserViewer: vi.fn(),
  };
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const transport = createMockTransport({
    getBrowserProfiles: vi.fn(async () => []),
    getBrowserInstances: vi.fn(async () => []),
  });
  function tree(owner: string) {
    return (
      <QueryClientProvider client={cache}>
        <TransportProvider transport={transport}>
          <ManagedBrowserWorkspace
            key={owner}
            cacheOwner={owner}
            production={production}
            viewer={viewer}
            input={input}
            lossSignal={loss.signal}
          />
        </TransportProvider>
      </QueryClientProvider>
    );
  }
  function mount(owner = 'alice') {
    const view = render(tree(owner));
    return { switchOwner: (next: string) => view.rerender(tree(next)) };
  }
  const releases: Array<() => void> = [];
  const originals: Promise<unknown>[] = [];
  onTestFinished(async () => {
    loss.abort();
    for (const release of releases) release();
    await Promise.allSettled(originals);
    cleanup();
    cache.clear();
  });
  return { production, transport, cache, loss, mount, releases, originals };
}
describe('public browser workflow', () => {
  it('launches only in a workspace returned by genuine status and does not manufacture control', async () => {
    const f = fixture();
    let opened: BrowserInstance | undefined;
    const open = vi.mocked(f.production.openBrowserRuntime).getMockImplementation()!;
    vi.spyOn(f.production, 'openBrowserRuntime').mockImplementation(async (...args) => {
      const receipt = await open(...args);
      opened = receipt.instance;
      return receipt;
    });
    vi.mocked(f.transport.getBrowserInstances).mockImplementation(async () =>
      opened ? [opened] : []
    );
    const otherOwner = [
      {
        browserId: 'bob_private_browser_000001',
        browserGeneration: 1,
        mode: 'ephemeral' as const,
        status: 'running' as const,
      },
    ];
    f.cache.setQueryData(['browser', 'bob', 'instances'], otherOwner);

    f.mount();
    await screen.findByRole('option', { name: 'My workspace' });
    await screen.findByText('No browsers are open.');
    fireEvent.change(screen.getByLabelText('Workspace'), {
      target: { value: workspaceId },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open clean browser' }));
    await screen.findByTestId('viewer');
    expect(await screen.findByRole('button', { name: 'Close' })).toBeEnabled();
    expect(f.transport.getBrowserInstances).toHaveBeenCalledTimes(2);
    expect(f.cache.getQueryData(['browser', 'alice', 'instances'])).toEqual([opened]);
    expect(f.cache.getQueryData(['browser', 'bob', 'instances'])).toEqual(otherOwner);
    expect(f.cache.getQueryState(['browser', 'bob', 'instances'])?.isInvalidated).toBe(false);

    expect(f.production.openBrowserRuntime).toHaveBeenCalledWith(
      workspaceId,
      { requestId: expect.any(String), mode: 'ephemeral' },
      f.loss.signal
    );
    expect(renders.at(-1)?.context?.binding).toEqual(binding);
    expect(renders.at(-1)?.input).toBeUndefined();
    expect(f.production.takeBrowserControl).not.toHaveBeenCalled();
  });
  it('fences original pixels before actual takeover then uses only returned controller binding', async () => {
    const f = fixture();
    f.mount();
    await screen.findByRole('option', { name: 'My workspace' });
    fireEvent.change(screen.getByLabelText('Workspace'), {
      target: { value: workspaceId },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open clean browser' }));
    await screen.findByTestId('viewer');
    const before = renders.at(-1)!;
    vi.spyOn(f.production, 'takeBrowserControl').mockImplementation(async (original) => {
      expect(before.lossSignal.aborted).toBe(true);
      expect(original).toEqual(binding);
      return {
        binding: { ...binding, epoch: 1, inputGeneration: 1 },
        status: 'ready',
        controllerId: 'controller_original_reference_001',
      };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
    await screen.findByRole('button', { name: 'You have control' });
    expect(renders.at(-1)?.context?.binding.epoch).toBe(1);
    expect(renders.at(-1)?.input?.readController()?.controllerId).toBe(
      'controller_original_reference_001'
    );
  });
  it('does not publish a late open after session loss; original acquisition still settles', async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.releases.push(() => release?.());
    vi.spyOn(f.production, 'openBrowserRuntime').mockImplementation((_workspace, request) => {
      const original = held.then(() => ({
        requestId: request.requestId,
        instance: {
          browserId: binding.browserId,
          browserGeneration: 1,
          mode: 'ephemeral' as const,
          status: 'running' as const,
        },
        binding,
      }));
      f.originals.push(original);
      return original;
    });
    f.mount();
    await screen.findByRole('option', { name: 'My workspace' });
    fireEvent.change(screen.getByLabelText('Workspace'), {
      target: { value: workspaceId },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open clean browser' }));
    await waitFor(() => expect(f.production.openBrowserRuntime).toHaveBeenCalledOnce());
    f.loss.abort();
    release?.();
    await Promise.allSettled(f.originals);
    expect(renders).toEqual([]);
    expect(screen.queryByTestId('viewer')).toBeNull();
  });
  it('never treats stored enabled choice or unavailable status as launch permission', async () => {
    const f = fixture();
    vi.spyOn(f.production, 'readBrowserRuntimeStatus').mockResolvedValue({
      state: 'unavailable',
      enabled: true,
      cause: 'nativeUnavailable',
    });
    f.mount();
    await screen.findByText('The shared browser is not available on this computer yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Open clean browser' }));
    expect(f.production.openBrowserRuntime).not.toHaveBeenCalled();
  });
  it.each(['open', 'tabs', 'control'] as const)(
    'fences held %s publication across unavailable status and later ready recovery',
    async (kind) => {
      const f = fixture();
      vi.spyOn(f.transport, 'getBrowserInstances').mockResolvedValue([
        {
          browserId: binding.browserId,
          browserGeneration: 1,
          mode: 'ephemeral',
          status: 'running',
        },
      ]);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.releases.push(release);
      function retain<T>(value: T): Promise<T> {
        const original = held.then(() => value);
        f.originals.push(original);
        return original;
      }
      if (kind === 'open')
        vi.spyOn(f.production, 'openBrowserRuntime').mockImplementation((_workspace, request) =>
          retain({
            requestId: request.requestId,
            instance: {
              browserId: binding.browserId,
              browserGeneration: 1,
              mode: 'ephemeral' as const,
              status: 'running' as const,
            },
            binding,
          })
        );
      if (kind === 'tabs')
        vi.spyOn(f.production, 'getBrowserBindings').mockImplementation(() => retain([binding]));
      if (kind === 'control')
        vi.spyOn(f.production, 'takeBrowserControl').mockImplementation(() =>
          retain({
            binding: { ...binding, epoch: 1, inputGeneration: 1 },
            status: 'ready' as const,
            controllerId: 'controller_original_reference_001',
          })
        );
      f.mount();
      await screen.findByRole('option', { name: 'My workspace' });
      fireEvent.change(screen.getByLabelText('Workspace'), {
        target: { value: workspaceId },
      });
      if (kind === 'tabs') fireEvent.click(await screen.findByRole('button', { name: 'View' }));
      else fireEvent.click(screen.getByRole('button', { name: 'Open clean browser' }));
      if (kind === 'control') {
        await screen.findByTestId('viewer');
        fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
      }
      await waitFor(() => expect(f.originals).toHaveLength(1));
      const renderedBeforeLoss = renders.length;
      act(() =>
        f.cache.setQueryData(['browser', 'alice', 'production-status'], {
          state: 'unavailable',
          enabled: true,
          cause: 'nativeUnavailable',
        })
      );
      expect(screen.queryByTestId('viewer')).toBeNull();
      // Returning to ready never resurrects work admitted by the old status generation.
      act(() =>
        f.cache.setQueryData(['browser', 'alice', 'production-status'], {
          state: 'ready',
          enabled: true,
          workspaces: [{ workspaceId, label: 'My workspace' }],
        })
      );
      await act(async () => {
        release();
        await Promise.allSettled(f.originals);
      });
      expect(renders).toHaveLength(renderedBeforeLoss);
      expect(screen.queryByTestId('viewer')).toBeNull();
    }
  );
  it('refuses cached running instance selection while status is unavailable', async () => {
    const f = fixture();
    vi.spyOn(f.transport, 'getBrowserInstances').mockResolvedValue([
      {
        browserId: binding.browserId,
        browserGeneration: 1,
        mode: 'ephemeral',
        status: 'running',
      },
    ]);
    vi.spyOn(f.production, 'readBrowserRuntimeStatus').mockResolvedValue({
      state: 'unavailable',
      enabled: true,
      cause: 'nativeUnavailable',
    });
    f.mount();
    await screen.findByText('The shared browser is not available on this computer yet.');
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    expect(f.production.getBrowserBindings).not.toHaveBeenCalled();
    expect(f.production.takeBrowserControl).not.toHaveBeenCalled();
    expect(renders).toEqual([]);
  });

  it('views a ready owned browser without choosing a launch workspace', async () => {
    const f = fixture();
    vi.spyOn(f.transport, 'getBrowserInstances').mockResolvedValue([
      {
        browserId: binding.browserId,
        browserGeneration: 1,
        mode: 'ephemeral',
        status: 'running',
      },
    ]);
    f.mount();
    await screen.findByRole('option', { name: 'My workspace' });
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    await screen.findByTestId('viewer');
    expect(f.production.getBrowserBindings).toHaveBeenCalledWith(
      binding.browserId,
      1,
      f.loss.signal
    );
    expect(f.production.openBrowserRuntime).not.toHaveBeenCalled();
  });
  it('keeps authenticated cleanup available for an uncertain browser while native status is unavailable', async () => {
    const f = fixture();
    vi.spyOn(f.transport, 'getBrowserInstances').mockResolvedValue([
      {
        browserId: binding.browserId,
        browserGeneration: 1,
        mode: 'ephemeral',
        status: 'uncertain',
      },
    ]);
    vi.spyOn(f.transport, 'closeBrowserInstance').mockImplementation(async (request) => ({
      ...request,
      cleanup: 'unverified' as const,
      reason: 'observationUnavailable' as const,
    }));
    vi.spyOn(f.production, 'readBrowserRuntimeStatus').mockResolvedValue({
      state: 'unavailable',
      enabled: true,
      cause: 'nativeUnavailable',
    });
    f.mount();
    await screen.findByText('The shared browser is not available on this computer yet.');
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await screen.findByText(
      'The browser may still be running. Its cleanup could not be confirmed.'
    );
    expect(f.transport.closeBrowserInstance).toHaveBeenCalledWith({
      requestId: expect.any(String),
      browserId: binding.browserId,
      browserGeneration: 1,
    });
    expect(f.production.getBrowserBindings).not.toHaveBeenCalled();
  });
  it('keeps a held acquisition admitted across an equivalent successful availability refetch', async () => {
    const f = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.releases.push(release);
    vi.spyOn(f.production, 'openBrowserRuntime').mockImplementation((_workspace, request) => {
      const original = held.then(() => ({
        requestId: request.requestId,
        instance: {
          browserId: binding.browserId,
          browserGeneration: 1,
          mode: 'ephemeral' as const,
          status: 'running' as const,
        },
        binding,
      }));
      f.originals.push(original);
      return original;
    });
    f.mount();
    await screen.findByRole('option', { name: 'My workspace' });
    fireEvent.change(screen.getByLabelText('Workspace'), {
      target: { value: workspaceId },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open clean browser' }));
    await waitFor(() => expect(f.originals).toHaveLength(1));
    await act(async () => {
      await f.cache.invalidateQueries({
        queryKey: ['browser', 'alice', 'production-status'],
        exact: true,
      });
    });
    expect(f.production.readBrowserRuntimeStatus).toHaveBeenCalledTimes(2);
    await act(async () => {
      release();
      await Promise.allSettled(f.originals);
    });
    expect(await screen.findByTestId('viewer')).toBeTruthy();
  });
  it('refuses launch when the actual cache removes the workspace before React renders', async () => {
    const f = fixture();
    f.mount();
    await screen.findByRole('option', { name: 'My workspace' });
    fireEvent.change(screen.getByLabelText('Workspace'), {
      target: { value: workspaceId },
    });
    const launch = screen.getByRole('button', { name: 'Open clean browser' });
    act(() => {
      f.cache.setQueryData(['browser', 'alice', 'production-status'], {
        state: 'ready',
        enabled: true,
        workspaces: [],
      });
      // The same original rendered event handler cannot borrow the old workspace list.
      fireEvent.click(launch);
    });
    expect(f.production.openBrowserRuntime).not.toHaveBeenCalled();
  });
});

it('joins the captured old display before navigation then takes genuine control at the returned cohort', async () => {
  const f = fixture();
  f.production.navigateBrowser = vi.fn(async (command) => ({
    requestId: command.requestId,
    binding: {
      ...command.binding,
      epoch: command.binding.epoch + 1,
      inputGeneration: command.binding.inputGeneration + 1,
      navigationGeneration: command.binding.navigationGeneration + 1,
    },
  }));
  f.mount();
  await screen.findByRole('option', { name: 'My workspace' });
  fireEvent.change(screen.getByLabelText('Workspace'), {
    target: { value: workspaceId },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Open clean browser' }));
  await screen.findByTestId('viewer');
  fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
  await screen.findByRole('button', { name: 'You have control' });
  const before = renders.at(-1)!;
  let release!: () => void;
  const held = new Promise<void>((yes) => {
    release = yes;
  });
  f.releases.push(release);
  f.originals.push(held);
  const disposal = vi.fn(() => held);
  act(() => before.onLifetime!({ disposeForNavigation: disposal }));
  vi.mocked(f.production.takeBrowserControl).mockImplementationOnce(async (original) => ({
    binding: {
      ...original,
      epoch: original.epoch + 1,
      inputGeneration: original.inputGeneration + 1,
    },
    status: 'ready',
    controllerId: 'controller_successor_reference_001',
  }));
  fireEvent.change(screen.getByLabelText('Page URL'), {
    target: { value: 'https://example.com/page' },
  });
  expect(renders.at(-1)?.context).toBe(before.context);
  fireEvent.click(screen.getByRole('button', { name: 'Go' }));
  expect(disposal).toHaveBeenCalledTimes(1);
  expect(f.production.navigateBrowser).not.toHaveBeenCalled();
  expect(before.lossSignal.aborted).toBe(false);
  await act(async () => {
    release();
    await held;
  });
  await waitFor(() => expect(f.production.navigateBrowser).toHaveBeenCalledTimes(1));
  expect(before.lossSignal.aborted).toBe(true);
  await waitFor(() =>
    expect(renders.at(-1)?.context?.binding).toEqual({
      ...binding,
      epoch: 3,
      inputGeneration: 3,
      navigationGeneration: 1,
    })
  );
  expect(renders.at(-1)?.input?.readController()?.controllerId).toBe(
    'controller_successor_reference_001'
  );
});

it('cannot navigate after actual status loss while the original display disposal remains held', async () => {
  const f = fixture();
  f.production.navigateBrowser = vi.fn();
  f.mount();
  await screen.findByRole('option', { name: 'My workspace' });
  fireEvent.change(screen.getByLabelText('Workspace'), {
    target: { value: workspaceId },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Open clean browser' }));
  await screen.findByTestId('viewer');
  fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
  await screen.findByRole('button', { name: 'You have control' });
  let release!: () => void;
  const held = new Promise<void>((yes) => {
    release = yes;
  });
  f.releases.push(release);
  f.originals.push(held);
  act(() => renders.at(-1)!.onLifetime!({ disposeForNavigation: () => held }));
  fireEvent.change(screen.getByLabelText('Page URL'), {
    target: { value: 'https://example.com/page' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Go' }));
  act(() =>
    f.cache.setQueryData(['browser', 'alice', 'production-status'], {
      state: 'unavailable',
      enabled: false,
    })
  );
  await act(async () => {
    release();
    await held;
  });
  expect(f.production.navigateBrowser).not.toHaveBeenCalled();
  expect(f.production.takeBrowserControl).toHaveBeenCalledTimes(1);
});

it('joins exact stopped-view cleanup before fresh controller acquisition at a genuine discovered successor', async () => {
  const f = fixture();
  let resolveDiscovery!: (value: BrowserBinding[]) => void;
  const discovery = new Promise<BrowserBinding[]>((resolve) => {
    resolveDiscovery = resolve;
  });
  let resolveCleanup!: (value: Readonly<{ priorFailure?: Readonly<{ value: unknown }> }>) => void;
  const cleanup = new Promise<Readonly<{ priorFailure?: Readonly<{ value: unknown }> }>>(
    (resolve) => {
      resolveCleanup = resolve;
    }
  );
  f.originals.push(discovery, cleanup);
  f.releases.push(
    () => resolveDiscovery([]),
    () => resolveCleanup({})
  );
  vi.mocked(f.production.getBrowserBindings).mockReturnValueOnce(discovery);
  f.mount();
  await screen.findByRole('option', { name: 'My workspace' });
  fireEvent.change(screen.getByLabelText('Workspace'), {
    target: { value: workspaceId },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Open clean browser' }));
  await screen.findByTestId('viewer');
  fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
  await waitFor(() => expect(renders.at(-1)?.input).toBeDefined());
  const before = renders.at(-1)!;
  const oldBinding = before.context!.binding;
  const next = {
    ...oldBinding,
    epoch: oldBinding.epoch + 1,
    inputGeneration: oldBinding.inputGeneration + 1,
    navigationGeneration: oldBinding.navigationGeneration + 1,
  };
  const successor = {
    ...next,
    epoch: next.epoch + 1,
    inputGeneration: next.inputGeneration + 1,
  };
  const dispose = vi.fn(() => cleanup);
  act(() =>
    before.onLifetime!({
      disposeForNavigation: vi.fn(),
      disposeForSuccessor: dispose,
    })
  );
  vi.mocked(f.production.takeBrowserControl).mockResolvedValueOnce({
    status: 'ready',
    controllerId: 'controller_successor_reference_001',
    binding: successor,
  });
  // Subsequent watcher sees the genuine returned current control binding, with no fake transition.
  vi.mocked(f.production.getBrowserBindings).mockResolvedValue([successor]);
  await act(async () => {
    resolveDiscovery([next]);
  });
  await waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
  expect(f.production.takeBrowserControl).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolveCleanup({
      priorFailure: { value: new Error('original stopped view') },
    });
  });
  await waitFor(() => expect(f.production.takeBrowserControl).toHaveBeenCalledTimes(2));
  expect(f.production.takeBrowserControl).toHaveBeenLastCalledWith(next, expect.any(AbortSignal));
  await waitFor(() => expect(renders.at(-1)?.context?.binding).toEqual(successor));
  expect(
    await screen.findByText('The previous view stopped during navigation. The new page is ready.')
  ).toBeTruthy();
});

it('cannot publish a discovered successor after real lifetime loss while its original view cleanup is held', async () => {
  const f = fixture();
  let resolveDiscovery!: (value: BrowserBinding[]) => void;
  const discovery = new Promise<BrowserBinding[]>((resolve) => {
    resolveDiscovery = resolve;
  });
  let release!: () => void;
  const held = new Promise<Readonly<{ priorFailure?: Readonly<{ value: unknown }> }>>((resolve) => {
    release = () => resolve({});
  });
  f.originals.push(discovery, held);
  f.releases.push(() => resolveDiscovery([]), release);
  vi.mocked(f.production.getBrowserBindings).mockReturnValueOnce(discovery);
  f.mount();
  await screen.findByRole('option', { name: 'My workspace' });
  fireEvent.change(screen.getByLabelText('Workspace'), {
    target: { value: workspaceId },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Open clean browser' }));
  await screen.findByTestId('viewer');
  fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
  await waitFor(() => expect(renders.at(-1)?.input).toBeDefined());
  const before = renders.at(-1)!;
  const dispose = vi.fn(() => held);
  act(() =>
    before.onLifetime!({
      disposeForNavigation: vi.fn(),
      disposeForSuccessor: dispose,
    })
  );
  const next = {
    ...before.context!.binding,
    epoch: before.context!.binding.epoch + 1,
    inputGeneration: before.context!.binding.inputGeneration + 1,
    navigationGeneration: before.context!.binding.navigationGeneration + 1,
  };
  await act(async () => {
    resolveDiscovery([next]);
  });
  await waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
  act(() => f.loss.abort());
  await act(async () => {
    release();
  });
  expect(f.production.takeBrowserControl).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('viewer')).toBeNull();
});

it('saved enabled without a graph requires explicit Start and refetches only after the original activation receipt', async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.releases.push(release);
  let ready = false;
  vi.mocked(f.production.readBrowserRuntimeStatus).mockImplementation(async () =>
    ready
      ? {
          state: 'ready',
          enabled: true,
          workspaces: [{ workspaceId, label: 'My workspace' }],
        }
      : { state: 'unavailable', enabled: true, cause: 'nativeUnavailable' }
  );
  vi.mocked(f.production.setBrowserRuntimeEnabled).mockImplementation((_enabled, signal) => {
    expect(signal.aborted).toBe(false);
    const original = held.then(() => {
      ready = true;
      return {
        state: 'ready' as const,
        enabled: true as const,
        workspaces: [{ workspaceId, label: 'My workspace' }],
      };
    });
    f.originals.push(original);
    return original;
  });
  f.mount();
  const start = await screen.findByRole('button', {
    name: 'Start shared browser',
  });
  expect(f.production.setBrowserRuntimeEnabled).not.toHaveBeenCalled();
  fireEvent.click(start);
  await waitFor(() => expect(f.production.setBrowserRuntimeEnabled).toHaveBeenCalledOnce());
  expect(f.production.setBrowserRuntimeEnabled).toHaveBeenCalledWith(true, expect.any(AbortSignal));
  expect(f.production.readBrowserRuntimeStatus).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Open clean browser' })).toBeDisabled();
  await act(async () => {
    release();
    await Promise.all(f.originals);
  });
  await screen.findByRole('option', { name: 'My workspace' });
  expect(f.production.readBrowserRuntimeStatus).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('button', { name: 'Start shared browser' })).toBeNull();
});

it('late original activation after loss remains joined but cannot refetch or publish ready', async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.releases.push(release);
  vi.mocked(f.production.readBrowserRuntimeStatus).mockResolvedValue({
    state: 'unavailable',
    enabled: true,
    cause: 'nativeUnavailable',
  });
  let captured: AbortSignal | undefined;
  vi.mocked(f.production.setBrowserRuntimeEnabled).mockImplementation((_enabled, signal) => {
    captured = signal;
    const original = held.then(() => ({
      state: 'ready' as const,
      enabled: true as const,
      workspaces: [{ workspaceId, label: 'My workspace' }],
    }));
    f.originals.push(original);
    return original;
  });
  f.mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Start shared browser' }));
  await waitFor(() => expect(f.production.setBrowserRuntimeEnabled).toHaveBeenCalledOnce());
  await act(async () => {
    f.loss.abort();
    release();
    await Promise.all(f.originals);
  });
  expect(captured?.aborted).toBe(true);
  expect(f.production.readBrowserRuntimeStatus).toHaveBeenCalledOnce();
  expect(screen.queryByRole('option', { name: 'My workspace' })).toBeNull();
});

it('explicit clean and saved acquisition forward distinct strict requests using actual owner profile metadata', async () => {
  const f = fixture(),
    profile = {
      profileId: 'profile_owned_reference_000001',
      label: 'Work account',
      revision: 0,
      status: 'available' as const,
    };
  let inUse = false;
  vi.mocked(f.transport.getBrowserProfiles).mockImplementation(async () => [
    { ...profile, status: inUse ? 'inUse' : 'available' },
  ]);
  vi.mocked(f.production.openBrowserRuntime).mockImplementation(async (_workspace, request) => {
    if (request.mode === 'persistent') inUse = true;
    return {
      requestId: request.requestId,
      instance: {
        browserId: binding.browserId,
        browserGeneration: 1,
        status: 'running',
        ...(request.mode === 'persistent'
          ? { mode: 'persistent' as const, profileId: request.profileId }
          : { mode: 'ephemeral' as const }),
      },
      binding,
    };
  });
  f.mount();
  await screen.findByRole('option', { name: 'My workspace' });
  fireEvent.change(screen.getByLabelText('Workspace'), {
    target: { value: workspaceId },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Open clean browser' }));
  await waitFor(() => expect(f.production.openBrowserRuntime).toHaveBeenCalledOnce());
  const clean = vi.mocked(f.production.openBrowserRuntime).mock.calls[0]![1];
  expect(clean.mode).toBe('ephemeral');
  expect(clean).not.toHaveProperty('profileId');
  fireEvent.change(screen.getByLabelText('Browser'), {
    target: { value: 'persistent' },
  });
  await screen.findByRole('option', { name: 'Work account' });
  fireEvent.change(screen.getByLabelText('Saved profile'), {
    target: { value: profile.profileId },
  });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Open saved browser' })).toBeEnabled()
  );
  const readsBeforePersistentOpen = vi.mocked(f.transport.getBrowserProfiles).mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Open saved browser' }));
  await waitFor(() => expect(f.production.openBrowserRuntime).toHaveBeenCalledTimes(2));
  expect(vi.mocked(f.production.openBrowserRuntime).mock.calls[1]![1]).toEqual({
    requestId: expect.any(String),
    mode: 'persistent',
    profileId: profile.profileId,
  });
  expect(await screen.findByRole('option', { name: 'Work account (in use)' })).toBeDisabled();
  expect(vi.mocked(f.transport.getBrowserProfiles).mock.calls.length).toBeGreaterThan(
    readsBeforePersistentOpen
  );
});

it('genuine profile creation receipt refreshes owner metadata before selecting its saved acquisition', async () => {
  const f = fixture(),
    profile = {
      profileId: 'profile_owned_reference_000001',
      label: 'Work account',
      revision: 0,
      status: 'available' as const,
    };
  let created = false;
  vi.mocked(f.transport.getBrowserProfiles).mockImplementation(async () =>
    created ? [profile] : []
  );
  vi.mocked(f.production.createBrowserProfile).mockImplementation(async (request) => {
    created = true;
    return { requestId: request.requestId, profile };
  });
  f.mount();
  await screen.findByRole('option', { name: 'My workspace' });
  fireEvent.change(screen.getByLabelText('New saved profile'), {
    target: { value: profile.label },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create saved profile' }));
  await screen.findByRole('option', { name: 'Work account' });
  expect(f.production.createBrowserProfile).toHaveBeenCalledWith(
    { requestId: expect.any(String), label: profile.label },
    expect.any(AbortSignal)
  );
  expect(screen.getByLabelText('Browser')).toHaveValue('persistent');
  expect(screen.getByLabelText('Saved profile')).toHaveValue(profile.profileId);
  expect(f.production.openBrowserRuntime).not.toHaveBeenCalled();
});

it('in-use and quarantined saved metadata never become an open request', async () => {
  const f = fixture();
  vi.mocked(f.transport.getBrowserProfiles).mockResolvedValue([
    {
      profileId: 'profile_owned_inuse_000000001',
      label: 'Busy account',
      revision: 1,
      status: 'inUse',
    },
    {
      profileId: 'profile_owned_unknown_0000001',
      label: 'Uncertain account',
      revision: 2,
      status: 'quarantined',
    },
  ]);
  f.mount();
  await screen.findByRole('option', { name: 'My workspace' });
  fireEvent.change(screen.getByLabelText('Workspace'), {
    target: { value: workspaceId },
  });
  fireEvent.change(screen.getByLabelText('Browser'), {
    target: { value: 'persistent' },
  });
  expect(await screen.findByRole('option', { name: 'Busy account (in use)' })).toBeDisabled();
  expect(screen.getByRole('option', { name: 'Uncertain account (needs review)' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Open saved browser' }));
  expect(f.production.openBrowserRuntime).not.toHaveBeenCalled();
});

it('does not refresh or publish an old open into the next authenticated owner', async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.releases.push(release);
  const open = vi.mocked(f.production.openBrowserRuntime).getMockImplementation()!;
  vi.spyOn(f.production, 'openBrowserRuntime').mockImplementation((...args) => {
    const original = held.then(() => open(...args));
    f.originals.push(original);
    return original;
  });
  const invalidation = vi.spyOn(f.cache, 'invalidateQueries');
  const view = f.mount();
  await screen.findByRole('option', { name: 'My workspace' });
  await screen.findByText('No browsers are open.');
  fireEvent.change(screen.getByLabelText('Workspace'), {
    target: { value: workspaceId },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Open clean browser' }));
  await waitFor(() => expect(f.production.openBrowserRuntime).toHaveBeenCalledOnce());
  view.switchOwner('bob');
  await waitFor(() => expect(f.cache.getQueryData(['browser', 'bob', 'instances'])).toEqual([]));
  release();
  await act(async () => {
    await Promise.allSettled(f.originals);
  });
  expect(invalidation).not.toHaveBeenCalled();
  expect(f.cache.getQueryData(['browser', 'bob', 'instances'])).toEqual([]);
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  expect(screen.queryByTestId('viewer')).toBeNull();
});

it('local website permission is an explicit owner request, never automatic navigation', async () => {
  const f = fixture();
  const allow = vi.fn<NonNullable<BrowserProductionTransport['allowBrowserLocalDestination']>>(
    async (request) => ({
      requestId: request.requestId,
      binding: request.binding,
      endpoint: new URL(request.endpoint).origin,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    })
  );
  f.production.allowBrowserLocalDestination = allow;
  f.production.navigateBrowser = vi.fn();
  f.mount();
  await screen.findByRole('option', { name: 'My workspace' });
  fireEvent.change(screen.getByLabelText('Workspace'), {
    target: { value: workspaceId },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Open clean browser' }));
  await screen.findByTestId('viewer');
  fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
  await screen.findByRole('button', { name: 'You have control' });
  fireEvent.change(screen.getByLabelText('Page URL'), {
    target: { value: 'http://127.0.0.1:4567/page' },
  });
  expect(allow).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Allow local website for five minutes',
    })
  );
  await screen.findByText(
    'Allowed http://127.0.0.1:4567 in this browser for five minutes. Choose Go to open the page.'
  );
  expect(allow).toHaveBeenCalledWith(
    {
      requestId: expect.any(String),
      binding: { ...binding, epoch: 1, inputGeneration: 1 },
      endpoint: 'http://127.0.0.1:4567',
      ttlMilliseconds: 300000,
    },
    expect.any(AbortSignal)
  );
  expect(f.production.navigateBrowser).not.toHaveBeenCalled();
});
