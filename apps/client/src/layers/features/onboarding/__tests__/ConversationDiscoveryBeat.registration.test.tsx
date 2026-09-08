/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DiscoveryCandidate } from '@dorkos/shared/mesh-schemas';
import { TooltipProvider } from '@/layers/shared/ui';
import { ConversationDiscoveryBeat } from '../ui/ConversationDiscoveryBeat';

const mocks = vi.hoisted(() => ({
  registerAgent: vi.fn(),
  startScan: vi.fn(),
  candidate: {
    path: '/home/kai/projects/scout',
    strategy: 'codex',
    hints: {
      suggestedName: 'Scout',
      detectedRuntime: 'codex',
    },
    discoveredAt: '2026-09-08T00:00:00.000Z',
  } as DiscoveryCandidate,
  candidates: [] as DiscoveryCandidate[],
}));

vi.mock('@/layers/entities/mesh', () => ({
  useRegisterAgent: () => ({ mutateAsync: mocks.registerAgent }),
}));

vi.mock('@/layers/entities/discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/discovery')>()),
  useDiscoveryScan: () => ({ startScan: mocks.startScan }),
  useDiscoveryStore: () => ({
    candidates: mocks.candidates,
    isScanning: false,
    lastScanAt: '2026-09-08T00:00:01.000Z',
    error: null,
  }),
}));

vi.mock('@/layers/features/chat', () => ({
  TypingDots: () => null,
}));

describe('ConversationDiscoveryBeat registration failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.candidates = [mocks.candidate];
  });

  it('keeps a failed onboarding candidate until retry succeeds', async () => {
    const user = userEvent.setup();
    mocks.registerAgent
      .mockRejectedValueOnce(new Error('registration failed'))
      .mockResolvedValueOnce({});

    render(
      <TooltipProvider>
        <ConversationDiscoveryBeat
          phase="results"
          onConsent={vi.fn()}
          onDecline={vi.fn()}
          onResults={vi.fn()}
          onZero={vi.fn()}
          onTimeout={vi.fn()}
          onDone={vi.fn()}
        />
      </TooltipProvider>
    );

    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Scout')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t add this project. Try again.');

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText('Scout')).not.toBeInTheDocument());
  });

  it('keeps the candidate after a failed bulk add', async () => {
    const user = userEvent.setup();
    const second = {
      ...mocks.candidate,
      path: '/home/kai/projects/writer',
      hints: { ...mocks.candidate.hints, suggestedName: 'Writer' },
    };
    mocks.candidates = [mocks.candidate, second];
    mocks.registerAgent.mockImplementation((input: { path: string }) =>
      input.path === second.path
        ? Promise.reject(new Error('registration failed'))
        : Promise.resolve({})
    );

    render(
      <TooltipProvider>
        <ConversationDiscoveryBeat
          phase="results"
          onConsent={vi.fn()}
          onDecline={vi.fn()}
          onResults={vi.fn()}
          onZero={vi.fn()}
          onTimeout={vi.fn()}
          onDone={vi.fn()}
        />
      </TooltipProvider>
    );

    await user.click(screen.getByRole('button', { name: 'Add All' }));

    await waitFor(() => expect(screen.queryByText('Scout')).not.toBeInTheDocument());
    expect(screen.getByText('Writer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('submits each project once when individual and bulk actions overlap', async () => {
    const second = {
      ...mocks.candidate,
      path: '/home/kai/projects/writer',
      hints: { ...mocks.candidate.hints, suggestedName: 'Writer' },
    };
    mocks.candidates = [mocks.candidate, second];
    const resolveRegistrations: Array<() => void> = [];
    mocks.registerAgent.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRegistrations.push(resolve);
        })
    );

    render(
      <TooltipProvider>
        <ConversationDiscoveryBeat
          phase="results"
          onConsent={vi.fn()}
          onDecline={vi.fn()}
          onResults={vi.fn()}
          onZero={vi.fn()}
          onTimeout={vi.fn()}
          onDone={vi.fn()}
        />
      </TooltipProvider>
    );

    const firstAdd = screen.getAllByRole('button', { name: 'Add' })[0];
    const addAll = screen.getByRole('button', { name: 'Add All' });
    act(() => {
      firstAdd.click();
      firstAdd.click();
      addAll.click();
    });

    expect(mocks.registerAgent).toHaveBeenCalledTimes(2);
    expect(mocks.registerAgent.mock.calls.map(([input]) => input.path)).toEqual([
      mocks.candidate.path,
      second.path,
    ]);
    expect(screen.getAllByRole('button', { name: 'Adding…' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Add All' })).toBeDisabled();

    await act(async () => {
      for (const resolve of resolveRegistrations) resolve();
    });
    await waitFor(() => expect(screen.queryByText('Scout')).not.toBeInTheDocument());
    expect(screen.queryByText('Writer')).not.toBeInTheDocument();
  });
});
