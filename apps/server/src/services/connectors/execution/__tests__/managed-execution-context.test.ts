/** Command-identity isolation for private managed execution context. */
import { describe, expect, it } from 'vitest';
import type { ConnectorProviderExecuteCommand } from '@dorkos/shared/connector-schemas';
import { ManagedConnectorExecutionContextStore } from '../managed-execution-context.js';

function command(): ConnectorProviderExecuteCommand {
  return {} as ConnectorProviderExecuteCommand;
}

describe('ManagedConnectorExecutionContextStore', () => {
  it('resolves only the exact command once and freezes trusted context', () => {
    const store = new ManagedConnectorExecutionContextStore();
    const bound = command();
    const other = command();
    store.bind(bound, {
      agentId: 'agent-a',
      attemptIndex: 2,
      hostedRevisionId: '10000000-0000-4000-8000-000000000001',
      grantScopeVersion: 7,
      attribution: {
        surface: 'cli',
        actorKind: 'program',
        actorId: 'credential-a',
      },
    });

    expect(store.resolve(other)).toBeUndefined();
    const resolved = store.resolve(bound);
    expect(resolved).toEqual({
      agentId: 'agent-a',
      attemptIndex: 2,
      hostedRevisionId: '10000000-0000-4000-8000-000000000001',
      grantScopeVersion: 7,
      attribution: {
        surface: 'cli',
        actorKind: 'program',
        actorId: 'credential-a',
      },
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(store.resolve(bound)).toBeUndefined();
  });

  it('refuses rebinding the same command before its context is consumed', () => {
    const store = new ManagedConnectorExecutionContextStore();
    const bound = command();
    const context = {
      agentId: 'agent-a',
      attemptIndex: 1,
      hostedRevisionId: '10000000-0000-4000-8000-000000000001',
      grantScopeVersion: 1,
      attribution: { surface: 'mcp', actorKind: 'agent', actorId: 'agent-a' },
    } as const;
    store.bind(bound, context);
    expect(() => store.bind(bound, context)).toThrow(/already bound/);
  });
});
