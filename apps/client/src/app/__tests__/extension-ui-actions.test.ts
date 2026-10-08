/** @vitest-environment jsdom */
// Lower-port controls pair a current occurrence with its retired continuation.
import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createMockTransport, createMockSession, createMockAccountUsage } from '@dorkos/test-utils';
import type { ApplyShapeResult } from '@dorkos/shared/marketplace-schemas';
import type { DispatcherContext } from '@/layers/shared/lib';
import { createExtensionUiActions } from '../extension-ui-actions';
vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn() } }));

function result(): ApplyShapeResult {
  return {
    ok: true,
    applied: {
      layout: {
        sidebarOpen: true,
        sidebarTab: 'overview',
        openPanels: [],
        focusDashboardSections: [],
      },
      activatedExtensions: [],
      schedulesCreated: [],
      schedulesRebound: [],
    },
    warnings: [],
    offeredAgents: [],
  };
}

describe('main async extension action adapter', () => {
  it.each([false, true])(
    'carries the exact owner into a held layout, retired=%s',
    async (retired) => {
      let deliver!: (value: ApplyShapeResult) => void;
      let current = true;
      let rejected = false;
      const sidebar = vi.fn();
      const queryClient = new QueryClient();
      const transport = createMockTransport({
        applyShape: vi.fn(
          () =>
            new Promise<Parameters<typeof deliver>[0]>((resolve) => {
              deliver = resolve;
            })
        ),
      });
      const context = {
        getStore: () => ({ setSidebarOpen: sidebar }),
        setTheme: vi.fn(),
      } as unknown as DispatcherContext;
      const actions = createExtensionUiActions({
        transport,
        queryClient,
        getStore: () => ({ setSelectedCwd: vi.fn() }),
        currentLocation: () => ({ pathname: '/session', search: {} }),
        navigate: vi.fn(),
        getDispatcherContext: () => context,
      });
      const operation = actions.applyShape('fixture', {
        beforeEffect: () => {
          if (!current) {
            rejected = true;
            throw new Error('EXTENSION_RETIRED');
          }
        },
      });
      try {
        current = !retired;
        deliver(result());
        if (retired) await expect(operation).rejects.toThrow('EXTENSION_RETIRED');
        else await operation;
        if (retired) {
          expect(rejected).toBe(true);
          expect(sidebar).not.toHaveBeenCalled();
        } else {
          expect(sidebar).toHaveBeenCalledWith(true);
          expect(sidebar).toHaveBeenCalledTimes(1);
        }
      } finally {
        deliver(result());
        await Promise.allSettled([operation]);
        queryClient.clear();
      }
    }
  );
});

it('keeps a held layout out of a newer agent destination without retiring auth', async () => {
  let deliver!: (value: ApplyShapeResult) => void;
  const response = new Promise<ApplyShapeResult>((resolve) => {
    deliver = resolve;
  });
  const sidebar = vi.fn();
  const queryClient = new QueryClient();
  const transport = createMockTransport({ applyShape: vi.fn(() => response) });
  let directory = '/original';
  const actions = createExtensionUiActions({
    transport,
    queryClient,
    getStore: () => ({ setSelectedCwd: vi.fn() }),
    currentLocation: () => ({ pathname: '/session', search: { dir: directory } }),
    navigate: vi.fn(),
    getDispatcherContext: () =>
      ({
        getStore: () => ({ setSidebarOpen: sidebar }),
        setTheme: vi.fn(),
      }) as unknown as DispatcherContext,
  });
  const original = actions.applyShape('fixture', { beforeEffect: () => {} });
  try {
    directory = '/newer';
    deliver(result());
    await expect(original).rejects.toThrow('Extension action was superseded.');
    expect(sidebar).not.toHaveBeenCalled();
  } finally {
    deliver(result());
    await Promise.allSettled([original]);
    queryClient.clear();
  }
});

it.each([false, true])(
  'held agent lookup preserves origin before cache/navigation, superseded=%s',
  async (superseded) => {
    let deliver!: (
      value: Awaited<ReturnType<ReturnType<typeof createMockTransport>['listSessions']>>
    ) => void;
    const response = new Promise<Parameters<typeof deliver>[0]>((resolve) => {
      deliver = resolve;
    });
    const queryClient = new QueryClient();
    const transport = createMockTransport({ listSessions: vi.fn(() => response) });
    const setCwd = vi.fn(),
      navigate = vi.fn();
    let directory = '/original';
    const actions = createExtensionUiActions({
      transport,
      queryClient,
      getStore: () => ({ setSelectedCwd: setCwd }),
      currentLocation: () => ({ pathname: '/session', search: { dir: directory } }),
      navigate,
      getDispatcherContext: () =>
        ({ getStore: () => ({}), setTheme: vi.fn() }) as unknown as DispatcherContext,
    });
    const original = actions.switchAgent('/target', { beforeEffect: () => {} });
    const body = {
      sessions: [createMockSession({ id: 'existing', cwd: '/target' })],
      accountUsage: [createMockAccountUsage()],
    };
    try {
      if (superseded) directory = '/newer';
      deliver(body);
      if (superseded)
        await expect(original).rejects.toThrow('Extension navigation was superseded.');
      else await original;
      if (superseded) {
        expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
        expect(setCwd).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
      } else {
        expect(setCwd).toHaveBeenCalledWith('/target');
        expect(navigate).toHaveBeenCalledTimes(1);
        expect(queryClient.getQueryCache().getAll().length).toBeGreaterThan(0);
      }
    } finally {
      deliver(body);
      await Promise.allSettled([original]);
      queryClient.clear();
    }
  }
);

it.each([false, undefined])(
  'preserves original app action rejection %s when diagnostics throw',
  async (cause) => {
    const queryClient = new QueryClient();
    const transport = createMockTransport({ applyShape: vi.fn(() => Promise.reject(cause)) });
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('diagnostic failure');
    });
    const actions = createExtensionUiActions({
      transport,
      queryClient,
      getStore: () => ({ setSelectedCwd: vi.fn() }),
      currentLocation: () => ({ pathname: '/session', search: {} }),
      navigate: vi.fn(),
      getDispatcherContext: () =>
        ({ getStore: () => ({}), setTheme: vi.fn() }) as unknown as DispatcherContext,
    });
    const original = actions.applyShape('fixture', { beforeEffect: () => {} });
    try {
      await expect(original).rejects.toBe(cause);
      expect(diagnostic).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.allSettled([original]);
      diagnostic.mockRestore();
      queryClient.clear();
    }
  }
);
