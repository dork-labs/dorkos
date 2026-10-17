/**
 * Copy the notes in Claude Code's own memory folders into each agent's DorkOS
 * memory (`<agentPath>/.dork/memory/`). A dry run unless `--apply` is passed.
 *
 *   pnpm --filter @dorkos/server migrate:claude-memory -- --dork-home ~/.dork
 *   pnpm --filter @dorkos/server migrate:claude-memory -- --dork-home ~/.dork --apply
 *
 * `--dork-home` is required rather than resolved, because the server's own
 * default outside production is a scratch folder, and this must read the real
 * agent registry. `--report <file>` writes the report there as well as
 * printing it. Only `~/.claude` and the numbered `~/.claudeN` accounts are
 * read; a named one (`~/.claude-ab1`) is left alone unless
 * `--include-account claude-ab1` names it. `--force` re-reads folders an
 * earlier run already moved. Originals are never changed or deleted; see
 * `@dorkos/memory`'s `migrate-claude-code.ts` for every rule.
 *
 * @module server/scripts/migrate-claude-memory
 */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import Database from 'better-sqlite3';
import {
  applyClaudeMemoryMigration,
  planClaudeMemoryMigration,
  renderMigrationReport,
  type MigrationAgent,
} from '@dorkos/memory';

import { listClaudeAccountFolderCandidates } from '../services/runtimes/claude-code/claude-config-dir.js';
import { projectSlug } from '../services/runtimes/claude-code/sessions/project-slug.js';

/**
 * Read every registered agent's name and home from the registry, read-only.
 *
 * @param dorkHome - The DorkOS data folder holding `dork.db`.
 */
function readAgents(dorkHome: string): MigrationAgent[] {
  const db = new Database(path.join(dorkHome, 'dork.db'), { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare('SELECT name, project_path AS path FROM agents ORDER BY name')
      .all() as MigrationAgent[];
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'dork-home': { type: 'string' },
      apply: { type: 'boolean', default: false },
      report: { type: 'string' },
      force: { type: 'boolean', default: false },
      'include-account': { type: 'string', multiple: true },
    },
  });
  const dorkHome = values['dork-home'];
  if (!dorkHome || !existsSync(path.join(dorkHome, 'dork.db'))) {
    console.error('Pass --dork-home, the folder that holds dork.db (usually ~/.dork).');
    process.exitCode = 2;
    return;
  }

  const accountDirs = listClaudeAccountFolderCandidates().filter((dir) =>
    existsSync(path.join(dir, 'projects'))
  );
  const plan = await planClaudeMemoryMigration({
    accountDirs,
    agents: readAgents(dorkHome),
    slugOf: projectSlug,
    date: new Date().toISOString().slice(0, 10),
    force: values.force,
    includeAccounts: values['include-account'] ?? [],
  });
  const results = values.apply ? await applyClaudeMemoryMigration(plan) : undefined;
  const report = renderMigrationReport(plan, results);
  if (values.report) writeFileSync(values.report, report);
  console.log(report);
}

void main();
