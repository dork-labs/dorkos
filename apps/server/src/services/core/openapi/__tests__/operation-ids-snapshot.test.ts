import { describe, it, expect } from 'vitest';
import { generateOpenAPISpec } from '../../openapi-registry.js';

/** The methods an operation can sit under, in the order the map lists them. */
const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

/**
 * Every operation's id, keyed `METHOD path` and sorted, so a changed id shows
 * as one changed line in the diff.
 */
function operationIdMap(): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const [path, item] of Object.entries(generateOpenAPISpec().paths ?? {})) {
    for (const method of METHODS) {
      const id = item?.[method]?.operationId;
      if (id !== undefined) ids[`${method.toUpperCase()} ${path}`] = id;
    }
  }
  return Object.fromEntries(Object.entries(ids).sort(([a], [b]) => (a < b ? -1 : 1)));
}

describe('operation ids', () => {
  // An operationId is the name a generated client calls an operation by, so
  // changing one is an API change. Rename one on purpose with
  // `pnpm vitest run <this file> -u` and commit the snapshot.
  it('match the committed snapshot', async () => {
    await expect(`${JSON.stringify(operationIdMap(), null, 2)}\n`).toMatchFileSnapshot(
      './operation-ids.snapshot.json'
    );
  });
});
