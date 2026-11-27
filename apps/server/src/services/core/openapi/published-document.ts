/**
 * Split the full OpenAPI document into the published document and the
 * internal part (ADR `261123-170832`, DOR-4983).
 *
 * - **The published document** (`docs/api/openapi.json`, `/api/openapi.json`
 *   and the site's API pages) holds every operation that is not `internal`,
 *   and every component except those only `internal` operations use.
 * - **The internal part** (`docs/api/openapi-internal.json`) holds the
 *   `internal` operations and the components only they use. It is not a
 *   document on its own: it has no `info`, so a release that bumps `VERSION`
 *   never touches it. The generated client (`packages/api-client`) and the API
 *   lint gate (`scripts/api-lint`) read the two merged
 *   (`scripts/lib/openapi-internal.ts`), because DorkOS's own app calls
 *   internal operations and every operation is held to the same lint rules.
 *
 * Merging the two gives back the full document's paths and components, so
 * nothing is lost and nothing is documented twice.
 *
 * @module services/core/openapi/published-document
 */
import { STABILITY_KEY } from './stability.js';

/** The HTTP methods an OpenAPI path item can hold an operation under. */
const OPERATION_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

/** A component section (`schemas`, `responses`, ...) by component name. */
type ComponentSection = Record<string, unknown>;

/** The slice of an OpenAPI document this module reads. */
export interface SplittableDocument {
  /** The document's paths, each mapping methods to operations. */
  paths?: object;
  /** The document's components, by section. */
  components?: object;
}

/** A document's components, as this module walks them. */
type Components = Record<string, ComponentSection | undefined> | undefined;

/** The internal operations and the components only they use. */
export interface InternalPart {
  /** Each path that has an internal operation, holding only those operations. */
  paths: Record<string, Record<string, unknown>>;
  /** The components only internal operations use, by section. */
  components: Record<string, ComponentSection>;
}

const REF_PREFIX = '#/components/';

/** Every `#/components/<section>/<name>` reference inside a value, as `section/name`. */
function refsIn(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) refsIn(entry, into);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === '$ref' && typeof entry === 'string' && entry.startsWith(REF_PREFIX)) {
      into.add(entry.slice(REF_PREFIX.length));
    } else {
      refsIn(entry, into);
    }
  }
}

/** The components a set of roots uses, following references between components. */
function reachable(roots: unknown[], components: Components): Set<string> {
  const seen = new Set<string>();
  const queue = new Set<string>();
  refsIn(roots, queue);
  while (queue.size > 0) {
    const [next] = queue;
    queue.delete(next!);
    if (seen.has(next!)) continue;
    seen.add(next!);
    const [section, ...name] = next!.split('/');
    const found = new Set<string>();
    refsIn(components?.[section!]?.[name.join('/')], found);
    for (const ref of found) if (!seen.has(ref)) queue.add(ref);
  }
  return seen;
}

/**
 * Split a document that carries `x-stability` on every operation.
 *
 * @param document - The full document, as `generateOpenAPISpec` returns it. Not changed.
 * @returns The published document (a copy) and the internal part.
 */
export function splitPublishedDocument<T extends SplittableDocument>(
  document: T
): { published: T; internal: InternalPart } {
  const publishedPaths: Record<string, object> = {};
  const internalPaths: InternalPart['paths'] = {};
  const publishedOps: unknown[] = [];
  const internalOps: unknown[] = [];
  const components = document.components as Components;
  for (const [path, item] of Object.entries((document.paths ?? {}) as Record<string, object>)) {
    const kept: Record<string, unknown> = {};
    const hidden: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(item ?? {})) {
      const isOperation = OPERATION_METHODS.includes(key);
      const internal =
        isOperation && (entry as Record<string, unknown>)[STABILITY_KEY] === 'internal';
      (internal ? hidden : kept)[key] = entry;
      if (isOperation) (internal ? internalOps : publishedOps).push(entry);
    }
    if (Object.keys(kept).some((key) => OPERATION_METHODS.includes(key))) {
      publishedPaths[path] = kept;
    }
    if (Object.keys(hidden).length > 0) internalPaths[path] = hidden;
  }

  const usedByPublished = reachable(publishedOps, components);
  const usedByInternal = reachable(internalOps, components);
  const publishedComponents: Record<string, ComponentSection> = {};
  const internalComponents: InternalPart['components'] = {};
  for (const [section, entries] of Object.entries(components ?? {})) {
    for (const [name, component] of Object.entries(entries ?? {})) {
      const key = `${section}/${name}`;
      const onlyInternal = usedByInternal.has(key) && !usedByPublished.has(key);
      const target = onlyInternal ? internalComponents : publishedComponents;
      (target[section] ??= {})[name] = component;
    }
  }

  return {
    published: { ...document, components: publishedComponents, paths: publishedPaths },
    internal: { paths: internalPaths, components: internalComponents },
  };
}
