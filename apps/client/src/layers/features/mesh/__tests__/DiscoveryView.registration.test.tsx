/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DiscoveryCandidate } from '@dorkos/shared/mesh-schemas';
import { TooltipProvider } from '@/layers/shared/ui';
import { DiscoveryView } from '../ui/DiscoveryView';

const mocks = vi.hoisted(() => ({
  registerAgent: vi.fn(),
  denyAgent: vi.fn(),
  startScan: vi.fn(),
  setScanRoots: vi.fn(),
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

const CANDIDATE = mocks.candidate;

vi.mock('@/layers/entities/mesh', () => ({
  useMeshScanRoots: () => ({
    roots: [mocks.candidate.path],
    setScanRoots: mocks.setScanRoots,
  }),
  useRegisteredAgents: () => ({ data: { agents: [] } }),
  useRegisterAgent: () => ({ mutateAsync: mocks.registerAgent }),
  useDenyAgent: () => ({ mutate: mocks.denyAgent }),
}));

vi.mock('@/layers/entities/discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/discovery')>()),
  useDiscoveryScan: () => ({ startScan: mocks.startScan }),
  useDiscoveryStore: () => ({
    candidates: mocks.candidates,
    existingAgents: [],
    isScanning: false,
    progress: null,
    error: null,
    lastScanAt: '2026-09-08T00:00:01.000Z',
  }),
}));

describe('DiscoveryView registration failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.candidates = [mocks.candidate];
  });

  it('keeps a failed candidate and retries it with its exact scan root', async () => {
    const user = userEvent.setup();
    const onRegistered = vi.fn();
    mocks.registerAgent
      .mockRejectedValueOnce(new Error('registration failed'))
      .mockResolvedValueOnce({});

    render(
      <TooltipProvider>
        <DiscoveryView onRegistered={onRegistered} />
      </TooltipProvider>
    );

    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.getByText('Scout')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t add this project. Try again.');
    expect(mocks.registerAgent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ path: CANDIDATE.path, scanRoot: CANDIDATE.path })
    );

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(screen.queryByText('Scout')).not.toBeInTheDocument());
    expect(onRegistered).toHaveBeenCalledOnce();
  });

  it('keeps every failed candidate after Add All', async () => {
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
        <DiscoveryView />
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
        <DiscoveryView />
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
