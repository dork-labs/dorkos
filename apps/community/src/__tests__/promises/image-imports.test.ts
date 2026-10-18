/**
 * The build guard for the space image (server-merge step 7, DOR-3006): the image's entries, the
 * server and its offline commands, never reach the machine store, a runtime SDK or the terminal.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { forbiddenReachedFrom, packagesReachedFrom } from './image-imports.js';

const baseline = JSON.parse(
  readFileSync(new URL('image.baseline.json', import.meta.url), 'utf8')
) as { commands: string[] };

/** The space package, relative to the repository root. */
const SPACE = 'apps/community';
/** Every entry the image runs: the server, then each offline command, as source files. */
const ENTRIES = ['dist-server/main.js', ...baseline.commands].map(
  (built) => `${SPACE}/${built.replace(/^dist-server\//u, 'src/').replace(/\.js$/u, '.ts')}`
);

describe('the space image', () => {
  it.each(ENTRIES)('%s reaches no machine store, runtime SDK or terminal', async (entry) => {
    // Purpose: fails if anything the image runs imports, at any depth, better-sqlite3, the
    // machine store, a runtime SDK or node-pty.
    expect(await forbiddenReachedFrom(entry)).toEqual([]);
  });

  it('walks the whole graph, through workspace packages', async () => {
    // Purpose: fails if the walk stops early, which would make the check above pass on nothing.
    const reached = await packagesReachedFrom(`${SPACE}/src/main.ts`);
    expect(reached).toEqual(expect.any(Map));
    for (const name of ['pg', 'hono', 'better-auth', '@dorkos/shared'])
      expect(reached.has(name)).toBe(true);
  });

  it("refuses the DorkOS server's request chain, which opens the machine store on import", async () => {
    // Purpose: the proof the guard bites. apps/server/src/http/api-chain.ts reaches @dorkos/db,
    // and through it better-sqlite3, the moment it is imported; if the space role ever ran inside
    // that chain, this is the failure the image would get.
    const found = await forbiddenReachedFrom('apps/server/src/http/api-chain.ts');
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^better-sqlite3 \(the machine store\), first from packages\/db\//u),
        expect.stringMatching(
          /^@dorkos\/db \(the machine store\), first from apps\/server\/src\//u
        ),
      ])
    );
  }, 60_000);
});
