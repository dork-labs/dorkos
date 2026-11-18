/** Enforce durable recovery authority at the common Claude launch boundary. */
import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  CREDITS_BLANKED_SETTINGS_NAMES,
  routesOrPays,
  folderSettingsFiles,
} from '../credits-launch.js';
import type { RequiredRoomLaunch } from '../../../../rooms/reseat/required-launch-store.js';
import { projectOfFolder } from '../../../../core/usage/account-eligibility.js';
import { resolveLaunchAccountRoot } from '../../claude-config-dir.js';
import { envBillsPerToken } from '../per-token-billing.js';

/** Server-private authority supplied by the runtime's exact settings owner. */
export interface RequiredLaunchReader {
  forSession(sessionId: string): RequiredRoomLaunch | null;
  hasOwnedAttempt(sessionId: string): boolean;
}
export type RequiredLaunchOwner = () => RequiredLaunchReader;

/** Uncomposed/private adapters cannot certify that a session is unconstrained. */
export function unknownRequiredLaunchOwner(): never {
  throw new Error('Recovery launch authority is unavailable.');
}

/** Fresh canonical/lifecycle check shared by launches and retained-process appends. */
export function readRequiredClaudeLaunch(
  sessionId: string,
  owner?: RequiredLaunchOwner
): RequiredRoomLaunch | null {
  const store = (owner ?? unknownRequiredLaunchOwner)();
  const requirement = store.forSession(sessionId);
  if (!requirement) return null;
  if (requirement.destinationSessionId !== sessionId)
    throw new Error('This recovery alias requires its canonical chat.');
  if (
    requirement.state === 'refused' ||
    (requirement.state === 'pending' && !store.hasOwnedAttempt(sessionId))
  ) {
    throw new Error('This recovery needs a new guarded handoff attempt.');
  }
  return requirement;
}

/** Required root never goes through a fallback ladder; current policy must still admit it. */
export async function requiredClaudeRoot(input: {
  sessionId: string;
  sessionRoot?: string;
  hintId?: string;
  agentAccountId?: string;
  agentId?: string;
  cwd: string;
  requiredLaunches?: RequiredLaunchOwner;
}): Promise<{ root: string; requirement: RequiredRoomLaunch | null }> {
  const requirement = readRequiredClaudeLaunch(input.sessionId, input.requiredLaunches);
  if (requirement) {
    if (input.sessionRoot && resolve(input.sessionRoot) !== requirement.root)
      throw new Error('Recovery account changed.');
    // No unregistered/default-root guess: a named account must resolve to the
    // same root under current project and sign-in policy, with no fallback.
    if (input.agentAccountId && input.agentAccountId !== requirement.accountId) {
      const pin = resolveLaunchAccountRoot({
        hintId: input.agentAccountId,
        project: await projectOfFolder(input.cwd),
      });
      if (!pin.ok || resolve(pin.root) !== requirement.root)
        throw new Error('Recovery conflicts with the current account pin.');
    }
    if (!requirement.accountId) throw new Error('Recovery account identity is unknown.');
    const allowed = resolveLaunchAccountRoot({
      hintId: requirement.accountId,
      project: await projectOfFolder(input.cwd),
    });
    if (!allowed.ok || resolve(allowed.root) !== requirement.root)
      throw new Error('Recovery account is not allowed.');
    return { root: requirement.root, requirement };
  }
  if (input.sessionRoot !== undefined) return { root: input.sessionRoot, requirement: null };
  const launch = resolveLaunchAccountRoot({
    hintId: input.hintId,
    agentAccountId: input.agentAccountId,
    agentId: input.agentId,
    project: await projectOfFolder(input.cwd),
  });
  if (!launch.ok) throw launch.error;
  return { root: launch.root, requirement: null };
}

/** Compare final SDK configuration before any model or SDK process effect. */
export function enforceRequiredClaudeConfiguration(
  requirement: Pick<RequiredRoomLaunch, 'runtime' | 'root' | 'inference' | 'billing'> | null,
  root: string,
  credits: boolean,
  environment: Readonly<Record<string, string | undefined>>,
  final?: { cwd: string; settings: unknown }
): void {
  if (!requirement) return;
  const merged = finalRecoveryEnvironment(root, credits, environment, final);
  if (
    requirement.runtime !== 'claude-code' ||
    resolve(root) !== requirement.root ||
    (credits ? 'credits' : 'own-account') !== requirement.inference ||
    (envBillsPerToken(merged) ? 'per-token' : 'subscription') !== requirement.billing
  ) {
    throw new Error('The recovery account or billing choice cannot be preserved.');
  }
}

function billingSettings(
  base: Record<string, string | undefined>,
  value: unknown
): Record<string, string | undefined> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Recovery credential settings are unknown.');
  const settings = value as Record<string, unknown>;
  if (settings.apiKeyHelper !== undefined && settings.apiKeyHelper !== '')
    throw new Error('Recovery credential helper is unknown.');
  if (settings.env === undefined) return base;
  if (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env))
    throw new Error('Recovery credential environment is unknown.');
  const result = { ...base };
  for (const [name, value] of Object.entries(settings.env)) {
    if (typeof value !== 'string') throw new Error('Recovery credential environment is unknown.');
    result[name] = value;
  }
  return result;
}

/** Positive route attestation for a previous SDK turn; unsupported normal launches stay unclassified. */
export function validatedRecoveryRoute(
  root: string,
  credits: boolean,
  environment: Readonly<Record<string, string | undefined>>,
  final?: { cwd: string; settings: unknown }
): { root: string; inference: 'credits' | 'own-account' } | undefined {
  try {
    finalRecoveryEnvironment(root, credits, environment, final);
    return { root: resolve(root), inference: credits ? 'credits' : 'own-account' };
  } catch {
    return undefined;
  }
}

function finalRecoveryEnvironment(
  root: string,
  credits: boolean,
  environment: Readonly<Record<string, string | undefined>>,
  final?: { cwd: string; settings: unknown }
): Record<string, string | undefined> {
  let merged: Record<string, string | undefined> = { ...environment };
  if (final) {
    for (const file of [join(root, 'settings.json'), ...folderSettingsFiles(final.cwd)]) {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const settings: unknown = JSON.parse(text);
      merged = billingSettings(merged, settings);
    }
    if (final.settings !== undefined) merged = billingSettings(merged, final.settings);
  }
  // A final routing/host-auth switch cannot be treated as subscription proof.
  const endpoint = merged.ANTHROPIC_BASE_URL;
  if (!credits && endpoint && endpoint !== 'https://api.anthropic.com')
    throw new Error('Recovery inference source is unknown.');
  for (const [name, value] of Object.entries(merged)) {
    if (
      !value ||
      name === 'ANTHROPIC_API_KEY' ||
      name === 'ANTHROPIC_AUTH_TOKEN' ||
      name === 'ANTHROPIC_BASE_URL'
    )
      continue;
    if (
      CREDITS_BLANKED_SETTINGS_NAMES.some((known) => known === name) ||
      /^CLAUDE_CODE_(?:USE_|SKIP_|HOST_|PROVIDER_|SESSION_ACCESS|GATEWAY)/.test(name) ||
      (routesOrPays(name) && /(?:BASE_URL|AUTH|KEY|TOKEN|HEADERS)/.test(name))
    ) {
      throw new Error('Recovery inference source is unsupported.');
    }
  }
  return merged;
}
