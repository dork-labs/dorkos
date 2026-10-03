/**
 * Who chose DorkOS credits for a runtime, which agents a person allowed onto
 * them, and the notices owed about choices DorkOS made (ADR `261001-000811`,
 * spec `dorkos-account-by-default` §1).
 *
 * A runtime's default is what new work runs on when nothing more specific (a
 * session's own pick, its agent) names an account; a project rule can block
 * credits but never chooses them. The choice is kept in
 * `cloud.credits.defaults`, never in the runtime's own `defaultAccount`, so
 * turning credits off always returns to the person's own sign-in, and flow's
 * CLI never reads a credits folder as a runtime's account.
 *
 * Every record says what the runtime runs on and who chose it:
 *
 * - `credits` + `user` — a person picked credits in Runs on.
 * - `own-sign-in` + `user` — a person said no (turned credits off, or undid
 *   what DorkOS chose). Nothing ever overrides it.
 * - `credits` + `default` — a NEW link found a runtime with no sign-in at all
 *   and filled that gap ({@link fillCreditsGaps}). The person is told once, with
 *   Change and Undo all, and if the runtime's own sign-in later starts working,
 *   switching back is offered once.
 *
 * What this module never does: fill a gap that already has a record, treat an
 * expired or out-of-usage sign-in as a gap (that sign-in needs attention, not
 * replacing), or arm a computer that was linked before credits were a choice
 * (it gets one dismissible offer instead, set by the `'0.96.0'` migration).
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
import type { RuntimeCapabilities, RuntimeSignInState } from '@dorkos/shared/agent-runtime';
import { logger } from '../../../lib/logger.js';
import { configManager } from '../config-manager.js';

/** The read/write surface of the config manager this module needs. */
export interface CreditsConfigPort {
  get<K extends keyof UserConfig>(key: K): UserConfig[K];
  set<K extends keyof UserConfig>(key: K, value: UserConfig[K]): void;
}

/** Where a runtime's own sign-in stands (`deriveRuntimeSignIn` in `@dorkos/shared/agent-runtime`). */
export type { RuntimeSignInState } from '@dorkos/shared/agent-runtime';

/** What one runtime offers this module: its type, whether it declares credits, and its sign-in. */
export interface CreditsRuntimeView {
  /** The runtime's type. */
  type: string;
  /** Its declared capabilities. */
  capabilities: Pick<RuntimeCapabilities, 'credits'>;
  /** Where the runtime's own sign-in stands right now. */
  signIn: () => Promise<RuntimeSignInState>;
}

const EMPTY: CloudCreditsSettings = { defaults: {}, offer: 'none', agents: [], linkedTo: null };

/**
 * The stored credits settings, read tolerantly: anything unreadable is "no
 * credits anywhere", which is the reading that spends nothing.
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
  return readCreditsSettings(config).defaults[runtime]?.runsOn === 'credits';
}

/**
 * Whether a person allowed this agent onto credits in the app. An agent's
 * file naming credits counts only then.
 *
 * @param agentId - The agent's id, or `undefined` for none.
 * @param config - Config reader.
 */
export function creditsAllowedForAgent(
  agentId: string | undefined,
  config: Pick<CreditsConfigPort, 'get'> = configManager
): boolean {
  return agentId !== undefined && readCreditsSettings(config).agents.includes(agentId);
}

/** Write the settings back, keeping every other `cloud` field as stored. */
function writeCreditsSettings(config: CreditsConfigPort, next: CloudCreditsSettings): void {
  const cloud = config.get('cloud');
  config.set('cloud', { ...cloud, credits: next });
}

/**
 * A person's choice for one runtime's default: credits, or the runtime's own
 * sign-in. Both are recorded as the person's, so a later new link never
 * overrides either. Answering the offer either way settles it.
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
  writeCreditsSettings(config, {
    ...current,
    defaults: {
      ...current.defaults,
      [runtime]: {
        runsOn: useCredits ? 'credits' : 'own-sign-in',
        chosenBy: 'user',
        announced: true,
        signInReoffered: true,
      },
    },
    offer: current.offer === 'pending' ? 'dismissed' : current.offer,
  });
}

/**
 * Allow or stop one agent running on credits, a person's decision made in the
 * app (never read from the agent's own file).
 *
 * @param agentId - The agent's id.
 * @param allowed - Whether its file may put it on credits.
 * @param config - Config reader/writer.
 */
export function setCreditsAllowedForAgent(
  agentId: string,
  allowed: boolean,
  config: CreditsConfigPort = configManager
): void {
  const current = readCreditsSettings(config);
  const has = current.agents.includes(agentId);
  if (has === allowed) return;
  writeCreditsSettings(config, {
    ...current,
    agents: allowed ? [...current.agents, agentId] : current.agents.filter((id) => id !== agentId),
  });
}

/**
 * Undo every choice DorkOS made on a link: the "Undo all". Each becomes the
 * person's own "no", so it is not filled again.
 *
 * @param config - Config reader/writer.
 * @returns The runtimes put back on their own sign-in.
 */
export function undoFilledDefaults(config: CreditsConfigPort = configManager): string[] {
  const current = readCreditsSettings(config);
  const undone: string[] = [];
  const defaults = { ...current.defaults };
  for (const [runtime, choice] of Object.entries(current.defaults)) {
    if (choice.chosenBy !== 'default' || choice.runsOn !== 'credits') continue;
    undone.push(runtime);
    defaults[runtime] = {
      runsOn: 'own-sign-in',
      chosenBy: 'user',
      announced: true,
      signInReoffered: true,
    };
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
  writeCreditsSettings(config, { ...current, defaults, offer });
}

/**
 * The account a new link was made under, and whether it is the one the stored
 * choices belong to.
 */
export interface NewLinkAccount {
  /** The account's id (else its org's), or `null` when it could not be read. */
  key: string | null;
}

/**
 * A NEW link: start the choices over when it is a different DorkOS account (or
 * one that cannot be told apart), keep them for the same account, then fill
 * the gaps: each runtime that declares credits, has NO record, and has no
 * sign-in at all runs on credits by default, recorded as `chosenBy: 'default'`
 * and announced once.
 *
 * Called only from the link flow's approval, never at startup or by a
 * migration, so a computer linked before credits were a choice is never
 * switched over. A record of either kind is left alone, and an expired or
 * out-of-usage sign-in is not a gap.
 *
 * @param runtimes - The registered runtimes.
 * @param account - The account the new link was made under.
 * @param config - Config reader/writer.
 * @returns The runtimes switched to credits.
 */
export async function fillCreditsGaps(
  runtimes: readonly CreditsRuntimeView[],
  account: NewLinkAccount,
  config: CreditsConfigPort = configManager
): Promise<string[]> {
  const before = readCreditsSettings(config);
  const sameAccount = account.key !== null && before.linkedTo === account.key;
  const start: CloudCreditsSettings = sameAccount
    ? { ...before, offer: 'none' }
    : { defaults: {}, offer: 'none', agents: [], linkedTo: account.key };
  const switched: string[] = [];
  for (const runtime of runtimes) {
    if (runtime.capabilities.credits === undefined) continue;
    if (start.defaults[runtime.type] !== undefined) continue;
    // A sign-in nobody can read is not a gap DorkOS may fill with money.
    const signIn = await runtime.signIn().catch((): RuntimeSignInState => 'working');
    if (signIn === 'none') switched.push(runtime.type);
  }
  const defaults = { ...start.defaults };
  for (const type of switched) {
    defaults[type] = {
      runsOn: 'credits',
      chosenBy: 'default',
      announced: false,
      signInReoffered: false,
    };
  }
  writeCreditsSettings(config, { ...start, defaults });
  return switched;
}

/**
 * Record which account the choices belong to when it was not known yet (a
 * link made before this was recorded). Never changes a known value: only a
 * new link may do that.
 *
 * @param key - The account's id (else its org's).
 * @param config - Config reader/writer.
 */
export function noteCreditsAccount(key: string, config: CreditsConfigPort = configManager): void {
  const current = readCreditsSettings(config);
  if (current.linkedTo !== null) return;
  writeCreditsSettings(config, { ...current, linkedTo: key });
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
      { runsOn: choice.runsOn, chosenBy: choice.chosenBy },
    ])
  );
}

/**
 * The notices the person is owed right now.
 *
 * @param settings - The stored settings.
 * @param opts - What the notices depend on.
 * @param opts.linked - Whether this computer is linked.
 * @param opts.runtimes - The registered runtimes.
 */
export async function creditsNotices(
  settings: CloudCreditsSettings,
  opts: { linked: boolean; runtimes: readonly CreditsRuntimeView[] }
): Promise<CloudCreditsNotice[]> {
  if (!opts.linked) return [];
  const notices: CloudCreditsNotice[] = [];
  const filled = Object.entries(settings.defaults)
    .filter(
      ([, choice]) =>
        choice.runsOn === 'credits' && choice.chosenBy === 'default' && !choice.announced
    )
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
    if (
      choice.runsOn !== 'credits' ||
      choice.chosenBy !== 'default' ||
      !choice.announced ||
      choice.signInReoffered
    ) {
      continue;
    }
    const runtime = declared.find((candidate) => candidate.type === type);
    if (!runtime) continue;
    // A sign-in nobody can read is not offered back as working.
    const signIn = await runtime.signIn().catch((): RuntimeSignInState => 'none');
    if (signIn === 'working') notices.push({ kind: 'signed-in', runtime: type });
  }
  return notices;
}
