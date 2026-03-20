/**
 * Generate MDX documentation files from the DorkOS OpenAPI specification.
 *
 * Reads the OpenAPI JSON spec from docs/api/openapi.json and generates
 * MDX pages in the docs/api/ directory. These pages are then picked up
 * by the Fumadocs MDX pipeline and rendered as interactive API reference docs.
 *
 * Must be run from the apps/site/ directory (the default for npm workspace scripts).
 * Run via: npm run generate:api-docs -w apps/site
 */
import { generateFiles } from 'fumadocs-openapi';
import { createOpenAPI } from 'fumadocs-openapi/server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../..');
const openapiPath = path.join(repoRoot, 'docs/api/openapi.json');
const outputDir = path.join(repoRoot, 'docs/api');

// Skip generation if the OpenAPI spec doesn't exist (e.g., CI builds
// where docs:export-api hasn't been run). The pre-committed MDX files
// in docs/api/api/ will still be used by the Fumadocs pipeline.
if (!fs.existsSync(openapiPath)) {
  console.log('[generate-api-docs] Skipping: docs/api/openapi.json not found');
  process.exit(0);
}

const openapi = createOpenAPI({
  input: ['../../docs/api/openapi.json'],
});

void generateFiles({
  input: openapi,
  output: outputDir,
  includeDescription: true,
});
