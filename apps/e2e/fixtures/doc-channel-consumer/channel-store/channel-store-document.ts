/** Real protected-source fixture composition. No browser/page can select an actor or issuer. */

import type { NativeConsumerResume } from '../channel-store.js';
import { requireOriginalConsumerRoom } from '../channel-store.js';
import { extendOriginalConsumerPhase } from './channel-store-phase-data.js';
/** Exact sequential original constructor phase; requires its inaccessible original key. */
export async function constructOriginalConsumerDocument(ownerKey: object) {
  const context = requireOriginalConsumerRoom(ownerKey);
  const {
    vault,
    dashboardUrl,
    target,
    resume,
    frameMode,
    agents,
    authors,
    eq,
    resolveOperatorAuthor,
    replayServiceCurrentDoc,
    db,
    installationId,
    agentId,
    sessionId,
    now,
    rooms,
    approvals,
    http,
  } = context;
  const actor = http.actor({ headers: {}, user: undefined, agentIdentity: undefined });
  let roomId: string | undefined = resume?.roomId;
  let authorId = resume?.authorId ?? resolveOperatorAuthor(rooms.authors).id;
  let roomAgentAuthorId: string | undefined = resume?.roomAgentAuthorId;
  let scope = resume?.scope ?? 'session:' + sessionId;
  if (target === 'room' && !resume) {
    const human = resolveOperatorAuthor(rooms.authors);
    const room = rooms.service.createRoom(
      { kind: 'channel', slug: 'temporary-consumer-room', members: [], agentPaths: [vault.root] },
      human.id
    );
    const member = db.select().from(authors).where(eq(authors.naturalKey, vault.root)).get();
    if (!member || member.mintedForManifestId !== agentId)
      throw new Error('Original Room member unavailable');
    rooms.store.bindRoomSession(room.id, member.id, sessionId, now);
    roomAgentAuthorId = member.id;
    roomId = room.id;
    authorId = human.id;
    scope = 'room:' + room.id;
  }
  const documentId =
    resume?.documentId ??
    rooms.canvas.open(
      scope,
      authorId,
      { type: 'browser', url: dashboardUrl, title: 'Temporary task dashboard' },
      {
        tree: {
          resolvedCwd: vault.root,
          treeKind: 'agent-cwd',
          sourceLabel: null,
          aheadOfMain: null,
        },
      }
    ).id;
  if (!resume && frameMode === 'routed') {
    http.grants.configure(
      documentId,
      {
        routes: [
          {
            id: 'consumer',
            on: 'task.*',
            to: target === 'room' ? 'room:self' : 'agent:owner',
            turn: { mode: 'coalesce', windowMs: 1000, maxBatch: 100 },
          },
        ],
      },
      actor,
      agentId
    );
  }
  const granted =
    frameMode === 'routed'
      ? (() => {
          const request = {
            documentId,
            routeId: 'consumer',
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          };
          const resumeGrantId = resume?.grantId;
          if (resume && !resumeGrantId)
            throw new Error('Original approved resume grant unavailable');
          const existingGrant = resumeGrantId ? http.channels.getGrant(resumeGrantId) : undefined;
          if (
            resume &&
            (!existingGrant ||
              existingGrant.documentId !== documentId ||
              (target === 'room' && existingGrant.revokedAt !== null))
          )
            throw new Error('Original approved grant unavailable after restart');
          const pending =
            resume && existingGrant
              ? { kind: 'granted' as const, grant: existingGrant }
              : http.grants.grant(request, actor);
          let granted = pending;
          if (pending.kind === 'approval_required') {
            approvals.grant(pending.ticket.approvalId);
            granted = http.grants.grant(request, actor, pending.ticket.token);
          }
          if (granted.kind !== 'granted') throw new Error('Genuine consumed grant unavailable');
          return granted;
        })()
      : undefined;
  const initial = await replayServiceCurrentDoc(http.service, documentId, actor);
  if (
    !initial.incarnation ||
    initial.incarnation.documentId !== documentId ||
    initial.scope !== scope
  )
    throw new Error('Genuine original replay birth/scope unavailable');
  if (resume && JSON.stringify(initial.incarnation) !== resume.birthJson)
    throw new Error('Original native document birth changed across restart');
  const resumeRecord: NativeConsumerResume = resume ?? {
    owner: undefined,
    closed: false,
    used: false,
    vault,
    dashboardUrl,
    installationId,
    agentId,
    sessionId,
    documentId,
    roomId,
    authorId,
    roomAgentAuthorId,
    scope,
    grantId: granted?.grant.grantId,
    birthJson: JSON.stringify(initial.incarnation),
  };
  resumeRecord.closed = false;

  return extendOriginalConsumerPhase(context, {
    actor,
    get roomId() {
      return roomId;
    },
    set roomId(value: typeof roomId) {
      roomId = value;
    },
    get authorId() {
      return authorId;
    },
    set authorId(value: typeof authorId) {
      authorId = value;
    },
    get roomAgentAuthorId() {
      return roomAgentAuthorId;
    },
    set roomAgentAuthorId(value: typeof roomAgentAuthorId) {
      roomAgentAuthorId = value;
    },
    get scope() {
      return scope;
    },
    set scope(value: typeof scope) {
      scope = value;
    },
    documentId,
    granted,
    initial,
    resumeRecord,
  });
}
