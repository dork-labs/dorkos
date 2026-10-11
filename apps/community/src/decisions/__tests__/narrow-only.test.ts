/**
 * "A decision can only narrow, never widen" (spec `official-community-space` D15), pinned by
 * source for the Community's post checks. `scripts/__tests__/decision-narrow-only.test.ts` keeps
 * the decision port and bridges inside this folder; this file pins what the folder can reach:
 *
 * 1. The checks write only audit rows and reports. No statement in this folder inserts into,
 *    updates or deletes any other table, so no answer can mute, ban, remove, hide, grant or admit.
 * 2. Only three modules outside the folder import it: the server entry that starts the worker,
 *    the monitoring routes that show the comparison, and the report queue that shows the hint.
 * 3. No module that decides who may do what reads a check's record, a check's report, or the
 *    folder, so no verdict can reach a permission.
 *
 * The behaviour these protect is pinned too, end to end, in
 * `src/__tests__/post-checks.integration.test.ts`: a flagged author still posts and reads.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const src = path.resolve(import.meta.dirname, '..', '..');
const decisionsDir = path.join(src, 'decisions');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'browser') out.push(...sources(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const rel = (file: string) => path.relative(src, file).split(path.sep).join('/');
const read = (file: string) => readFileSync(file, 'utf8');

/** Every table a statement writes to: INSERT INTO, UPDATE, DELETE FROM. */
function writtenTables(text: string): string[] {
  const tables: string[] = [];
  for (const match of text.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?([a-z_]+)"?/gi))
    tables.push(match[1]!.toLowerCase());
  return tables;
}

/** The modules that decide who may do what: identity, roles, posting rules, stream access. */
const PERMISSION_MODULES = [
  'auth.ts',
  'data.ts',
  'tenant-context.ts',
  'host/authority.ts',
  'moderation/posting.ts',
  'moderation/person.ts',
  'moderation/mutes.ts',
  'moderation/bans.ts',
  'routes/community/entries.ts',
  'routes/community/event-stream-access.ts',
];

/** Reading a check's record or a check's report, in SQL or in code. */
const READS_A_CHECK =
  /'decision\.|\bdecision\s*(?:->|\?)|\.decision\b|source\s*=\s*'check'|check_name/;

describe('the post checks only narrow', () => {
  it('write nothing but audit rows and reports', () => {
    const files = sources(decisionsDir);
    expect(files.length).toBeGreaterThan(3);
    const tables = new Set(files.flatMap((file) => writtenTables(read(file))));
    expect([...tables].sort()).toEqual(['audit_events', 'reports']);
  });

  it('are reached from three places only, none of which decides a permission', () => {
    const importers = sources(src)
      .filter((file) => !file.startsWith(decisionsDir + path.sep))
      .filter((file) => /from\s+['"](?:\.\.?\/)+(?:[a-z-]+\/)*decisions\//.test(read(file)))
      .map(rel)
      .sort();
    expect(importers).toEqual(['live/monitoring.ts', 'main.ts', 'routes/community/reports.ts']);
  });

  it.each(PERMISSION_MODULES)('keep %s blind to every verdict', (module) => {
    const text = read(path.join(src, module));
    expect(text).not.toMatch(/['"](?:\.\.?\/)+(?:[a-z-]+\/)*decisions\//);
    expect(text).not.toMatch(/@dorkos\/decisions|decision-model/);
    expect(text).not.toMatch(READS_A_CHECK);
  });

  it('let the report queue read a verdict only to show it', () => {
    const queue = read(path.join(src, 'routes/community/reports.ts'));
    // The one import is the read-only hint; nothing from the folder can resolve or act.
    expect(queue.match(/from '\.\.\/\.\.\/decisions\/[a-z-]+\.js'/g)).toEqual([
      "from '../../decisions/hints.js'",
    ]);
  });
});
