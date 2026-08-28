/**
 * `POST /api/telemetry/heartbeat` — anonymous daily heartbeat sink (DOR-293;
 * opt-in per ADR 260727-182651, which supersedes 260713-143958's Tier 1 posture).
 *
 * Runs as a Vercel Edge Function. Validates the incoming heartbeat with Zod,
 * then **upserts** a single row into `instance_heartbeats` keyed on
 * `instanceId` via Drizzle — no Redis, no queue, no background job, mirroring
 * the install-telemetry pipeline.
 *
 * Why upsert (last-seen), not append-only: the endpoint is public and
 * unauthenticated. Keying on `instanceId` means each real installation owns
 * exactly one row (its latest ping), so legitimate daily pings do not grow the
 * table without bound and the row count is a true distinct-instance metric.
 *
 * Residual abuse note: a spray of random valid UUIDs still creates one row per
 * distinct UUID, because each fake UUID looks like a new install. The per-IP
 * throttle below (DOR-1586) now bounds how fast one source can do that. It is
 * friction, not a guarantee: the limiter's state is process-local, and on the
 * Edge runtime that means per V8 isolate, so the effective ceiling is looser
 * than the number suggests. A hard, global limit would need the KV/Redis store
 * the telemetry architecture deliberately forbids (see
 * contributing/marketplace-telemetry.md §3), and this deliberately does not add
 * one. The metric stays "best-effort, undercounting by design"; the size/shape
 * cap, the upsert, and the throttle are the guardrails together.
 *
 * Privacy contract:
 *   - The validated schema below is the **complete** set of fields the handler
 *     may persist. No request header — IP, cookies, user agent — is ever
 *     stored, logged, or forwarded.
 *   - The one header read is the client IP, taken by the throttle into a
 *     process-local counter holding nothing but a count and a timestamp. It
 *     never reaches the row or the logs.
 *   - Database errors are swallowed and logged so a transient outage cannot
 *     cause a client retry storm. The handler always responds `200 { ok: true }`
 *     once validation passes.
 *
 * Public payload documentation: https://dorkos.ai/telemetry
 *
 * @module app/api/telemetry/heartbeat
 */

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '@/db/client';
import { instanceHeartbeats } from '@/db/schema';
import { consumeHeartbeatTelemetryQuota } from '@/lib/telemetry/heartbeat-rate-limit';

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
 * Handle a heartbeat POST. Returns `429` when this IP is over its limit and
 * `400` on malformed JSON or schema validation failure; all other paths
 * (including database failures) return `200` so the server never retries
 * against a degraded backend.
 */
export async function POST(request: Request): Promise<Response> {
  // Charged before the body is read: a spray is a spray whatever it carries.
  const quota = consumeHeartbeatTelemetryQuota(request);
  if (!quota.allowed) {
    return Response.json(
      { error: 'Too many requests. Retry after the number of seconds in the Retry-After header.' },
      { status: 429, headers: { 'retry-after': String(quota.retryAfterSeconds) } }
    );
  }

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
 * Upsert one validated heartbeat into Neon Postgres, keyed on `instanceId`
 * (last-seen semantics): a first ping inserts a row, and every later ping from
 * the same install updates that one row's payload and `receivedAt`. Errors are
 * caught and logged so a database hiccup never propagates to the client —
 * graceful degradation is part of the privacy contract.
 */
async function persistHeartbeat(heartbeat: Heartbeat): Promise<void> {
  try {
    const db = getDb();
    const row = {
      instanceId: heartbeat.instanceId,
      dorkosVersion: heartbeat.dorkosVersion,
      os: heartbeat.os,
      runtimesConfigured: heartbeat.runtimesConfigured,
      tunnelEnabled: heartbeat.tunnelEnabled,
      cloudLinked: heartbeat.cloudLinked,
      countAgents: heartbeat.counts.agents,
      countTasks: heartbeat.counts.tasks,
      countRelayAdapters: heartbeat.counts.relayAdapters,
    };
    await db
      .insert(instanceHeartbeats)
      .values(row)
      .onConflictDoUpdate({
        target: instanceHeartbeats.instanceId,
        set: {
          dorkosVersion: row.dorkosVersion,
          os: row.os,
          runtimesConfigured: row.runtimesConfigured,
          tunnelEnabled: row.tunnelEnabled,
          cloudLinked: row.cloudLinked,
          countAgents: row.countAgents,
          countTasks: row.countTasks,
          countRelayAdapters: row.countRelayAdapters,
          receivedAt: sql`now()`,
        },
      });
  } catch (error) {
    console.error('[api/telemetry/heartbeat] upsert failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
