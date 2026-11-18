/**
 * What an agent's connector tool lists say about money (DOR-4204 PR 2, spec
 * §5.1): whether each operation spends and what one run costs, and how much
 * is left this month, so an agent can plan before it runs.
 *
 * Added on top of the access query's own lists, by the two list tools, so the
 * stored-access schemas stay what they are: these are facts about the limit,
 * read live from the meter, never from a grant.
 *
 * @module services/connectors/spending/spend-tool-fields
 */
import { z } from 'zod';
import {
  AccessibleConnectorOperationSchema,
  ConnectorAccessibleConnectionsResponseSchema,
  ConnectorAccessibleOperationsResponseSchema,
  isPaidOperation,
  type ConnectorAccessibleConnectionsResponse,
  type ConnectorAccessibleOperationsResponse,
} from '@dorkos/shared/connector-schemas';
import { connectorSpending } from './spending-port.js';
import { nextMonthStart } from './spending-store.js';

const Micro = z.string().regex(/^\d+$/);

/** One operation an agent may run, with what it costs. */
export const AgentOperationSchema = AccessibleConnectorOperationSchema.extend({
  /** Whether running it spends money. */
  spendsMoney: z.boolean(),
  /** One run's price, when a person set one; null when unknown or free. */
  pricePerRun: z
    .object({ amount: Micro, source: z.literal('person') })
    .strict()
    .nullable(),
}).strict();

/** The operations an agent may run on one account, with what each costs. */
export const AgentOperationsResponseSchema = ConnectorAccessibleOperationsResponseSchema.extend({
  operations: z.array(AgentOperationSchema),
}).strict();

/** The accounts an agent may use, with this month's spend limit. */
export const AgentConnectionsResponseSchema = ConnectorAccessibleConnectionsResponseSchema.extend({
  spending: z
    .object({
      /** The monthly limit in micro-units, or null: every paid action asks. */
      limit: Micro.nullable(),
      /** What is left this month, or null with no limit. */
      left: Micro.nullable(),
      /** When the month resets, ISO. */
      resetsOn: z.string(),
    })
    .strict(),
}).strict();

/** A person's price for one run of an app, or null when unknown or unreadable. */
function priceOf(toolkit: string): number | null {
  try {
    return connectorSpending()?.store.price(toolkit) ?? null;
  } catch {
    return null;
  }
}

/**
 * Add each operation's money facts to an operation list.
 *
 * @param listed - The access query's list.
 */
export function withOperationSpending(
  listed: ConnectorAccessibleOperationsResponse
): z.infer<typeof AgentOperationsResponseSchema> {
  return {
    ...listed,
    operations: listed.operations.map((op) => {
      const spendsMoney = isPaidOperation(op);
      const price = spendsMoney ? priceOf(op.toolkit) : null;
      return {
        ...op,
        spendsMoney,
        pricePerRun: price === null ? null : { amount: String(price), source: 'person' as const },
      };
    }),
  };
}

/**
 * Add this month's spend limit to a connection list.
 *
 * @param listed - The access query's list.
 * @param now - The month's instant.
 */
export function withConnectionSpending(
  listed: ConnectorAccessibleConnectionsResponse,
  now: Date = new Date()
): z.infer<typeof AgentConnectionsResponseSchema> {
  const resetsOn = nextMonthStart(now).toISOString();
  const store = connectorSpending()?.store;
  let limit: number | null = null;
  let left: number | null = null;
  try {
    limit = store?.limit() ?? null;
    if (store && limit !== null) left = Math.max(0, limit - store.meter().usedMicro);
  } catch {
    // An unreadable meter: say nothing is left, so an agent plans on asking.
    left = limit === null ? null : 0;
  }
  return {
    ...listed,
    spending: {
      limit: limit === null ? null : String(limit),
      left: left === null ? null : String(left),
      resetsOn,
    },
  };
}
