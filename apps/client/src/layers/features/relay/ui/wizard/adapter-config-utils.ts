/**
 * Pure helpers for turning an adapter manifest and a stored config into wizard
 * form values, and back again.
 *
 * @module features/relay/ui/wizard/adapter-config-utils
 */
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import { storedValueToFormText } from '@dorkos/shared/relay-schemas';

/**
 * Heading the wizard files a declared field under when no setup step names it
 * and the field names no section of its own.
 */
export const ADVANCED_SECTION = 'Advanced';

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

/**
 * Initializes form values from a stored config, falling back to the manifest's
 * declared default.
 *
 * Runs over every declared field, not just the ones the current step shows, so a
 * config saved before a field existed still opens on that field's declared
 * default rather than on a blank. Surfacing a field therefore never changes what
 * it is set to.
 *
 * A stored value is rendered into editable text by `storedValueToFormText`,
 * which is what keeps a list or an object round-tripping instead of reaching the
 * textarea as `a,b` or `[object Object]`.
 *
 * @param manifest - Adapter manifest declaring the fields, defaults and value shapes.
 * @param existingConfig - Config already stored for this adapter instance, if any.
 * @returns Flat map of field key to initial form value.
 */
export function initializeValues(
  manifest: AdapterManifest,
  existingConfig?: Record<string, unknown>
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of manifest.configFields) {
    const existing = existingConfig ? getNestedValue(existingConfig, field.key) : undefined;
    if (existing !== undefined && field.type !== 'password') {
      values[field.key] = storedValueToFormText(field, existing);
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
 *
 * @param manifest - Adapter manifest whose `type` seeds the ID.
 * @param existingIds - Adapter IDs already in use.
 * @returns An adapter ID not present in `existingIds`.
 */
export function generateDefaultId(manifest: AdapterManifest, existingIds: string[] = []): string {
  const base = manifest.type;
  if (!existingIds.includes(base)) return base;
  let n = 2;
  while (existingIds.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
