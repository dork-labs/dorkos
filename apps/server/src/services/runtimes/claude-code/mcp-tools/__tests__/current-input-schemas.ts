/** Enumerate executable Zod nodes without keeping a second capability list. */
import { z } from 'zod';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolDeps } from '../types.js';

/** One node in an original executable input, including wrappers and union branches. */
export interface InputNode {
  path: string;
  schema: z.ZodType;
}

/** Walk each schema instance once per declaration, including recursive lazy inputs. */
export function inputNodes(
  schema: z.ZodType,
  path = '$',
  seen = new Set<z.ZodType>()
): InputNode[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const result: InputNode[] = [{ path, schema }];
  const collect = (value: unknown, at: string): void => {
    if (value instanceof z.ZodType) result.push(...inputNodes(value, at, seen));
    else if (Array.isArray(value)) value.forEach((item, index) => collect(item, `${at}[${index}]`));
    else if (
      value &&
      typeof value === 'object' &&
      Object.getPrototypeOf(value) === Object.prototype
    )
      Object.entries(value).forEach(([key, item]) => collect(item, `${at}.${key}`));
  };
  Object.entries(schema._zod.def).forEach(([key, value]) => collect(value, `${path}.${key}`));
  if (schema instanceof z.ZodLazy) collect(schema.unwrap(), `${path}.lazy`);
  return result;
}

/** The actual SDK/client fixture supplied by the existing default-arguments suite. */
export interface McpContractHarness {
  createFullDeps: () => McpToolDeps;
  connect: (instance: {
    connect: (transport: InMemoryTransport) => Promise<void>;
  }) => Promise<{ client: Client; close: () => Promise<void> }>;
  payloadOf: (result: CallToolResult) => Record<string, unknown>;
}
