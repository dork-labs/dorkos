/** One safe form field derived from an event definition's JSON schema. */
export interface EventFilterField {
  name: string;
  label: string;
  required: boolean;
  type: 'string' | 'number' | 'integer' | 'boolean';
  options?: string[];
  defaultValue?: string | number | boolean;
  examples?: Array<string | number | boolean>;
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
const FIELD_SCHEMA_KEYS = new Set([
  ...SCHEMA_ANNOTATION_KEYS,
  'enum',
  'type',
  'default',
  'examples',
]);

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
    const accepts = (value: unknown): value is string | number | boolean => {
      if (rawType === 'boolean') return typeof value === 'boolean';
      if (rawType === 'string') {
        return typeof value === 'string' && (!options || options.includes(value));
      }
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (rawType !== 'integer' || Number.isInteger(value))
      );
    };
    // Annotations are suggestions, but malformed suggestions must not become
    // owner consent. In particular, never coerce a string to a numeric default.
    const hasDefault = Object.hasOwn(raw, 'default');
    if (hasDefault && !accepts(raw.default)) return null;
    if (
      Object.hasOwn(raw, 'examples') &&
      (!Array.isArray(raw.examples) || !raw.examples.every(accepts))
    )
      return null;
    fields.push({
      name,
      label: typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title : name,
      required: required.has(name),
      type: rawType,
      ...(options && { options }),
      ...(hasDefault && { defaultValue: raw.default as string | number | boolean }),
      ...(Array.isArray(raw.examples) && {
        examples: raw.examples as Array<string | number | boolean>,
      }),
    });
  }
  return fields;
}

/** Initialize one newly selected definition from validated defaults, never examples. */
export function initialEventFilterValues(
  fields: EventFilterField[]
): Record<string, string | boolean> {
  const entries: Array<[string, string | boolean]> = [];
  for (const field of fields) {
    if (field.defaultValue !== undefined) {
      entries.push([
        field.name,
        typeof field.defaultValue === 'boolean' ? field.defaultValue : String(field.defaultValue),
      ]);
    } else if (field.type === 'boolean' && field.required) {
      entries.push([field.name, false]);
    }
  }
  return Object.fromEntries(entries);
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
      else if (field.required || field.defaultValue !== undefined) return null;
      continue;
    }
    if (typeof value !== 'string' || (field.type !== 'string' && value.trim() === '')) {
      if (field.required || field.defaultValue !== undefined) return null;
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
      // Presence and minimum length are different JSON Schema constraints.
      // Preserve explicit blanks/whitespace for exact provider reconciliation.
      result[field.name] = value;
    }
  }
  return result;
}
