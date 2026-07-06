/**
 * A schema-only Better Auth plugin registering the device-link `instance` model
 * (accounts-and-auth P2).
 *
 * The instance registry is written and read exclusively through Better Auth's
 * database adapter (`auth.$context.adapter`) so the same code path runs against
 * the production Postgres Drizzle adapter and the in-memory adapter tests use.
 * Declaring the model here (rather than only as a Drizzle table) is what makes
 * the adapter aware of the `instance` model — its field names, types, and the
 * intra-account `userId` foreign key. The heartbeat, registry, and revoke
 * endpoints all resolve `model: 'instance'` through this declaration.
 *
 * It ships no endpoints: heartbeat, listing, and revocation are Next.js route
 * handlers under `app/api/instances/*`, not Better Auth routes.
 *
 * @module lib/instance-registry-plugin
 */
import type { BetterAuthPlugin } from 'better-auth';

/** The Better Auth model name for the instance registry table. */
export const INSTANCE_MODEL = 'instance';

/**
 * Better Auth plugin that declares the `instance` table schema so the database
 * adapter can create, find, update, and (via the isolated cluster FK) cascade it
 * with the account tables. Field names mirror `db/instance-schema.ts` exactly.
 */
export function instanceRegistry(): BetterAuthPlugin {
  return {
    id: 'instance-registry',
    schema: {
      instance: {
        fields: {
          userId: {
            type: 'string',
            required: true,
            references: { model: 'user', field: 'id', onDelete: 'cascade' },
          },
          name: { type: 'string', required: true },
          platform: { type: 'string', required: true },
          dorkosVersion: { type: 'string', required: true },
          createdAt: { type: 'date', required: true },
          lastSeenAt: { type: 'date', required: true },
          revokedAt: { type: 'date', required: false },
        },
      },
    },
  };
}
