/** Recover advertised object fields without changing the registry's executable input schema. */
import { z } from 'zod';
import type { CapabilityDefinition } from './capability-definition.js';

/** Outer preprocess pipes validate at invocation; their output describes the public object. */
export function capabilityInputObject(
  capability: CapabilityDefinition
): z.ZodObject<z.ZodRawShape> {
  let schema: z.core.$ZodType = capability.input;
  while (schema instanceof z.ZodPipe) schema = schema.out;
  if (!(schema instanceof z.ZodObject))
    throw new Error(`Capability '${capability.id}' has no object input schema to project.`);
  return schema;
}

/** A capability input split into the fields its path carries and the rest. */
export interface PathSplitInput {
  /** One field per `{name}` segment of the path, or `null` when the path has none. */
  readonly params: z.ZodObject<z.ZodRawShape> | null;
  /** The remaining fields, for the query string or the JSON body. */
  readonly rest: z.ZodObject<z.ZodRawShape>;
}

/**
 * Split a capability's input object along its HTTP path, so a field the path
 * carries (`/api/audit/{id}` carries `id`) is declared once, as a path
 * parameter, and not again in the query or body.
 *
 * A path parameter takes the input field's own schema (and so its
 * description) when the input has a field of that name, made required because
 * a path segment is never absent; otherwise it is a plain string.
 *
 * @param input - The capability's input object (see {@link capabilityInputObject}).
 * @param path - The capability's HTTP path, with `{name}` segments.
 * @returns The path parameters and the remaining fields.
 */
export function splitPathParams(input: z.ZodObject<z.ZodRawShape>, path: string): PathSplitInput {
  const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
  if (names.length === 0) return { params: null, rest: input };

  const shape: Record<string, z.core.$ZodType> = input.shape;
  const params: Record<string, z.core.$ZodType> = {};
  for (const name of names) {
    const field = shape[name];
    params[name] = field instanceof z.ZodOptional ? field.unwrap() : (field ?? z.string());
  }
  const rest = Object.fromEntries(Object.entries(shape).filter(([key]) => !names.includes(key)));
  // Only rebuild the object when a field actually moved, so a capability whose
  // path names no input field keeps its own schema (and any registered name).
  const moved = names.some((name) => name in shape);
  return { params: z.object(params), rest: moved ? z.object(rest) : input };
}
