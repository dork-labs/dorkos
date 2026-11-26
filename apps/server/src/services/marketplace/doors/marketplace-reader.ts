/**
 * What an agent reads of the marketplace's installs and held-back packages
 * (DOR-4978): everything a person reads, less the working folder a dev-linked
 * package runs from. That folder is a person's, like the folders the mesh
 * reads leave out for an agent (`services/mesh/doors/mesh-read-capabilities.ts`).
 *
 * @module services/marketplace/doors/marketplace-reader
 */
import type { CapabilityHandlerContext } from '../../core/capabilities/index.js';

/** The words a note says in place of a linked folder, for an agent. */
const ITS_FOLDER = 'its folder';

/**
 * Whether an agent, or a machine that presented an agent token, is asking.
 * The person at the app presents neither.
 *
 * @param context - The call's context.
 */
export function agentIsAsking(context: CapabilityHandlerContext): boolean {
  return context.identity !== undefined || context.agentIdentityPresented === true;
}

/** A held-back package's state, as the installs list and the held-back list carry it. */
interface HeldBackLike {
  note: string;
  linkedPath?: string;
  bindsTo?: string;
}

/**
 * A held-back state without its linked folder: no `linkedPath`, the folder
 * named as "its folder" in `note`, and no `bindsTo` that spells it.
 *
 * @param held - The state as a person reads it.
 */
export function heldBackWithoutFolder<T extends HeldBackLike>(held: T): T {
  const { linkedPath, bindsTo, ...rest } = held;
  if (linkedPath === undefined) return held;
  return {
    ...rest,
    note: held.note.split(linkedPath).join(ITS_FOLDER),
    ...(bindsTo !== undefined && !bindsTo.includes(linkedPath) ? { bindsTo } : {}),
  } as T;
}

/** An installation, as the installs reads carry it. */
interface InstallationLike {
  heldBack?: HeldBackLike;
  devLink?: { path?: string };
}

/**
 * An installation as this caller may read it: whole for a person, and for an
 * agent without the folder a dev link runs from.
 *
 * @param context - The call's context: who is reading.
 */
export function installationForReader(
  context: CapabilityHandlerContext
): <T extends InstallationLike>(installation: T) => T {
  if (!agentIsAsking(context)) return (installation) => installation;
  return <T extends InstallationLike>(installation: T): T => {
    const kept: T = { ...installation };
    if (installation.heldBack) kept.heldBack = heldBackWithoutFolder(installation.heldBack);
    if (installation.devLink) {
      const { path: _folder, ...devLink } = installation.devLink;
      kept.devLink = devLink;
    }
    return kept;
  };
}
