/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import {
  getExtensionLoadFailed,
  requestExtensionRemount,
  setAuthRequired,
  setExtensionLoadFailed,
} from '@/layers/shared/lib';

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

import { ExtensionProvider, useExtensions } from '../model/extension-context';
import type { ExtensionAPIDeps } from '../model/types';

const mockFetch = vi.fn();

/** A record the loader lists (its bundle import cannot resolve in jsdom). */
const desk = {
  id: 'desk',
  manifest: { clientApiVersion: 2, id: 'desk', name: 'Desk', version: '1.0.0' },
  status: 'compiled',
  scope: 'global',
  bundleReady: true,
  approvedToRun: true,
  hasServerEntry: false,
  hasDataProxy: false,
} as unknown as ExtensionRecordPublic;

/** Answers the extension list with `status` and `body`; anything else is a 404. */
function answerList(status: number, body: unknown) {
  mockFetch.mockImplementation((url: string) => {
    if (String(url).endsWith('/api/extensions')) {
      return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });
}

/** How many times the extension list was asked for. */
function listFetches(): number {
  return mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/api/extensions')).length;
}

function ExtensionCount() {
  const { extensions, ready } = useExtensions();
  return <p>{ready ? `${extensions.length} extensions` : 'loading'}</p>;
}

function renderProvider() {
  const deps = { registry: { register: vi.fn(() => () => {}) } } as unknown as ExtensionAPIDeps;
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ExtensionProvider deps={deps}>
        <ExtensionCount />
      </ExtensionProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  setAuthRequired(false);
  setExtensionLoadFailed(false);
});

afterEach(() => {
  cleanup();
  setAuthRequired(false);
  setExtensionLoadFailed(false);
  vi.restoreAllMocks();
});

describe('ExtensionProvider and sign-in', () => {
  it('loads the extensions again once the person signs in after a refused first load', async () => {
    // The window opens signed out: the first list request is refused.
    answerList(401, { code: 'AUTH_REQUIRED' });
    renderProvider();
    await screen.findByText('0 extensions');
    // A refused list is a failed load, never "none installed".
    expect(getExtensionLoadFailed()).toBe(true);
    act(() => setAuthRequired(true));

    // The person signs in, and the list now answers.
    answerList(200, [desk]);
    act(() => setAuthRequired(false));

    await screen.findByText('1 extensions');
    expect(listFetches()).toBe(2);
    expect(getExtensionLoadFailed()).toBe(false);
  });

  it('reports a failed load when the list request fails, and clears it on a working retry', async () => {
    answerList(500, {});
    renderProvider();
    await screen.findByText('0 extensions');
    expect(getExtensionLoadFailed()).toBe(true);

    // "Try again" in the sidebar runs the shared remount.
    answerList(200, [desk]);
    await act(() => requestExtensionRemount());

    await screen.findByText('1 extensions');
    expect(getExtensionLoadFailed()).toBe(false);
  });

  it('does not report a failed load when the list is just empty', async () => {
    answerList(200, []);
    renderProvider();
    await screen.findByText('0 extensions');
    expect(getExtensionLoadFailed()).toBe(false);
  });

  it('does not reload a window that never asked anyone to sign in', async () => {
    answerList(200, [desk]);
    renderProvider();
    await screen.findByText('1 extensions');

    act(() => setAuthRequired(false));

    await waitFor(() => expect(listFetches()).toBe(1));
  });
});
