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
