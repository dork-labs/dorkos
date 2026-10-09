import { eq, session, type Db } from '@dorkos/db';
import { fromNodeHeaders, type Auth } from '../../../core/auth/index.js';
import { findOwnerAccount } from '../../../core/auth/accounts.js';
import type { ConfigManager } from '../../../core/config-manager.js';
import { BrokerError } from '../../egress/broker/errors.js';
const refusals = new WeakSet<object>();
export const isOriginalActivationRefusal = (value: unknown) =>
  typeof value === 'object' && value !== null && refusals.has(value);
function refuse(): BrokerError {
  const value = new BrokerError('AUTHORITY_REFUSED');
  refusals.add(value);
  return value;
}
/** Only actual cookie-authenticated owner facts are admitted; Off uses no native/runtime import. */
export function createActivationAuthentication(
  db: Db,
  config: ConfigManager,
  getAuth: () => Auth | undefined,
  alive: () => boolean
) {
  const get = config.get.bind(config),
    select = db.select.bind(db);
  return async (cookie: string | undefined, signal: AbortSignal): Promise<() => boolean> => {
    const guard = () => get('auth').enabled === true && alive() && !signal.aborted;
    if (!guard() || Buffer.byteLength(cookie ?? '') > 8192) throw refuse();
    const auth = getAuth();
    if (!auth) throw refuse();
    const api = auth.api,
      getSession = api.getSession.bind(api);
    if (!guard()) throw refuse();
    const result = await getSession({
      headers: fromNodeHeaders({ cookie }),
      query: { disableCookieCache: true, disableRefresh: true },
    });
    if (!guard()) throw refuse();
    const owner = findOwnerAccount(db),
      id = result?.session?.id;
    const credential = id ? select().from(session).where(eq(session.id, id)).get() : undefined;
    if (
      !owner ||
      !credential ||
      result?.user?.id !== owner.id ||
      credential.userId !== owner.id ||
      credential.expiresAt.getTime() <= Date.now()
    )
      throw refuse();
    const original = JSON.stringify(credential),
      ownerId = owner.id;
    const current = () => {
      // All original configuration/lifetime callbacks precede final exact SQL credential reads.
      if (!guard()) return false;
      const account = findOwnerAccount(db),
        observed = select().from(session).where(eq(session.id, credential.id)).get();
      return (
        !signal.aborted &&
        account?.id === ownerId &&
        !!observed &&
        observed.expiresAt.getTime() > Date.now() &&
        JSON.stringify(observed) === original
      );
    };
    if (!current()) throw refuse();
    return current;
  };
}
