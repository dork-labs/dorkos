/**
 * The monthly spend limit's HTTP contract (DOR-4204 PR 2), under
 * `/api/connectors/spending`. Amounts are micro-unit integer strings.
 *
 * @module services/connectors/spending/openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  SetSpendingLimitBodySchema,
  SetSpendingPriceBodySchema,
  SpendingSummarySchema,
} from '@dorkos/shared/connector-spending';
import { problemResponse } from '../../core/openapi/problem-openapi.js';

const held = { description: 'Confirm it’s you first: more money could leave without a card.' };
const refused = problemResponse(
  '`person_only` or `owner_only`: only the person who owns this DorkOS can change spending.'
);
const invalid = problemResponse(
  '`invalid_request`: the amount is below $0.01, above the maximum, or not a number.'
);

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
        content: { 'application/json': { schema: SetSpendingLimitBodySchema } },
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
        content: { 'application/json': { schema: SetSpendingPriceBodySchema } },
      },
    },
    responses: { 200: ok, 400: invalid, 403: refused, 428: held },
  });
}
