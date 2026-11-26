/**
 * Server-resolved browser metadata ownership. No browser or grant authority is
 * issued here. The browser registry on the computer side consumes the scopes
 * this makes (`../owner-scope.ts`); the person bars and the operator author are
 * read here, in a folder the side map files on the space side (spec
 * `computer-side-starts-alone` §5.12).
 *
 * @module services/core/browser-registry/owner/owner-scope-resolver
 */
import type { RequestFacts } from '../../../../http/request-facts.js';
import { refuseUnlessAccountOwner } from '../../../../lib/caller-authority.js';
import { readOwnerAccount } from '../../auth/index.js';
import { getRoomService } from '../../../rooms/index.js';
import { resolveOperatorAuthor } from '../../../rooms/operator-author.js';
import { credentialGated, isAtThisComputer } from '../../auth/gate-policy.js';
import type {
  BrowserOwnerNamespace,
  BrowserOwnerScope,
  BrowserOwnerScopeResolver,
} from '../owner-scope.js';

/**
 * Construct a resolver in trusted server composition, after auth and rooms boot.
 * It accepts a request's facts after the session gate (`honoRequestFacts`);
 * request body owner/actor fields are never read. Under login-off, the established local
 * trust and insecure-bind deployment residuals remain, without a human-proof
 * claim. The existing author registry preserves the local author's ID when the
 * install gains an owner account. This module does not wire a route or engine.
 *
 * A consumed namespace is a metadata snapshot only. Future writes/dispatch must
 * resolve current access again; it is not durable authorization or grant scope.
 * @returns Resolve, consume once, and retire operations over private membership.
 */
export function createBrowserOwnerScopeResolver(): BrowserOwnerScopeResolver {
  const scopes = new WeakMap<object, BrowserOwnerNamespace>();
  let retired = false;
  return Object.freeze({
    /** Apply existing person/owner/local bars before resolving the operator author. */
    resolve(caller: RequestFacts): BrowserOwnerScope | null {
      if (retired) return null;
      try {
        const loginEnabled = credentialGated(caller);
        if (refuseUnlessAccountOwner(caller) !== undefined) return null;
        if (!loginEnabled && !isAtThisComputer(caller)) return null;
        const ownerId = readOwnerAccount()?.id ?? null;
        const author = resolveOperatorAuthor(getRoomService().authorRegistry);
        const ownerAuthorId = author.id;
        if (
          author.kind !== 'human' ||
          typeof ownerAuthorId !== 'string' ||
          !ownerAuthorId ||
          author.naturalKey !== (ownerId === null ? 'local' : `user:${ownerId}`)
        )
          return null;
        // Author resolution can observe storage. Recheck the actual bars and
        // ownership correspondence before publishing any private scope.
        if (
          credentialGated(caller) !== loginEnabled ||
          (readOwnerAccount()?.id ?? null) !== ownerId ||
          refuseUnlessAccountOwner(caller) !== undefined ||
          (!loginEnabled && !isAtThisComputer(caller)) ||
          retired
        )
          return null;
        const scope = Object.freeze({}) as BrowserOwnerScope;
        scopes.set(
          scope,
          Object.freeze({
            ownerAuthorId,
            posture: loginEnabled ? 'signedInOwner' : 'localOperator',
          })
        );
        return scope;
      } catch {
        return null;
      }
    },
    /** Consume before returning metadata; no repeat, foreign resolver or JSON adoption. */
    consume(scope: unknown): BrowserOwnerNamespace | null {
      if (retired || typeof scope !== 'object' || scope === null) return null;
      const namespace = scopes.get(scope);
      if (!namespace) return null;
      scopes.delete(scope);
      return namespace;
    },
    /** Synchronously invalidate all outstanding scopes and refuse future resolution. */
    retire(): void {
      retired = true;
    },
  });
}
