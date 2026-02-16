/**
 * Export the OpenAPI spec to a static JSON file.
 *
 * Used by the marketing site to generate API reference docs via Fumadocs OpenAPI plugin.
 * Run with: npm run docs:export-api
 */
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { generateOpenAPISpec } from '../apps/server/src/services/openapi-registry';

const OUTPUT_PATH = 'docs/api/openapi.json';

const spec = generateOpenAPISpec();

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });

writeFileSync(OUTPUT_PATH, JSON.stringify(spec, null, 2));
console.log(`OpenAPI spec exported to ${OUTPUT_PATH}`);
