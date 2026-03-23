import type { AdapterManifest } from '@dorkos/shared/relay-schemas';

/**
 * Converts a flat object with dot-notation keys into a nested object.
 *
 * @param flat - Object with dot-notation keys, e.g. `{'inbound.subject': 'x'}`
 * @returns Nested object, e.g. `{inbound: {subject: 'x'}}`
 */
export function unflattenConfig(flat: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let current = result;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
  }
  return result;
}

/** Resolves a dot-notation key from a potentially nested config object. */
function getNestedValue(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Initializes form values from manifest defaults or existing config. */
export function initializeValues(
  manifest: AdapterManifest,
  existingConfig?: Record<string, unknown>
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of manifest.configFields) {
    const existing = existingConfig ? getNestedValue(existingConfig, field.key) : undefined;
    if (existing !== undefined && field.type !== 'password') {
      values[field.key] = existing;
    } else if (
      field.type === 'password' &&
      existingConfig &&
      getNestedValue(existingConfig, field.key) !== undefined
    ) {
      // Use sentinel so edit mode shows "Saved" placeholder instead of blank.
      values[field.key] = '***';
    } else if (field.default !== undefined) {
      values[field.key] = field.default;
    } else {
      values[field.key] = field.type === 'boolean' ? false : '';
    }
  }
  return values;
}

/**
 * Generates a non-colliding default adapter ID.
 *
 * Returns `{type}` if unused, otherwise `{type}-2`, `{type}-3`, etc.
 */
export function generateDefaultId(manifest: AdapterManifest, existingIds: string[] = []): string {
  const base = manifest.type;
  if (!existingIds.includes(base)) return base;
  let n = 2;
  while (existingIds.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
