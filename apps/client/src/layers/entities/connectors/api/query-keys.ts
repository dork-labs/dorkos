/**
 * TanStack Query key factory for connector entity queries.
 *
 * @module entities/connectors/api
 */

export const connectorKeys = {
  all: ['connectors'] as const,

  providers: () => [...connectorKeys.all, 'providers'] as const,
  toolkits: () => [...connectorKeys.all, 'toolkits'] as const,

  // The unfiltered base is the prefix of every filtered key, so one
  // invalidation of `accounts()` reaches the per-toolkit variants too.
  accounts: () => [...connectorKeys.all, 'accounts'] as const,
  accountList: (toolkit?: string) =>
    toolkit
      ? ([...connectorKeys.accounts(), { toolkit }] as const)
      : ([...connectorKeys.accounts()] as const),

  recommendation: (service: string) => [...connectorKeys.all, 'recommend', service] as const,

  flow: (flowId: string) => [...connectorKeys.all, 'flow', flowId] as const,

  // Per-session connector surface; `sessions()` is the prefix so a global
  // change (an account disconnected) can sweep every session's cache at once.
  sessions: () => [...connectorKeys.all, 'session'] as const,
  session: (sessionId: string) => [...connectorKeys.sessions(), sessionId] as const,
};
