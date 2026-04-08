/**
 * `POST /api/telemetry/install` — opt-in marketplace install telemetry sink.
 *
 * Runs as a Vercel Edge Function. Validates the incoming event with Zod, then
 * inserts a single row into `marketplace_install_events` via Drizzle. There is
 * **no Redis, no queue, no background job** — the Edge runtime writes directly
 * to Neon Postgres in a single hop, and the page-level hourly ISR aggregates
 * the rows on read.
 *
 * Privacy contract:
 *   - The validated `InstallEvent` shape is the **complete** set of fields the
 *     handler is allowed to persist. Request headers (IP, cookies, user agent)
 *     are intentionally never read or stored.
 *   - All three outcomes (`success`, `failure`, `cancelled`) are inserted —
 *     failures are debugging signal for the marketplace team.
 *   - Database errors are swallowed and logged so a transient outage cannot
 *     cause a client-side retry storm or block the install pipeline. The
 *     handler always responds `200 { ok: true }` once validation passes.
 *
 * @module app/api/telemetry/install
 */

import { z } from 'zod';

import { getDb } from '@/db/client';
import { marketplaceInstallEvents } from '@/db/schema';

export const runtime = 'edge';

const MAX_NAME_LEN = 64;
const MAX_ERROR_CODE_LEN = 64;
const MAX_VERSION_LEN = 32;
const MAX_DURATION_MS = 600_000;

/**
 * Wire format for an install telemetry event posted by the DorkOS CLI.
 *
 * Adding a field here is the only way new data can land in the
 * `marketplace_install_events` table — keep this schema and the Drizzle table
 * in lockstep, and never add a header-derived or PII-shaped field.
 */
const InstallEventSchema = z.object({
  packageName: z.string().min(1).max(MAX_NAME_LEN),
  marketplace: z.string().min(1).max(MAX_NAME_LEN),
  type: z.enum(['agent', 'plugin', 'skill-pack', 'adapter']),
  outcome: z.enum(['success', 'failure', 'cancelled']),
  durationMs: z.number().int().min(0).max(MAX_DURATION_MS),
  errorCode: z.string().max(MAX_ERROR_CODE_LEN).optional(),
  installId: z.string().uuid(),
  dorkosVersion: z.string().min(1).max(MAX_VERSION_LEN),
  sourceType: z.enum(['relative-path', 'github', 'url', 'git-subdir', 'npm']),
});

type InstallEvent = z.infer<typeof InstallEventSchema>;

/**
 * Handle a telemetry POST. Returns `400` only on malformed JSON or schema
 * validation failure; all other paths (including database failures) return
 * `200` so the CLI never retries against a degraded backend.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = InstallEventSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid event', issues: parsed.error.issues }, { status: 400 });
  }

  await persistInstallEvent(parsed.data);

  return Response.json({ ok: true });
}

/**
 * Insert one validated install event into Neon Postgres.
 *
 * Errors are caught and logged so a database hiccup never propagates to the
 * client — graceful degradation is part of the privacy contract: the CLI must
 * not learn about backend health from telemetry responses.
 */
async function persistInstallEvent(event: InstallEvent): Promise<void> {
  try {
    const db = getDb();
    await db.insert(marketplaceInstallEvents).values({
      packageName: event.packageName,
      marketplace: event.marketplace,
      type: event.type,
      outcome: event.outcome,
      durationMs: event.durationMs,
      errorCode: event.errorCode ?? null,
      installId: event.installId,
      dorkosVersion: event.dorkosVersion,
      sourceType: event.sourceType,
    });
  } catch (error) {
    console.error('[api/telemetry/install] insert failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
