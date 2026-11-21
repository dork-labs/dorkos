/** Keep a person's acknowledged chat tied to its exact source until first binding. */
import { agents, and, eq, sessionBirthAllocations, sessionLocations, type Db } from '@dorkos/db';
import type { MeshCore } from '@dorkos/mesh';
import type { RequestFacts } from '../http/request-facts.js';
import { BoundaryError, validateBoundaryOrDorkHome } from '../lib/boundary.js';
import { readOwnerAccount } from '../services/core/auth/index.js';
import { PreparedSettingsWriteError } from '../services/core/runtime-seam/prepared-settings-write.js';
import {
  readDraftSource,
  type PersonChatBinding,
} from '../services/core/runtime-seam/person-draft-settings.js';
import { SessionBirthWriteError } from '../services/core/runtime-seam/session-birth-write.js';
import { primaryOf } from '../services/session/resolution/session-key-registry.js';
import { assessPerson, type PersonBarCopy } from './extensions-person-bar.js';

const PERSON_BAR: PersonBarCopy = {
  error: 'Only a person can choose a chat folder.',
  code: 'SESSION_LOCATION_PERSON_REQUIRED',
  subject: 'chat folders',
  crossSite: () => 'Open DorkOS to choose a chat folder.',
  agent: 'Only a person can choose a chat folder.',
};

/** Preserve the existing person and site checks for all uses of a saved folder. */
export function assessSessionLocationPerson(facts: RequestFacts) {
  if (facts.headers['sec-fetch-site'] === 'cross-site')
    return { status: 403 as const, body: { error: PERSON_BAR.error, code: PERSON_BAR.code } };
  return assessPerson(facts, PERSON_BAR);
}

/** The owner key used by the existing saved-location routes. */
export function sessionLocationOwnerId(facts: RequestFacts): string {
  return facts.user?.userId ?? readOwnerAccount()?.id ?? 'local';
}

/** The same response for a missing or differently owned acknowledged chat. */
export const personChatMissing = {
  status: 404 as const,
  body: { error: 'Session not found', code: 'SESSION_NOT_FOUND' },
};

/** A source or draft rejected before its settings or runtime could be stored. */
export function isPersonChatWriteRefusal(error: unknown): boolean {
  return (
    error instanceof PreparedSettingsWriteError ||
    (error instanceof SessionBirthWriteError &&
      ['context', 'source', 'metadata'].includes(error.reason))
  );
}

type PersonChatRefusal =
  | typeof personChatMissing
  | {
      status: 403;
      body: { error: string; code: string };
    };

type PreparedPersonChat =
  | { binding: PersonChatBinding; cwd: string; registeredAgentPath?: never }
  | { binding: PersonChatBinding; registeredAgentPath: string; cwd?: never };

/** Capture the exact source before runtime/model or placement reads can yield. */
export function observePersonChat(db: Db, id: string) {
  const allocation = db
    .select()
    .from(sessionBirthAllocations)
    .where(eq(sessionBirthAllocations.sessionId, id))
    .get();
  const draft = readDraftSource(db, id);
  if ((!allocation || allocation.sourceKind === 'internal') && !draft) return;
  return { allocation, draft };
}

/** Revalidate an observed source for either ordinary settings or ordinary first send. */
export async function preparePersonChat(
  db: Db,
  id: string,
  facts: RequestFacts,
  source: NonNullable<ReturnType<typeof observePersonChat>>,
  meshCore: Pick<MeshCore, 'getProjectPath'> | undefined,
  requestedCwd?: string
): Promise<PreparedPersonChat | { refusal: PersonChatRefusal }> {
  const refusal = assessSessionLocationPerson(facts);
  if (refusal) return { refusal };
  const { allocation, draft } = source;
  const ownerId = sessionLocationOwnerId(facts);
  if (
    primaryOf(id) !== id ||
    (allocation && draft) ||
    (allocation && allocation.sourceKind === 'internal')
  )
    return { refusal: personChatMissing };
  const owned = allocation ?? draft;
  if (!owned || owned.ownerId !== ownerId) return { refusal: personChatMissing };
  if (owned.sourceKind === 'person-agent') {
    const registeredAgentId = owned.registeredAgentId;
    const recordedPath = draft?.sourcePath ?? allocation?.recordedRegisteredPath;
    if (
      !registeredAgentId ||
      !recordedPath ||
      meshCore?.getProjectPath(registeredAgentId) !== recordedPath
    )
      return { refusal: personChatMissing };
    const agent = db.select().from(agents).where(eq(agents.id, registeredAgentId)).get();
    if (!agent || agent.projectPath !== recordedPath) return { refusal: personChatMissing };
    if (draft) {
      if (draft.sourceCreatedAt !== agent.registeredAt) return { refusal: personChatMissing };
      return {
        binding: { draft: { ...draft, sourceKind: 'person-agent', registeredAgentId } },
        registeredAgentPath: recordedPath,
      };
    }
    if (!allocation) return { refusal: personChatMissing };
    return {
      binding: {
        birth: {
          kind: 'person-agent',
          sessionId: id,
          ownerId,
          registeredAgentId,
          recordedRegisteredPath: recordedPath,
          sourceCreatedAt: agent.registeredAt,
          allocationCreatedAt: allocation.createdAt,
        },
      },
      registeredAgentPath: recordedPath,
    };
  }
  if (!owned.locationId) return { refusal: personChatMissing };
  const location = db
    .select()
    .from(sessionLocations)
    .where(and(eq(sessionLocations.id, owned.locationId), eq(sessionLocations.ownerId, ownerId)))
    .get();
  if (!location) return { refusal: personChatMissing };
  try {
    if (
      (await validateBoundaryOrDorkHome(location.cwd)) !== location.cwd ||
      (requestedCwd && (await validateBoundaryOrDorkHome(requestedCwd)) !== location.cwd)
    )
      return { refusal: personChatMissing };
  } catch (error) {
    if (error instanceof BoundaryError)
      return { refusal: { status: 403, body: { error: error.message, code: error.code } } };
    throw error;
  }
  if (draft) {
    if (draft.sourcePath !== location.cwd || draft.sourceCreatedAt !== location.createdAt)
      return { refusal: personChatMissing };
    return {
      binding: { draft: { ...draft, sourceKind: 'person-location', locationId: location.id } },
      cwd: location.cwd,
    };
  }
  if (!allocation) return { refusal: personChatMissing };
  return {
    binding: {
      birth: {
        kind: 'person-location',
        sessionId: id,
        ownerId,
        locationId: location.id,
        cwd: location.cwd,
        sourceCreatedAt: location.createdAt,
        allocationCreatedAt: allocation.createdAt,
      },
    },
    cwd: location.cwd,
  };
}
