/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useTourOccasions } from '../model/use-tour-occasions';

// --- Controllable mocks for every signal the detector observes ---
const setPendingOffer = vi.fn();
let mockIsSuppressed: (id: string) => boolean = () => false;
let mockPendingOfferId: string | null = null;
let mockRunningDefinition: unknown = null;

vi.mock('../model/use-tours', () => ({
  useTours: () => ({
    isSuppressed: mockIsSuppressed,
    setPendingOffer,
    pendingOfferId: mockPendingOfferId,
    runningDefinition: mockRunningDefinition,
  }),
}));

let mockTasks: unknown[] | undefined;
let mockCatalog: { instances: unknown[] }[] | undefined;
let mockMesh: { agents: unknown[] } | undefined;
let mockRelayEnabled = true;
let mockStreaming = false;

vi.mock('@/layers/entities/tasks', () => ({ useTasks: () => ({ data: mockTasks }) }));
vi.mock('@/layers/entities/relay', () => ({
  useExternalAdapterCatalog: () => ({ data: mockCatalog }),
  useRelayEnabled: () => mockRelayEnabled,
}));
vi.mock('@/layers/entities/mesh', () => ({ useRegisteredAgents: () => ({ data: mockMesh }) }));
vi.mock('@/layers/entities/session', () => ({
  useSessionListStore: (selector: (s: unknown) => unknown) =>
    selector({ statuses: mockStreaming ? { s1: { lifecycle: 'streaming' } } : {} }),
}));

function tasks(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `t${i}` }));
}
function agents(n: number) {
  return { agents: Array.from({ length: n }, (_, i) => ({ id: `a${i}` })) };
}

beforeEach(() => {
  setPendingOffer.mockClear();
  mockIsSuppressed = () => false;
  mockPendingOfferId = null;
  mockRunningDefinition = null;
  mockTasks = [];
  mockCatalog = [];
  mockMesh = agents(1);
  mockRelayEnabled = true;
  mockStreaming = false;
});

describe('useTourOccasions', () => {
  it('offers the tasks tour on an observed 0 to 1 transition', () => {
    mockTasks = [];
    const { rerender } = renderHook(() => useTourOccasions());
    expect(setPendingOffer).not.toHaveBeenCalled();

    mockTasks = tasks(1);
    rerender();
    expect(setPendingOffer).toHaveBeenCalledWith('tasks');
  });

  it('never offers when the count is already above the threshold at mount', () => {
    mockTasks = tasks(3);
    const { rerender } = renderHook(() => useTourOccasions());
    mockTasks = tasks(4);
    rerender();
    expect(setPendingOffer).not.toHaveBeenCalled();
  });

  it('offers the mesh tour only on the second agent (1 to 2)', () => {
    mockMesh = agents(1);
    const { rerender } = renderHook(() => useTourOccasions());
    mockMesh = agents(2);
    rerender();
    expect(setPendingOffer).toHaveBeenCalledWith('mesh');
  });

  it('defers across a streaming turn, then offers when it ends', () => {
    mockTasks = [];
    mockStreaming = true;
    const { rerender } = renderHook(() => useTourOccasions());

    mockTasks = tasks(1);
    rerender();
    expect(setPendingOffer).not.toHaveBeenCalled();

    mockStreaming = false;
    rerender();
    expect(setPendingOffer).toHaveBeenCalledWith('tasks');
  });

  it('does not offer a tour that is already seen or declined', () => {
    mockIsSuppressed = (id) => id === 'tasks';
    mockTasks = [];
    const { rerender } = renderHook(() => useTourOccasions());
    mockTasks = tasks(1);
    rerender();
    expect(setPendingOffer).not.toHaveBeenCalled();
  });

  it('holds at one offer: does not fire while another offer stands', () => {
    mockPendingOfferId = 'relay';
    mockTasks = [];
    const { rerender } = renderHook(() => useTourOccasions());
    mockTasks = tasks(1);
    rerender();
    expect(setPendingOffer).not.toHaveBeenCalled();
  });

  it('offers the relay tour on the first connected channel', () => {
    mockCatalog = [];
    const { rerender } = renderHook(() => useTourOccasions());
    mockCatalog = [{ instances: [{ id: 'tg-1' }] }];
    rerender();
    expect(setPendingOffer).toHaveBeenCalledWith('relay');
  });
});
