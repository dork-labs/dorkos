/**
 * Export the OpenAPI document to static JSON files.
 *
 * Writes two files (ADR `261123-170832`, DOR-4983):
 *
 * - `docs/api/openapi.json`, the published document: every operation that is
 *   not `internal`. The site's API reference pages are generated from it.
 *   Its `info.version` is the repo's `VERSION` (see `lib/openapi-version.ts`).
 * - `docs/api/openapi-internal.json`, the `internal` operations and the
 *   components only they use. The generated client and the API lint gate read
 *   it merged into the published one (`packages/api-client/scripts/api-document.ts`).
 *
 * Run with: pnpm docs:export-api
 */
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { generateOpenAPISpec } from '../apps/server/src/services/core/openapi-registry';
import { splitPublishedDocument } from '../apps/server/src/services/core/openapi/published-document';
import {
  INTERNAL_PART_PATH,
  PUBLISHED_DOCUMENT_PATH,
} from '../packages/api-client/scripts/api-document';
import { readProductVersion } from './lib/openapi-version';

let version: string;
try {
  version = readProductVersion('VERSION');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const { published, internal } = splitPublishedDocument(generateOpenAPISpec({ version }));

for (const [path, content] of [
  [PUBLISHED_DOCUMENT_PATH, published],
  [INTERNAL_PART_PATH, internal],
] as const) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(content, null, 2));
  console.log(
    `OpenAPI ${path === PUBLISHED_DOCUMENT_PATH ? 'document' : 'internal part'} exported to ${path}`
  );
}
