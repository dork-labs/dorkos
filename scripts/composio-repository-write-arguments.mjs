#!/usr/bin/env node
// Refreshes the repository write-argument snapshot that
// apps/server/src/services/connectors/__tests__/workflow-file-keys.test.ts pins
// (DOR-4508). For every write or destructive action of the repository apps it
// records each string argument's key path (`[]` marks an array item) and each
// free-form object argument (`{}` marks one), from Composio's live schemas.
// Needs the `composio` CLI signed in; makes read-only catalog calls only.
//
//   node scripts/composio-repository-write-arguments.mjs [out.json]
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { classifyComposioAction } from '../packages/connector-providers/src/composio/action-classes.ts';

const run = promisify(execFile);
const TOOLKITS = ['github', 'github_mcp', 'gitlab', 'gitea', 'bitbucket'];
const outFile =
  process.argv[2] ??
  fileURLToPath(
    new URL(
      '../apps/server/src/services/connectors/__tests__/fixtures/repository-write-arguments.json',
      import.meta.url
    )
  );

async function composio(args) {
  const { stdout } = await run('composio', args, { maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function hasType(schema, type) {
  return [].concat(schema?.type ?? []).includes(type);
}

/** Every string argument's key path, and every free-form object's, under `prefix`. */
function argumentPaths(schema, prefix = '', out = new Set(), depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 12) return out;
  const variants = [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])];
  if (prefix && (hasType(schema, 'string') || variants.some((v) => hasType(v, 'string')))) {
    out.add(prefix);
  }
  const properties = Object.entries(schema.properties ?? {});
  if (
    prefix &&
    hasType(schema, 'object') &&
    properties.length === 0 &&
    schema.additionalProperties !== false
  ) {
    out.add(`${prefix}{}`);
  }
  for (const [key, child] of properties) {
    argumentPaths(child, prefix ? `${prefix}.${key}` : key, out, depth + 1);
  }
  if (schema.items) argumentPaths(schema.items, `${prefix}[]`, out, depth + 1);
  for (const variant of variants) argumentPaths(variant, prefix, out, depth + 1);
  return out;
}

const snapshot = {};
for (const toolkit of TOOLKITS) {
  const tools = await composio(['tools', 'list', toolkit, '--limit', '1000']);
  const writes = tools.filter(
    (tool) => classifyComposioAction(toolkit, tool.slug, tool.tags ?? []) !== 'read'
  );
  const actions = {};
  const queue = [...writes];
  async function worker() {
    for (let tool = queue.shift(); tool; tool = queue.shift()) {
      try {
        const info = await composio(['execute', tool.slug, '--get-schema']);
        actions[tool.slug] = [...argumentPaths(info.inputSchema)].sort();
      } catch {
        actions[tool.slug] = null;
      }
    }
  }
  await Promise.all([worker(), worker()]);
  snapshot[toolkit] = Object.fromEntries(Object.entries(actions).sort());
  console.log(`${toolkit}: ${tools.length} actions, ${writes.length} write or destructive`);
}
writeFileSync(
  outFile,
  `${JSON.stringify(
    {
      source: 'Composio live input schemas, scripts/composio-repository-write-arguments.mjs',
      checkedAt: new Date().toISOString().slice(0, 10),
      toolkits: snapshot,
    },
    null,
    2
  )}\n`
);
const failed = Object.values(snapshot).flatMap((actions) =>
  Object.entries(actions)
    .filter(([, paths]) => paths === null)
    .map(([slug]) => slug)
);
console.log(`wrote ${outFile}; schemas that failed: ${failed.length ? failed.join(', ') : 'none'}`);
