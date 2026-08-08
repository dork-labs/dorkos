// @vitest-environment jsdom
/**
 * The directory → roster-id join every path-holding surface opens a profile
 * through (DOR-957).
 *
 * Every fixture below keeps the id and the path **visibly different**. They are
 * different in production — a registry ULID and a filesystem path — and a
 * fixture where they agreed would pass whether the join returned the id or
 * simply echoed the path back, which is the one confusion this hook exists to
 * prevent.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useMeshMemberId, useMeshMemberIds } from '../model/use-mesh-member-ids';

const ALPHA_PATH = '/projects/alpha';
const ALPHA_ID = '01JALPHAREGISTRYULID';
const BETA_PATH = '/projects/beta';
const BETA_ID = '01JBETAREGISTRYULID';

function wrapperFor(agents: { id: string; name: string; projectPath: string }[]) {
  const transport = createMockTransport({
    listMeshAgentPaths: vi.fn().mockResolvedValue({ agents }),
  } as Partial<Transport>);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

const FLEET = [
  { id: ALPHA_ID, name: 'alpha', projectPath: ALPHA_PATH },
  { id: BETA_ID, name: 'beta', projectPath: BETA_PATH },
];

describe('useMeshMemberIds', () => {
  it('maps each agent directory to the id the roster files it under', async () => {
    const { result } = renderHook(() => useMeshMemberIds(), { wrapper: wrapperFor(FLEET) });

    await waitFor(() => expect(result.current.size).toBe(2));
    expect(result.current.get(ALPHA_PATH)).toBe(ALPHA_ID);
    expect(result.current.get(BETA_PATH)).toBe(BETA_ID);
  });

  it('is empty before the fleet answers, rather than guessing', () => {
    const { result } = renderHook(() => useMeshMemberIds(), { wrapper: wrapperFor(FLEET) });
    expect(result.current.size).toBe(0);
  });
});

describe('useMeshMemberId', () => {
  it('answers with the registry id, never the path it was asked about', async () => {
    const { result } = renderHook(() => useMeshMemberId(ALPHA_PATH), {
      wrapper: wrapperFor(FLEET),
    });

    await waitFor(() => expect(result.current).toBe(ALPHA_ID));
    expect(result.current).not.toBe(ALPHA_PATH);
  });

  it('answers undefined for a directory the mesh does not hold — no id, no profile', async () => {
    // Both hooks in one render, because `undefined` on its own cannot tell
    // "the fleet answered and does not have it" from "the request has not
    // landed yet" — waiting on the KNOWN one is what settles the read.
    const { result } = renderHook(
      () => ({
        known: useMeshMemberId(ALPHA_PATH),
        unknown: useMeshMemberId('/projects/never-registered'),
      }),
      { wrapper: wrapperFor(FLEET) }
    );

    await waitFor(() => expect(result.current.known).toBe(ALPHA_ID));
    expect(result.current.unknown).toBeUndefined();
  });

  it('answers undefined when the surface has no path yet', () => {
    const { result } = renderHook(() => useMeshMemberId(undefined), { wrapper: wrapperFor(FLEET) });
    expect(result.current).toBeUndefined();
  });
});
