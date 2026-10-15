/** Fixed current native owner/member/grant prerequisites. No actor is restored. */
import type { Db } from '@dorkos/db';
import { requireServerNativeDatabaseQueryCustody } from '@dorkos/db/internal-server';
import type { OriginalDocTokenCapsuleData } from './token-native-data.js';
import type { OriginalNativeDocTokenHeader } from './token-store.js';
const apply = Reflect.apply;
const define = Object.defineProperty,
  freeze = Object.freeze;
function refuse(): never {
  throw new Error('Original document token source is unavailable');
}
/** Captured statements are private; the original engine alone combines these facts with provenance. */
export function createOriginalDocTokenCurrentReader(db: Db) {
  requireServerNativeDatabaseQueryCustody(db);
  const client = db.$client,
    prepare = client.prepare;
  const fixed = (text: string) => apply(prepare, client, [text]);
  const identityBlocked = fixed(`SELECT 1 FROM main.canvas_doc_identity_intents
    WHERE (document_id=? AND status<>'applied') OR (from_scope=? AND to_scope<>from_scope) LIMIT 1`);
  const membership = fixed(`SELECT r.id,r.archived,a.id AS author_id FROM main.rooms r
    JOIN main.room_members m ON m.room_id=r.id JOIN main.authors a ON a.id=m.author_id
    WHERE r.id=? AND a.kind='human' AND a.natural_key=? AND a.retired_at IS NULL LIMIT 2`);
  const grant =
    fixed(`SELECT grant_id FROM main.canvas_doc_grants WHERE document_id=? AND grant_id=?
    AND revoked_at IS NULL AND julianday(expires_at) IS NOT NULL
    AND julianday(expires_at)>julianday('now') LIMIT 1`);
  const privateTarget = fixed(`SELECT a.id FROM main.agents a JOIN main.session_metadata s
    ON s.session_id=? AND s.agent_path=a.project_path AND s.runtime=a.runtime
    WHERE a.id=? AND a.status='active' AND a.runtime=? LIMIT 1`);
  const roomTarget = fixed(`SELECT r.id FROM main.rooms r
    JOIN main.room_members m ON m.room_id=r.id
    JOIN main.authors au ON au.id=m.author_id AND au.kind='agent' AND au.retired_at IS NULL
    JOIN main.agents a ON a.project_path=au.natural_key AND a.id=au.minted_for_manifest_id
    JOIN main.room_sessions rs ON rs.room_id=r.id AND rs.author_id=au.id
    JOIN main.session_metadata sm ON sm.session_id=rs.session_id AND sm.agent_path=a.project_path AND sm.runtime=a.runtime
    WHERE r.id=? AND r.archived=0 AND a.id=? AND a.status='active' AND a.runtime=? AND rs.session_id=?
    AND NOT EXISTS(SELECT 1 FROM main.community_room_mirrors c WHERE c.local_room_id=r.id) LIMIT 2`);
  const identityGet = identityBlocked.get;
  const memberAll = membership.all,
    grantGet = grant.get,
    privateGet = privateTarget.get,
    roomAll = roomTarget.all;
  return (
    header: OriginalNativeDocTokenHeader,
    data: OriginalDocTokenCapsuleData,
    installationId: string | undefined
  ) => {
    requireServerNativeDatabaseQueryCustody(db);
    // Pending/unknown ownership and even completed moved canonical sources need
    // a fresh genuinely issued binding; the old immutable capsule is not rewritten.
    if (apply(identityGet, identityBlocked, [header.documentId, header.scope])) refuse();
    if (
      data.owner.kind === 'local_install' &&
      (!installationId || installationId !== data.owner.installationId || data.facts.owner !== null)
    )
      refuse();
    const roomId = header.scope.slice(0, 5) === 'room:' ? header.scope.slice(5) : undefined;
    if (!roomId && header.scope.slice(0, 8) !== 'session:') refuse();
    if (roomId) {
      const key = data.owner.kind === 'user' ? 'user:' + data.owner.userId : 'local';
      const members = apply(memberAll, membership, [roomId, key]);
      if (members.length !== 1) refuse();
      const member = members[0];
      if (
        !member ||
        typeof member !== 'object' ||
        !('id' in member) ||
        member.id !== roomId ||
        !('archived' in member)
      )
        refuse();
      for (let index = 0; index < data.permissions.length; index++)
        if (data.permissions[index] === 'ingest' && member.archived !== 0) refuse();
    }
    for (let index = 0; index < data.grantIds.length; index++) {
      const id = data.grantIds[index]!;
      if (!apply(grantGet, grant, [header.documentId, id])) refuse();
      let selected: (typeof data.facts.grants)[number] | undefined;
      for (let row = 0; row < data.facts.grants.length; row++)
        if (data.facts.grants[row]!.grant_id === id) selected = data.facts.grants[row];
      if (!selected) refuse();
      const agentId = selected.target_agent_id,
        sessionId = selected.target_session_id,
        runtime = selected.target_runtime;
      if (agentId !== null || sessionId !== null || runtime !== null) {
        if (
          typeof agentId !== 'string' ||
          typeof sessionId !== 'string' ||
          typeof runtime !== 'string'
        )
          refuse();
        if (roomId) {
          if (apply(roomAll, roomTarget, [roomId, agentId, runtime, sessionId]).length !== 1)
            refuse();
        } else if (!apply(privateGet, privateTarget, [sessionId, agentId, runtime])) refuse();
      }
    }
    requireServerNativeDatabaseQueryCustody(db);
  };
}
