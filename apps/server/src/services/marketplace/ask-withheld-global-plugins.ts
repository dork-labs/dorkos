/**
 * Ask a person about the globally installed packages that are held back from
 * every session because nobody approved them as they are now (DOR-2306), and
 * say plainly what is held back and why.
 *
 * `global-plugin-consent.ts` decides what loads; this module is the other half:
 *
 * - {@link askAboutWithheldGlobalPlugins} raises one approval card for each
 *   held-back package that has never been answered, at boot and after every
 *   global package change. A yes records the approval and hands the refresh
 *   back to the caller; a no is recorded as a refusal, which lasts until the
 *   package changes or the person decides again; an expired card records
 *   nothing.
 * - {@link reviewHeldBackPackage} raises that card again on request: the
 *   Installed view's Review button and a refused package the person wants to
 *   reconsider.
 * - {@link listHeldBackPackages} says what is held back, why, and what can be
 *   done, for `GET /api/marketplace/held-back`, the Installed rows, the CLI,
 *   and the startup notice.
 * - {@link decideHeldBackPackage} records a decision made in the terminal
 *   (`dorkos marketplace held-back --allow|--refuse`), bound to the content
 *   hash the terminal showed.
 *
 * Cards are bound to the package's content hash as well as what it declares,
 * and the grant is re-checked against the tree before it is recorded: a
 * package that changed while the card was open is not approved by it. There
 * is at most one open card per package NAME, and a package that keeps changing
 * raises at most one card per {@link CARD_COOLDOWN_MS}, so churning a package
 * cannot bury a person in cards.
 *
 * A package whose declarations cannot be read, or whose list is too long for
 * a card, is never put on one: what cannot be shown in full cannot be
 * approved. The terminal can show a long list, so `--allow` works there.
 *
 * @module services/marketplace/ask-withheld-global-plugins
 */
import { APPROVAL_DETAIL_MAX_LENGTH } from '@dorkos/shared/approval-schemas';
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import type { HeldBackPackage, HeldBackState } from '@dorkos/shared/marketplace-schemas';
import type { ApprovalBinding } from '../core/approvals/approval-service.js';
import { hashApprovalInput, quoteSummaryValue } from '../core/approvals/index.js';
import type { HookApprovalGateway } from '../harness/hook-approval.js';
import { logger } from '../../lib/logger.js';
import { describeEffectsInFull, type DisclosedEffects } from './disclosed-effects.js';
import {
  forgetRefusal,
  partitionGlobalPlugins,
  readActivationState,
  recordGlobalActivationApproval,
  recordGlobalActivationRefusal,
  type WithheldGlobalPlugin,
} from './global-plugin-consent.js';
import { readInstallMetadata } from './installed-metadata.js';

/**
 * What the card calls this. Not something an agent can invoke: it names the
 * decision on the card, the stored row and the audit trail, as
 * `harness.project_hooks` does for project hooks.
 */
export const GLOBAL_ACTIVATION_CAPABILITY_ID = 'marketplace.activate_global_plugin';

/** The card's title. */
export const GLOBAL_ACTIVATION_CAPABILITY_TITLE =
  'Let a globally installed package run programs in every session';

/** At most one card per package per this long, unless a person asks for one. */
export const CARD_COOLDOWN_MS = 10 * 60_000;

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

/** Where a held-back package came from, as its install record says. */
interface Origin {
  version?: string;
  source?: string;
}

/** The version and source an install recorded, when it recorded them. */
async function originOf(packageDir: string): Promise<Origin> {
  const metadata = await readInstallMetadata(packageDir).catch(() => null);
  if (!metadata) return {};
  const source = metadata.installedFrom ?? metadata.sourceRepo;
  return {
    ...(metadata.version && { version: metadata.version }),
    ...(source && { source }),
  };
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
 * Every line of the card's detail: why it is asked, the version and source,
 * and what the package runs, written out whole.
 *
 * @param plugin - The held-back package.
 * @param origin - Its recorded version and source.
 * @returns The detail text.
 */
export function describeGlobalActivationInFull(
  plugin: Pick<WithheldGlobalPlugin, 'changedSinceApproval'> & { effects: DisclosedEffects },
  origin: Origin
): string {
  return [
    plugin.changedSinceApproval
      ? 'Its files changed since it was last approved. DorkOS cannot tell who changed them.'
      : 'Nobody has approved it as it is now, so it is held back from every session.',
    `Version ${JSON.stringify(origin.version ?? 'not recorded')}, from ${JSON.stringify(origin.source ?? 'a source that was not recorded')}.`,
    '',
    ...describeEffectsInFull(plugin.effects, 'in every session'),
  ].join('\n');
}

/** Package names with a card open right now. */
const askingNow = new Set<string>();

/** When each package name last had a card raised. */
const lastAsked = new Map<string, number>();

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
  /** The clock the cooldown reads. */
  now: (): number => Date.now(),
  /** Drop the open-card and cooldown memory, so one test cannot answer for the next. */
  forget: (): void => {
    askingNow.clear();
    lastAsked.clear();
  },
};

/** A held-back package that can be put on a card. */
type Askable = WithheldGlobalPlugin & { effects: DisclosedEffects; contentHash: string };

/**
 * Ask a person about one held-back package, wait for the answer, and record
 * it only if the package is still exactly what the card showed.
 *
 * @returns True only when a person granted it and it was recorded.
 */
async function askForGlobalActivation(
  gateway: HookApprovalGateway,
  plugin: Askable,
  origin: Origin
): Promise<boolean> {
  const binding: ApprovalBinding = {
    capabilityId: GLOBAL_ACTIVATION_CAPABILITY_ID,
    // Bound to the same facts the stored entry digests, so a card granted for
    // one package's bytes can never be spent on another's.
    inputHash: hashApprovalInput({
      packageName: plugin.name,
      effects: plugin.effects,
      contentHash: plugin.contentHash,
    }),
  };
  const ticket = gateway.request({
    ...binding,
    summary: summariseGlobalActivation(plugin.name, plugin.effects),
    detail: describeGlobalActivationInFull(plugin, origin),
  });
  logger.info('[Marketplace] Waiting on a person to allow a global package in every session', {
    packageName: plugin.name,
    approvalId: ticket.approvalId,
  });

  const deadline = new Date(ticket.expiresAt).getTime();
  for (;;) {
    const result = gateway.consume(ticket.token, binding);
    if (result.outcome === 'granted') {
      // The card was about these bytes. If the package changed while it was
      // open, this yes covers nothing on disk now: it asks again next time.
      const now = await readActivationState(plugin.packageDir);
      if ('unreadable' in now || now.contentHash !== plugin.contentHash) return false;
      recordGlobalActivationApproval(plugin.name, plugin.effects, plugin.contentHash);
      return true;
    }
    if (result.outcome !== 'pending') {
      if (result.outcome === 'denied') {
        recordGlobalActivationRefusal(plugin.name, plugin.effects, plugin.contentHash);
      }
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

/** Whether a held-back package's full list fits on one card. */
function fitsOnCard(plugin: Askable, origin: Origin): boolean {
  return describeGlobalActivationInFull(plugin, origin).length <= APPROVAL_DETAIL_MAX_LENGTH;
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
 * Raise one card, fire and forget, and release the package's card slot when
 * it is answered or expires.
 */
function raiseCard(
  opts: AskAboutWithheldGlobalPluginsOptions,
  plugin: Askable,
  origin: Origin
): Promise<void> {
  askingNow.add(plugin.name);
  lastAsked.set(plugin.name, _internal.now());
  return askForGlobalActivation(opts.approvals, plugin, origin)
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
      askingNow.delete(plugin.name);
    });
}

/**
 * Raise one card for every held-back package nobody has answered, and record
 * each answer. Resolves once every card it raised is answered or expired;
 * callers fire it without waiting.
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
    if (plugin.reason !== 'unasked' || !plugin.effects || !plugin.contentHash) continue;
    if (askingNow.has(plugin.name)) continue;
    const last = lastAsked.get(plugin.name);
    if (last !== undefined && _internal.now() - last < CARD_COOLDOWN_MS) continue;
    const askable: Askable = {
      ...plugin,
      effects: plugin.effects,
      contentHash: plugin.contentHash,
    };
    const origin = await originOf(plugin.packageDir);
    if (!fitsOnCard(askable, origin)) {
      logger.warn(
        '[Marketplace] A global package runs too much to list on one card; it stays held back',
        { packageName: plugin.name }
      );
      continue;
    }
    asks.push(raiseCard(opts, askable, origin));
  }
  await Promise.all(asks);
}

/** Why {@link reviewHeldBackPackage} could not raise a card. */
export class HeldBackReviewError extends Error {
  /**
   * Build the error.
   *
   * @param reason - One plain sentence saying why and what to do instead.
   */
  constructor(reason: string) {
    super(reason);
    this.name = 'HeldBackReviewError';
  }
}

/**
 * Raise the card for one held-back package now, because a person asked:
 * ignores the cooldown, and lets a refused package be decided again.
 *
 * @param opts - Where to look, how to ask, and what to do after a yes.
 * @param name - The package's directory name.
 * @returns Once the card is raised (the answer arrives later).
 * @throws {HeldBackReviewError} When it is not held back, or cannot be shown
 *   on a card; the message says why and what to do instead.
 */
export async function reviewHeldBackPackage(
  opts: AskAboutWithheldGlobalPluginsOptions,
  name: string
): Promise<void> {
  const { withheld } = await partitionGlobalPlugins(opts.dorkHome);
  const plugin = withheld.find((w) => w.name === name);
  if (!plugin) throw new HeldBackReviewError(`${name} is not held back.`);
  const state = heldBackStateOf(plugin, await originOf(plugin.packageDir));
  if (!state.reviewable || !plugin.effects || !plugin.contentHash) {
    throw new HeldBackReviewError(state.note);
  }
  if (askingNow.has(name)) return;
  if (plugin.reason === 'refused') forgetRefusal(name, plugin.effects, plugin.contentHash);
  const askable: Askable = { ...plugin, effects: plugin.effects, contentHash: plugin.contentHash };
  void raiseCard(opts, askable, await originOf(plugin.packageDir));
}

/**
 * What a person needs to know about one held-back package, in one sentence.
 *
 * @param plugin - The held-back package.
 * @param origin - Its recorded version and source.
 */
function heldBackStateOf(plugin: WithheldGlobalPlugin, origin: Origin): HeldBackState {
  switch (plugin.reason) {
    case 'unreadable':
      return {
        reason: 'unreadable',
        reviewable: false,
        note:
          `Held back: DorkOS could not read part of it (${(plugin.unreadable ?? []).join(', ')}), ` +
          'so it cannot show you what it runs. Reinstall it, or uninstall it.',
      };
    case 'unreadable-config':
      return {
        reason: 'unreadable-config',
        reviewable: false,
        note:
          'Held back: DorkOS could not read your settings file, so it cannot tell what you ' +
          'approved. Fix ~/.dork/config.json first.',
      };
    case 'refused':
      return {
        reason: 'refused',
        reviewable: true,
        note: 'Held back: you turned it down. Review it to decide again.',
      };
    case 'unasked': {
      const askable =
        plugin.effects && plugin.contentHash
          ? fitsOnCard(
              { ...plugin, effects: plugin.effects, contentHash: plugin.contentHash },
              origin
            )
          : false;
      const why = plugin.changedSinceApproval
        ? 'its files changed since you approved it'
        : 'you have not approved it as it is now';
      return askable
        ? { reason: 'unasked', reviewable: true, note: `Held back: ${why}. Review it to decide.` }
        : {
            reason: 'unasked',
            reviewable: false,
            note:
              `Held back: ${why}, and it runs too much to show on one card. Review it in a ` +
              `terminal with \`dorkos marketplace held-back --allow ${plugin.name}\`.`,
          };
    }
  }
}

/**
 * Every held-back global package, with why, what it runs, and the content hash
 * a decision about it binds.
 *
 * @param dorkHome - The resolved DorkOS data directory.
 * @returns One entry per held-back package, in scan order.
 */
export async function listHeldBackPackages(dorkHome: string): Promise<HeldBackPackage[]> {
  const { withheld } = await partitionGlobalPlugins(dorkHome);
  return Promise.all(
    withheld.map(async (plugin) => {
      const origin = await originOf(plugin.packageDir);
      return {
        name: plugin.name,
        ...heldBackStateOf(plugin, origin),
        ...origin,
        changedSinceApproval: plugin.changedSinceApproval === true,
        ...(plugin.effects && { effects: plugin.effects }),
        ...(plugin.contentHash && { contentHash: plugin.contentHash }),
      };
    })
  );
}

/** Why {@link decideHeldBackPackage} did not record a decision. */
export class HeldBackDecisionError extends Error {
  /**
   * Build the error.
   *
   * @param reason - One plain sentence saying why.
   */
  constructor(reason: string) {
    super(reason);
    this.name = 'HeldBackDecisionError';
  }
}

/**
 * Record a person's decision about one held-back package, made after seeing
 * it somewhere other than a card (the terminal). Bound to the content hash
 * they were shown: a package that changed since is not decided by it.
 *
 * @param dorkHome - The resolved DorkOS data directory.
 * @param name - The package's directory name.
 * @param decision - `allow` or `refuse`.
 * @param contentHash - The content hash the person was shown.
 * @throws {HeldBackDecisionError} When it is not held back, cannot be read, or
 *   changed since it was shown.
 */
export async function decideHeldBackPackage(
  dorkHome: string,
  name: string,
  decision: 'allow' | 'refuse',
  contentHash: string
): Promise<void> {
  const { withheld } = await partitionGlobalPlugins(dorkHome);
  const plugin = withheld.find((w) => w.name === name);
  if (!plugin) throw new HeldBackDecisionError(`${name} is not held back.`);
  if (!plugin.effects || !plugin.contentHash || plugin.reason === 'unreadable-config') {
    throw new HeldBackDecisionError(heldBackStateOf(plugin, {}).note);
  }
  if (plugin.contentHash !== contentHash) {
    throw new HeldBackDecisionError(
      `${name} changed since it was shown to you, so nothing was recorded. Look at it again.`
    );
  }
  if (decision === 'allow') {
    recordGlobalActivationApproval(name, plugin.effects, plugin.contentHash);
  } else {
    recordGlobalActivationRefusal(name, plugin.effects, plugin.contentHash);
  }
}
