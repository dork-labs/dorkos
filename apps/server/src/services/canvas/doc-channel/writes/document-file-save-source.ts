/** Fixed current operator/session-document source checks. No writes, grants or callback-shaped authority. */
import fs from 'node:fs/promises';
import type { DbTransaction } from '@dorkos/db';
import type { WriteFileRequest } from '@dorkos/shared/schemas';
import {
  sameCanvasDocIncarnation,
  type CanvasDocIncarnation,
} from '@dorkos/shared/canvas-channel-schemas';
import type { RequestFacts } from '../../../../http/request-facts.js';
import { resolveWithinCwd, sha256 } from '../../../../lib/file-route-guards.js';
import { BoundaryError } from '../../../../lib/boundary.js';
import { CanonicalFileIdentityChangedError } from './canonical-writer.js';
import type { FileSaveIntentRow } from './file-save-intents.js';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { parseScope } from '../../scopes.js';
import {
  DocChannelNotFoundError,
  type DocChannelActor,
  type DocChannelAuthorization,
} from '../authorization.js';
import {
  docInstallationOwner,
  readSessionDocSourceDescriptor,
  sameDocOwnerAuthority,
  type DocSourceDescriptor,
  type DocSourceDependencies,
} from '../doc-source-policy.js';
import { docDocumentGeneration } from '../identity/incarnation.js';
import type { DocChannelStore } from '../store.js';
import type { CanonicalFileIdentity } from './canonical-writer.js';

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
/** Real current installation instances; no caller-supplied checker or file-effect callback. */
export interface DocumentFileSaveDependencies extends Pick<
  DocSourceDependencies,
  'db' | 'documents'
> {
  authorization: DocChannelAuthorization;
  channels: DocChannelStore;
  installationId: string;
}
/** Trusted front-door facts; body data never supplies these identities. */
export type DocumentFileSaveCaller = Pick<RequestFacts, 'headers'> &
  Partial<Pick<RequestFacts, 'agentIdentity' | 'user'>>;
export type Capture = {
  actor: DocChannelActor;
  source: DocSourceDescriptor;
  incarnation: CanvasDocIncarnation;
  owner: ReturnType<typeof docInstallationOwner>;
};

/** Resolve a real trusted front-door operator, refusing any presented agent identity. */
export function captureDocumentSaveOperator(
  deps: DocumentFileSaveDependencies,
  caller: DocumentFileSaveCaller
) {
  if (
    caller.agentIdentity ||
    Object.hasOwn(caller.headers, 'x-dorkos-agent') ||
    (typeof caller.headers.authorization === 'string' &&
      /^Bearer\s+dct_/iu.test(caller.headers.authorization))
  )
    throw new DocChannelNotFoundError();
  const owner = docInstallationOwner(deps.installationId);
  if (caller.user && (owner.kind !== 'user' || owner.userId !== caller.user.userId))
    throw new DocChannelNotFoundError();
  const actor: DocChannelActor = {
    surface: 'http',
    principal: createServerPrincipal({ kind: 'operator', owner }),
  };
  return { owner, actor };
}

/**
 * Resolve a document's root folder. A folder that is gone (deleted or moved
 * since the document was opened) leaves a document this lane will never save,
 * so it is "not available" rather than a fault worth retrying.
 */
async function realRoot(folder: string): Promise<string> {
  try {
    return await fs.realpath(folder);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR')
      throw new DocChannelNotFoundError({ cause: error });
    throw error;
  }
}

/**
 * Derive a current source from the installed operator and registered session, never a caller path.
 *
 * The root is the session's agent directory, or for a chat with no agent the
 * folder the server recorded when the document was opened
 * ({@link readSessionDocSourceDescriptor}). Either way the recorded folder must
 * be that root, and the file must resolve inside it.
 */
export async function resolveCurrentDocumentSaveSource(
  deps: DocumentFileSaveDependencies,
  documentId: string,
  caller: DocumentFileSaveCaller
) {
  const { owner, actor } = captureDocumentSaveOperator(deps, caller);
  const authorized = await deps.authorization.require(documentId, actor, true);
  if (parseScope(authorized.scope).kind !== 'session') throw new DocChannelNotFoundError();
  const source = readSessionDocSourceDescriptor(deps, documentId);
  if (
    parseScope(source.scope).kind !== 'session' ||
    (source.treeKind !== 'agent-cwd' && source.treeKind !== null) ||
    !source.resolvedCwd ||
    !source.sourcePath ||
    !source.rootCandidate ||
    !source.matchRoot
  )
    throw new DocChannelNotFoundError();
  const root = await realRoot(source.rootCandidate);
  if ((await realRoot(source.resolvedCwd)) !== root || (await realRoot(source.matchRoot)) !== root)
    throw new DocChannelNotFoundError();
  // The document's own file must stay inside its root and the boundary. A file
  // that does not is a document this lane will not save, not a server fault.
  const actual = await resolveWithinCwd(source.resolvedCwd, source.sourcePath).catch(
    (error: unknown) => {
      if (error instanceof BoundaryError) throw new DocChannelNotFoundError({ cause: error });
      throw error;
    }
  );
  const channel = deps.channels.getChannel(source.id);
  if (!channel) throw new DocChannelNotFoundError();
  const incarnation: CanvasDocIncarnation = {
    v: 1,
    documentId: source.id,
    physicalOpenedAt: source.openedAt,
    channelCreatedAt: channel.createdAt,
    generation: docDocumentGeneration(source, channel),
  };
  const captured: Capture = { actor, source, incarnation, owner };
  requireCurrentDocumentSaveSource(deps, captured);
  return { captured, canonicalPath: actual.resolved };
}
/** Fixed binding-only capture supports receipt recovery without fabricating a content-bearing PUT. */
export async function captureDocumentSaveBinding(
  deps: DocumentFileSaveDependencies,
  binding: { documentId: string; incarnation: CanvasDocIncarnation },
  caller: DocumentFileSaveCaller,
  identity: CanonicalFileIdentity
): Promise<Capture> {
  const current = await resolveCurrentDocumentSaveSource(deps, binding.documentId, caller);
  if (
    current.canonicalPath !== identity.canonicalPath ||
    !sameCanvasDocIncarnation(current.captured.incarnation, binding.incarnation)
  )
    throw new DocChannelNotFoundError();
  return current.captured;
}
/** Existing save keeps the identical current session/root/path/incarnation checks. */
export async function captureDocumentSaveSource(
  deps: DocumentFileSaveDependencies,
  input: WriteFileRequest,
  caller: DocumentFileSaveCaller,
  identity: CanonicalFileIdentity
): Promise<Capture> {
  if (!input.documentSave) throw new DocChannelNotFoundError();
  return captureDocumentSaveBinding(deps, input.documentSave, caller, identity);
}

/** Recheck only synchronous authoritative rows; safe inside the owning SQLite transaction. */
export function requireCurrentDocumentSaveSource(
  deps: DocumentFileSaveDependencies,
  captured: Capture,
  tx?: DbTransaction
): void {
  if (!sameDocOwnerAuthority(captured.owner, docInstallationOwner(deps.installationId)))
    throw new DocChannelNotFoundError();
  deps.authorization.requireCurrent(captured.source.id, captured.actor, true, tx);
  const source = readSessionDocSourceDescriptor(deps, captured.source.id, tx);
  const channel = deps.channels.getChannel(source.id, tx);
  if (
    !channel ||
    !same(source, captured.source) ||
    docDocumentGeneration(source, channel) !== captured.incarnation.generation ||
    channel.createdAt !== captured.incarnation.channelCreatedAt
  )
    throw new DocChannelNotFoundError();
}

function matches(info: { dev: bigint; ino: bigint }, device: string, inode: string) {
  return String(info.dev) === device && String(info.ino) === inode;
}
function uncertain(): never {
  throw Object.assign(new Error('The original save needs recovery.'), {
    code: 'DOC_SAVE_IN_DOUBT',
    status: 503,
  });
}
/** Mechanically extracted original named-inode read; no receipt or write authority. */
export async function readOriginalDocumentFile(identity: CanonicalFileIdentity): Promise<string> {
  const handle = await fs.open(identity.canonicalPath, 'r');
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || !matches(info, identity.device, identity.inode))
      throw new CanonicalFileIdentityChangedError();
    const content = await handle.readFile('utf8');
    const named = await fs.lstat(identity.canonicalPath, { bigint: true });
    if (!named.isFile() || !matches(named, identity.device, identity.inode))
      throw new CanonicalFileIdentityChangedError();
    return content;
  } finally {
    await handle.close();
  }
}
/** Mechanically extracted exact original replacement verification, without repeating any file effect. */
export async function requireOriginalDocumentFileEffect(
  deps: DocumentFileSaveDependencies,
  row: FileSaveIntentRow,
  captured: Capture
): Promise<void> {
  requireCurrentDocumentSaveSource(deps, captured);
  const path = await resolveWithinCwd(captured.source.resolvedCwd!, captured.source.sourcePath!);
  const handle = await fs.open(path.resolved, 'r');
  try {
    const info = await handle.stat({ bigint: true });
    if (
      path.resolved !== row.canonicalPath ||
      !info.isFile() ||
      !row.replacementDevice ||
      !row.replacementInode ||
      !matches(info, row.replacementDevice, row.replacementInode) ||
      sha256(await handle.readFile('utf8')) !== row.afterHash
    )
      uncertain();
    const named = await fs.lstat(path.resolved, { bigint: true });
    if (!named.isFile() || !matches(named, row.replacementDevice, row.replacementInode))
      uncertain();
    requireCurrentDocumentSaveSource(deps, captured);
  } finally {
    await handle.close();
  }
}
