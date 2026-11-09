/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ExtensionModule, ExtensionRecordPublic } from '@dorkos/extension-api';
import { setExtensionLoadFailed } from '@/layers/shared/lib';
import {
  getExtensionClientStates,
  setExtensionClientState,
} from '@/layers/shared/lib/extension-client-state';
import { useEventSubscription } from '@/layers/shared/model';

// The provider's side hooks reach stores and streams this test is not about.
vi.mock('../model/use-sync-require-login', () => ({ useSyncRequireLogin: vi.fn() }));
vi.mock('@/layers/entities/agent', () => ({
  useSyncCurrentAgentId: vi.fn(),
  useReconcileExplicitAgentPath: vi.fn(),
}));
vi.mock('@/layers/entities/project', () => ({ useCurrentProjectSync: vi.fn() }));
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useEventSubscription: vi.fn(),
}));
vi.mock('../model/extension-bundle-import', () => ({ importExtensionModule: vi.fn() }));

import { importExtensionModule } from '../model/extension-bundle-import';
import { ExtensionProvider, useExtensions } from '../model/extension-context';
import type { ExtensionAPIDeps } from '../model/types';

const mockFetch = vi.fn();

function desk(overrides: Partial<ExtensionRecordPublic> = {}): ExtensionRecordPublic {
  return {
    id: 'desk',
    manifest: { id: 'desk', name: 'Desk', version: '1.0.0' },
    status: 'compiled',
    scope: 'global',
    origin: 'user',
    bundleReady: true,
    approvedToRun: true,
    hasServerEntry: false,
    hasDataProxy: false,
    shadowedBy: null,
    ...overrides,
  };
}

/** Answer the extension list with each body in turn; the last one repeats. */
function answerLists(...bodies: ExtensionRecordPublic[][]) {
  let call = 0;
  mockFetch.mockImplementation((url: string) => {
    if (String(url).endsWith('/api/extensions')) {
      const body = bodies[Math.min(call++, bodies.length - 1)];
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });
}

/** One bundle import the test settles by hand. */
function heldImport() {
  let settle!: () => void;
  const done = new Promise<ExtensionModule>((resolve) => {
    settle = () => resolve({ activate: () => {} });
  });
  return { done, settle };
}

/** What the provider says, in one line. */
function Probe() {
  const { extensions, ready, settling } = useExtensions();
  const record = extensions.find((extension) => extension.id === 'desk');
  return (
    <p data-testid="probe">
      {`ready=${ready} settling=${settling} approved=${record?.approvedToRun ?? 'none'}`}
    </p>
  );
}

/** The handler the provider gave `extension_reloaded`. */
function hotReloadHandler(): (data: unknown) => void {
  const call = vi
    .mocked(useEventSubscription)
    .mock.calls.filter(([event]) => event === 'extension_reloaded')
    .at(-1);
  if (!call) throw new Error('no extension_reloaded subscription');
  return call[1] as (data: unknown) => void;
}

function renderProvider() {
  const deps = { registry: { register: vi.fn(() => () => {}) } } as unknown as ExtensionAPIDeps;
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ExtensionProvider deps={deps}>
        <Probe />
      </ExtensionProvider>
    </QueryClientProvider>
  );
}

/** Let every queued promise run. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  setExtensionLoadFailed(false);
});

afterEach(() => {
  cleanup();
  setExtensionLoadFailed(false);
  for (const id of Object.keys(getExtensionClientStates())) setExtensionClientState(id, undefined);
  vi.restoreAllMocks();
});

describe('ExtensionProvider and a hot reload during the first load', () => {
  it('keeps settling while a hot reload that started during the first load is still importing (C3)', async () => {
    const first = heldImport();
    const reload = heldImport();
    vi.mocked(importExtensionModule)
      .mockReturnValueOnce(first.done)
      .mockReturnValueOnce(reload.done);
    answerLists([desk()]);
    renderProvider();
    await flush();

    // The app is turned off and on while its first import is still running.
    act(() => hotReloadHandler()({ extensionIds: ['desk'], timestamp: 1 }));
    await flush();

    // The first import comes back first. Its activation is skipped (the reload
    // owns the app now), so the page is not there yet: this must not read as
    // a finished load.
    first.settle();
    await flush();
    expect(screen.getByTestId('probe')).toHaveTextContent('ready=true settling=true');
    expect(getExtensionClientStates().desk).toBe('starting');

    reload.settle();
    await flush();
    expect(screen.getByTestId('probe')).toHaveTextContent('ready=true settling=false');
    expect(getExtensionClientStates().desk).toBe('ready');
  });

  it('keeps the hot reload’s newer list when the first load finishes after it (C2)', async () => {
    const first = heldImport();
    vi.mocked(importExtensionModule).mockReturnValueOnce(first.done);
    // The first list says the app may run; after its files change it waits on
    // a person again.
    answerLists([desk()], [desk({ approvedToRun: false })]);
    renderProvider();
    await flush();

    act(() => hotReloadHandler()({ extensionIds: ['desk'], timestamp: 1 }));
    await flush();
    expect(screen.getByTestId('probe')).toHaveTextContent(
      'ready=true settling=false approved=false'
    );

    // The first load's import comes back late, with the list it read before
    // the change. It must not put that older answer back.
    first.settle();
    await flush();
    expect(screen.getByTestId('probe')).toHaveTextContent(
      'ready=true settling=false approved=false'
    );
  });

  it('still finishes the first load when a hot reload during it fails', async () => {
    const first = heldImport();
    vi.mocked(importExtensionModule).mockReturnValueOnce(first.done);
    answerLists([desk()]);
    renderProvider();
    await flush();

    // The reload's list request fails outright.
    mockFetch.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    act(() => hotReloadHandler()({ extensionIds: ['desk'], timestamp: 1 }));
    await flush();

    first.settle();
    await flush();
    expect(screen.getByTestId('probe')).toHaveTextContent('ready=true settling=false');
  });
});
