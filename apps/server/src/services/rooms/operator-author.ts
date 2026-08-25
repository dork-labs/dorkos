/**
 * Who "the person at the keyboard" is, in one place (DOR-691).
 *
 * Five surfaces resolved this independently and identically — the room routes'
 * `resolveCaller` in its last branch, the MCP capability layer's `callerAuthor`
 * in its last branch, the local community's viewer, the server's own boot
 * wiring, and the test-control route — and a sixth was about to: the Obsidian
 * embed, which has no request to resolve a caller FROM and is the operator by
 * construction. Six copies of an access rule is five chances for one of them to
 * drift, and search is precisely where a drifted copy would be a disclosure
 * rather than a bug.
 *
 * @module server/services/rooms/operator-author
 */
import { readOwnerAccount } from '../core/auth/index.js';
import type { AuthorRegistry, AuthorRecord } from './author-registry.js';

/**
 * The author row the person operating this install acts as.
 *
 * **`bindOwner` rather than a plain lookup**, which is what rebinds the unbound
 * `'local'` sentinel onto their account the first time they ask for anything —
 * so an install that gains a login does not strand the rooms, memberships and
 * read cursors that were already there. An install with no owner yet resolves to
 * the `'local'` author, which is the same row `bindOwner` will later adopt.
 *
 * **It answers who, never whether.** It does not ask if login is on, and it does
 * not decide that this caller IS the operator — every caller has already settled
 * that for itself before reaching here (a request by exhausting its identity
 * branches, the embed by being a window on the operator's own machine). Calling
 * it is the claim; this function only spells the answer.
 *
 * @param registry - The author registry to resolve through.
 * @returns The operator's author record.
 */
export function resolveOperatorAuthor(registry: AuthorRegistry): AuthorRecord {
  const owner = readOwnerAccount();
  return owner ? registry.bindOwner(owner.id) : registry.localHuman();
}
