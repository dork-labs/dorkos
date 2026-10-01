/** Bounded Draft-07 payload validation for a confined local document app. */
import { Ajv, type ValidateFunction } from 'ajv';
import {
  CanvasChannelEventTypeSchema,
  inspectCanvasChannelJson,
} from './canvas-channel-schemas.js';

/** Maximum UTF-8 manifest size, before parsing or compilation. */
export const CANVAS_APP_MANIFEST_BYTES = 64 * 1024;
const MAX_TYPES = 128;
const MAX_DEPTH = 16;
const MAX_NODES = 1024;
const MAX_ENUM = 128;
const SCALAR_LIMIT = 16 * 1024;
const schemaKeywords = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
]);
const schemaTypes = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);

/** App limits only narrow the platform limits; absence inherits the platform cap. */
export interface CanvasAppLimits {
  envelopeBytes?: number;
  eventsPerMinute?: number;
  turnsPerHour?: number;
}
/** Minimal manifest: versioned exact event-type payload schemas and optional narrower limits. */
export interface CanvasAppManifest {
  v: 1;
  types: Record<string, boolean | Record<string, unknown>>;
  limits?: CanvasAppLimits;
}
/** A manifest cannot be loaded or compiled within its bounded grammar. */
export class CanvasAppManifestError extends Error {
  readonly code = 'INVALID_APP_MANIFEST';
  /** Describe a safe validation refusal without echoing app contents. */
  constructor(message: string) {
    super(message);
    this.name = 'CanvasAppManifestError';
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fail(message: string): never {
  throw new CanvasAppManifestError(message);
}
function keysOnly(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key)))
    fail('Manifest contains an unsupported field.');
}
function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_TYPES &&
    value.every((item) => typeof item === 'string') &&
    new Set(value).size === value.length
  );
}
function inspectSchemaFields(schema: Record<string, unknown>): void {
  keysOnly(schema, schemaKeywords);
  if (
    schema.type !== undefined &&
    (typeof schema.type !== 'string' || !schemaTypes.has(schema.type))
  )
    fail('Manifest schema type is unsupported.');
  if (schema.required !== undefined && !stringArray(schema.required))
    fail('Manifest required fields must be unique strings.');
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) || schema.enum.length < 1 || schema.enum.length > MAX_ENUM)
  )
    fail('Manifest enum exceeds its limit.');
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    const value = schema[key];
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > SCALAR_LIMIT)
    )
      fail('Manifest length limit is invalid.');
  }
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
    if (
      schema[key] !== undefined &&
      (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))
    )
      fail('Manifest numeric limit is invalid.');
  }
}
function inspectSchemas(types: Record<string, unknown>): void {
  const stack = Object.values(types).map((value) => ({ value, depth: 0 }));
  let nodes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail('Manifest schema exceeds its work limit.');
    if (typeof value === 'boolean') continue;
    if (!object(value)) fail('Manifest schema must be an object or boolean.');
    inspectSchemaFields(value);
    if (value.properties !== undefined) {
      if (!object(value.properties) || Object.keys(value.properties).length > MAX_TYPES)
        fail('Manifest properties exceed their limit.');
      for (const child of Object.values(value.properties))
        stack.push({ value: child, depth: depth + 1 });
    }
    for (const key of ['items', 'additionalProperties']) {
      if (value[key] !== undefined) stack.push({ value: value[key], depth: depth + 1 });
    }
  }
}
function parseLimits(value: unknown): CanvasAppLimits | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) fail('Manifest limits must be an object.');
  const ceilings = { envelopeBytes: 16384, eventsPerMinute: 60, turnsPerHour: 10 };
  keysOnly(value, new Set(Object.keys(ceilings)));
  for (const [key, ceiling] of Object.entries(ceilings)) {
    if (
      value[key] !== undefined &&
      (!Number.isSafeInteger(value[key]) ||
        (value[key] as number) < 1 ||
        (value[key] as number) > ceiling)
    )
      fail('Manifest cannot raise platform limits.');
  }
  return value as CanvasAppLimits;
}

/** Canonical serialization after bounded plain-JSON validation, for server hashing. */
export function canonicalCanvasAppJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalCanvasAppJson).join(',')}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalCanvasAppJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Validate the small manifest format before passing any schema to Ajv. */
export function parseCanvasAppManifest(value: unknown): CanvasAppManifest {
  if (inspectCanvasChannelJson(value, CANVAS_APP_MANIFEST_BYTES))
    fail('Manifest is not bounded plain JSON.');
  if (!object(value)) fail('Manifest must be an object.');
  keysOnly(value, new Set(['v', 'types', 'limits']));
  if (value.v !== 1 || !object(value.types) || Object.keys(value.types).length > MAX_TYPES)
    fail('Manifest version or event types are invalid.');
  for (const type of Object.keys(value.types))
    if (!CanvasChannelEventTypeSchema.safeParse(type).success)
      fail('Manifest event types must be exact names.');
  inspectSchemas(value.types);
  const limits = parseLimits(value.limits);
  return { v: 1, types: value.types as CanvasAppManifest['types'], ...(limits ? { limits } : {}) };
}

function freezeJson(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  for (const child of Object.values(value)) freezeJson(child);
  Object.freeze(value);
}

/** Compiled payload checks; no defaults, coercion, format loading or remote schema resolution. */
export class CompiledCanvasAppManifest {
  readonly manifest: CanvasAppManifest;
  readonly canonicalJson: string;
  private readonly validators = new Map<string, ValidateFunction>();
  /** Compile only validated schemas; callers cache this result by its canonical hash. */
  constructor(value: unknown) {
    const validated = parseCanvasAppManifest(value);
    this.manifest = JSON.parse(canonicalCanvasAppJson(validated)) as CanvasAppManifest;
    freezeJson(this.manifest);
    this.canonicalJson = canonicalCanvasAppJson(this.manifest);
    const ajv = new Ajv({
      strict: true,
      strictTypes: false,
      allErrors: false,
      ownProperties: true,
      validateFormats: false,
      addUsedSchema: false,
    });
    try {
      for (const [type, schema] of Object.entries(this.manifest.types))
        this.validators.set(type, ajv.compile(schema));
    } catch {
      fail('Manifest schema is not valid Draft-07.');
    }
  }
  /** Return undeclared for absent exact types, otherwise validate without mutating payload. */
  validate(type: string, payload: unknown): 'valid' | 'invalid' | 'undeclared' {
    const validator = this.validators.get(type);
    if (!validator) return 'undeclared';
    if (inspectCanvasChannelJson(payload)) return 'invalid';
    return validator(payload) ? 'valid' : 'invalid';
  }
}
