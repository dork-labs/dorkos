/**
 * A request's query string, read the way Express read it for the routes that
 * moved off it.
 *
 * Express (through `qs`) gives a key that appears once as a string and a key
 * that repeats as an array, and the routes were written against that: a
 * repeated `?runtime=a&runtime=b` reads as "no runtime", and a schema that
 * expects a string refuses it. Hono's `c.req.query()` keeps only one value,
 * which would quietly turn the same request into a different one. This keeps
 * the old shape for flat keys, the only kind these routes read.
 *
 * @module http/request-query
 */
import type { Context } from 'hono';

/**
 * The query string as Express's `req.query`: each key once as a string, a
 * repeated key as an array of its values.
 *
 * @param c - The Hono context.
 * @returns The query object.
 */
export function readQuery(c: Context): Record<string, string | string[]> {
  // No prototype: a key named `__proto__` is a key like any other.
  const query: Record<string, string | string[]> = Object.create(null);
  for (const [key, values] of Object.entries(c.req.queries())) {
    query[key] = values.length === 1 ? values[0]! : values;
  }
  return query;
}
