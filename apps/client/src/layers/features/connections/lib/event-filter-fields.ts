/** One safe form field derived from an event definition's JSON schema. */
export interface EventFilterField {
  name: string;
  label: string;
  required: boolean;
  type: 'string' | 'number' | 'integer' | 'boolean';
  options?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SCHEMA_ANNOTATION_KEYS = new Set(['$id', '$schema', 'description', 'title']);
const OBJECT_SCHEMA_KEYS = new Set([
  ...SCHEMA_ANNOTATION_KEYS,
  'additionalProperties',
  'properties',
  'required',
  'type',
]);
const FIELD_SCHEMA_KEYS = new Set([...SCHEMA_ANNOTATION_KEYS, 'enum', 'type']);

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

/**
 * Reduce a bounded JSON schema to controls this client can validate.
 *
 * `null` means the schema asks for a shape this UI cannot safely collect. The
 * caller then refuses creation instead of offering an arbitrary JSON field.
 */
export function readEventFilterFields(schema: Record<string, unknown>): EventFilterField[] | null {
  if (Object.keys(schema).length === 0) return [];
  if (!hasOnlyKeys(schema, OBJECT_SCHEMA_KEYS)) return null;
  if (schema.type !== undefined && schema.type !== 'object') return null;
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    return null;
  }
  if (!isRecord(schema.properties)) return null;
  const properties = schema.properties;
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      schema.required.some((name) => typeof name !== 'string' || !(name in properties)))
  ) {
    return null;
  }
  const required = new Set((schema.required as string[] | undefined) ?? []);

  const fields: EventFilterField[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    if (!isRecord(raw)) return null;
    if (!hasOnlyKeys(raw, FIELD_SCHEMA_KEYS)) return null;
    const rawType = raw.type;
    if (
      rawType !== 'string' &&
      rawType !== 'number' &&
      rawType !== 'integer' &&
      rawType !== 'boolean'
    ) {
      return null;
    }
    const rawOptions = raw.enum;
    let options: string[] | undefined;
    if (rawOptions !== undefined) {
      if (
        rawType !== 'string' ||
        !Array.isArray(rawOptions) ||
        rawOptions.length === 0 ||
        rawOptions.some((option) => typeof option !== 'string')
      ) {
        return null;
      }
      options = rawOptions;
    }
    fields.push({
      name,
      label: typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title : name,
      required: required.has(name),
      type: rawType,
      ...(options && { options }),
    });
  }
  return fields;
}

/** Convert controlled form strings to the exact primitive values described by the schema. */
export function buildEventFilter(
  fields: EventFilterField[],
  values: Record<string, string | boolean>
): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (field.type === 'boolean') {
      if (typeof value === 'boolean') result[field.name] = value;
      else if (field.required) return null;
      continue;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      if (field.required) return null;
      continue;
    }
    if (field.options && !field.options.includes(value)) return null;
    if (field.type === 'number' || field.type === 'integer') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || (field.type === 'integer' && !Number.isInteger(parsed))) {
        return null;
      }
      result[field.name] = parsed;
    } else {
      result[field.name] = value;
    }
  }
  return result;
}
