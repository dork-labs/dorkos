/**
 * Who chose DorkOS credits as a runtime's default, and the notices owed about
 * it (ADR `261001-000811`, spec `dorkos-account-by-default` §1).
 *
 * A runtime's default is what new work runs on when nothing more specific (a
 * session's own pick, its agent, a project rule) names an account. Credits as
 * that default is kept in `cloud.credits.defaults`, never in the runtime's own
 * `defaultAccount`, so turning credits off always returns to the person's own
 * sign-in, and flow's CLI never reads a credits folder as a runtime's account.
 *
 * Every choice records who made it:
 *
 * - `user` — a person picked credits in Runs on.
 * - `default` — a NEW link found a runtime with no working sign-in and filled
 *   that gap ({@link fillCreditsGaps}). The person is told once, with Change and
 *   Undo all, and if the runtime's own sign-in later starts working, switching
 *   back is offered once.
 *
 * What this module never does: move work onto credits because a sign-in
 * expired or ran out of usage, or arm a computer that was linked before
 * credits were a choice. Such a computer gets one dismissible offer instead
 * (`offer: 'pending'`, set by the `'0.95.0'` config migration).
 *
 * @module services/core/cloud/credits-defaults
 */
import type {
  CloudCreditsChoice,
  CloudCreditsNotice,
  CloudCreditsNoticeDismissRequest,
} from '@dorkos/shared/cloud-schemas';
import {
  CloudCreditsSettingsSchema,
  type CloudCreditsSettings,
  type UserConfig,
} from '@dorkos/shared/config-schema';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { logger } from '../../../lib/logger.js';
import { configManager } from '../config-manager.js';

/** The read/write surface of the config manager this module needs. */
export interface CreditsConfigPort {
  get<K extends keyof UserConfig>(key: K): UserConfig[K];
  set<K extends keyof UserConfig>(key: K, value: UserConfig[K]): void;
}

/** What one runtime offers this module: its type, whether it declares credits, and its sign-in. */
export interface CreditsRuntimeView {
  /** The runtime's type. */
  type: string;
  /** Its declared capabilities. */
  capabilities: Pick<RuntimeCapabilities, 'credits'>;
  /** Whether the runtime's own sign-in works right now. */
  hasWorkingSignIn: () => Promise<boolean>;
}

const EMPTY: CloudCreditsSettings = { defaults: {}, offer: 'none' };

/**
 * The stored credits settings, read tolerantly: anything unreadable is "no
 * credits default anywhere", which is the reading that spends nothing.
 *
 * @param config - Config reader (defaults to the module singleton).
 */
export function readCreditsSettings(
  config: Pick<CreditsConfigPort, 'get'> = configManager
): CloudCreditsSettings {
  try {
    const raw = (config.get('cloud') as { credits?: unknown } | undefined)?.credits;
    const parsed = CloudCreditsSettingsSchema.safeParse(raw ?? EMPTY);
    return parsed.success ? parsed.data : EMPTY;
  } catch (err) {
    logger.debug('[credits] settings unavailable', { err: String(err) });
    return EMPTY;
  }
}

/**
 * Whether new work on this runtime runs on credits by default.
 *
 * @param runtime - The runtime type.
 * @param config - Config reader.
 */
export function creditsIsDefaultFor(
  runtime: string,
  config: Pick<CreditsConfigPort, 'get'> = configManager
): boolean {
  return readCreditsSettings(config).defaults[runtime] !== undefined;
}

/** Write the settings back, keeping every other `cloud` field as stored. */
function writeCreditsSettings(config: CreditsConfigPort, next: CloudCreditsSettings): void {
  const cloud = config.get('cloud');
  config.set('cloud', { ...cloud, credits: next });
}

/**
 * A person's choice for one runtime's default: credits (`chosenBy: 'user'`), or
 * back to the runtime's own sign-in. Answering the offer either way settles it.
 *
 * @param runtime - The runtime type.
 * @param useCredits - Whether new work should run on credits by default.
 * @param config - Config reader/writer.
 */
export function setCreditsDefault(
  runtime: string,
  useCredits: boolean,
  config: CreditsConfigPort = configManager
): void {
  const current = readCreditsSettings(config);
  const defaults = { ...current.defaults };
  if (useCredits) {
    defaults[runtime] = { chosenBy: 'user', announced: true, signInReoffered: true };
  } else {
    delete defaults[runtime];
  }
  writeCreditsSettings(config, {
    defaults,
    offer: current.offer === 'pending' ? 'dismissed' : current.offer,
  });
}

/**
 * Undo every default DorkOS filled in on a link, leaving the person's own
 * picks alone: the "Undo all" on the notice.
 *
 * @param config - Config reader/writer.
 * @returns The runtimes put back on their own sign-in.
 */
export function undoFilledDefaults(config: CreditsConfigPort = configManager): string[] {
  const current = readCreditsSettings(config);
  const undone: string[] = [];
  const defaults: CloudCreditsSettings['defaults'] = {};
  for (const [runtime, choice] of Object.entries(current.defaults)) {
    if (choice.chosenBy === 'default') undone.push(runtime);
    else defaults[runtime] = choice;
  }
  if (undone.length > 0) writeCreditsSettings(config, { ...current, defaults });
  return undone;
}

/**
 * Settle one notice without changing any choice.
 *
 * @param request - Which notice.
 * @param config - Config reader/writer.
 */
export function dismissCreditsNotice(
  request: CloudCreditsNoticeDismissRequest,
  config: CreditsConfigPort = configManager
): void {
  const current = readCreditsSettings(config);
  const defaults = { ...current.defaults };
  let offer = current.offer;
  switch (request.kind) {
    case 'filled':
      for (const [runtime, choice] of Object.entries(defaults)) {
        if (!choice.announced) defaults[runtime] = { ...choice, announced: true };
      }
      break;
    case 'offer':
      if (offer === 'pending') offer = 'dismissed';
      break;
    case 'signed-in': {
      const choice = request.runtime ? defaults[request.runtime] : undefined;
      if (request.runtime && choice) {
        defaults[request.runtime] = { ...choice, signInReoffered: true };
      }
      break;
    }
  }
  writeCreditsSettings(config, { defaults, offer });
}

/**
 * Fill the gaps on a NEW link: each runtime that declares credits and has no
 * working sign-in of its own runs on credits by default, recorded as
 * `chosenBy: 'default'` and announced once.
 *
 * Called only from the link flow's approval, never at startup or by a
 * migration, so a computer linked before credits were a choice is never
 * switched over. A runtime the person already set either way is left alone,
 * as is any runtime with a working sign-in.
 *
 * @param runtimes - The registered runtimes.
 * @param config - Config reader/writer.
 * @returns The runtimes switched to credits.
 */
export async function fillCreditsGaps(
  runtimes: readonly CreditsRuntimeView[],
  config: CreditsConfigPort = configManager
): Promise<string[]> {
  const switched: string[] = [];
  for (const runtime of runtimes) {
    if (runtime.capabilities.credits === undefined) continue;
    if (readCreditsSettings(config).defaults[runtime.type] !== undefined) continue;
    // A sign-in nobody can read is not a gap DorkOS may fill with money.
    const working = await runtime.hasWorkingSignIn().catch(() => true);
    if (!working) switched.push(runtime.type);
  }
  const current = readCreditsSettings(config);
  const defaults = { ...current.defaults };
  for (const type of switched) {
    defaults[type] ??= { chosenBy: 'default', announced: false, signInReoffered: false };
  }
  // A new link settles the offer: it was owed only to links made before
  // credits were a choice.
  writeCreditsSettings(config, { defaults, offer: 'none' });
  return switched;
}

/**
 * The choices to report, without the bookkeeping.
 *
 * @param settings - The stored settings.
 */
export function creditsChoices(
  settings: CloudCreditsSettings
): Partial<Record<string, CloudCreditsChoice>> {
  return Object.fromEntries(
    Object.entries(settings.defaults).map(([runtime, choice]) => [
      runtime,
      { chosenBy: choice.chosenBy },
    ])
  );
}

/**
 * The notices the person is owed right now.
 *
 * @param settings - The stored settings.
 * @param opts - What the notices depend on.
 * @param opts.linked - Whether this computer is linked.
 * @param opts.runtimes - The registered runtimes that declare credits.
 */
export async function creditsNotices(
  settings: CloudCreditsSettings,
  opts: { linked: boolean; runtimes: readonly CreditsRuntimeView[] }
): Promise<CloudCreditsNotice[]> {
  if (!opts.linked) return [];
  const notices: CloudCreditsNotice[] = [];
  const filled = Object.entries(settings.defaults)
    .filter(([, choice]) => choice.chosenBy === 'default' && !choice.announced)
    .map(([runtime]) => runtime);
  if (filled.length > 0) notices.push({ kind: 'filled', runtimes: filled });
  const declared = opts.runtimes.filter((runtime) => runtime.capabilities.credits !== undefined);
  if (
    settings.offer === 'pending' &&
    Object.keys(settings.defaults).length === 0 &&
    declared.length > 0
  ) {
    notices.push({ kind: 'offer' });
  }
  for (const [type, choice] of Object.entries(settings.defaults)) {
    // Only after the person has seen that DorkOS made the choice, so two
    // notices about one runtime never stand at once.
    if (choice.chosenBy !== 'default' || !choice.announced || choice.signInReoffered) continue;
    const runtime = declared.find((candidate) => candidate.type === type);
    if (!runtime) continue;
    // A sign-in nobody can read is not offered back as working.
    const working = await runtime.hasWorkingSignIn().catch(() => false);
    if (working) notices.push({ kind: 'signed-in', runtime: type });
  }
  return notices;
}
