/**
 * Build a patch that writes one policy dot-path, materializing every `[]`
 * segment as a one-element array — so `connectors.rawMcpServers[].url` becomes
 * `{ connectors: { rawMcpServers: [{ url: … }] } }`, which is the shape a caller
 * actually sends.
 *
 * @param dotPath - A policy path, `[]` segments included.
 * @param leaf - The value to write at the end of it.
 * @returns The patch object.
 */
export function patchForPath(dotPath: string, leaf: unknown = 'x'): Record<string, unknown> {
  const segments = dotPath.split('.');
  let node: unknown = leaf;
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]!;
    const isArray = segment.endsWith('[]');
    const key = isArray ? segment.slice(0, -2) : segment;
    node = { [key]: isArray ? [node] : node };
  }
  return node as Record<string, unknown>;
}

/**
 * The path matcher exactly as it stood before DOR-1113 taught it to descend into
 * arrays. Kept here, in the test, as the reference the new behavior is compared
 * against: the fix had to close the `[]` gap without moving a single verdict on
 * any other path, and "identical to the old code" is the only honest way to say
 * that.
 *
 * @param value - The patch node being walked.
 * @param prefix - Internal accumulator for the current path.
 * @returns Dot-paths for every leaf and every empty branch, treating an array as
 *   a leaf.
 */
export function legacyPatchPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return prefix ? [prefix] : [];
  return entries.flatMap(([key, child]) =>
    legacyPatchPaths(child, prefix ? `${prefix}.${key}` : key)
  );
}
