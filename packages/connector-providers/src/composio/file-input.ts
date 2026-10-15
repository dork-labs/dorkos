/**
 * Whether a Composio call would hand the provider a file.
 *
 * File uploads are not available yet, so a call that sends one is refused
 * before dispatch. An operation that only OFFERS a file field (Gmail's
 * optional `attachment`) must still run when no file is sent.
 *
 * @module connector-providers/composio/file-input
 */
/** Whether one schema node is an SDK file input that needs an explicit upload capability. */
function isFileInputNode(node: Record<string, unknown>): boolean {
  return node.format === 'path' || node.file_uploadable === true;
}

/** Detect SDK file inputs anywhere in a schema. */
function containsFilePathInput(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsFilePathInput);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (isFileInputNode(record)) return true;
  return Object.values(record).some(containsFilePathInput);
}

function schemaRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Deepest schema nesting walked before a call is refused as unsafe to judge. */
const MAX_FILE_INPUT_DEPTH = 32;

/**
 * Whether a call would hand the provider a file: a file field is filled in
 * (anything but absent or `null`), or a file field the schema requires.
 *
 * Walks the schema beside the arguments, so an operation that merely OFFERS a
 * file field (Gmail's optional `attachment`) still runs when none is sent. A
 * local `$ref` is followed; anything this walk cannot judge (a remote `$ref`,
 * nesting past the depth limit) counts as a file when the schema holds one.
 *
 * @param root - The operation's input schema, as stored.
 * @param value - The arguments the call would send.
 * @returns `true` when the call must be refused as a file upload.
 */
export function usesFileInput(root: Record<string, unknown>, value: unknown): boolean {
  const resolve = (ref: string): Record<string, unknown> | undefined => {
    const match = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(ref);
    return match ? schemaRecord(schemaRecord(root[match[1]!])?.[match[2]!]) : undefined;
  };
  const walk = (schema: unknown, current: unknown, depth: number): boolean => {
    const node = schemaRecord(schema);
    if (!node) return false;
    if (depth > MAX_FILE_INPUT_DEPTH) return containsFilePathInput(node);
    if (isFileInputNode(node)) return current !== undefined && current !== null;
    if (typeof node.$ref === 'string') {
      const target = resolve(node.$ref);
      if (!target) return containsFilePathInput(root);
      if (walk(target, current, depth + 1)) return true;
    }
    for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
      const branches = node[keyword];
      if (Array.isArray(branches) && branches.some((branch) => walk(branch, current, depth + 1))) {
        return true;
      }
    }
    const properties = schemaRecord(node.properties) ?? {};
    if (Array.isArray(node.required)) {
      for (const name of node.required) {
        if (typeof name === 'string' && containsFilePathInput(properties[name])) return true;
      }
    }
    if (current === undefined || current === null) return false;
    if (Array.isArray(current)) {
      const items = node.items;
      return current.some((item, index) =>
        walk(Array.isArray(items) ? items[index] : items, item, depth + 1)
      );
    }
    const record = schemaRecord(current);
    if (!record) return false;
    return Object.entries(record).some(([name, field]) =>
      walk(
        Object.hasOwn(properties, name) ? properties[name] : node.additionalProperties,
        field,
        depth + 1
      )
    );
  };
  return walk(root, value, 0);
}
