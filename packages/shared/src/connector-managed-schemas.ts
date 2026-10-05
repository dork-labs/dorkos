/**
 * Re-export of `@dork-labs/connector-providers/connector-managed-schemas`, kept so the
 * `@dorkos/shared/connector-managed-schemas` subpath stays one import for everything in this repo.
 *
 * The module itself lives in `packages/connector-providers`, which publishes it
 * so hosted services can read the same connector contract without this
 * private package. Edit it there; this file only forwards it.
 *
 * @module shared/connector-managed-schemas
 */
export * from '@dork-labs/connector-providers/connector-managed-schemas';
