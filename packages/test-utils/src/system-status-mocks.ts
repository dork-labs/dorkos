import { vi } from 'vitest';
import { BUILTIN_MEMORY_PROVIDER_ID } from '@dorkos/shared/memory-provider';
import type { Transport } from '@dorkos/shared/transport';

/**
 * The mock transport's system status reads, and the choices that go with them:
 * the shell check, and the load gate's waiting line (empty by default).
 */
export function systemStatusTransportMocks(): Pick<
  Transport,
  | 'getMemoryProviderStatus'
  | 'getShellCheckStatus'
  | 'continueWithoutShellCheck'
  | 'getLoadGateWaitingLine'
  | 'actOnLoadGateJob'
> {
  return {
    getMemoryProviderStatus: vi.fn().mockResolvedValue({
      configuredId: BUILTIN_MEMORY_PROVIDER_ID,
      activeId: BUILTIN_MEMORY_PROVIDER_ID,
      benched: false,
      benchReason: null,
    }),
    getShellCheckStatus: vi
      .fn()
      .mockResolvedValue({ down: false, full: false, canContinue: false, continuing: false }),
    continueWithoutShellCheck: vi
      .fn()
      .mockResolvedValue({ down: true, full: true, canContinue: true, continuing: true }),
    getLoadGateWaitingLine: vi.fn().mockResolvedValue({ jobs: [] }),
    actOnLoadGateJob: vi.fn().mockResolvedValue({ jobs: [] }),
  };
}
