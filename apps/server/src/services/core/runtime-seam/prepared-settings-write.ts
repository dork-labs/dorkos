/** One admitted, exact-id settings mutation; never a shared or wire authority store. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import type { SessionSettingsPort } from '@dorkos/shared/agent-runtime';
import type { SessionSettings } from '@dorkos/shared/types';
import type { PersonDraftWitness } from './person-draft-settings.js';
import type { SessionBirthWriteContext } from './session-birth-write.js';

interface Publication {
  isCurrent(): boolean;
  publish(): undefined;
}
type SettingsTarget = { birth: SessionBirthWriteContext } | { draft: PersonDraftWitness };

interface Mutation {
  id: string;
  target: SettingsTarget;
  open: boolean;
  phase: 'available' | 'staged' | 'writing' | 'consumed' | 'failed';
  publication?: Publication;
  failure?: { error: unknown };
}
const mutations = new AsyncLocalStorage<Mutation>();

/** A stale or unsupported scoped mutation makes no settings write. */
export class PreparedSettingsWriteError extends Error {
  readonly code = 'SESSION_BIRTH_CONTEXT_UNAVAILABLE';
  constructor() {
    super('Prepared settings mutation is unavailable.');
  }
}
/** The durable write already committed; this error must never be reported as a stale no-write. */
export class SettingsPublicationError extends Error {
  readonly code = 'SETTINGS_PUBLICATION_FAILED';
  readonly committed = true;
  constructor(cause: unknown) {
    super('Settings committed but local update failed.', { cause });
  }
}

/**
 * Stage a first settings write against its admitted allocation.
 *
 * @param id - The canonical chat id the adapter will address.
 * @param birth - The exact prepared source for the first metadata insert.
 * @param update - The owning adapter's normal settings entry point.
 * @returns The adapter's update result after the scoped write and publication.
 */
export async function runPreparedSettingsMutation<T>(
  id: string,
  birth: SessionBirthWriteContext,
  update: () => T | Promise<T>
): Promise<T> {
  return runScopedSettingsMutation(id, { birth }, update);
}

/**
 * Stage an existing-only settings write against its admitted person-owned draft.
 *
 * @param id - The canonical chat id the adapter will address.
 * @param draft - The exact provenance observed after verifying its person source.
 * @param update - The owning adapter's normal settings entry point.
 * @returns The adapter's update result after the scoped write and publication.
 */
export async function runPreparedDraftSettingsMutation<T>(
  id: string,
  draft: PersonDraftWitness,
  update: () => T | Promise<T>
): Promise<T> {
  return runScopedSettingsMutation(id, { draft }, update);
}

async function runScopedSettingsMutation<T>(
  id: string,
  target: SettingsTarget,
  update: () => T | Promise<T>
): Promise<T> {
  const mutation: Mutation = {
    id,
    target: structuredClone(target),
    open: true,
    phase: 'available',
  };
  return mutations.run(mutation, async () => {
    try {
      const result = await update();
      if (mutation.failure) throw mutation.failure.error;
      if (mutation.phase !== 'consumed') throw new PreparedSettingsWriteError();
      return result;
    } catch (error) {
      if (mutation.failure) throw mutation.failure.error;
      if (mutation.phase === 'consumed') throw new SettingsPublicationError(error);
      throw error;
    } finally {
      mutation.open = false;
    }
  });
}

/** Other ids and ordinary calls do not acquire the prepared context. Escaped calls cannot revive it. */
export function hasPreparedSettingsMutation(id: string): boolean {
  const mutation = mutations.getStore();
  if (!mutation || mutation.id !== id) return false;
  if (!mutation.open) throw new PreparedSettingsWriteError();
  return mutation.phase !== 'consumed';
}

/** A refused open first-write attempt cannot be retried inside the same exact-id scope. */
function refuseAcquisition(mutation?: Mutation): never {
  const error = new PreparedSettingsWriteError();
  if (mutation?.open && mutation.phase !== 'consumed') {
    mutation.phase = 'failed';
    mutation.failure ??= { error };
    throw mutation.failure.error;
  }
  throw error;
}

/** Register only the actual adapter's local-owner predicate and synchronous publication. */
export function stageSettingsPublication(id: string, publication: Publication): void {
  const mutation = mutations.getStore();
  if (!mutation || mutation.id !== id) refuseAcquisition();
  if (!mutation.open || mutation.phase !== 'available') refuseAcquisition(mutation);
  mutation.publication = publication;
  mutation.phase = 'staged';
}

/**
 * Commit a prepared settings patch through the supplied adapter's durable port.
 * The current owner publishes only once the settings transaction commits.
 */
export async function savePreparedSettings(
  id: string,
  patch: SessionSettings,
  port: SessionSettingsPort | undefined,
  publication: Publication
): Promise<{ updated: true }> {
  if (!port || !publication.isCurrent()) throw new PreparedSettingsWriteError();
  stageSettingsPublication(id, publication);
  await port.saveSessionSettings(id, patch);
  return { updated: true };
}

/** Acquire immediately before the registry's original synchronous SQL operation. */
export function preparedSettingsWrite(id: string, explicit?: SessionBirthWriteContext) {
  const mutation = mutations.getStore();
  if (!mutation || mutation.id !== id) return undefined;
  if (!mutation.open) refuseAcquisition(mutation);
  if (mutation.phase === 'consumed') return undefined;
  if (
    mutation.phase !== 'staged' ||
    !mutation.publication ||
    (explicit &&
      (!('birth' in mutation.target) || !isDeepStrictEqual(explicit, mutation.target.birth)))
  )
    refuseAcquisition(mutation);
  const publication = mutation.publication;
  mutation.phase = 'writing';
  return {
    target: mutation.target,
    assertCurrent(): void {
      if (!mutation.open || mutation.phase !== 'writing') refuseAcquisition(mutation);
      const current = publication.isCurrent();
      // A reentrant denied acquisition inside the predicate must also stop this write.
      if (!current || mutation.phase !== 'writing' || mutation.failure) refuseAcquisition(mutation);
    },
    committed(): void {
      mutation.phase = 'consumed';
      try {
        if (publication.publish() !== undefined)
          throw new Error('Settings publication must be synchronous.');
      } catch (cause) {
        const error = new SettingsPublicationError(cause);
        mutation.failure = { error };
        throw error;
      }
    },
    failed(error: unknown): void {
      if (mutation.phase !== 'consumed') mutation.phase = 'failed';
      mutation.failure ??= { error };
    },
  };
}
