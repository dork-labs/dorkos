import { readOriginalClaudeNativePreparationView } from '../claude-code-runtime.js';
import path from 'path';
import type { ReloadPluginsResult } from '@dorkos/shared/types';
import { ControlRequestTimeoutError } from '../sessions/bounded-control.js';
import {
  conversationTokens,
  pluginReloadIsWorthHolding,
  readCacheImpact,
} from '../messaging/plugin-reload-policy.js';
import { logger } from '../../../../lib/logger.js';

/** Execute original refreshActivatedPlugins behavior after actual runtime private-key admission. */
export async function refreshActivatedPlugins(
  ownerKey: object,
  changedProjectPath?: string
): Promise<void> {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  const before = facet.activatedPlugins.map((plugin) => plugin.path);
  // Built into locals and assigned ONCE, after every await: two refreshes can
  // overlap (boot, plus a change delivered right after it), and one that read
  // or appended to the shared list between another's awaits loaded a root
  // twice, or mistook an extension's own root for a same-named plugin.
  let packages: Array<{ type: 'local'; path: string }>;
  try {
    const { resolveDorkHome } = await import('../../../../lib/dork-home.js');
    const { listConsentedPluginNames } =
      await import('../../../marketplace/consent/global-plugin-consent.js');
    const { buildClaudeAgentSdkPluginsArray } = await import('../messaging/plugin-activation.js');
    const { logger } = await import('../../../../lib/logger.js');
    const dorkHome = resolveDorkHome();
    // Only packages a person approved (or that run nothing on their own):
    // a global package's hooks and servers start in every session (DOR-2306).
    const enabledNames = await listConsentedPluginNames(dorkHome);
    packages =
      enabledNames.length === 0
        ? []
        : await buildClaudeAgentSdkPluginsArray({
            dorkHome,
            enabledPluginNames: enabledNames,
            logger,
          });
  } catch {
    // Fail closed (DOR-2306): a refresh that cannot say which global packages
    // a person approved loads none of them, rather than keeping a list that
    // may hold one nobody approves any more.
    packages = [];
  }
  // Running global extensions' skills (DOR-2685), each from its generated
  // plugin root. Already consented: the extension's approval to run is the
  // consent, and the root holds skills only. Asked separately, so a ledger
  // that cannot be read loads no extension skills and leaves the packages
  // above as they are.
  let skillRoots: Array<{ type: 'local'; path: string }> = [];
  try {
    const { resolveDorkHome } = await import('../../../../lib/dork-home.js');
    const { extensionSkillPluginRoots } =
      await import('../../../extensions/agent-skills/running-skills-ledger.js');
    const loaded = new Set(packages.map((plugin) => path.basename(plugin.path)));
    const roots = await extensionSkillPluginRoots(resolveDorkHome(), loaded);
    skillRoots = roots.map((root) => ({ type: 'local' as const, path: root }));
  } catch {
    // Best-effort: no extension skills this time; the next refresh asks again.
  }
  facet.activatedPlugins = [...packages, ...skillRoots];

  // Hot-reload every live session so its cached command list reflects the
  // new plugin set instantly, then tell clients to re-fetch. Isolated from
  // the plugin-array swap above so a reload failure never reverts it.
  const kept = new Set(facet.activatedPlugins.map((plugin) => plugin.path));
  await facet.reloadCommandsForLiveSessions({
    mayHold: before.every((pluginPath) => kept.has(pluginPath)),
  });

  // A PROJECT-scoped install/uninstall changes which commands that project's
  // sessions report, but only sessions launched after the change see the new
  // plugin set — so drop the cwd's cached command list (and any warm-probe
  // cooldown) and let the broadcast below trigger a re-warm with the merged
  // per-cwd plugins. Runs AFTER the live-session reload, which would
  // otherwise repopulate the cache from a session still holding the old set.
  if (changedProjectPath) facet.forgetProjectCommands(changedProjectPath);

  facet.broadcastCommandsChanged();
}

/** Execute original reloadCommandsForLiveSessions behavior after actual runtime private-key admission. */
export async function reloadCommandsForLiveSessions(
  ownerKey: object,
  { mayHold }: { mayHold: boolean }
): Promise<void> {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  const reloadable = facet.sessionStore.getReloadableSessions();
  if (reloadable.length === 0) return;
  await Promise.all(
    reloadable.map(async ({ sessionId, session }) => {
      const queryObj = session.activeQuery ?? session.lastQuery;
      if (!queryObj) return;
      const contextTokens = conversationTokens(session);
      if (!mayHold) {
        // A plugin was withdrawn: never wait on the cache for it.
        try {
          await facet.cache.reloadPlugins(queryObj, session.cwd, facet.cwd);
        } catch (err) {
          logger.debug('[refreshActivatedPlugins] session hot-reload failed', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      try {
        const asked = await facet.cache.reloadPlugins(queryObj, session.cwd, facet.cwd, {
          holdOnCacheImpact: true,
          sessionId,
          ...(contextTokens !== undefined ? { contextTokens } : {}),
        });
        if (!asked.held) {
          logger.debug('[refreshActivatedPlugins] hot-reloaded session commands', {
            sessionId,
            commands: asked.commandCount,
            plugins: asked.pluginCount,
          });
          return;
        }
        const impact = asked.cacheImpact ?? readCacheImpact(undefined);
        if (pluginReloadIsWorthHolding(contextTokens)) {
          facet.pluginReloads.hold({ sessionId, impact, contextTokens });
          logger.debug('[refreshActivatedPlugins] holding a session reload', {
            sessionId,
            contextTokens,
          });
          return;
        }
        // Small enough that waiting would cost more in staleness than it
        // saves. Pay it now and say nothing.
        await facet.cache.reloadPlugins(queryObj, session.cwd, facet.cwd);
        facet.recordPaidPluginReload({
          sessionId,
          deferred: false,
          heldMs: 0,
          release: undefined,
          contextTokens,
          impact,
        });
      } catch (err) {
        // Never strand a reload (spec §risks). The ask is a SECOND control
        // round trip on a channel with a documented habit of going unanswered,
        // and a reload nobody applied is worse than a reload nobody costed —
        // so an unanswered ask falls back to exactly what this path did before
        // the check existed: one plain reload, best-effort.
        logger.debug('[refreshActivatedPlugins] cost check failed, reloading anyway', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          await facet.cache.reloadPlugins(queryObj, session.cwd, facet.cwd);
        } catch (fallbackErr) {
          logger.debug('[refreshActivatedPlugins] session hot-reload failed', {
            sessionId,
            error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          });
        }
      }
    })
  );
}

/** Execute original reloadPlugins behavior after actual runtime private-key admission. */
export async function reloadPlugins(
  ownerKey: object,
  sessionId: string
): Promise<ReloadPluginsResult | null> {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  const session = facet.sessionStore.findSession(sessionId);
  const queryObj = session?.activeQuery ?? session?.lastQuery;
  if (!queryObj) {
    logger.warn('[reloadPlugins] no query available', { sessionId });
    return null;
  }
  try {
    const contextTokens = conversationTokens(session!);
    const result = await facet.cache.reloadPlugins(queryObj, session!.cwd, facet.cwd);
    // Settled AFTER the apply landed: a reload that threw leaves the wait
    // armed, so a failed hand trigger never strands the held reload.
    const settled = facet.pluginReloads.settle(sessionId, 'hand-triggered');
    // An expensive reload is recorded whether or not a wait was running
    // (decision 8: held OR above threshold). Nothing was holding when the
    // person reloads a busy session the fan-out never reached — and that is
    // exactly the reload worth a line in the feed. Below the threshold this
    // stays silent, like every other cheap reload.
    if (!settled && pluginReloadIsWorthHolding(contextTokens)) {
      facet.recordPaidPluginReload({
        sessionId,
        deferred: false,
        heldMs: 0,
        release: 'hand-triggered',
        contextTokens,
        // Nothing asked what this reload would disturb — it was applied
        // outright — so there is nothing honest to put here.
        impact: readCacheImpact(undefined),
      });
    }
    logger.info('[reloadPlugins] plugins reloaded', {
      sessionId,
      commands: result.commandCount,
      plugins: result.pluginCount,
      errorCount: result.errorCount,
    });
    return {
      commandCount: result.commandCount,
      pluginCount: result.pluginCount,
      errorCount: result.errorCount,
    };
  } catch (err) {
    logger.error('[reloadPlugins] reload failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    // A timeout is NOT the `null` case (DOR-1301). `null` means "no query to
    // ask", which the route answers with "send a message first" — a sentence
    // that is simply false about a session whose query existed and did not
    // answer in time. Rethrown so the route can say the true thing.
    if (err instanceof ControlRequestTimeoutError) throw err;
    return null;
  }
}
