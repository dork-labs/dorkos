/**
 * `POST /api/telemetry/heartbeat` — opt-in weekly heartbeat sink (DOR-293).
 *
 * Runs as a Vercel Edge Function. Validates the incoming heartbeat with Zod,
 * then inserts a single row into `instance_heartbeats` via Drizzle — no Redis,
 * no queue, no background job, mirroring the install-telemetry pipeline.
 *
 * Privacy contract:
 *   - The validated schema below is the **complete** set of fields the handler
 *     may persist. Request headers (IP, cookies, user agent) are intentionally
 *     never read or stored.
 *   - Database errors are swallowed and logged so a transient outage cannot
 *     cause a client retry storm. The handler always responds `200 { ok: true }`
 *     once validation passes.
 *
 * Public payload documentation: https://dorkos.ai/telemetry
 *
 * @module app/api/telemetry/heartbeat
 */

import { z } from 'zod';

import { getDb } from '@/db/client';
import { instanceHeartbeats } from '@/db/schema';

export const runtime = 'edge';

const MAX_VERSION_LEN = 32;
const MAX_OS_LEN = 64;
const MAX_RUNTIME_LEN = 64;
const MAX_RUNTIMES = 16;
const MAX_COUNT = 1_000_000;

/**
 * Wire format for a heartbeat posted by the DorkOS server. Adding a field here
 * is the only way new data can land in `instance_heartbeats` — keep this schema
 * and the Drizzle table in lockstep, and never add a header-derived or
 * PII-shaped field.
 */
const HeartbeatSchema = z.object({
  instanceId: z.string().uuid(),
  dorkosVersion: z.string().min(1).max(MAX_VERSION_LEN),
  os: z.string().min(1).max(MAX_OS_LEN),
  runtimesConfigured: z.array(z.string().min(1).max(MAX_RUNTIME_LEN)).max(MAX_RUNTIMES),
  tunnelEnabled: z.boolean(),
  cloudLinked: z.boolean(),
  counts: z.object({
    agents: z.number().int().min(0).max(MAX_COUNT),
    tasks: z.number().int().min(0).max(MAX_COUNT),
    relayAdapters: z.number().int().min(0).max(MAX_COUNT),
  }),
});

type Heartbeat = z.infer<typeof HeartbeatSchema>;

/**
 * Handle a heartbeat POST. Returns `400` only on malformed JSON or schema
 * validation failure; all other paths (including database failures) return
 * `200` so the server never retries against a degraded backend.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = HeartbeatSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'Invalid heartbeat', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  await persistHeartbeat(parsed.data);

  return Response.json({ ok: true });
}

/**
 * Insert one validated heartbeat into Neon Postgres. Errors are caught and
 * logged so a database hiccup never propagates to the client — graceful
 * degradation is part of the privacy contract.
 */
async function persistHeartbeat(heartbeat: Heartbeat): Promise<void> {
  try {
    const db = getDb();
    await db.insert(instanceHeartbeats).values({
      instanceId: heartbeat.instanceId,
      dorkosVersion: heartbeat.dorkosVersion,
      os: heartbeat.os,
      runtimesConfigured: heartbeat.runtimesConfigured,
      tunnelEnabled: heartbeat.tunnelEnabled,
      cloudLinked: heartbeat.cloudLinked,
      countAgents: heartbeat.counts.agents,
      countTasks: heartbeat.counts.tasks,
      countRelayAdapters: heartbeat.counts.relayAdapters,
    });
  } catch (error) {
    console.error('[api/telemetry/heartbeat] insert failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
