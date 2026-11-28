/**
 * This computer's own reads (DOR-4978): what each runtime needs, the memory
 * backend, keep-awake, a folder's git status and an OpenRouter sign-in's
 * status, each a capability's own path, through the generated API client
 * (DOR-5473).
 *
 * @module shared/lib/transport/computer-read-methods
 */
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';
import type { MemoryProviderStatus } from '@dorkos/shared/memory-provider';
import type { OpenRouterOAuthStatus } from '@dorkos/shared/runtime-connect';
import type { GitStatusError, GitStatusResponse, KeepAwakeStatus } from '@dorkos/shared/schemas';
import { createTransportApiClient } from './api-client';

/**
 * Create this computer's read methods bound to a base URL.
 *
 * @param baseUrl - Server base URL
 */
export function createComputerReadMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    async getGitStatus(cwd?: string): Promise<GitStatusResponse | GitStatusError> {
      return (await api.call('git.status', { query: { dir: cwd } })) as
        GitStatusResponse | GitStatusError;
    },

    async checkRequirements(): Promise<SystemRequirements> {
      return (await api.call('system.requirements', {})) as SystemRequirements;
    },

    async getKeepAwake(): Promise<KeepAwakeStatus> {
      return (await api.call('keep-awake.status', {})) as KeepAwakeStatus;
    },

    async getMemoryProviderStatus(): Promise<MemoryProviderStatus> {
      return (await api.call('system.memory', {})) as MemoryProviderStatus;
    },

    async getOpenRouterOAuthStatus(state: string): Promise<OpenRouterOAuthStatus> {
      return (await api.call('runtimes.openrouter_sign_in_status', {
        query: { state },
      })) as OpenRouterOAuthStatus;
    },
  };
}
