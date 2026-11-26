/**
 * The deps of a person's doors on the capability mount (DOR-4978) for the
 * conformance suite: each refuses or answers on its own before reaching a
 * real store, as the suite asks of a wired capability.
 */
import type { CapabilityDeps } from '../capability-definition.js';

/**
 * A person's MCP servers for every agent, chat from the web switched off,
 * agent folders where no agent lives, and the owner's connection doors.
 */
export const conformancePersonDoorDeps: Pick<
  CapabilityDeps,
  'globalMcpPersonDeps' | 'sessionRelayDeps' | 'agentHomeDeps' | 'connectionOwnerDeps'
> = {
  // `/api/connectors`: behind the account-decision bar, so a call with no mount proof is
  // refused before any of these run (DOR-4978).
  connectionOwnerDeps: {
    query: {} as NonNullable<CapabilityDeps['connectionOwnerDeps']>['query'],
    lifecycle: {} as NonNullable<CapabilityDeps['connectionOwnerDeps']>['lifecycle'],
  },
  // `GET /api/agents/current` and the persona move: no agent lives in any folder.
  agentHomeDeps: { agentAt: async () => null },
  // `/api/mcp-servers`: person-only, so the anonymous probe is refused before any of these run.
  globalMcpPersonDeps: {
    store: {} as NonNullable<CapabilityDeps['globalMcpPersonDeps']>['store'],
    ledger: {} as NonNullable<CapabilityDeps['globalMcpPersonDeps']>['ledger'],
    agents: () => [],
  },
  // `/api/session-relay`: the experiment is off, so each door answers its own `/api` 404.
  sessionRelayDeps: {
    isHub: () => false,
    enabled: () => false,
    readPin: () => null,
    updatePin: async () => null,
    clearPin: () => undefined,
    closeRelay: () => undefined,
    connected: () => false,
    suggestedName: () => 'conformance',
    presence: () => ({ active: false, devices: [] }),
    devices: () => [],
    passkeys: { readKeys: () => null, keysUnreadable: () => false },
    withPinLock: async (change) => change(),
    recordAudit: () => undefined,
  },
};
