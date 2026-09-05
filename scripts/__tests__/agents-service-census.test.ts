/**
 * Drift guard for the service-domain census in AGENTS.md.
 *
 * AGENTS.md loads into every agent session as project instructions, so its map
 * of `apps/server/src/services/` is what an agent greps to decide where code
 * lives. By DOR-1788 that list named 15 domains and the tree held 26: eleven
 * were missing outright — connectors, diff, identity, mcp-apps, memory,
 * notifications, observability, rooms, shapes, terminal, workbench-serve — and
 * `rooms` alone is 62 source files.
 *
 * A short list does not read as short. Nothing in the sentence told a reader it
 * was partial, so an agent looking for room code found no `rooms` entry and
 * concluded the domain did not exist. That is the same failure shape as DOR-670,
 * where a stale list in the root vitest config made ~168 real test files look
 * broken: a document that is confidently incomplete is worse than one that is
 * obviously missing, because it answers the question wrongly instead of not
 * answering it.
 *
 * The prose half of the fix is that the line now says it is a complete census.
 * This is the half that keeps it true. Adding a service directory and forgetting
 * the doc is a mistake nobody makes on purpose, so it has to fail here rather
 * than be remembered.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

/** The prefix identifying the census sentence in AGENTS.md. */
const CENSUS_PREFIX = '**Service domains** under';

/**
 * The directory that lives beside the domains without being one — it holds
 * cross-service tests. AGENTS.md calls this out in the same sentence.
 */
const NOT_A_DOMAIN = '__tests__';

describe('AGENTS.md service-domain census', () => {
  it('names exactly the directories under apps/server/src/services', () => {
    const agentsMd = readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
    const line = agentsMd.split('\n').find((l) => l.startsWith(CENSUS_PREFIX));

    // A reword that loses the sentence, or either delimiter, must fail loudly
    // rather than vacuously pass by finding nothing to compare.
    if (line === undefined) {
      throw new Error(`AGENTS.md has no line starting "${CENSUS_PREFIX}"`);
    }

    // The names run from the first ": " on the line to the parenthetical that
    // closes the list, so the sentence may be reworded freely around them.
    const listStart = line.indexOf(': ');
    if (listStart === -1) {
      throw new Error(`no ": " introducing the census list in: ${line}`);
    }
    const afterColon = line.slice(listStart + 2);
    const listEnd = afterColon.indexOf(' (');
    if (listEnd === -1) {
      throw new Error(`no " (" closing the census list in: ${line}`);
    }
    const documented = afterColon
      .slice(0, listEnd)
      .split(', ')
      .map((name) => name.trim());

    const onDisk = readdirSync(path.join(repoRoot, 'apps/server/src/services'), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory() && entry.name !== NOT_A_DOMAIN)
      .map((entry) => entry.name)
      .sort();

    expect(documented).toEqual(onDisk);
  });
});
