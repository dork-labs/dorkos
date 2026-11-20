/**
 * The owner's second ways to prove a sign-in from another device (DOR-3647):
 * an authenticator app's code (TOTP) or a passkey.
 *
 * One row per factor. An authenticator row holds its shared secret sealed with
 * a key derived from the server's signing secret, never in the clear, and
 * counts only once `confirmedAt` is set (the owner typed one good code). A
 * passkey row holds its public key, the relying party it was made for (the
 * host the owner added it on) and the signature counter last seen.
 *
 * @module db/schema/owner/owner-factors
 */
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { user } from '../auth.js';

export const ownerFactors = sqliteTable(
  'owner_factors',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** `totp` or `passkey`. */
    kind: text('kind', { enum: ['totp', 'passkey'] }).notNull(),
    /** What the owner called it. */
    label: text('label').notNull(),
    /** TOTP only: the sealed shared secret. */
    sealedSecret: text('sealed_secret'),
    /** TOTP only: the last time step a code was accepted for, so no code works twice. */
    lastStep: integer('last_step'),
    /** Passkey only: the credential id, base64url. */
    credentialId: text('credential_id'),
    /** Passkey only: the COSE public key, base64url. */
    publicKey: text('public_key'),
    /** Passkey only: its COSE algorithm. */
    alg: integer('alg'),
    /** Passkey only: the signature counter last seen. */
    signCount: integer('sign_count'),
    /** Passkey only: the relying party id (a host name) it was made for. */
    rpId: text('rp_id'),
    /** When the factor counts. Null for an authenticator not yet confirmed. */
    confirmedAt: integer('confirmed_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    index('owner_factors_user_idx').on(table.userId),
    uniqueIndex('owner_factors_credential_idx').on(table.credentialId),
  ]
);
