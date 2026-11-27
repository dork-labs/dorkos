/**
 * Read the whole DorkOS API description: the published document plus its
 * internal part (ADR `261123-170832`, DOR-4983).
 *
 * `docs/api/openapi.json` is the published document: the site's API pages
 * come from it, and it leaves out every `internal` operation.
 * `docs/api/openapi-internal.json` holds those operations and the components
 * only they use, with no `info` of its own. DorkOS's own app calls internal
 * operations, and the API lint gate holds them to the same rules, so this
 * generator and `scripts/api-lint` read the two merged. The server writes both
 * (`scripts/export-openapi.ts`, `splitPublishedDocument`), so merging them
 * gives back the full document's paths and components.
 *
 * @module api-client/scripts/api-document
 */

/** The published document, relative to the repo root. */
export const PUBLISHED_DOCUMENT_PATH = 'docs/api/openapi.json';

/** The internal operations and the components only they use, relative to the repo root. */
export const INTERNAL_PART_PATH = 'docs/api/openapi-internal.json';

/** The slice of an OpenAPI document the merge reads. */
export interface MergeableDocument {
  /** The paths, each mapping methods to operations. */
  paths?: object;
  /** The components, by section. */
  components?: object;
}

/** Copy `extra`'s entries onto `base`'s, refusing a key both hold. */
function mergeRecords(
  base: Record<string, unknown> | undefined,
  extra: Record<string, unknown> | undefined,
  where: string
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (key in merged) throw new Error(`${where} ${key} is in both API document files.`);
    merged[key] = value;
  }
  return merged;
}

/**
 * Merge the internal part into the published document.
 *
 * @param published - The published document. Not changed.
 * @param internal - The internal part. Not changed.
 * @returns The full document: the published one with the internal operations
 *   and components added.
 * @throws If both files hold one operation or one component.
 */
export function mergeInternalPart<T extends MergeableDocument>(
  published: T,
  internal: MergeableDocument
): T {
  const paths: Record<string, unknown> = { ...published.paths };
  for (const [path, item] of Object.entries((internal.paths ?? {}) as Record<string, unknown>)) {
    paths[path] = mergeRecords(
      paths[path] as Record<string, unknown> | undefined,
      item as Record<string, unknown>,
      path
    );
  }
  const components: Record<string, unknown> = { ...published.components };
  for (const [section, entries] of Object.entries(
    (internal.components ?? {}) as Record<string, unknown>
  )) {
    components[section] = mergeRecords(
      components[section] as Record<string, unknown> | undefined,
      entries as Record<string, unknown>,
      `components.${section}`
    );
  }
  return { ...published, paths, components };
}
