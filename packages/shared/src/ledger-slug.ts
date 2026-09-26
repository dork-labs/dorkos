/**
 * The slug rule of the usage ledger contract (flow-cli-core §1.2), shared by
 * the ledger's key helpers and the Codex mapping. A leaf module, so both can
 * import it without importing each other.
 *
 * @module shared/ledger-slug
 */

/**
 * Slug a name for a ledger key (`model:<slug>`, `credits:<slug>`,
 * `rate_limit:<slug>`), per the contract: lowercase, every run outside
 * `[a-z0-9._-]` becomes `-`, anything but a letter or digit trimmed from the
 * start and `-` from the end. `'GPT-5.3-Codex-Spark'` →
 * `'gpt-5.3-codex-spark'`. `null` when nothing is left.
 *
 * @param name - The name as the source reported it.
 */
export function ledgerSlug(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '');
  return slug === '' ? null : slug;
}
