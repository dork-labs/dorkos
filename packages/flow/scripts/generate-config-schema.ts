/**
 * CLI generator: writes `.agents/flow/config.schema.json` from the
 * authoritative Zod schema. Run via `pnpm --filter @dorkos/flow generate:schema`.
 *
 * The artifact is the JSON Schema that `.agents/flow/config.json`'s `$schema`
 * points at; this module keeps it in sync with `src/config-schema.ts`. Prettier
 * formatting lives here (not in `src/`) so the engine's runtime surface stays
 * free of build-tooling deps; the unit tests import {@link serializeConfigJsonSchema}
 * from this script to assert the committed artifact is in sync.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import prettier from 'prettier';
import {
  CONFIG_SCHEMA_RELATIVE_PATH,
  buildConfigJsonSchema,
} from '../src/generate-config-schema.js';

// scripts/ -> packages/flow -> packages -> repo root
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const outputPath = path.join(repoRoot, CONFIG_SCHEMA_RELATIVE_PATH);

/**
 * Serialize the generated JSON Schema as Prettier-formatted JSON so the
 * committed artifact survives the repo's pre-commit `format` hook unchanged
 * (the hook runs Prettier over staged files). Resolving the repo's Prettier
 * config keeps the on-disk bytes byte-identical and drift-free.
 *
 * @returns The schema as a Prettier-formatted JSON string.
 */
export async function serializeConfigJsonSchema(): Promise<string> {
  const raw = JSON.stringify(buildConfigJsonSchema(), null, 2);
  const config = await prettier.resolveConfig(outputPath);
  return prettier.format(raw, { ...config, parser: 'json' });
}

// Only write when invoked directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(outputPath, await serializeConfigJsonSchema(), 'utf8');
  process.stdout.write(`Wrote ${CONFIG_SCHEMA_RELATIVE_PATH}\n`);
}
