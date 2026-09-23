/**
 * The schema-tree walker the contract tests share.
 *
 * Reads Zod 4's `.def` internals to reach every node of every exported schema,
 * so a guard written once (no catalog value, no stray credential) covers every
 * schema this package publishes, including ones added later.
 */
import { z } from 'zod';

import * as contract from '../index.js';

/** Strips the wrappers that sit between a field and the type it really is. */
export function unwrap(node: z.ZodTypeAny): z.ZodTypeAny {
  let current = node;
  for (let i = 0; i < 50; i += 1) {
    const def = (current as unknown as { def: { type: string; innerType?: z.ZodTypeAny } }).def;
    if (
      (def.type === 'optional' ||
        def.type === 'nullable' ||
        def.type === 'default' ||
        def.type === 'readonly' ||
        def.type === 'catch' ||
        def.type === 'nonoptional') &&
      def.innerType
    ) {
      current = def.innerType;
      continue;
    }
    return current;
  }
  return current;
}

/** One node found by the walk, with the dotted path that reached it. */
export interface Visited {
  path: string;
  node: z.ZodTypeAny;
}

/**
 * Walks every reachable node of a schema tree.
 *
 * @param root - The schema to walk.
 * @param rootPath - The name to report the root as.
 */
export function walk(root: z.ZodTypeAny, rootPath: string): Visited[] {
  const found: Visited[] = [];
  const seen = new Set<unknown>();

  /**
   * Visits one node and everything under it.
   *
   * @param node - The node to visit.
   * @param at - The dotted path that reached it.
   */
  function visit(node: z.ZodTypeAny, at: string): void {
    if (node == null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    found.push({ path: at, node });

    const def = (node as unknown as Record<string, unknown>).def as
      Record<string, unknown> | undefined;
    if (!def) return;

    const shape = def.shape as Record<string, z.ZodTypeAny> | undefined;
    if (shape) {
      for (const [key, value] of Object.entries(shape)) visit(value, `${at}.${key}`);
    }
    for (const key of ['innerType', 'element', 'valueType', 'keyType'] as const) {
      const child = def[key] as z.ZodTypeAny | undefined;
      if (child) visit(child, at);
    }
    const options = def.options as z.ZodTypeAny[] | Map<unknown, z.ZodTypeAny> | undefined;
    if (Array.isArray(options)) {
      options.forEach((option, index) => visit(option, `${at}[${index}]`));
    } else if (options instanceof Map) {
      for (const option of options.values()) visit(option, at);
    }
  }

  visit(root, rootPath);
  return found;
}

/** Every exported Zod schema of the root entry point, keyed by export name. */
export function exportedSchemas(): Array<[string, z.ZodTypeAny]> {
  const found: Array<[string, z.ZodTypeAny]> = [];
  for (const [name, value] of Object.entries(contract) as Array<[string, unknown]>) {
    if (value instanceof z.ZodType) found.push([name, value as z.ZodTypeAny]);
  }
  return found;
}
