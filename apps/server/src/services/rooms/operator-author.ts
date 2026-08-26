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

/**
 * The same answer, for a caller that may not write (DOR-1563).
 *
 * {@link resolveOperatorAuthor} mints. That is right for every caller that can
 * write — it is what adopts the `'local'` sentinel onto a new account — and
 * impossible for one that cannot: the Obsidian embed opens the database
 * read-only so it can never be a second writer to DorkOS's own file, and a mint
 * there raises "attempt to write a readonly database" on every search.
 *
 * So this asks the same question of the same two natural keys and answers `null`
 * where the other would have created a row. **It resolves the owner branch and
 * the unowned branch separately, exactly as its twin does**, so a reader cannot
 * end up searching as somebody the writer would not have been.
 *
 * `null` is a database no DorkOS has ever booted against — it mints this row
 * itself — and a caller that gets one should refuse rather than pick an
 * identity.
 *
 * @param registry - The author registry to look in.
 * @returns The operator's author record, or `null` when it does not exist yet.
 */
export function peekOperatorAuthor(registry: AuthorRegistry): AuthorRecord | null {
  return registry.peekOperator(readOwnerAccount()?.id ?? null);
}
