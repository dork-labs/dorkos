/**
 * `POST /api/discovery/scans`: the one folder scan for agents, streamed as it
 * walks (DOR-4982). It took the place of two doors onto the same scanner,
 * `POST /api/discovery/scan` (this stream) and `POST /api/mesh/discover` (the
 * same scan, answered at the end as one JSON list).
 *
 * The body schema lives here and the route parses with it, so the document
 * and the route cannot disagree. The `existing-agent` frame mirrors the
 * `ExistingAgent` type in `@dorkos/shared`; the type check at the bottom fails
 * the typecheck when that type gains, loses or changes a field.
 *
 * @module services/core/openapi/discovery-scan-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  AgentRuntimeSchema,
  DiscoveryCandidateSchema,
  ScanProgressSchema,
  type ExistingAgent,
} from '@dorkos/shared/mesh-schemas';
import { problemResponse } from './problem-openapi.js';

/** The body of `POST /api/discovery/scans`, which the route parses with it. */
export const DiscoveryScanRequestSchema = z.object({
  root: z.string().optional().describe('One folder to scan. `roots` wins when both are sent.'),
  roots: z
    .array(z.string())
    .optional()
    .describe('The folders to scan. With neither field, the scan starts at the boundary.'),
  maxDepth: z.number().int().min(1).max(10).optional().describe('How deep to walk. Default 5.'),
  timeout: z
    .number()
    .int()
    .min(1000)
    .max(120000)
    .optional()
    .describe('When to stop, in milliseconds. Default 30000.'),
});

const ExistingAgentSchema = z.object({
  path: z.string(),
  name: z.string(),
  runtime: AgentRuntimeSchema,
  description: z.string(),
});

/** One frame's `data:` on a scan's stream, by its `event:` name. */
const DiscoveryScanFrameSchema = z.union([
  DiscoveryCandidateSchema.describe('A `candidate` frame: a folder that looks like an agent.'),
  ExistingAgentSchema.describe(
    'An `existing-agent` frame: a folder that already held an agent file, now registered.'
  ),
  ScanProgressSchema.describe('A `progress` frame: how far the scan has walked.'),
  ScanProgressSchema.extend({ timedOut: z.boolean() }).describe(
    'The `complete` frame, sent once, last: the totals and whether the scan ran out of time.'
  ),
  z
    .object({ error: z.string() })
    .describe('An `error` frame: the scan stopped early. The reason stays in the log.'),
]);

/**
 * Register the scan.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerDiscoveryScanOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'post',
    path: '/api/discovery/scans',
    operationId: 'discovery.create_scan',
    // The group is the app's own; this one stream is open to scripts, as the Mesh scan it
    // took the place of was, and still being reshaped (DOR-4982).
    'x-stability': 'preview',
    tags: ['Mesh'],
    summary: 'Scan folders for agents (SSE)',
    description:
      'Walks the folders and streams what it finds as it goes. A folder that already holds an ' +
      'agent file is registered as it is found and sent as an `existing-agent` frame. Every root ' +
      'must sit inside the boundary, or the scan is refused before the stream opens.',
    request: {
      body: { content: { 'application/json': { schema: DiscoveryScanRequestSchema } } },
    },
    responses: {
      200: {
        description:
          'An SSE stream: `candidate`, `existing-agent` and `progress` frames while it walks, ' +
          'then one `complete` frame, or an `error` frame when it stops early.',
        content: { 'text/event-stream': { schema: DiscoveryScanFrameSchema } },
      },
      400: problemResponse('`invalid_request`: the body does not fit'),
      403: problemResponse('`outside_boundary`: a root is outside the folders DorkOS may use'),
    },
  });
}

/** True when `A` and `B` have exactly the same keys. */
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false;

/** A failing line here means `ExistingAgent` changed: change its schema above to match. */
const mirrors = {
  existingAgent: true satisfies SameKeys<z.infer<typeof ExistingAgentSchema>, ExistingAgent>,
};
void mirrors;
