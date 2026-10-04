/** Server-resolved metadata ownership. No browser or grant authority is issued here. */
import type { Request, Response } from 'express';
import { isLocalCaller, refuseUnlessAccountOwner } from '../../../lib/caller-authority.js';
import { readOwnerAccount } from '../auth/index.js';
import { configManager } from '../config-manager.js';
import { getRoomService } from '../../rooms/index.js';
import { resolveOperatorAuthor } from '../../rooms/operator-author.js';

declare const ownerScopeBrand: unique symbol;
/** Opaque one-use scope; structural/serialized copies have no private membership. */
export interface BrowserOwnerScope {
  readonly [ownerScopeBrand]: true;
}
/** Stable existing operator author namespace, not an engine capability or lease. */
export interface BrowserOwnerNamespace {
  readonly ownerAuthorId: string;
  readonly posture: 'signedInOwner' | 'localOperator';
}

/**
 * Construct a resolver in trusted server composition, after auth and rooms boot.
 * It accepts real server Request/Response objects after sessionGate; request
 * body owner/actor fields are never read. Under login-off, the established local
 * trust and insecure-bind deployment residuals remain, without a human-proof
 * claim. The existing author registry preserves the local author's ID when the
 * install gains an owner account. This module does not wire a route or engine.
 *
 * A consumed namespace is a metadata snapshot only. Future writes/dispatch must
 * resolve current access again; it is not durable authorization or grant scope.
 * @returns Resolve, consume once, and retire operations over private membership.
 */
export function createBrowserOwnerScopeResolver() {
  const scopes = new WeakMap<object, BrowserOwnerNamespace>();
  let retired = false;
  return Object.freeze({
    /** Apply existing person/owner/local bars before resolving the operator author. */
    resolve(req: Request, res: Response): BrowserOwnerScope | null {
      if (retired) return null;
      try {
        const loginEnabled = configManager.get('auth')?.enabled === true;
        if (refuseUnlessAccountOwner(req, res) !== undefined) return null;
        if (!loginEnabled && !isLocalCaller(req)) return null;
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
          (configManager.get('auth')?.enabled === true) !== loginEnabled ||
          (readOwnerAccount()?.id ?? null) !== ownerId ||
          refuseUnlessAccountOwner(req, res) !== undefined ||
          (!loginEnabled && !isLocalCaller(req)) ||
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
