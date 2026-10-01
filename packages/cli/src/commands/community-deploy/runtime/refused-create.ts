/**
 * What `dorkos community deploy` says when Fly or Neon refuses this run's credential at a create.
 *
 * @module commands/community-deploy/runtime/refused-create
 */
import type { CommunityCreationRefusedError } from '../execute.js';
import { deleteLaunchJournal, journalRecordsNoResource, type LaunchJournal } from '../journal.js';
import { describeCommunityCredential } from './credential-env.js';

const REFUSED_CREATE = {
  fly: { service: 'Fly', noun: 'app', plural: 'apps', credential: 'token' },
  neon: { service: 'Neon', noun: 'project', plural: 'projects', credential: 'key' },
  tigris: { service: 'Fly', noun: 'storage bucket', plural: 'storage', credential: 'token' },
} as const;

/**
 * Say plainly that a service refused this run's credential at a create, and what to do next.
 *
 * @param refusal - Which create was refused, in which organization.
 * @param env - The environment `fly` and `neonctl` were given, to name the credential. Only
 *   variable names are printed, never a value.
 * @param nothingMade - True when the run made nothing and its journal was removed; otherwise the
 *   recovery table and resume command were printed just above.
 */
export function formatCommunityCreationRefusal(
  refusal: Pick<CommunityCreationRefusedError, 'service' | 'organizationId' | 'resourceName'>,
  env: Readonly<Record<string, string | undefined>>,
  nothingMade: boolean
): string {
  const words = REFUSED_CREATE[refusal.service];
  const credential = describeCommunityCredential(refusal.service === 'neon' ? 'neon' : 'fly', env);
  return [
    `${words.service} refused to create ${words.noun} ${refusal.resourceName} in organization ${refusal.organizationId}.`,
    `${credential} can't create ${words.plural} there.`,
    `Use a ${words.credential} or sign-in that can, then`,
    nothingMade
      ? 'run setup again. Nothing was created, so there is nothing to clean up.'
      : 'resume with the command above.',
  ].join(' ');
}

/**
 * End a launch whose create was refused, with the plain refusal as the error.
 *
 * A refusal proves the refused create made nothing. When the run made nothing before it either,
 * there is nothing to resume or clean up, so its journal is deleted and no recovery is printed.
 * Otherwise the recovery table and resume command are printed first, as for any other stop.
 *
 * @param refusal - The refused create.
 * @param journal - The run's latest journal, with the refused intent already cleared.
 * @param journalPath - Where that journal lives.
 * @param env - The environment `fly` and `neonctl` were given, to name the credential.
 * @param recovery - Renders the recovery table for a kept journal.
 */
export async function stopForRefusedCreate(
  refusal: CommunityCreationRefusedError,
  journal: LaunchJournal,
  journalPath: string,
  env: Readonly<Record<string, string | undefined>>,
  recovery: (journal: LaunchJournal) => string
): Promise<never> {
  if (journal.pendingIntent === null && journalRecordsNoResource(journal)) {
    const removed = await deleteLaunchJournal(journalPath, journal.revision).then(
      () => true,
      () => false
    );
    if (removed) {
      throw new Error(formatCommunityCreationRefusal(refusal, env, true), { cause: refusal });
    }
  }
  process.stderr.write(`Community setup stopped.\n${recovery(journal)}\n`);
  throw new Error(formatCommunityCreationRefusal(refusal, env, false), { cause: refusal });
}
