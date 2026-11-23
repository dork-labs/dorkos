/**
 * Export the OpenAPI spec to a static JSON file.
 *
 * Used by the marketing site to generate API reference docs via Fumadocs OpenAPI plugin.
 * Its `info.version` is the repo's `VERSION` (see `lib/openapi-version.ts`).
 * Run with: npm run docs:export-api
 */
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { generateOpenAPISpec } from '../apps/server/src/services/core/openapi-registry';
import { readProductVersion } from './lib/openapi-version';

const OUTPUT_PATH = 'docs/api/openapi.json';

let version: string;
try {
  version = readProductVersion('VERSION');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const spec = generateOpenAPISpec({ version });

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });

writeFileSync(OUTPUT_PATH, JSON.stringify(spec, null, 2));
console.log(`OpenAPI spec exported to ${OUTPUT_PATH}`);
