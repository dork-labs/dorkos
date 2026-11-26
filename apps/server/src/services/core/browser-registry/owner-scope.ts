/**
 * The shapes of browser metadata ownership the registry consumes. No browser
 * or grant authority is issued here.
 *
 * Who owns the metadata is decided on the space side, where the person bars
 * and the room author registry are read (`owner/owner-scope-resolver.ts`), and the
 * registry is handed that resolver; it only consumes the scopes it makes
 * (spec `computer-side-starts-alone` §5.12).
 *
 * @module services/core/browser-registry/owner-scope
 */
import type { RequestFacts } from '../../../http/request-facts.js';

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

/** Resolve, consume once, and retire operations over private scope membership. */
export interface BrowserOwnerScopeResolver {
  /** Apply the person, owner and local bars before resolving the operator author. */
  resolve(caller: RequestFacts): BrowserOwnerScope | null;
  /** Consume before returning metadata; no repeat, foreign resolver or JSON adoption. */
  consume(scope: unknown): BrowserOwnerNamespace | null;
  /** Synchronously invalidate all outstanding scopes and refuse future resolution. */
  retire(): void;
}
