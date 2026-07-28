/**
 * Which account owns this install (ADR 260727-184933 D6).
 *
 * The local install is single-user and stays that way: the registration policy
 * in `./index.ts` opens sign-up only while the `user` table is empty and refuses
 * every later attempt, permanently. So there is exactly one account, it is the
 * earliest one, and it is the owner.
 *
 * **The `role` column is not read here, and that is the point.** It used to be
 * preferred, with the earliest row as a fallback — which was worse than either
 * rule alone. A database state where the owner's stamp was blanked and a second
 * row carried one (a broken migration, a future bug) satisfied the first query
 * and never reached the fallback, so it handed the install to the wrong account:
 * the owner would have lost every room, every setting and every gated route on
 * their own machine. Ordering by creation is what the registration policy
 * actually guarantees, so it is the only thing worth reading, and no write to
 * `user.role` can move ownership.
 *
 * A pure reader over an injected `Db`, mirroring `exposure-guard.ts`: the
 * request-time form that reaches for the initialized singleton lives in
 * `./index.ts` next to {@link hasAnyUser}, which it is the sibling of.
 *
 * @module services/core/auth/accounts
 */
import { user, asc, type Db } from '@dorkos/db';

/** One local account, reduced to what a caller outside auth ever needs. */
export interface Account {
  /** The Better Auth user id. Opaque, random, and stable for the account's life. */
  id: string;
  /** The account's display name — what a room roster renders. */
  name: string;
}

/**
 * The account that owns this install, or `null` when nobody has registered yet.
 *
 * The earliest account, unconditionally — see the module doc for why `role` is
 * not consulted. `createdAt` makes the answer deterministic rather than whatever
 * the table happens to return first, which matters only for a database the
 * registration policy could not have produced.
 *
 * @param db - The consolidated DB handle.
 */
export function findOwnerAccount(db: Db): Account | null {
  return (
    db
      .select({ id: user.id, name: user.name })
      .from(user)
      .orderBy(asc(user.createdAt))
      .limit(1)
      .get() ?? null
  );
}
