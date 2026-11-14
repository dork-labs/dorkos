import type { CatalogEntry, CatalogInstance } from '@dorkos/shared/relay-schemas';

/** Chat app types whose direct messages can be open to anyone. */
const OPEN_DM_TYPES = new Set(['slack', 'telegram']);

/**
 * Whether an enabled Slack or Telegram connection accepts messages from anyone.
 *
 * An open policy stays open even when an allowlist is present because the list
 * is ignored until the policy changes.
 *
 * @param entry - The chat app's catalog entry.
 * @param instance - The configured connection.
 */
export function isOpenToAnyone(entry: CatalogEntry, instance: CatalogInstance): boolean {
  return (
    instance.enabled &&
    OPEN_DM_TYPES.has(entry.manifest.type) &&
    instance.config?.dmPolicy === 'open'
  );
}

/**
 * Whether an enabled Slack or Telegram connection is limited to a list with
 * nobody on it, so no one can message it privately. A chat turned back on
 * lands here when nobody was listed before (DOR-3859).
 *
 * @param entry - The chat app's catalog entry.
 * @param instance - The configured connection.
 */
export function hasNoOneListed(entry: CatalogEntry, instance: CatalogInstance): boolean {
  const list = instance.config?.dmAllowlist;
  return (
    instance.enabled &&
    OPEN_DM_TYPES.has(entry.manifest.type) &&
    instance.config?.dmPolicy === 'allowlist' &&
    (!Array.isArray(list) || list.length === 0)
  );
}
