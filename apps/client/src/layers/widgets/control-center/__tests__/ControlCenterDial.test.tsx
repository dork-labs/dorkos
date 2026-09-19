// @vitest-environment jsdom
/**
 * The Control Center's global dial, and the one sentence that has to travel
 * with its top stop (DOR-2102).
 *
 * The note's presence is asserted through the rendered DOM rather than through
 * a grep of this file's source. The picker list in
 * `shared/ui/__tests__/permission-mode-scope-note.test.tsx` is a source-text
 * guard: it proves the component is MENTIONED here, and it stayed green when
 * the review blanked the descriptor this site passes, because the note hangs
 * entirely off that lookup. So the behaviour needs its own assertion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ControlCenterDial } from '../ui/ControlCenterDial';

/**
 * Claude Code's capability map, trimmed to what the dial reads: it resolves a
 * stored `null` through the default runtime's own starting mode.
 */
const CAPABILITIES = {
  capabilities: {
    'claude-code': {
      permissionModes: {
        supported: true,
        default: 'default',
        values: [
          {
            id: 'default',
            label: 'Default',
            stop: 'ask',
            asks: 'always',
            reach: 'edit',
            promise: 'Asks before it edits a file or runs a command.',
          },
        ],
      },
    },
  },
} as unknown as Awaited<ReturnType<Transport['getCapabilities']>>;

function makeConfig(trustStop: 'ask' | 'act' | 'autonomy' | null): ServerConfig {
  return {
    executionDefaults: { runtime: 'claude-code', trustStop },
  } as unknown as ServerConfig;
}

function harness(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return Wrapper;
}

/** Render the dial with the stored stop this case is about. */
async function renderDial(trustStop: 'ask' | 'act' | 'autonomy' | null) {
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue(makeConfig(trustStop)),
    getCapabilities: vi.fn().mockResolvedValue(CAPABILITIES),
  });
  render(<ControlCenterDial />, { wrapper: harness(transport) });
  await screen.findByTestId('control-center-dial');
  return transport;
}

/** The scope note, found by its slot rather than by a sentence that may be reworded. */
const scopeNote = () => document.querySelector('[data-slot="permission-mode-scope-note"]');

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('ControlCenterDial — what Full autonomy does not cover', () => {
  it('carries the note at the top stop', async () => {
    await renderDial('autonomy');
    await waitFor(() => expect(scopeNote()).toBeInTheDocument());
    expect(scopeNote()).toHaveTextContent(/DorkOS’s own risky actions still stop for you/);
  });

  it('points at the switch below, not at Settings', async () => {
    // `ControlCenterBody` renders `ControlCenterSwitches` — which owns the live
    // Standing permissions switch — directly under this section. Sending the
    // person to Settings would walk them past the control the sentence is about.
    await renderDial('autonomy');
    await waitFor(() => expect(scopeNote()).toBeInTheDocument());
    expect(scopeNote()).toHaveTextContent(
      'The setting for that is the Standing permissions switch below.'
    );
    expect(scopeNote()).not.toHaveTextContent(/in Settings under Access/);
  });

  it('says nothing at a stop that still asks', async () => {
    await renderDial('ask');
    // The dial is up and the config has landed, so the absence is the component's
    // answer rather than a frame before one.
    await screen.findByRole('radio', { name: 'Full autonomy' });
    expect(scopeNote()).not.toBeInTheDocument();
  });

  it('says nothing at the middle stop either', async () => {
    await renderDial('act');
    await screen.findByRole('radio', { name: 'Full autonomy' });
    expect(scopeNote()).not.toBeInTheDocument();
  });
});
