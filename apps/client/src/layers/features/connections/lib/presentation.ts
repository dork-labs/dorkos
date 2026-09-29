/**
 * Presentation lookups for the Connections surface: the human name of a
 * provider on its setup card. Pure data — no copy in here is a custody
 * disclosure (that copy is always the server's).
 *
 * @module features/connections/lib/presentation
 */

/** Human names for the known provider types on their setup cards. */
const PROVIDER_NAMES: Record<string, string> = {
  composio: 'Composio',
  nango: 'Nango',
  'test-connector': 'Test connector',
};

/**
 * The human name of a provider type; an unknown type is title-cased rather
 * than shown as a raw slug.
 *
 * @param type - Provider type, e.g. `'composio'`.
 */
export function providerName(type: string): string {
  const known = PROVIDER_NAMES[type];
  if (known) return known;
  return type.charAt(0).toUpperCase() + type.slice(1);
}
