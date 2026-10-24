import { vi } from 'vitest';
/** Credential actions are always fake in a mock transport. */
export function runtimeSigninTransportMocks() {
  return {
    storeRuntimeCredential: vi.fn().mockResolvedValue({ ref: 'file:mock' }),
    storeProviderCredential: vi.fn().mockResolvedValue({ ref: 'file:mock' }),
    getOpenCodeDirectSetup: vi
      .fn()
      .mockResolvedValue({ providerId: null, baseURL: null, key: { saved: false } }),
    checkProviderCredential: vi.fn().mockResolvedValue({ ok: true }),
    getRuntimeKeyStatus: vi.fn().mockResolvedValue({ key: { saved: false } }),
    checkRuntimeCredential: vi.fn().mockResolvedValue({ ok: true }),
    getClaudeSigninPolicy: vi
      .fn()
      .mockResolvedValue({ deniedOrganizations: [], folders: [], accounts: [] }),
    changeClaudeSigninPolicy: vi.fn().mockResolvedValue({ ok: true }),
    delegateRuntimeLogin: vi.fn().mockResolvedValue({ ok: true }),
  };
}
