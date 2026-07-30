// @vitest-environment jsdom
/**
 * Where the three roster states come from.
 *
 * `AgentRosterPicker.test.tsx` asserts what each state LOOKS like; this asserts
 * that the hook ever produces them. Both halves are needed — the defect this
 * closes was a hook that only ever produced one.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { useAgentPickerCandidates } from '../model/use-agent-picker-candidates';

afterEach(cleanup);

function wrapperFor(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

function render(overrides: Partial<Transport>) {
  const transport = createMockTransport(overrides);
  return {
    transport,
    ...renderHook(() => useAgentPickerCandidates(), { wrapper: wrapperFor(transport) }),
  };
}

describe('useAgentPickerCandidates', () => {
  it('reports a failed mesh read as a FAILURE, not as an empty fleet', async () => {
    const { result } = render({
      listMeshAgentPaths: vi.fn().mockRejectedValue(new Error('500')),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // Both matter: `isError` is what the picker branches on, and `isLoading`
    // must have stopped, or the failure would render as a permanent spinner.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.candidates).toEqual([]);
  });

  it('settles on a genuinely empty fleet instead of loading forever', async () => {
    // `useResolvedAgents` is disabled with no paths, so it stays PENDING for
    // this person for good. Reading that flag unguarded spins their picker
    // permanently and they never reach the copy that tells them to add an
    // agent — the one state where that copy is the true thing to say.
    const { result } = render({
      listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [] }),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isError).toBe(false);
    expect(result.current.candidates).toEqual([]);
  });

  it('names the agents it found, sorted, once both reads land', async () => {
    const { result } = render({
      listMeshAgentPaths: vi
        .fn()
        .mockResolvedValue({ agents: [{ projectPath: '/w/kai' }, { projectPath: '/w/ana' }] }),
      resolveAgents: vi.fn().mockResolvedValue({}),
    });

    await waitFor(() => expect(result.current.candidates).toHaveLength(2));
    // The subject, not a count: these two agents, in the order a reader scans.
    expect(result.current.candidates).toEqual([
      { agentPath: '/w/ana', displayName: 'ana', visual: null, description: null },
      { agentPath: '/w/kai', displayName: 'kai', visual: null, description: null },
    ]);
    expect(result.current.isError).toBe(false);
  });

  it('does not fail the roster when only the manifests could not be resolved', async () => {
    // A failed resolve costs a nicer display name and nothing else — the right
    // agents are still offerable under their directory names. Blocking the
    // picker on that would trade a worse label for no picker at all.
    const { result } = render({
      listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [{ projectPath: '/w/ana' }] }),
      resolveAgents: vi.fn().mockRejectedValue(new Error('500')),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isError).toBe(false);
    // Degraded on both halves and honest about it: the name falls back to the
    // directory, and the face is dropped rather than hashed out of the path,
    // which would be a confident guess this agent wears nowhere else.
    expect(result.current.candidates).toEqual([
      { agentPath: '/w/ana', displayName: 'ana', visual: null, description: null },
    ]);
  });

  it('does not resolve an empty list of paths when retrying a failed mesh read', async () => {
    // `refetch` runs a query even when `enabled` is false. A failed mesh read
    // leaves no paths, so an unguarded retry posts an empty resolve the server
    // answers 400 to — a console error and a wasted request on the one press a
    // reader makes when something is already broken.
    const resolveAgents = vi.fn().mockResolvedValue({});
    const { result } = render({
      listMeshAgentPaths: vi.fn().mockRejectedValue(new Error('500')),
      resolveAgents,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    result.current.retry();
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(resolveAgents).not.toHaveBeenCalled();
  });

  it('asks again when told to', async () => {
    const listMeshAgentPaths = vi.fn().mockRejectedValue(new Error('500'));
    const { result } = render({ listMeshAgentPaths });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const before = listMeshAgentPaths.mock.calls.length;
    result.current.retry();

    await waitFor(() => expect(listMeshAgentPaths.mock.calls.length).toBeGreaterThan(before));
  });
});
