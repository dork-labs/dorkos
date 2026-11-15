/**
 * The monthly spend limit's HTTP contract (DOR-4204 PR 2), under
 * `/api/connectors/spending`. Amounts are micro-unit integer strings.
 *
 * @module services/connectors/spending/openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

const Micro = z.string().regex(/^\d+$/);

/** What the Spending block reads. */
export const SpendingSummarySchema = z.object({
  currency: z.string(),
  limitMicro: Micro.nullable(),
  maxMicro: Micro,
  resetsAt: z.string(),
  prices: z.record(z.string(), Micro),
  meterReadable: z.boolean(),
  month: z.string().optional(),
  usedMicro: Micro.optional(),
  leftMicro: Micro.nullable().optional(),
  overMicro: Micro.nullable().optional(),
  approximate: z.boolean().optional(),
  byApp: z
    .array(
      z.object({
        toolkit: z.string(),
        runs: z.number().int(),
        amountMicro: Micro,
        estimated: z.boolean(),
        unknownRuns: z.number().int(),
      })
    )
    .optional(),
});

const held = { description: 'Confirm it’s you first: more money could leave without a card.' };
const refused = { description: 'Only the person who owns this DorkOS can change spending.' };
const invalid = { description: 'The amount is below $0.01, above the maximum, or not a number.' };

/**
 * Register the spending routes.
 *
 * @param registry - The OpenAPI registry.
 */
export function registerConnectorSpendingOpenApi(registry: OpenAPIRegistry): void {
  const ok = {
    description: 'This month’s limit, prices and spending.',
    content: { 'application/json': { schema: SpendingSummarySchema } },
  };
  registry.registerPath({
    method: 'get',
    path: '/api/connectors/spending',
    tags: ['Connections'],
    summary: 'Read the monthly spend limit and what agents spent this month',
    responses: { 200: ok },
  });
  registry.registerPath({
    method: 'put',
    path: '/api/connectors/spending/limit',
    tags: ['Connections'],
    summary: 'Set, lower or clear the monthly spend limit',
    description: 'A first limit or a higher one waits for Confirm it’s you; lowering never does.',
    request: {
      body: {
        content: { 'application/json': { schema: z.object({ limit: Micro.nullable() }) } },
      },
    },
    responses: { 200: ok, 400: invalid, 403: refused, 428: held },
  });
  registry.registerPath({
    method: 'put',
    path: '/api/connectors/spending/prices/{toolkit}',
    tags: ['Connections'],
    summary: 'Set or clear an app’s price per run',
    description: 'A first price or a lower one waits for Confirm it’s you; raising never does.',
    request: {
      params: z.object({ toolkit: z.string() }),
      body: {
        content: { 'application/json': { schema: z.object({ price: Micro.nullable() }) } },
      },
    },
    responses: { 200: ok, 400: invalid, 403: refused, 428: held },
  });
}
