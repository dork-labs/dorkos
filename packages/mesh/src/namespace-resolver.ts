import path from 'path';

/** Maximum allowed namespace length. */
const MAX_NAMESPACE_LENGTH = 64;

/**
 * Normalize a raw namespace string: lowercase, replace non-alphanumeric with hyphens, trim hyphens.
 *
 * @param raw - The raw namespace string to normalize
 * @returns Normalized namespace string
 */
export function normalizeNamespace(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Validate a namespace string. Must be non-empty and max 64 chars.
 *
 * @param ns - The namespace to validate
 * @returns Validation result with reason on failure
 */
export function validateNamespace(ns: string): { valid: true } | { valid: false; reason: string } {
  if (!ns || ns.length === 0) {
    return { valid: false, reason: 'Namespace must not be empty' };
  }
  if (ns.length > MAX_NAMESPACE_LENGTH) {
    return { valid: false, reason: `Namespace must be at most ${MAX_NAMESPACE_LENGTH} characters (got ${ns.length})` };
  }
  return { valid: true };
}

/**
 * Resolve a namespace for an agent from its project path and scan root.
 *
 * Algorithm:
 * 1. If `manifestNamespace` is provided and non-empty, use it
 * 2. Otherwise, compute `path.relative(scanRoot, projectPath)` and take the first path segment
 * 3. Normalize: lowercase, replace non-alphanumeric with hyphens, trim hyphens
 * 4. Validate: non-empty, max 64 chars
 *
 * @param projectPath - Absolute path to the agent's project directory
 * @param scanRoot - The root directory that was scanned
 * @param manifestNamespace - Optional namespace override from the agent manifest
 * @returns The resolved namespace string
 * @throws If the derived namespace is invalid (empty after normalization)
 */
export function resolveNamespace(
  projectPath: string,
  scanRoot: string,
  manifestNamespace?: string,
): string {
  if (manifestNamespace && manifestNamespace.trim().length > 0) {
    const normalized = normalizeNamespace(manifestNamespace);
    const validation = validateNamespace(normalized);
    if (!validation.valid) {
      throw new Error(`Invalid manifest namespace: ${validation.reason}`);
    }
    return normalized;
  }

  const relative = path.relative(scanRoot, projectPath);
  const firstSegment = relative.split(path.sep)[0];
  if (!firstSegment) {
    throw new Error(`Cannot derive namespace: projectPath '${projectPath}' is at or above scanRoot '${scanRoot}'`);
  }

  const normalized = normalizeNamespace(firstSegment);
  const validation = validateNamespace(normalized);
  if (!validation.valid) {
    throw new Error(`Invalid derived namespace '${normalized}': ${validation.reason}`);
  }
  return normalized;
}
