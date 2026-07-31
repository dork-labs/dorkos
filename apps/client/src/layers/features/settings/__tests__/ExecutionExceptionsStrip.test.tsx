// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { useAgentHubStore } from '@/layers/features/agent-hub';
import { ExecutionExceptionsStrip } from '../ui/execution-defaults/ExecutionExceptionsStrip';

// No RouterProvider here — the strip only asks the deep-link hook to CLOSE the
// dialog, which the openHub assertion below stands in for. URL behavior is
// covered by `use-dialog-deep-link.test.tsx`.
const mockCloseSettings = vi.fn();
vi.mock('@/layers/shared/model/use-dialog-deep-link', () => ({
  useSettingsDeepLink: () => ({
    isOpen: true,
    activeTab: 'runtimes',
    section: null,
    open: vi.fn(),
    close: mockCloseSettings,
    setTab: vi.fn(),
    setSection: vi.fn(),
  }),
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function agent(name: string, extra: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: name,
    name,
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    color: '#888',
    icon: '🤖',
    ...extra,
  } as AgentManifest;
}

const CATALOG = [
  { value: 'opus', displayName: 'Opus', description: '', supportsEffort: true },
  { value: 'haiku', displayName: 'Haiku', description: '', supportsEffort: false },
];

function renderStrip(
  agents: Record<string, AgentManifest>,
  opts: { models?: typeof CATALOG; perRuntimeModel?: string | null } = {}
) {
  const models = opts.models ?? CATALOG;
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({
      version: '1.0.0',
      port: 4242,
      uptime: 0,
      workingDirectory: '/test',
      nodeVersion: 'v20.0.0',
      platform: 'linux-x64',
      runtimes: ['claude-code'],
      claudeCliPath: null,
      executionDefaults: {
        runtime: 'claude-code',
        perRuntime: [
          {
            runtime: 'claude-code',
            model: opts.perRuntimeModel ?? null,
            effort: null,
            supportsEffort: true,
          },
        ],
      },
      tunnel: {
        enabled: false,
        connected: false,
        url: null,
        authEnabled: false,
        tokenConfigured: false,
      },
    }),
    getCapabilities: vi.fn().mockResolvedValue({
      capabilities: { 'claude-code': { type: 'claude-code' } },
      defaultRuntime: 'claude-code',
    }),
    listMeshAgentPaths: vi
      .fn()
      .mockResolvedValue({ agents: Object.keys(agents).map((p) => ({ projectPath: p })) }),
    resolveAgents: vi.fn().mockResolvedValue(agents),
    getModels: vi.fn().mockResolvedValue(models),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <ExecutionExceptionsStrip />
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('ExecutionExceptionsStrip', () => {
  it('draws nothing at all when the whole fleet inherits', async () => {
    renderStrip({ '/a': agent('alpha') });
    await waitFor(() => expect(screen.queryByTestId('execution-exceptions-strip')).toBeNull());
    // Give the queries a chance to settle and still show nothing.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('execution-exceptions-strip')).toBeNull();
  });

  it('names a healthy deviation without calling it broken', async () => {
    renderStrip({ '/a': agent('alpha', { model: 'opus' }) });
    expect(await screen.findByTestId('execution-exception')).toHaveTextContent('model opus');
    expect(screen.queryByTestId('execution-exception-broken')).toBeNull();
  });

  it('puts broken agents first, in their own row kind', async () => {
    renderStrip({
      '/a': agent('alpha', { model: 'opus' }),
      '/b': agent('beta', { runtime: 'codex' }),
    });
    const broken = await screen.findByTestId('execution-exception-broken');
    expect(broken).toHaveTextContent('Codex is not connected');
    const rows = screen.getAllByRole('button');
    expect(rows[0]).toBe(broken);
  });

  it('opens the agent’s own Config tab, and gets the dialog out of the way first', async () => {
    const openHub = vi.spyOn(useAgentHubStore.getState(), 'openHub');
    renderStrip({ '/a': agent('alpha', { model: 'opus' }) });
    await userEvent.click(await screen.findByTestId('execution-exception'));
    expect(mockCloseSettings).toHaveBeenCalled();
    expect(openHub).toHaveBeenCalledWith('/a', 'config');
    // Naming the agent is not the same as showing it: without these the dialog
    // closes onto an unchanged dashboard.
    expect(useAppStore.getState().rightPanelOpen).toBe(true);
    expect(useAppStore.getState().activeRightPanelTab).toBe('agent-hub');
  });

  it('calls a pinned model the runtime no longer offers broken', async () => {
    renderStrip({ '/a': agent('alpha', { model: 'opus-3' }) });
    expect(await screen.findByTestId('execution-exception-broken')).toHaveTextContent(
      'Claude Code no longer offers opus-3'
    );
  });

  // ── B1: the catalog answers 200 {models: []} while it warms up ─────────────
  it('does not turn the whole fleet amber against a cold catalog', async () => {
    renderStrip({ '/a': agent('alpha', { model: 'opus' }) }, { models: [] });
    // The row still appears — pinning a model IS a deviation — but a warming
    // catalog must not upgrade that deviation to breakage.
    expect(await screen.findByTestId('execution-exception')).toHaveTextContent('model opus');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('execution-exception-broken')).toBeNull();
  });

  // ── I3: the strip and the Config tab judge effort by the same model ────────
  it('calls an effort broken against the INHERITED model that cannot take it', async () => {
    // The agent pins nothing; the server default for its runtime is Haiku,
    // which takes no effort. The strip used to look only at pinned models and
    // so called this agent healthy while its own Config tab called it broken.
    renderStrip({ '/a': agent('alpha', { effort: 'high' }) }, { perRuntimeModel: 'haiku' });
    expect(await screen.findByTestId('execution-exception-broken')).toHaveTextContent(
      'haiku does not take an effort setting'
    );
  });

  // ── I4: a joined multi-breakage sentence must not be cut off mid-word ──────
  it('carries the whole reason in a tooltip, however many breakages joined it', async () => {
    renderStrip({ '/a': agent('alpha', { runtime: 'opencode', effort: 'high' }) });
    const row = await screen.findByTestId('execution-exception-broken');
    const reason = row.querySelector('[title]');
    expect(reason).not.toBeNull();
    // The full sentence, not the clipped render — both breakages, both intact.
    expect(reason).toHaveAttribute(
      'title',
      expect.stringContaining('OpenCode is not connected on this machine.')
    );
    expect(reason?.getAttribute('title')).toContain('so this one does nothing.');
    // Clamped to two lines rather than one, so the pair fits without a tooltip
    // at every width the strip is drawn at.
    expect(reason).toHaveClass('line-clamp-2');
  });
});
