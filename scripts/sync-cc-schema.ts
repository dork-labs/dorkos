#!/usr/bin/env node
/**
 * sync-cc-schema — weekly drift monitor for the Claude Code marketplace
 * schema that DorkOS's `cc-validator.ts` mirrors.
 *
 * Fetches the community-maintained reference schema from
 * `hesreallyhim/claude-code-json-schema` and compares its set of
 * top-level / entry-level field names against DorkOS's current Zod port.
 * On drift, it opens a PR labelled `cc-schema-drift` with a short
 * summary so a human can reconcile the port.
 *
 * Invoked by `.github/workflows/cc-schema-sync.yml` on a weekly cron.
 * Per ADR-0238, the diff is deliberately coarse — the goal is "signal
 * that something changed," not "prove equivalence." False positives are
 * acceptable (a human PR reviewer can dismiss them); false negatives
 * are bounded by the weekly cadence.
 *
 * Flags:
 *   --dry-run    Print the diff report but do not open a PR.
 *
 * Exit codes:
 *   0  Schema is in sync (or PR was opened successfully)
 *   1  Fetch or diff failed
 *
 * @module scripts/sync-cc-schema
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const UPSTREAM_SCHEMA_URL =
  'https://raw.githubusercontent.com/hesreallyhim/claude-code-json-schema/main/schemas/marketplace.schema.json';

const LOCAL_VALIDATOR_PATH = 'packages/marketplace/src/cc-validator.ts';

/** Minimal JSON Schema shape we care about. */
interface JsonSchema {
  $schema?: string;
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  additionalProperties?: boolean;
  enum?: unknown[];
}

async function fetchUpstreamSchema(): Promise<JsonSchema> {
  const response = await fetch(UPSTREAM_SCHEMA_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch upstream schema: ${response.status} ${response.statusText}`);
  }
  const raw = await response.text();
  return JSON.parse(raw) as JsonSchema;
}

/**
 * Extract the set of field names that the DorkOS Zod port defines for
 * the top-level document and for plugin entries. Uses regex heuristics
 * over the source file — good enough for drift detection per ADR-0238.
 */
function extractDorkosFields(): { top: Set<string>; entry: Set<string> } {
  const source = readFileSync(LOCAL_VALIDATOR_PATH, 'utf8');

  const top = new Set<string>();
  const entry = new Set<string>();

  // Crude parser: find `CcMarketplaceJsonSchema` and `CcMarketplaceJsonEntrySchema`
  // and extract the z.object({ ... }) field names.
  const topMatch = source.match(
    /CcMarketplaceJsonSchema\s*=\s*z\s*\.\s*object\s*\(\s*\{([\s\S]*?)\}\s*\)/
  );
  if (topMatch) {
    for (const m of topMatch[1].matchAll(/^\s*(\w+)\s*:/gm)) {
      top.add(m[1]);
    }
  }

  const entryMatch = source.match(
    /CcMarketplaceJsonEntrySchema\s*=\s*z\s*\.\s*object\s*\(\s*\{([\s\S]*?)\}\s*\)/
  );
  if (entryMatch) {
    for (const m of entryMatch[1].matchAll(/^\s*(\w+)\s*:/gm)) {
      entry.add(m[1]);
    }
  }

  return { top, entry };
}

/** Extract the set of property names under a JSON Schema object node. */
function extractUpstreamFields(schema: JsonSchema): {
  top: Set<string>;
  entry: Set<string>;
} {
  const top = new Set(Object.keys(schema.properties ?? {}));
  // Plugin entries are conventionally under `properties.plugins.items.properties`.
  const entryNode = schema.properties?.plugins?.items?.properties ?? {};
  const entry = new Set(Object.keys(entryNode));
  return { top, entry };
}

interface DiffReport {
  topAdded: string[];
  topRemoved: string[];
  entryAdded: string[];
  entryRemoved: string[];
}

function computeDiff(
  upstream: { top: Set<string>; entry: Set<string> },
  dorkos: { top: Set<string>; entry: Set<string> }
): DiffReport {
  const diffSet = (a: Set<string>, b: Set<string>): string[] =>
    Array.from(a)
      .filter((x) => !b.has(x))
      .sort();

  return {
    topAdded: diffSet(upstream.top, dorkos.top),
    topRemoved: diffSet(dorkos.top, upstream.top),
    entryAdded: diffSet(upstream.entry, dorkos.entry),
    entryRemoved: diffSet(dorkos.entry, upstream.entry),
  };
}

function formatReport(diff: DiffReport): string {
  const lines: string[] = [];
  lines.push('# cc-schema-drift report');
  lines.push('');
  lines.push("The weekly `sync-cc-schema` job detected a difference between DorkOS's");
  lines.push('`packages/marketplace/src/cc-validator.ts` and the upstream reference');
  lines.push(`schema at \`${UPSTREAM_SCHEMA_URL}\`.`);
  lines.push('');

  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push(`## ${title}`);
    lines.push('');
    for (const item of items) lines.push(`- \`${item}\``);
    lines.push('');
  };

  section('Top-level fields added upstream (DorkOS missing)', diff.topAdded);
  section('Top-level fields removed upstream (DorkOS stale)', diff.topRemoved);
  section('Plugin-entry fields added upstream (DorkOS missing)', diff.entryAdded);
  section('Plugin-entry fields removed upstream (DorkOS stale)', diff.entryRemoved);

  lines.push('## Action');
  lines.push('');
  lines.push('Review the additions/removals and update `cc-validator.ts` so the DorkOS');
  lines.push("Zod port stays no stricter than CC's actual CLI behaviour. Remember the");
  lines.push(
    'sync-direction invariant from ADR-0238: looser-than-CC is acceptable, stricter-than-CC is a regression.'
  );

  return lines.join('\n');
}

function hasDrift(diff: DiffReport): boolean {
  return (
    diff.topAdded.length > 0 ||
    diff.topRemoved.length > 0 ||
    diff.entryAdded.length > 0 ||
    diff.entryRemoved.length > 0
  );
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');
  const date = new Date().toISOString().slice(0, 10);

  let upstream: JsonSchema;
  try {
    upstream = await fetchUpstreamSchema();
  } catch (err) {
    console.error(`sync-cc-schema: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const upstreamFields = extractUpstreamFields(upstream);
  const dorkosFields = extractDorkosFields();
  const diff = computeDiff(upstreamFields, dorkosFields);

  if (!hasDrift(diff)) {
    console.log('cc-schema: no drift');
    return 0;
  }

  const report = formatReport(diff);
  console.log(report);

  if (dryRun) {
    console.log('\n[dry-run] skipping PR creation');
    return 0;
  }

  const reportPath = join(tmpdir(), `cc-schema-drift-${date}.md`);
  writeFileSync(reportPath, report, 'utf8');

  const totalChanges =
    diff.topAdded.length +
    diff.topRemoved.length +
    diff.entryAdded.length +
    diff.entryRemoved.length;
  const title = `cc-schema-drift: ${date} — ${totalChanges} field changes detected`;

  try {
    execSync(
      `gh pr create --title ${JSON.stringify(title)} --body-file ${JSON.stringify(reportPath)} --label cc-schema-drift`,
      { stdio: 'inherit' }
    );
  } catch (err) {
    console.error(
      `sync-cc-schema: gh pr create failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return 1;
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
