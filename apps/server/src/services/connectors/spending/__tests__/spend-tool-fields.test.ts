/**
 * What an agent's connector tool lists say about money (DOR-4204 PR 2, spec
 * §5.1): each operation says whether it spends and what one run costs, the
 * connection list says how much is left this month, and the run tools say a
 * paid action asks first unless a limit covers it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { ConnectionIdSchema } from '@dorkos/shared/connector-schemas';
import { SpendingStore } from '../spending-store.js';
import { initConnectorSpending } from '../spending-port.js';
import {
  AgentConnectionsResponseSchema,
  AgentOperationsResponseSchema,
  withConnectionSpending,
  withOperationSpending,
} from '../spend-tool-fields.js';
import { connectorExecutionDomain } from '../../execution/execution-capabilities.js';

const NOW = new Date('2026-11-14T12:00:00.000Z');

function operation(toolkit: string, operationSlug: string) {
  return {
    operationRevisionId: `rev-${operationSlug}`,
    toolkit,
    operationSlug,
    toolkitVersion: 'v1',
    capabilityClassification: 'read' as const,
    retryPolicy: 'never' as const,
    inputSchema: { type: 'object' },
  };
}

describe('money in the connector tool lists', () => {
  let store: SpendingStore;

  beforeEach(() => {
    store = new SpendingStore(createTestDb(), () => NOW);
    initConnectorSpending({ store, outsider: () => false });
  });

  afterEach(() => initConnectorSpending(undefined));

  it('marks a paid operation and gives a person’s price per run', () => {
    store.setPrice('tavily', 300_000);
    const listed = withOperationSpending({
      connectionId: ConnectionIdSchema.parse('connection-acme-search'),
      operations: [operation('tavily', 'TAVILY_SEARCH'), operation('gmail', 'GMAIL_FETCH_EMAILS')],
    });
    expect(listed.operations.map((op) => [op.spendsMoney, op.pricePerRun])).toEqual([
      [true, { amount: '300000', source: 'person' }],
      [false, null],
    ]);
    expect(() => AgentOperationsResponseSchema.parse(listed)).not.toThrow();
  });

  it('says a paid operation’s price is unknown when nobody set one', () => {
    const listed = withOperationSpending({
      connectionId: ConnectionIdSchema.parse('connection-acme-search'),
      operations: [operation('tavily', 'TAVILY_SEARCH')],
    });
    expect(listed.operations[0]).toMatchObject({ spendsMoney: true, pricePerRun: null });
  });

  it('says how much is left this month, so an agent can plan', () => {
    store.setLimit(40_000_000);
    store.reserve({
      id: 'earlier',
      toolkit: 'tavily',
      agentId: 'agent-kestrel',
      amountMicro: 12_400_000,
      source: 'person',
      enforceLimit: true,
    });
    const listed = withConnectionSpending({ connections: [] }, NOW);
    expect(listed.spending).toEqual({
      limit: '40000000',
      left: '27600000',
      resetsOn: '2026-12-01T00:00:00.000Z',
    });
    expect(() => AgentConnectionsResponseSchema.parse(listed)).not.toThrow();
  });

  it('says there is no limit when none is set', () => {
    expect(withConnectionSpending({ connections: [] }, NOW).spending).toEqual({
      limit: null,
      left: null,
      resetsOn: '2026-12-01T00:00:00.000Z',
    });
  });

  it('tells an agent on the run tools that paid actions ask first', () => {
    for (const id of [
      'connectors.execute_read',
      'connectors.execute_write',
      'connectors.execute_destructive',
    ]) {
      const capability = connectorExecutionDomain.capabilities.find((c) => c.id === id);
      expect(capability?.description).toContain(
        'Paid actions ask a person first unless a monthly limit covers them.'
      );
    }
  });
});
