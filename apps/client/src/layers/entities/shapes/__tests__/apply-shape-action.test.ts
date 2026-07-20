/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { UiCommand } from '@dorkos/shared/types';
import type { ApplyShapeResult } from '@dorkos/shared/marketplace-schemas';

// Mock sonner so the honest-warnings surfacing is assertable without a DOM toaster.
const toastSuccess = vi.fn();
const toastWarning = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    warning: (...a: unknown[]) => toastWarning(...a),
  },
}));

import { registerExtensionRemount } from '@/layers/shared/lib';
import { applyShapeAction } from '../lib/apply-shape-action';

/** Build an ApplyShapeResult with sane defaults, overridable per test. */
function result(overrides: Partial<ApplyShapeResult> = {}): ApplyShapeResult {
  return {
    ok: true,
    applied: {
      layout: {
        sidebarOpen: true,
        sidebarTab: 'overview',
        openPanels: [],
        focusDashboardSections: [],
      },
      activatedExtensions: ['linear-issues'],
      schedulesCreated: ['inbox-tick'],
      schedulesRebound: [],
    },
    warnings: [],
    offeredAgents: [],
    ...overrides,
  };
}

function makeDeps(res: ApplyShapeResult) {
  const applyShape = vi.fn().mockResolvedValue(res);
  const dispatched: UiCommand[] = [];
  const switchAgent = vi.fn();
  const deps = {
    transport: { applyShape },
    queryClient: new QueryClient(),
    dispatch: (c: UiCommand) => dispatched.push(c),
    switchAgent,
    label: 'Linear Ops',
  };
  return { applyShape, dispatched, switchAgent, deps };
}

describe('applyShapeAction', () => {
  beforeEach(() => {
    toastSuccess.mockClear();
    toastWarning.mockClear();
  });

  it('POSTs the apply, restores the returned chrome through the dispatcher, and returns the result', async () => {
    // Purpose: the review-locked contract — chrome comes from the response, no second fetch.
    const { applyShape, dispatched, deps } = makeDeps(result());
    const out = await applyShapeAction('linear-ops', deps);

    expect(applyShape).toHaveBeenCalledWith('linear-ops');
    // On the web cockpit (the default host here) there is no sidebar tab strip, so
    // the returned layout's pinned tab degrades to a plain open — the sidebar still
    // honors `sidebarOpen`, and no `switch_sidebar_tab` is dispatched.
    expect(dispatched).toContainEqual({ action: 'open_sidebar' });
    expect(dispatched).not.toContainEqual({ action: 'switch_sidebar_tab', tab: 'overview' });
    expect(out.applied.activatedExtensions).toEqual(['linear-issues']);
  });

  it('requests a live extension remount so newly-activated slots appear without a reload (W1c)', async () => {
    // Purpose: applying a Shape enables extensions server-side; the client must remount.
    const remount = vi.fn().mockResolvedValue(undefined);
    const unregister = registerExtensionRemount(remount);
    try {
      const { deps } = makeDeps(result());
      await applyShapeAction('linear-ops', deps);
      expect(remount).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

  it('surfaces a plain success when nothing degraded', async () => {
    const { deps } = makeDeps(result({ warnings: [] }));
    await applyShapeAction('linear-ops', deps);
    expect(toastSuccess).toHaveBeenCalledWith('Switched to Linear Ops');
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it('surfaces the §7 degradation warnings to the user (not the console) as a warning toast', async () => {
    // Purpose: a half-satisfied Shape must reach the user honestly.
    const warnings = [
      "Extension 'linear-issues' not found; install it to complete this Shape",
      "Connection 'linear_api_key' for 'linear-issues' needs setup",
    ];
    const { deps } = makeDeps(result({ warnings }));
    await applyShapeAction('linear-ops', deps);

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastWarning).toHaveBeenCalledWith(
      'Switched to Linear Ops · 2 notes',
      expect.objectContaining({ description: warnings.join('\n') })
    );
  });

  it('auto-follows a satisfied arrival agent only when the server opted in (autoFollow)', async () => {
    // Purpose: offer, never force — the switch only rides the opt-in flag + a real path.
    const { switchAgent, deps } = makeDeps(
      result({
        offeredAgents: [
          {
            ref: 'linear-tender',
            affinity: 'default',
            satisfied: true,
            arrival: true,
            autoFollow: true,
            agentId: 'a1',
            projectPath: '/home/kai/linear',
            displayName: 'Linear Tender',
          },
        ],
      })
    );
    await applyShapeAction('linear-ops', deps);
    expect(switchAgent).toHaveBeenCalledWith('/home/kai/linear');
  });

  it('does NOT follow an arrival agent when autoFollow is off (offer, never force)', async () => {
    const { switchAgent, deps } = makeDeps(
      result({
        offeredAgents: [
          {
            ref: 'linear-tender',
            affinity: 'default',
            satisfied: true,
            arrival: true,
            autoFollow: false,
            agentId: 'a1',
            projectPath: '/home/kai/linear',
            displayName: 'Linear Tender',
          },
        ],
      })
    );
    await applyShapeAction('linear-ops', deps);
    expect(switchAgent).not.toHaveBeenCalled();
  });
});
