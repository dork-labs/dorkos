/**
 * Legacy MCP key seeding — the one-time migration that folds a pre-auth global
 * `dork_mcp_*` key into the per-user Better Auth API key model (accounts-and-auth
 * P1, task 1.4).
 *
 * Before this spec, external MCP access used a single global key stored at
 * `config.mcp.apiKey` (minted by the now-removed `POST /api/config/mcp/generate-key`).
 * The rewritten MCP auth middleware accepts per-user Better Auth API keys instead.
 * To keep an upgrading user's existing MCP clients working without them re-issuing
 * a key, {@link seedLegacyMcpApiKey} takes the exact legacy key value and stores it
 * as an owner-owned Better Auth API key, then clears `config.mcp.apiKey` so the
 * compat path in `middleware/mcp-auth.ts` retires itself.
 *
 * ## Why a direct row insert
 *
 * The installed `@better-auth/api-key` `createApiKey` endpoint always generates the
 * key material itself (its body schema has no `key` field), so it cannot preserve
 * the caller's existing `dork_mcp_*` value. Seeding therefore inserts the row
 * through the Drizzle adapter directly, hashing the plaintext with the plugin's own
 * {@link defaultKeyHasher} (SHA-256 → base64url, no padding) so `verifyApiKey`
 * finds it by the same hashed lookup it uses for plugin-minted keys. Every other
 * column is left to its schema default, which matches what `createApiKey` writes.
 *
 * ## Idempotency and the two seams
 *
 * Seeding is driven twice — once at startup (`index.ts`, after `initAuth`) for an
 * instance whose owner already exists, and once from the owner-creation database
 * hook (`createAuth`) so enabling login mid-upgrade seeds without a restart. Both
 * call this function. It is idempotent: the primary guard is `config.mcp.apiKey`
 * being non-null (cleared in the same operation), and a secondary guard skips the
 * insert when a row with the same hashed key already exists. It never throws — a
 * failure is logged and swallowed so it can never block server startup or owner
 * sign-up.
 *
 * @module services/core/auth/seed-legacy-mcp-key
 */
import { user, apikey, eq, type Db } from '@dorkos/db';
import { defaultKeyHasher } from '@better-auth/api-key';
import { configManager } from '../config-manager.js';
import { logger, logError } from '../../../lib/logger.js';

/** The name attached to the seeded key so it is recognizable in the API-key list UI. */
const SEEDED_KEY_NAME = 'Legacy MCP key';

/**
 * Resolve the owner user id: the sole/first account, preferring `role === 'owner'`.
 * Returns `null` when no user exists yet (the legacy compat window keeps the key
 * working until an owner is created).
 */
function findOwnerId(db: Db): string | null {
  const owner =
    db.select({ id: user.id }).from(user).where(eq(user.role, 'owner')).limit(1).get() ??
    db.select({ id: user.id }).from(user).limit(1).get();
  return owner?.id ?? null;
}

/**
 * Seed a lingering `config.mcp.apiKey` as an owner-owned Better Auth API key, then
 * clear it. No-op (returns early) when there is no legacy key or no owner account.
 * Idempotent and non-throwing — safe to call at startup and from the owner-creation
 * hook.
 *
 * @param db - The server's Drizzle database (the same handle passed to `initAuth`).
 */
export async function seedLegacyMcpApiKey(db: Db): Promise<void> {
  try {
    const mcp = configManager.get('mcp');
    const legacyKey = mcp?.apiKey ?? null;
    // Primary idempotency guard: once seeded (and cleared) there is nothing to do.
    if (!legacyKey) return;

    const ownerId = findOwnerId(db);
    // Without an owner there is no user to own the key. Leave the legacy value in
    // place; the mcp-auth compat window keeps it working until an owner exists.
    if (!ownerId) return;

    const hashed = await defaultKeyHasher(legacyKey);

    // Secondary guard: never create a duplicate row for the same key material
    // (e.g. a prior run that inserted the row but failed before clearing config).
    const existing = db.select({ id: apikey.id }).from(apikey).where(eq(apikey.key, hashed)).get();
    if (!existing) {
      const now = new Date();
      db.insert(apikey)
        .values({
          id: crypto.randomUUID(),
          referenceId: ownerId,
          name: SEEDED_KEY_NAME,
          key: hashed,
          prefix: null,
          start: null,
          enabled: true,
          createdAt: now,
          updatedAt: now,
          // configId, rate-limit fields, requestCount, remaining, expiresAt all
          // take their schema defaults — identical to what createApiKey inserts.
        })
        .run();
    }

    // Clear the legacy value in the same operation so the primary guard trips on
    // every subsequent run. Preserve the rest of the mcp block.
    configManager.set('mcp', { ...mcp, apiKey: null });
    // Never log the key value itself.
    logger.info('[Auth] Seeded legacy MCP API key as an owner-owned Better Auth key');
  } catch (err) {
    logger.error('[Auth] Failed to seed legacy MCP API key', logError(err));
  }
}
