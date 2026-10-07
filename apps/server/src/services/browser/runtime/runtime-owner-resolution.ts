import type { Db } from '@dorkos/db';
import { findOwnerAccount } from '../../core/auth/accounts.js';
import type { AuthorRegistry } from '../../rooms/author-registry.js';
import {
  isServerPrincipal,
  type ServerPrincipalProof,
} from '../../connectors/principal/server-principal.js';

/** Browser resource ownership is separate from connector installation authority.
 * No mapping rewrites the genuine turn claims or its durable binding. */
export interface BrowserRuntimeOwner {
  readonly accountId: string;
  readonly authorId: string;
  current(): boolean;
}
export interface BrowserRuntimeOwnerResolution {
  resolve(
    principal: ServerPrincipalProof,
    originalTurnCurrent: () => boolean
  ): BrowserRuntimeOwner | undefined;
}
/** Construct only in the original mode with the actual boot installation id.
 * The account reader is the auth domain's canonical earliest-owner rule, and
 * the author registry maps that account into the browser's resource namespace.
 * Every later use rereads that current account and its exact original author. */
export function createBrowserRuntimeOwnerResolution(options: {
  db: Db;
  authors: Pick<AuthorRegistry, 'bindOwner' | 'isOwner'>;
  installationId: string | undefined;
  enabled(): boolean;
}): BrowserRuntimeOwnerResolution {
  const db = options.db,
    installationId = options.installationId,
    enabled = options.enabled.bind(options),
    bindOwner = options.authors.bindOwner.bind(options.authors),
    isOwner = options.authors.isOwner.bind(options.authors);
  return Object.freeze({
    resolve(principal: ServerPrincipalProof, originalTurnCurrent: () => boolean) {
      if (!isServerPrincipal(principal) || principal.claims.kind !== 'runtime') return;
      const original = principal.claims.owner;
      if (
        original.kind === 'local_install' &&
        (!installationId || original.installationId !== installationId)
      )
        return;
      const guard = () => enabled() && originalTurnCurrent() && enabled();
      if (!guard()) return;
      const account = findOwnerAccount(db);
      if (!account || !guard() || (original.kind === 'user' && original.userId !== account.id))
        return;
      const author = bindOwner(account.id);
      if (!guard() || !isOwner(author.id, account.id)) return;
      const current = () => {
        if (!guard()) return false;
        const actual = findOwnerAccount(db);
        if (actual?.id !== account.id || !guard()) return false;
        return isOwner(author.id, account.id) && guard();
      };
      if (!current()) return;
      return Object.freeze({
        accountId: account.id,
        authorId: author.id,
        current,
      });
    },
  });
}
