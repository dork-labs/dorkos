/** The HTTP settings write, including confirmation for lasting access changes. */
import type { Context } from 'hono';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { isFromWifi } from '../services/core/auth/sessions/wifi-level.js';
import {
  trustStopPatchRaises,
  wifiRaiseRefusal,
} from '../services/core/auth/sessions/wifi-raise-guard.js';
import { configManager } from '../services/core/config-manager.js';
import {
  applyGuardedConfigWrite,
  refuseDedicatedConfigPaths,
  type ConfigWriteAuthority,
} from '../services/core/operator/config-write.js';
import { deepMerge, sanitizedConfigSnapshot } from '../services/core/operator/config-patch.js';
import { findOperatorOnlyPaths } from '../services/core/operator/config-write-policy.js';
import { frontDoorSubjectOf } from '../services/core/operator/front-door-settings.js';
import { frontDoorStepUpPaths } from './config-step-up-paths.js';
import { runFrontDoorWrite } from './front-door-step-up.js';
import { getAccountUsageStore } from '../services/core/usage/current-usage-store.js';
import { logger, logError } from '../lib/logger.js';

/**
 * How long a save that changed Claude Code's accounts waits for the usage store
 * to catch up before answering anyway. A reference move after a rename can be
 * slow, and the save itself has already landed.
 */
const ACCOUNT_RECONCILE_WAIT_MS = 2_000;

/**
 * The Claude Code fields that decide which accounts the usage store lists, and
 * whether `default` stands alone, as one comparable string.
 */
function claudeAccountFields(): string {
  const claudeCode = configManager.get('runtimes')?.claudeCode;
  return JSON.stringify([
    claudeCode?.accounts ?? null,
    claudeCode?.defaultAccount ?? null,
    claudeCode?.defaultAccountColor ?? null,
  ]);
}

/**
 * Wait, bounded, for the usage store to re-read the accounts after a save that
 * changed them (spec `claude-account-ui` §6.5, "Main's own row").
 *
 * The config listener in `index.ts` starts a reconcile without waiting, and it
 * can join the 60 s scan's pass, which read the config BEFORE this save. The
 * client refetches usage the moment this route answers, so answering first let
 * it read that stale list: a standalone `default` beside the row that now owns
 * its folder, for up to a minute. `fresh` waits out any pass in flight and runs
 * one that reads the saved file. A reconcile that writes config itself (moving
 * references off a renamed account) fires the listener again, which joins this
 * pass rather than starting another, so the wait cannot loop.
 *
 * Never fails the request: the save has landed, so a reconcile that throws or
 * runs past {@link ACCOUNT_RECONCILE_WAIT_MS} is logged and the route answers
 * as it would have. Without a running store there is nothing to wait for.
 */
async function awaitAccountReconcile(): Promise<void> {
  const store = getAccountUsageStore();
  if (!store) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ACCOUNT_RECONCILE_WAIT_MS);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([store.reconcileAccounts({ fresh: true }), timedOut]);
    if (outcome === 'timeout') {
      logger.warn(
        '[Config] account usage did not catch up with the save in time; answering anyway'
      );
    }
  } catch (err) {
    logger.warn('[Config] account usage reconcile after the save failed', logError(err));
  } finally {
    clearTimeout(timer);
  }
}

/** Apply a settings patch, holding lasting access changes until confirmation. */
export async function patchConfig(
  c: Context<ApiEnv>,
  authorityFor: (facts: RequestFacts) => ConfigWriteAuthority
): Promise<Response> {
  try {
    const patch = readJsonBody(c);
    // From Wi-Fi, a Files & commands stop may tighten, never loosen (DOR-3037).
    if (
      isFromWifi(honoRequestFacts(c)) &&
      trustStopPatchRaises(patch, configManager.get('runtimes'))
    ) {
      return c.json(wifiRaiseRefusal(), 403);
    }
    // The bars, the autonomy consent door, the write, and the audit line — the
    // sequence `dorkos config set` and the `config_patch` tool also run, so the
    // three doors cannot drift into meaning different things. What this route
    // adds is who the caller is and what a refusal looks like over HTTP.
    const facts = honoRequestFacts(c);
    const dedicated = refuseDedicatedConfigPaths(patch);
    if (dedicated) {
      const { status, error, code, paths, message } = dedicated;
      return c.json({ error, code, paths, message }, status as ContentfulStatusCode);
    }
    const paths = findOperatorOnlyPaths(patch);
    const refusal = paths.length > 0 ? authorityFor(facts).refuseOperatorOnly(paths) : undefined;
    if (refusal) {
      const { status, error, code, paths, message } = refusal;
      return c.json({ error, code, paths, message }, status as ContentfulStatusCode);
    }
    const run = async (confirming: RequestFacts): Promise<Response> => {
      try {
        const accountsBefore = claudeAccountFields();
        const result = applyGuardedConfigWrite({
          patch,
          authority: authorityFor(confirming),
          source: 'PATCH /api/config',
          // This route cannot say WHO is calling it, and does not pretend to. With
          // local login off — the default — the server cannot tell the app from any
          // other process running as the same user, so claiming `operator` here
          // would let an agent `curl` its own suggestion back through this door and
          // launder the stamp. `display-name-provenance.ts` carries the full
          // reasoning; the door a person's name-save actually uses is
          // `PATCH /api/profile`, which refuses agents.
          writer: { kind: 'unattributed' },
        });

        if (!result.ok) {
          if (result.kind === 'invalid') {
            return c.json(
              { error: result.error, ...(result.details && { details: result.details }) },
              400
            );
          }
          const { status, error, code, paths, message } = result.refusal;
          return c.json({ error, code, paths, message }, status as ContentfulStatusCode);
        }

        for (const warning of result.warnings) {
          logger.warn(`[Config] ${warning}`);
        }

        if (claudeAccountFields() !== accountsBefore) await awaitAccountReconcile();

        return c.json({
          success: true,
          // ## The answer is the CURATED snapshot, never the stored file (DOR-1740)
          //
          // This used to be `result.config` — everything on disk — so saving an ngrok
          // token got that token straight back in the response body, and after that
          // EVERY unrelated patch carried it too, along with `tunnel.auth`,
          // `mcp.apiKey` and `cloud.instanceToken`.
          //
          // A response body is not a private channel. It is logged by whatever sits
          // in front of the server, it lands in caches and devtools history, and when
          // a person uses DorkOS from their phone it crosses the public internet over
          // the built-in tunnel. That is the same reasoning that keeps the local MCP
          // token off `GET /api/config` and behind a POST-only reveal (see that route
          // below), and the reason the `config_patch` operator tool already answers
          // with this projection rather than the raw config. This door was the one
          // that never caught up, and it is the door the app uses.
          //
          // The projection is an ALLOWLIST (`config-disclosure.ts`), so a
          // secret-bearing field added tomorrow is withheld until somebody classifies
          // it, rather than exposed until somebody remembers to hide it. Each
          // withheld credential comes back as a boolean `…Configured` sibling, so a
          // caller can still tell that the write landed without being told what
          // landed — which `null` could not do, since it cannot be told apart from
          // "nothing is set".
          config: sanitizedConfigSnapshot(result.config),
          ...(result.warnings.length > 0 && { warnings: result.warnings }),
        });
      } catch (error) {
        return configPatchFailed(c, error);
      }
    };
    const guarded = frontDoorStepUpPaths(patch);
    if (guarded.length === 0) return await run(facts);
    const valid = UserConfigSchema.safeParse(
      deepMerge(
        configManager.getAll() as unknown as Record<string, unknown>,
        patch as Record<string, unknown>
      )
    );
    if (!valid.success) return c.json({ error: 'Check the settings and try again.' }, 400);
    return await runFrontDoorWrite(c, {
      kind: 'config.front-door',
      target: 'settings',
      input: patch,
      reason: 'Save these DorkOS access settings.',
      subject: frontDoorSubjectOf(guarded[0]!),
      run,
    });
  } catch (err) {
    return configPatchFailed(c, err);
  }
}

/** Preserve the settings route's error response during immediate and deferred writes. */
function configPatchFailed(c: Context<ApiEnv>, error: unknown): Response {
  logger.error('[Config] PATCH failed', logError(error));
  return c.json({ error: 'Internal server error' }, 500);
}
