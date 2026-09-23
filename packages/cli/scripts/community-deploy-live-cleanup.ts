/** Exact-identity cleanup for the separately armed Community release gate. */

/** Non-secret identities retained in the launcher's own recovery journal. */
export interface CommunityLiveGateJournal {
  recoveryContext?: {
    flyOrganization: string;
    neonOrganization: string;
    appName: string;
    bucketName: string;
  };
  resources: {
    flyAppId?: string;
    neonProjectId?: string;
    tigrisBucketId?: string;
  };
  ownerBootstrapRotated?: boolean;
  secretDigests?: Record<string, string>;
}

/** Sanitized resource identity returned by the provider wrappers. */
export interface CommunityLiveGateResource {
  id: string;
  name: string;
  organization: string;
  appId?: string;
  appName?: string;
}

/** Result deliberately fit for a non-secret CI receipt. */
export interface CommunityLiveGateCleanupReceipt {
  cleaned: readonly string[];
  retained: readonly string[];
}

/** Provider boundaries needed for one exact journal-identity cleanup. */
export interface CommunityLiveGateCleanupDependencies {
  readFlyApps(organization: string): Promise<readonly CommunityLiveGateResource[]>;
  readNeonProjects(organization: string): Promise<readonly CommunityLiveGateResource[]>;
  readTigris(id: string): Promise<CommunityLiveGateResource>;
  deleteTigris(name: string): Promise<void>;
  deleteNeonProject(id: string): Promise<void>;
  destroyFlyApp(name: string): Promise<void>;
}

/** Stable cleanup refusal which never includes raw provider output. */
export class CommunityLiveGateCleanupError extends Error {
  constructor(
    readonly step: string,
    readonly retained: readonly string[]
  ) {
    super(`Community live cleanup failed (${step}); retained: ${retained.join(', ') || 'unknown'}`);
    this.name = 'CommunityLiveGateCleanupError';
  }
}

function required(journal: CommunityLiveGateJournal) {
  const context = journal.recoveryContext;
  const { flyAppId, neonProjectId, tigrisBucketId } = journal.resources;
  if (!context || !flyAppId || !neonProjectId || !tigrisBucketId) {
    throw new CommunityLiveGateCleanupError('journal-identity', []);
  }
  return { context, flyAppId, neonProjectId, tigrisBucketId };
}

function exactlyOne(
  resources: readonly CommunityLiveGateResource[],
  predicate: (resource: CommunityLiveGateResource) => boolean,
  step: string,
  retained: readonly string[]
): CommunityLiveGateResource {
  const matches = resources.filter(predicate);
  if (matches.length !== 1) throw new CommunityLiveGateCleanupError(step, retained);
  return matches[0]!;
}

/**
 * Delete only resources whose current provider identity exactly matches the recovery journal.
 * Any ambiguous or failed deletion reports the known retained identities and stops immediately.
 */
export async function cleanupCommunityLiveGate(
  journal: CommunityLiveGateJournal,
  dependencies: CommunityLiveGateCleanupDependencies
): Promise<CommunityLiveGateCleanupReceipt> {
  const { context, flyAppId, neonProjectId, tigrisBucketId } = required(journal);
  const retained = [flyAppId, neonProjectId, tigrisBucketId];
  try {
    const fly = exactlyOne(
      await dependencies.readFlyApps(context.flyOrganization),
      (item) =>
        item.id === flyAppId &&
        item.name === context.appName &&
        item.organization === context.flyOrganization,
      'fly-identity',
      retained
    );
    const neon = exactlyOne(
      await dependencies.readNeonProjects(context.neonOrganization),
      (item) => item.id === neonProjectId && item.organization === context.neonOrganization,
      'neon-identity',
      retained
    );
    const tigris = await dependencies.readTigris(tigrisBucketId);
    if (
      tigris.id !== tigrisBucketId ||
      tigris.name !== context.bucketName ||
      tigris.organization !== context.flyOrganization ||
      tigris.appId !== fly.id ||
      tigris.appName !== fly.name
    ) {
      throw new CommunityLiveGateCleanupError('tigris-identity', retained);
    }
    await dependencies.deleteTigris(tigris.name);
    retained.splice(retained.indexOf(tigrisBucketId), 1);
    await dependencies.deleteNeonProject(neon.id);
    retained.splice(retained.indexOf(neonProjectId), 1);
    await dependencies.destroyFlyApp(fly.name);
    retained.splice(retained.indexOf(flyAppId), 1);
    return { cleaned: [tigrisBucketId, neonProjectId, flyAppId], retained };
  } catch (error) {
    if (error instanceof CommunityLiveGateCleanupError) throw error;
    throw new CommunityLiveGateCleanupError('provider-operation', retained);
  }
}
