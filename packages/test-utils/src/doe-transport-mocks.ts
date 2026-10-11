/**
 * The DorkOS runtime's model-setup methods on a mock `Transport`, kept apart
 * from `mock-factories.ts` so that file can only shrink (Hard Rule 9).
 *
 * @module test-utils/doe-transport-mocks
 */
import { vi } from 'vitest';
import type { Transport } from '@dorkos/shared/transport';

/** Mocks for the DorkOS model-setup transport methods: nothing configured, no catalog. */
export function doeTransportMocks(): Pick<
  Transport,
  'getDoeInference' | 'setDoeInference' | 'storeDoeCredential' | 'getDoeCreditsModels'
> {
  return {
    getDoeInference: vi
      .fn()
      .mockResolvedValue({ inference: null, hasKey: false, autoProtocol: null }),
    setDoeInference: vi.fn().mockResolvedValue({ ok: true }),
    storeDoeCredential: vi.fn().mockResolvedValue({ ok: true, hasKey: true }),
    getDoeCreditsModels: vi.fn().mockResolvedValue({ endpoint: null, models: [] }),
  };
}
