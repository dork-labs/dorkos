/**
 * Ask a person about the globally installed packages that are left out of
 * every session because nobody has approved what they run (DOR-2306).
 *
 * `global-plugin-consent.ts` decides what loads; this module is the other half:
 * for each package withheld as `unasked`, one approval card listing everything
 * it runs, and the answer recorded. A yes records the approval and hands the
 * refresh back to the caller (`onGranted`), so the package loads into sessions
 * straight away; a no is recorded as a refusal, which lasts until the package
 * changes what it runs or `dorkos harness hooks --revoke <name>`; nobody
 * deciding before the card expires records nothing, and the person is asked
 * again at the next start or package change.
 *
 * It runs at boot and after every package change, fire-and-forget: a card can
 * stay open for the whole approval window, and nothing waits on it.
 *
 * A package whose declarations cannot be read, or whose list of programs is too
 * long for a card, is never put in front of a person: what cannot be shown in
 * full cannot be approved. It stays withheld and the server log says why.
 *
 * @module services/marketplace/ask-withheld-global-plugins
 */
import { APPROVAL_DETAIL_MAX_LENGTH } from '@dorkos/shared/approval-schemas';
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import type { ApprovalBinding } from '../core/approvals/approval-service.js';
import { hashApprovalInput, quoteSummaryValue } from '../core/approvals/index.js';
import type { HookApprovalGateway } from '../harness/hook-approval.js';
import { logger } from '../../lib/logger.js';
import { describeEffectsInFull, type DisclosedEffects } from './disclosed-effects.js';
import {
  globalActivationEntry,
  partitionGlobalPlugins,
  recordGlobalActivationApproval,
  recordGlobalActivationRefusal,
  type WithheldGlobalPlugin,
} from './global-plugin-consent.js';

/**
 * What the card calls this. Not something an agent can invoke: it names the
 * decision on the card, the stored row and the audit trail, as
 * `harness.project_hooks` does for project hooks.
 */
export const GLOBAL_ACTIVATION_CAPABILITY_ID = 'marketplace.activate_global_plugin';

/** The card's title. */
export const GLOBAL_ACTIVATION_CAPABILITY_TITLE =
  'Let a globally installed package run programs in every session';

/**
 * Describe {@link GLOBAL_ACTIVATION_CAPABILITY_ID} for an approval card.
 * `destructive`, because that is what the tier means to a person reading the
 * card: a program that starts in every session needs a decision.
 *
 * @param capabilityId - The id `ApprovalService` is resolving.
 * @returns The descriptor, or `undefined` for any other id.
 */
export function describeGlobalActivationCapability(
  capabilityId: string
): { title: string; tier: CapabilityTier } | undefined {
  if (capabilityId !== GLOBAL_ACTIVATION_CAPABILITY_ID) return undefined;
  return { title: GLOBAL_ACTIVATION_CAPABILITY_TITLE, tier: 'destructive' };
}

/** How many things a package runs, for the card's one sentence. */
function countOf(effects: DisclosedEffects): number {
  return (
    effects.hooks.length +
    effects.mcpServers.length +
    effects.lspServers.length +
    effects.monitors.length +
    effects.executables.length +
    effects.skillTools.length
  );
}

/**
 * The card's one sentence. The package name is quoted, escaped and capped, so
 * a name carrying its own quotes cannot forge the rest of it; the full list is
 * the card's detail.
 *
 * @param name - The package's directory name.
 * @param effects - What it runs.
 * @returns One plain sentence.
 */
export function summariseGlobalActivation(name: string, effects: DisclosedEffects): string {
  const count = countOf(effects);
  return (
    `Let the globally installed package ${quoteSummaryValue(name)} run ` +
    `${count === 1 ? '1 program or command' : `${count} programs and commands`} in every ` +
    'session. Everything it runs is listed below.'
  );
}

/**
 * Every line of the card's detail: what the package runs, written out whole.
 *
 * @param effects - What it runs.
 * @returns The detail text.
 */
export function describeGlobalActivationInFull(effects: DisclosedEffects): string {
  return describeEffectsInFull(effects, 'in every session').join('\n');
}

/** Entries with a card open right now, so two triggers never raise two cards. */
const askingNow = new Set<string>();

/** Seams the wait loop uses, injectable so tests do not sleep in real time. */
export const _internal = {
  /** Pause between presentations of a pending token. */
  sleep: (ms: number): Promise<void> =>
    new Promise((resolve) => {
      // Unref'd: a pending card must never keep a CLI-embedded server alive.
      setTimeout(resolve, ms).unref?.();
    }),
  /** How long to wait between presentations. */
  pollIntervalMs: 5_000,
  /** Drop the open-card memory, so one test cannot answer for the next. */
  forget: (): void => {
    askingNow.clear();
  },
};

/**
 * Ask a person about one withheld package, wait for the answer, and record it.
 *
 * Fails closed on every path that is not an explicit yes. Only an explicit no
 * is recorded as a refusal; an expired card means nobody decided.
 *
 * @param gateway - The approval primitive.
 * @param plugin - The withheld package and what it runs.
 * @returns True only when a person granted it.
 */
async function askForGlobalActivation(
  gateway: HookApprovalGateway,
  plugin: WithheldGlobalPlugin & { effects: DisclosedEffects }
): Promise<boolean> {
  const binding: ApprovalBinding = {
    capabilityId: GLOBAL_ACTIVATION_CAPABILITY_ID,
    // Bound to the same facts the stored entry digests, so a card granted for
    // one set of programs can never be spent on another.
    inputHash: hashApprovalInput({ packageName: plugin.name, effects: plugin.effects }),
  };
  const ticket = gateway.request({
    ...binding,
    summary: summariseGlobalActivation(plugin.name, plugin.effects),
    detail: describeGlobalActivationInFull(plugin.effects),
  });
  logger.info('[Marketplace] Waiting on a person to allow a global package in every session', {
    packageName: plugin.name,
    approvalId: ticket.approvalId,
  });

  const deadline = new Date(ticket.expiresAt).getTime();
  for (;;) {
    const result = gateway.consume(ticket.token, binding);
    if (result.outcome === 'granted') {
      recordGlobalActivationApproval(plugin.name, plugin.effects);
      return true;
    }
    if (result.outcome !== 'pending') {
      if (result.outcome === 'denied') recordGlobalActivationRefusal(plugin.name, plugin.effects);
      logger.info('[Marketplace] A global package was not allowed in every session', {
        packageName: plugin.name,
        outcome: result.outcome,
      });
      return false;
    }
    // A finite deadline as well as the primitive's own expiry, so a clock the
    // store disagrees with cannot turn this into a loop that never ends.
    if (Number.isFinite(deadline) && Date.now() > deadline) return false;
    await _internal.sleep(_internal.pollIntervalMs);
  }
}

/** What {@link askAboutWithheldGlobalPlugins} needs from its caller. */
export interface AskAboutWithheldGlobalPluginsOptions {
  /** The resolved DorkOS data directory. */
  dorkHome: string;
  /** The approval primitive that raises the cards and reports the answers. */
  approvals: HookApprovalGateway;
  /** Called after each yes is recorded: reload the plugins sessions get. */
  onGranted: () => Promise<void> | void;
}

/**
 * Raise one card for every global package withheld because nobody was asked,
 * and record each answer. Resolves once every card it raised is answered or
 * expired; callers fire it without waiting.
 *
 * @param opts - Where to look, how to ask, and what to do after a yes.
 */
export async function askAboutWithheldGlobalPlugins(
  opts: AskAboutWithheldGlobalPluginsOptions
): Promise<void> {
  const { withheld } = await partitionGlobalPlugins(opts.dorkHome);
  const asks: Promise<void>[] = [];
  for (const plugin of withheld) {
    if (plugin.reason === 'unreadable' || plugin.reason === 'unreadable-config') {
      logger.warn('[Marketplace] A global package is held back and cannot be approved as it is', {
        packageName: plugin.name,
        reason: plugin.reason,
        ...(plugin.unreadable && { unreadable: plugin.unreadable }),
        ...(plugin.configProblem && { configProblem: plugin.configProblem }),
      });
      continue;
    }
    if (plugin.reason !== 'unasked' || !plugin.effects) continue;
    const effects = plugin.effects;
    if (describeGlobalActivationInFull(effects).length > APPROVAL_DETAIL_MAX_LENGTH) {
      logger.warn(
        '[Marketplace] A global package runs too much to list on one card, so it stays held back',
        { packageName: plugin.name }
      );
      continue;
    }
    const entry = globalActivationEntry(plugin.name, effects);
    if (askingNow.has(entry)) continue;
    askingNow.add(entry);
    asks.push(
      askForGlobalActivation(opts.approvals, { ...plugin, effects })
        .then(async (granted) => {
          if (granted) await opts.onGranted();
        })
        .catch((err: unknown) => {
          logger.warn('[Marketplace] Asking about a global package failed; it stays held back', {
            packageName: plugin.name,
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          askingNow.delete(entry);
        })
    );
  }
  await Promise.all(asks);
}
