import { vi } from 'vitest';
import type { ComputerTransport } from '@dorkos/shared/transport-computers';

/** A disabled computer by default; native readiness always needs an explicit test override. */
export function createMockComputerTransport(): ComputerTransport {
  const status = {
    id: 'local',
    name: 'Agent computer',
    supported: false,
    phase: 'disabled',
    generation: 0,
    ready: false,
  };
  return {
    getComputer: vi.fn().mockResolvedValue(status),
    createComputer: vi.fn().mockResolvedValue(status),
    startComputer: vi.fn().mockResolvedValue(status),
    stopComputer: vi.fn().mockResolvedValue(status),
    signInComputer: vi.fn().mockResolvedValue(status),
    createComputerSession: vi.fn().mockRejectedValue(new Error('Computer unavailable')),
    acquireComputerControl: vi.fn().mockRejectedValue(new Error('Computer unavailable')),
    releaseComputerControl: vi.fn().mockResolvedValue(undefined),
    sendComputerInput: vi.fn().mockRejectedValue(new Error('Computer unavailable')),
    getComputerFrame: vi.fn().mockRejectedValue(new Error('Computer unavailable')),
  };
}
