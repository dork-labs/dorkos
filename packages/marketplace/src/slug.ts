/**
 * Re-export slug utilities from `@dorkos/skills/slug`. Marketplace package
 * names share the same kebab-case validation rules as SKILL.md names, so we
 * surface the existing helpers under a local subpath for discoverability.
 *
 * @module @dorkos/marketplace/slug
 */
export * from '@dorkos/skills/slug';
