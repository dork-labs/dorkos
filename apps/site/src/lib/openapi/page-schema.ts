import type { GeneratedPageProps } from 'fumadocs-openapi';
import type { OpenAPIPageProps_Preloaded } from 'fumadocs-openapi/server';

type Preloaded = OpenAPIPageProps_Preloaded['preloaded'];
type Document = Preloaded['docs'][string];
type ObjectNode = Record<string, unknown>;
const methods = new Set([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
  'query',
]);

function object(value: unknown): value is ObjectNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Send only this page's operations and their reference closure across the RSC
 * boundary. The cached bundled document and the raw OpenAPI download stay intact.
 * Root metadata, path-level inheritance and named security schemes are retained.
 */
export function projectOpenAPIPage(preloaded: Preloaded, page: GeneratedPageProps): Preloaded {
  const document = preloaded.docs[page.document];
  if (!document) throw new Error(`OpenAPI document not preloaded: ${page.document}`);
  return {
    ...preloaded,
    docs: { [page.document]: projectDocument(document, page) },
  };
}

function projectDocument(document: Document, page: GeneratedPageProps): Document {
  const original = document as unknown as ObjectNode;
  const projected: ObjectNode = Object.fromEntries(
    Object.entries(original).filter(([key]) => !['paths', 'webhooks', 'components'].includes(key))
  );
  const pending: unknown[] = Object.values(projected);
  const visited = new WeakSet<object>();
  const references = new Set<string>();
  let requiresFullDocument = false;

  function group(name: string): ObjectNode {
    if (!object(projected[name])) projected[name] = {};
    return projected[name] as ObjectNode;
  }

  function retain(name: string, key: string, value: unknown) {
    Object.defineProperty(group(name), key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    pending.push(value);
  }

  function select(name: 'paths' | 'webhooks', key: string, method: string) {
    const source = original[name];
    const item = object(source) && Object.hasOwn(source, key) ? source[key] : undefined;
    if (!object(item)) throw new Error(`OpenAPI ${name} item missing: ${key}`);
    // Referenced path items keep their complete target through the closure below.
    if (typeof item.$ref === 'string') {
      retain(name, key, item);
      return;
    }
    if (!Object.hasOwn(item, method)) throw new Error(`OpenAPI method missing: ${method} ${key}`);
    const selectedGroup = group(name);
    const existing = Object.hasOwn(selectedGroup, key) ? selectedGroup[key] : undefined;
    const selected = object(existing)
      ? { ...existing }
      : Object.fromEntries(Object.entries(item).filter(([field]) => !methods.has(field)));
    Object.defineProperty(selected, method, {
      value: item[method],
      enumerable: true,
      configurable: true,
      writable: true,
    });
    retain(name, key, selected);
  }

  for (const operation of page.operations ?? []) select('paths', operation.path, operation.method);
  for (const webhook of page.webhooks ?? []) select('webhooks', webhook.name, webhook.method);

  // Security requirements use scheme names rather than JSON references. Keep all
  // schemes, including their OAuth metadata and any referenced dependencies.
  if (object(original.components)) {
    for (const [key, value] of Object.entries(original.components)) {
      if (key === 'securitySchemes' || key.startsWith('x-')) retain('components', key, value);
    }
  }
  // Extensions on the Paths/Webhooks containers are metadata, not operations.
  for (const name of ['paths', 'webhooks']) {
    if (object(original[name])) {
      for (const [key, value] of Object.entries(original[name])) {
        if (key.startsWith('x-')) retain(name, key, value);
      }
    }
  }

  function reference(ref: string) {
    if (!ref.startsWith('#') || references.has(ref)) return;
    references.add(ref);
    let fragment: string;
    try {
      fragment = decodeURIComponent(ref.slice(1));
    } catch {
      requiresFullDocument = true;
      return;
    }
    // Anchor/scoped-schema resolution needs the original document context.
    if (!fragment.startsWith('/')) {
      requiresFullDocument = true;
      return;
    }
    const encodedKeys = fragment.slice(1).split('/');
    if (encodedKeys.some((key) => /~(?![01])/u.test(key))) {
      requiresFullDocument = true;
      return;
    }
    const keys = encodedKeys.map((key) => key.replace(/~1/g, '/').replace(/~0/g, '~'));
    let target: unknown = original;
    for (const key of keys) {
      if (typeof target !== 'object' || target === null || !Object.hasOwn(target, key)) {
        // A literal reference inside an example is not a schema dependency.
        // Do not turn projection into a new validator; keep original behavior.
        requiresFullDocument = true;
        return;
      }
      target = (target as ObjectNode)[key];
    }
    const [name, bucket, member] = keys;
    if (name === 'components' && bucket && member && object(original.components)) {
      const sourceBucket = original.components[bucket];
      if (!object(sourceBucket)) throw new Error(`Invalid OpenAPI component reference: ${ref}`);
      const components = group('components');
      const retained = object(components[bucket]) ? { ...components[bucket] } : {};
      Object.defineProperty(retained, member, {
        value: sourceBucket[member],
        enumerable: true,
        configurable: true,
        writable: true,
      });
      retain('components', bucket, retained);
    } else if ((name === 'paths' || name === 'webhooks') && bucket && object(original[name])) {
      // Links/callbacks may reference another operation. Retain its complete path
      // item rather than guessing which inherited fields the target needs.
      retain(name, bucket, original[name][bucket]);
    } else {
      // A reference to an entire bucket or another root field retains that field.
      projected[name] = object(original[name]) ? { ...original[name] } : original[name];
      pending.push(projected[name]);
    }
  }

  while (pending.length && !requiresFullDocument) {
    const value = pending.pop();
    if (typeof value !== 'object' || value === null || visited.has(value)) continue;
    visited.add(value);
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    const node = value as ObjectNode;
    // Relative refs under an explicit schema ID or dynamic anchors can depend on
    // omitted context. Preserve the full document for those uncommon documents.
    if ('$id' in node || '$anchor' in node || '$dynamicAnchor' in node) {
      requiresFullDocument = true;
      break;
    }
    for (const key of ['$ref', '$dynamicRef', 'operationRef']) {
      if (typeof node[key] === 'string') reference(node[key]);
    }
    if (object(node.discriminator) && object(node.discriminator.mapping)) {
      for (const ref of Object.values(node.discriminator.mapping)) {
        if (typeof ref === 'string') {
          if (!ref.startsWith('#') && !ref.includes('/')) requiresFullDocument = true;
          reference(ref);
        }
      }
    }
    pending.push(...Object.values(node));
  }
  return requiresFullDocument ? document : (projected as unknown as Document);
}
