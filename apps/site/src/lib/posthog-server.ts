/**
 * Server-side PostHog operations for identified accounts (ADR 260713-143958
 * Phase 4, Tier 2). Two seams live here, both server-only and both best-effort:
 *
 * 1. {@link aliasInstanceToAccount} — the **device-link merge point**. When a
 *    signed-in account links a DorkOS instance, this stitches the instance's
 *    anonymous app-telemetry history (keyed by the app's per-install
 *    `instanceId`) into the account person, so one PostHog person spans the
 *    site visitor, the app instance, and the account. Emitted as a
 *    `$create_alias` event through the same `/batch/` fan-out the owned-ingest
 *    route uses (the write-only project key), so no vendor SDK runs server-side.
 *
 * 2. {@link deletePostHogPerson} — the **DSR erasure hook**. On account
 *    deletion, this erases the account's PostHog person (and, because a merged
 *    person shares all its distinct ids, the merged app-telemetry data with it).
 *    Uses the *personal* API key + numeric project id; skips gracefully (logged,
 *    never thrown) when unconfigured, so account erasure never depends on
 *    PostHog being reachable.
 *
 * Both swallow and log their errors: the account actions they hang off
 * (device-link token exchange, account deletion) must never fail because
 * PostHog is down.
 *
 * This module deliberately mirrors (does not import) the `/batch/` fan-out shape
 * in `app/api/telemetry/events/route.ts` — that route is an Edge function with
 * a route-local schema, and this is a Node server module; keeping them separate
 * avoids coupling the two runtimes. Any change to the batch envelope should move
 * in lockstep with that route.
 *
 * @module lib/posthog-server
 */
import { env } from '@/env';
import { deriveUiHost } from '@/lib/posthog-host';

/** The batch-capture endpoint on the region ingest host (`<host>/batch/`). */
function batchCaptureUrl(): string {
  return `${env.NEXT_PUBLIC_POSTHOG_HOST.replace(/\/+$/, '')}/batch/`;
}

/**
 * Per-request cap on every PostHog call here (ms). Both callers sit inside
 * latency-sensitive auth flows (the `/device/token` after-hook and the
 * account-deletion `afterDelete` hook), so a hanging PostHog must abort fast
 * rather than eat the Vercel function's time budget — the surrounding catch
 * absorbs the resulting AbortError like any other failure.
 */
const POSTHOG_TIMEOUT_MS = 3000;

/**
 * Merge an app instance's anonymous telemetry history into an account person by
 * emitting a server-side `$create_alias` (previous `instanceId` → account UUID).
 *
 * No-ops (silently, zero requests) when the project key is unset **or** no
 * telemetry instance id is present — the merge is only meaningful once the app
 * threads its anonymous per-install id through the device-link descriptor, which
 * is the app-side signal that it has identified-telemetry opt-in for that
 * instance. Errors are swallowed and logged; a merge failure must never fail the
 * device-link token exchange.
 *
 * PostHog merge semantics: after this alias, the account UUID and the app
 * `instanceId` are the **same** person, so a later {@link deletePostHogPerson}
 * for the account UUID erases both distinct ids' data together.
 *
 * @param args.telemetryInstanceId - The app's anonymous per-install `instanceId`
 *   (the distinct id its anonymous telemetry is captured under), or undefined
 *   when the linking instance did not send one (the merge is then skipped).
 * @param args.accountId - The Better Auth account UUID (the identified person).
 */
export async function aliasInstanceToAccount(args: {
  telemetryInstanceId: string | undefined;
  accountId: string;
}): Promise<void> {
  const apiKey = env.POSTHOG_PROJECT_KEY;
  const { telemetryInstanceId, accountId } = args;
  // Skip when unconfigured, when the app did not send a telemetry id (nothing to
  // merge), or in the degenerate case the two ids coincide.
  if (!apiKey || !telemetryInstanceId || telemetryInstanceId === accountId) return;

  try {
    await fetch(batchCaptureUrl(), {
      method: 'POST',
      signal: AbortSignal.timeout(POSTHOG_TIMEOUT_MS),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        historical_migration: false,
        batch: [
          {
            event: '$create_alias',
            // The merge target is the identified account; `alias` is the prior
            // anonymous app-telemetry distinct id being folded into it.
            distinct_id: accountId,
            properties: {
              alias: telemetryInstanceId,
              $lib: 'dorkos-owned-ingest',
            },
          },
        ],
      }),
    });
  } catch (error) {
    console.error('[lib/posthog-server] alias merge failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** One person row from the PostHog persons list API (only the id is used). */
interface PostHogPerson {
  id: string;
}

/**
 * Erase an account's PostHog person for a data-subject deletion request.
 *
 * Two steps against the PostHog persons REST API (personal API key, numeric
 * project id): look the person up by `distinct_id`, then `DELETE` it with
 * `delete_events=true` so their captured events are erased too. Because a
 * device-link merge makes the account UUID and the app `instanceId` one person,
 * this single delete removes the merged app-telemetry data as well.
 *
 * Graceful degrade — this NEVER throws. When the personal key or project id is
 * unset, it logs a skip line and returns (a missing analytics-erasure key must
 * never block a user's right to erasure). When no person exists (the account
 * never opted in / was never identified), there is nothing to delete and it
 * returns quietly. Any API error is swallowed and logged so the failure is
 * visible without blocking the account deletion it hangs off.
 *
 * @param distinctId - The account's distinct id (its Better Auth UUID).
 */
export async function deletePostHogPerson(distinctId: string): Promise<void> {
  const personalKey = env.POSTHOG_PERSONAL_API_KEY;
  const projectId = env.POSTHOG_PROJECT_ID;
  if (!personalKey || !projectId) {
    console.info(
      '[lib/posthog-server] POSTHOG_PERSONAL_API_KEY/POSTHOG_PROJECT_ID unset — skipping PostHog person erasure'
    );
    return;
  }

  const apiBase = `${deriveUiHost(env.NEXT_PUBLIC_POSTHOG_HOST)}/api/projects/${encodeURIComponent(
    projectId
  )}/persons`;
  const authHeader = { authorization: `Bearer ${personalKey}` };

  try {
    // 1. Resolve the person's internal id from its distinct id.
    const lookup = await fetch(`${apiBase}/?distinct_id=${encodeURIComponent(distinctId)}`, {
      headers: authHeader,
      signal: AbortSignal.timeout(POSTHOG_TIMEOUT_MS),
    });
    if (!lookup.ok) {
      console.error('[lib/posthog-server] person lookup failed', { status: lookup.status });
      return;
    }
    const body = (await lookup.json()) as { results?: PostHogPerson[] };
    const personId = body.results?.[0]?.id;
    if (!personId) {
      // No identified person for this account (never consented) — nothing to erase.
      console.info('[lib/posthog-server] no PostHog person for deleted account — nothing to erase');
      return;
    }

    // 2. Delete the person and their events (async on PostHog's side).
    const del = await fetch(`${apiBase}/${encodeURIComponent(personId)}/?delete_events=true`, {
      method: 'DELETE',
      headers: authHeader,
      signal: AbortSignal.timeout(POSTHOG_TIMEOUT_MS),
    });
    if (!del.ok) {
      console.error('[lib/posthog-server] person delete failed', { status: del.status });
    }
  } catch (error) {
    console.error('[lib/posthog-server] person erasure errored', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
