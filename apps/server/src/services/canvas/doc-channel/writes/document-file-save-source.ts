/** Fixed current operator/session-document source checks. No writes, grants or callback-shaped authority. */
import fs from 'node:fs/promises';
import type { DbTransaction } from '@dorkos/db';
import type { WriteFileRequest } from '@dorkos/shared/schemas';
import {
  sameCanvasDocIncarnation,
  type CanvasDocIncarnation,
} from '@dorkos/shared/canvas-channel-schemas';
import type { RequestFacts } from '../../../../http/request-facts.js';
import { resolveWithinCwd } from '../../../../lib/file-route-guards.js';
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
  if (caller.agentIdentity || Object.hasOwn(caller.headers, 'x-dorkos-agent'))
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

/** Observe the actual confined session source. Main session control_ui records its sole tree as null; both forms still require the registered session root, physical cwd and confined file to agree. */
export async function captureDocumentSaveSource(
  deps: DocumentFileSaveDependencies,
  input: WriteFileRequest,
  caller: DocumentFileSaveCaller,
  identity: CanonicalFileIdentity
): Promise<Capture> {
  if (!input.documentSave) throw new DocChannelNotFoundError();
  const { owner, actor } = captureDocumentSaveOperator(deps, caller);
  const authorized = await deps.authorization.require(input.documentSave.documentId, actor, true);
  if (parseScope(authorized.scope).kind !== 'session') throw new DocChannelNotFoundError();
  const source = readSessionDocSourceDescriptor(deps, input.documentSave.documentId);
  if (
    parseScope(source.scope).kind !== 'session' ||
    (source.treeKind !== 'agent-cwd' && source.treeKind !== null) ||
    !source.resolvedCwd ||
    !source.sourcePath
  )
    throw new DocChannelNotFoundError();
  if (!source.rootCandidate || !source.matchRoot) throw new DocChannelNotFoundError();
  const root = await fs.realpath(source.rootCandidate);
  if (
    (await fs.realpath(source.resolvedCwd)) !== root ||
    (await fs.realpath(source.matchRoot)) !== root
  )
    throw new DocChannelNotFoundError();
  const actual = await resolveWithinCwd(source.resolvedCwd, source.sourcePath);
  if (actual.resolved !== identity.canonicalPath) throw new DocChannelNotFoundError();
  const channel = deps.channels.getChannel(source.id);
  if (!channel) throw new DocChannelNotFoundError();
  const incarnation: CanvasDocIncarnation = {
    v: 1,
    documentId: source.id,
    physicalOpenedAt: source.openedAt,
    channelCreatedAt: channel.createdAt,
    generation: docDocumentGeneration(source, channel),
  };
  if (!sameCanvasDocIncarnation(incarnation, input.documentSave.incarnation))
    throw new DocChannelNotFoundError();
  const captured = { actor, source, incarnation, owner };
  requireCurrentDocumentSaveSource(deps, captured);
  return captured;
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
