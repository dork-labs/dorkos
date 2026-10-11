import { resolveWithinCwd } from '../../../../../../lib/file-route-guards.js';
import { getBoundary } from '../../../../../../lib/boundary.js';
import type { Db } from '@dorkos/db';
import type { DocChannelStore } from '../../../store.js';
import { requireDocHttpFileWriteCurrent } from '../../../http-composition.js';
import { assertRecognizedCheckboxAdmission } from '../../checkbox-fence.js';
import {
  CanonicalFileIdentityChangedError,
  type CanonicalFileIdentity,
  type CanonicalWriteLease,
} from '../../canonical-writer.js';
import type { WriteFileRequest } from '@dorkos/shared/schemas';
import type { SaveScope, InstallationFileCustody } from './installation-file-custody-types.js';
import { readOriginalInstallationFileSaveScopePorts } from './installation-file-custody.js';

function scopeOf(owner: object, handle: object): SaveScope {
  const ports = readOriginalInstallationFileSaveScopePorts(owner);
  const { scopes, outsideSql } = ports;
  const scope = scopes.get(handle);
  if (!scope?.active) throw new Error('Inactive owning file-save operation.');
  outsideSql(scope.assembly.db);
  scope.owned.assertActive();
  return scope;
}

/** Detached finite arguments only; access requires an actually active private operation. */
export function readInstallationFileSaveScope(
  owner: object,
  handle: object
): Readonly<{
  input: Readonly<WriteFileRequest>;
  identity: Readonly<CanonicalFileIdentity>;
  lease: CanonicalWriteLease;
  forceConflict: boolean;
}> {
  readOriginalInstallationFileSaveScopePorts(owner);
  const scope = scopeOf(owner, handle);
  return Object.freeze({
    input: scope.input,
    identity: Object.freeze({ ...scope.identity }),
    lease: scope.lease,
    forceConflict: scope.forceConflict,
  });
}

/** Read actual private save custody outside SQL; no caller can create this handle. */
export function readOriginalDocumentFileSave(
  owner: object,
  handle: object,
  db: Db,
  store: DocChannelStore
): ReturnType<InstallationFileCustody['readOriginalDocumentFileSave']> {
  const ports = readOriginalInstallationFileSaveScopePorts(owner);
  const { requireInstallationFileWritesOwner } = ports;
  const scope = scopeOf(owner, handle);
  requireInstallationFileWritesOwner(scope.owner, db, store);
  if (scope.assembly.db !== db || scope.assembly.store !== store || !scope.input.documentSave)
    throw new Error('Foreign document-bound save scope.');
  return Object.freeze({ input: scope.input, identity: Object.freeze({ ...scope.identity }) });
}

/** Retain only the request identity for the same original service store. */
export function readOriginalDocumentFileSaveIdentity(
  owner: object,
  handle: object,
  store: DocChannelStore
): ReturnType<InstallationFileCustody['readOriginalDocumentFileSaveIdentity']> {
  const ports = readOriginalInstallationFileSaveScopePorts(owner);
  const { requireInstallationFileWritesOwner } = ports;
  const scope = scopeOf(owner, handle);
  if (scope.assembly.store !== store || !scope.input.documentSave)
    throw new Error('Foreign document save request.');
  requireInstallationFileWritesOwner(scope.owner, scope.assembly.db, store);
  return scope.input.documentSave;
}

/** Read only the active original save identity inside the final document inspection transaction. */
export function readOriginalDocumentFileSaveCurrent(
  owner: object,
  handle: object,
  db: Db,
  store: DocChannelStore
): ReturnType<InstallationFileCustody['readOriginalDocumentFileSaveCurrent']> {
  const ports = readOriginalInstallationFileSaveScopePorts(owner);
  const { scopes, requireInstallationFileWritesOwner } = ports;
  const scope = scopes.get(handle);
  if (
    !scope?.active ||
    scope.assembly.db !== db ||
    scope.assembly.store !== store ||
    !scope.input.documentSave
  )
    throw new Error('Document save has no active original scope.');
  requireInstallationFileWritesOwner(scope.owner, db, store);
  return Object.freeze({ request: scope.input.documentSave, path: scope.identity.canonicalPath });
}

/** Verify the actual original changed result inside the exact completion transaction. */
export function requireOriginalDocumentFileSaveCompleted(
  owner: object,
  handle: object,
  db: Db,
  store: DocChannelStore,
  hash: string
): void {
  const ports = readOriginalInstallationFileSaveScopePorts(owner);
  const { scopes, requireInstallationFileWritesOwner } = ports;
  const scope = scopes.get(handle);
  if (
    !scope?.active ||
    scope.assembly.db !== db ||
    scope.assembly.store !== store ||
    scope.completedSave?.effect !== 'changed' ||
    scope.completedSave.hash !== hash
  )
    throw new Error('Document save has no original changed completion.');
  requireInstallationFileWritesOwner(scope.owner, db, store);
}

/** Final synchronous current checks directly precede each participating effect. */
export function requireInstallationFileSaveCurrent(owner: object, handle: object): undefined {
  readOriginalInstallationFileSaveScopePorts(owner);
  const scope = scopeOf(owner, handle);
  if (getBoundary() !== scope.assembly.root) throw new Error('Installed file boundary changed.');
  requireDocHttpFileWriteCurrent(scope.owner, scope.caller);
  assertRecognizedCheckboxAdmission(
    scope.assembly.fence,
    scope.assembly.db,
    scope.assembly.store,
    scope.identity
  );
  return undefined;
}

/** Awaited roots/path/identity work never replaces the final synchronous current checks. */
export async function checkInstallationFileSaveScope(owner: object, handle: object): Promise<void> {
  const ports = readOriginalInstallationFileSaveScopePorts(owner);
  const { physical, same } = ports;
  const scope = scopeOf(owner, handle);
  await scope.owned.assertCurrentRoots();
  scopeOf(owner, handle);
  const { resolved } = await resolveWithinCwd(scope.input.cwd, scope.input.path);
  scopeOf(owner, handle);
  const current = await physical(scope.assembly.db, resolved);
  scopeOf(owner, handle);
  if (!same(current, scope.identity)) throw new CanonicalFileIdentityChangedError();
  requireInstallationFileSaveCurrent(owner, handle);
}

/** Only this operation's already reserved replacement may become its expected target. */
export function markInstallationFileSaveReplaced(
  owner: object,
  handle: object,
  replacement: CanonicalFileIdentity
): undefined {
  readOriginalInstallationFileSaveScopePorts(owner);
  const scope = scopeOf(owner, handle);
  if (!scope.replacements.has(replacement)) throw new Error('Unknown replacement reservation.');
  if (replacement.canonicalPath === scope.identity.canonicalPath)
    throw new Error('Replacement must originate from a distinct owned temporary path.');
  scope.identity = { ...replacement, canonicalPath: scope.identity.canonicalPath };
  return undefined;
}

/** Mandatory owned-temp cleanup has exclusion/lifetime, not a fresh caller permission grant. */
export async function checkInstallationFileSaveCleanup(
  owner: object,
  handle: object
): Promise<void> {
  readOriginalInstallationFileSaveScopePorts(owner);
  const scope = scopeOf(owner, handle);
  await scope.owned.assertCurrentRoots();
  scopeOf(owner, handle);
}
