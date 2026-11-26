import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { liveShape } from '../config-migration/check-config-migration.ts';

/**
 * Every user config setting has a row in the configuration guide (DOR-4940).
 *
 * Step 6 of the `adding-config-fields` skill asks for a row in
 * `contributing/configuration.md` per new field; nothing checked it. This
 * census reads the leaves of the live `UserConfigSchema` (through the same
 * JSON Schema walk the config migration check uses) and fails on any leaf no
 * table row names.
 *
 * A leaf stops where the schema enters a list or a record: the guide documents
 * `cloud.credits.agents` and `extensions.approvedSources` as one row each, not
 * one per element field. A row for an object stands for its members, which is
 * how the guide documents `ui.sidebar` ("see below").
 *
 * {@link UNDOCUMENTED_TODAY} are the leaves that had no row when this census
 * landed. The list only shrinks: an entry that gains a row fails until it is
 * removed here.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const GUIDE = 'contributing/configuration.md';

/** Leaves with no row in the guide when this census landed (DOR-4940). Shrink only. */
const UNDOCUMENTED_TODAY = [
  'extensions.forwardAgents',
  'extensions.legacySlotless',
  'extensions.legacyUnsourced',
  'extensions.roomAccess',
  'mcp.enabled',
  'mcp.rateLimit.enabled',
  'mcp.rateLimit.maxPerWindow',
  'mcp.rateLimit.windowSecs',
  'onboarding.completedAt',
  'onboarding.completedSteps',
  'onboarding.dismissedAt',
  'onboarding.firstRunPath',
  'onboarding.priorRuntime',
  'onboarding.runtimeDefaultSetAt',
  'onboarding.skippedSteps',
  'onboarding.startedAt',
  'onboarding.welcomeEntryId',
  'permissions.approvedFolderAllowRules',
  'permissions.approvedFolderAllows',
  'permissions.refusedFolderAllows',
  'runtimes.doe.defaultTrustStop',
  'runtimes.doe.enabled',
  'runtimes.doe.inference.contextWindow',
  'runtimes.doe.inference.credentialEndpoint',
  'runtimes.doe.inference.credentialRef',
  'runtimes.doe.inference.endpoint',
  'runtimes.doe.inference.maxOutputTokens',
  'runtimes.doe.inference.model',
  'runtimes.doe.inference.protocol',
  'runtimes.doe.inference.provider',
  'runtimes.doe.inference.source',
  'runtimes.environment.inherit.claudeCode',
  'runtimes.environment.inherit.codex',
  'runtimes.environment.inherit.doe',
  'runtimes.environment.inherit.opencode',
  'runtimes.loadGate.heavyCommands.remove',
  'telemetry.usage',
  'tours.declined',
  'tours.seen',
  'version',
  'workbench.defaultViewers',
];

/** A path cut where it steps into a list (`[]`) or a record (`*`). */
function settingOf(schemaPath: string): string {
  return schemaPath.replace(/(\[\]|\.\*).*$/, '');
}

/** Every setting the schema holds: its leaves, cut at lists and records. */
function schemaLeaves(): string[] {
  const paths = Object.keys(liveShape());
  const leaves = paths.filter(
    (p) => !paths.some((other) => other.startsWith(`${p}.`) || other.startsWith(`${p}[]`))
  );
  return [...new Set(leaves.map(settingOf))].sort();
}

/** The key each table row in the guide names, cut the same way. */
function documentedKeys(): Set<string> {
  const guide = readFileSync(path.join(ROOT, GUIDE), 'utf8');
  return new Set([...guide.matchAll(/^\| `([^`]+)`/gm)].map((match) => settingOf(match[1] ?? '')));
}

/** Whether a row names the leaf or an object that holds it. */
function isDocumented(leaf: string, rows: Set<string>): boolean {
  const parts = leaf.split('.');
  return parts.some((_, i) => rows.has(parts.slice(0, i + 1).join('.')));
}

describe('the configuration guide census', () => {
  const leaves = schemaLeaves();
  const rows = documentedKeys();

  it('read the schema and the guide, so it cannot pass on nothing', () => {
    expect(leaves.length).toBeGreaterThan(200);
    expect(rows.has('server.port')).toBe(true);
  });

  it(`every UserConfigSchema setting has a row in ${GUIDE}`, () => {
    const missing = leaves.filter(
      (leaf) => !UNDOCUMENTED_TODAY.includes(leaf) && !isDocumented(leaf, rows)
    );
    expect(
      missing,
      `Add a row for each to the settings tables in ${GUIDE} (adding-config-fields skill, step 6).`
    ).toEqual([]);
  });

  it('every grandfathered leaf is still a leaf with no row, so the list only shrinks', () => {
    const stale = UNDOCUMENTED_TODAY.filter(
      (leaf) => !leaves.includes(leaf) || isDocumented(leaf, rows)
    );
    expect(stale, 'Remove these from UNDOCUMENTED_TODAY: each has a row or is gone.').toEqual([]);
  });
});
