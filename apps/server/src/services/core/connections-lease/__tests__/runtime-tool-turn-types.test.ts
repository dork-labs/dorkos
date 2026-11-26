/** Compile-time port contract; server typecheck checks this file, Vitest alone does not. */
import { expectTypeOf, it } from 'vitest';
import type { AgentHome } from '../../agent-identity/index.js';
import type { CapabilityHoldSession } from '../../capabilities/capability-approval-hold.js';
import type { ServerPrincipalProof } from '../principal-types.js';
import type {
  ConnectorRuntimePrincipalPort,
  ConnectorTurnOwnership,
  RuntimeToolCaller,
  RuntimeToolTurnFacts,
} from '../runtime-principal-port.js';

it('keeps the frozen live-facts and canonical caller signatures', () => {
  expectTypeOf<keyof RuntimeToolTurnFacts>().toEqualTypeOf<
    'effectiveMode' | 'chosenMode' | 'neverAsks' | 'session' | 'signal'
  >();
  expectTypeOf<RuntimeToolTurnFacts['effectiveMode']>().toEqualTypeOf<string | undefined>();
  expectTypeOf<RuntimeToolTurnFacts['chosenMode']>().toEqualTypeOf<string | undefined>();
  expectTypeOf<RuntimeToolTurnFacts['session']>().toEqualTypeOf<CapabilityHoldSession>();
  expectTypeOf<RuntimeToolCaller['agentHome']>().toEqualTypeOf<AgentHome>();
  expectTypeOf<RuntimeToolCaller['read']>().toEqualTypeOf<() => RuntimeToolTurnFacts>();
  expectTypeOf<RuntimeToolCaller['assertCurrent']>().toEqualTypeOf<() => Promise<void>>();
  expectTypeOf<ConnectorTurnOwnership['readToolTurn']>().toEqualTypeOf<
    (() => RuntimeToolTurnFacts | undefined) | undefined
  >();
  expectTypeOf<ConnectorRuntimePrincipalPort['resolveToolTurn']>().toEqualTypeOf<
    (principal: ServerPrincipalProof) => Promise<RuntimeToolCaller>
  >();
});
