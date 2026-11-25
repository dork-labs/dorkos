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
 * @param fields - Which input field a segment fills when the names differ
 *   (the surface's `params`); a segment not listed fills its own name.
 * @returns The path parameters and the remaining fields.
 */
export function splitPathParams(
  input: z.ZodObject<z.ZodRawShape>,
  path: string,
  fields: Readonly<Record<string, string>> = {}
): PathSplitInput {
  const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
  if (names.length === 0) return { params: null, rest: input };

  const shape: Record<string, z.core.$ZodType> = input.shape;
  const params: Record<string, z.core.$ZodType> = {};
  const carried = names.map((name) => fields[name] ?? name);
  names.forEach((name, index) => {
    const field = shape[carried[index]!];
    params[name] = field instanceof z.ZodOptional ? field.unwrap() : (field ?? z.string());
  });
  const rest = Object.fromEntries(Object.entries(shape).filter(([key]) => !carried.includes(key)));
  // Only rebuild the object when a field actually moved, so a capability whose
  // path names no input field keeps its own schema (and any registered name).
  const moved = carried.some((name) => name in shape);
  return { params: z.object(params), rest: moved ? z.object(rest) : input };
}

/**
 * Refuse an HTTP surface whose input a caller could not send: a `get` or
 * `delete` has no body, so when its surface names `query`, every input field
 * must be either a path segment's or on that list.
 *
 * @param capability - The capability being composed.
 * @throws Naming the fields no request could carry.
 */
function assertHttpInputReachable(capability: CapabilityDefinition): void {
  const http = capability.surfaces.http;
  if (!http?.query || (http.method !== 'get' && http.method !== 'delete')) return;
  const carried = [...http.path.matchAll(/\{([^}]+)\}/g)].map(
    (match) => http.params?.[match[1]!] ?? match[1]!
  );
  const unreachable = Object.keys(capabilityInputObject(capability).shape).filter(
    (field) => !carried.includes(field) && !http.query!.includes(field)
  );
  if (unreachable.length > 0) {
    throw new Error(
      `Capability registry: "${capability.id}" is ${http.method.toUpperCase()} ${http.path}, ` +
        `which has no body, so no request can send ${unreachable.join(', ')}. ` +
        'Put each in the path or in http.query.'
    );
  }
}

/**
 * Refuse an HTTP surface that cannot be served as declared: its input must be
 * reachable ({@link assertHttpInputReachable}), and a person-only capability
 * (`audience: 'person'`) may not declare an MCP surface. Every MCP caller is an
 * agent, so such a tool could only ever refuse; leaving it off MCP hides it
 * there instead.
 *
 * @param capability - The capability being composed.
 * @throws Naming what no caller could use.
 */
export function assertHttpSurface(capability: CapabilityDefinition): void {
  assertHttpInputReachable(capability);
  if (capability.surfaces.http?.audience === 'person' && capability.surfaces.mcp) {
    throw new Error(
      `Capability registry: "${capability.id}" is for a person only (http.audience), ` +
        'so it may not declare an MCP surface: every MCP caller is an agent.'
    );
  }
}
