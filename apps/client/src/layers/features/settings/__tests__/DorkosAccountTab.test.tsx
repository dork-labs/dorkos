// @vitest-environment jsdom
/**
 * Settings › DorkOS account (DOR-2628): the hosted account's one home.
 *
 * Signed out, a calm page naming only what the server reports as wired, with
 * one button. Signed in, the account's sections with "Unlink this computer"
 * last. Never a badge, never a dot.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { DorkosAccountTab } from '../ui/DorkosAccountTab';

const CREDITS_ON = {
  enabled: true,
  ready: false,
  runtimes: { 'claude-code': 'wired', opencode: 'follow-up', codex: 'follow-up' },
} as const;

function renderTab(transport: Transport) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <DorkosAccountTab />
      </TransportProvider>
    </QueryClientProvider>
  );
  return view.container;
}

afterEach(() => cleanup());

describe('DorkosAccountTab', () => {
  it('signed out with nothing wired: one plain line, one button, who can buy', async () => {
    renderTab(createMockTransport());
    expect(await screen.findByText(/Everything else works without one\./)).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^link this computer$/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Who can buy a plan?' })).toBeInTheDocument();
  });

  it('signed out with credits wired: names exactly the runtimes the server reports', async () => {
    renderTab(createMockTransport({ getCloudCredits: vi.fn().mockResolvedValue(CREDITS_ON) }));
    const benefit = await screen.findByText(/Use one account for/);
    expect(benefit).toHaveTextContent('Use one account for Claude: run it on your DorkOS credits.');
    expect(benefit).not.toHaveTextContent(/Codex|OpenCode/);
  });

  it('signed in: the account line, its sections, and Unlink this computer last', async () => {
    const transport = createMockTransport({
      getCloudStatus: vi.fn().mockResolvedValue({
        linked: true,
        accountLabel: 'kai@dork.dev',
        lastHeartbeatAt: null,
      }),
    });
    renderTab(transport);
    expect(await screen.findByText('kai@dork.dev')).toBeInTheDocument();
    expect(screen.getByText('Signed in')).toBeInTheDocument();
    expect(await screen.findByText('What’s on your account')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlink this computer' })).toBeInTheDocument();
    // The signed-out page and its button are gone once linked.
    expect(screen.queryByRole('button', { name: /^link this computer$/i })).not.toBeInTheDocument();
  });

  it('draws no badge and no status dot, signed in or out', async () => {
    const container = renderTab(createMockTransport());
    await screen.findByRole('button', { name: /^link this computer$/i });
    expect(container.querySelector('[data-slot="badge"], .rounded-full.size-2')).toBeNull();
  });
});
