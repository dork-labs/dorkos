/**
 * The build guard for the space image (server-merge step 7, DOR-3006): the image's entries, the
 * server and its offline commands, never reach the machine store, a runtime SDK or the terminal.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_IN_SPACE_IMAGE,
  REPO_ROOT,
  forbiddenReachedFrom,
  walkImports,
} from './image-imports.js';
import { SPACE_SRC } from '../space-paths.js';

const baseline = JSON.parse(
  readFileSync(new URL('image.baseline.json', import.meta.url), 'utf8')
) as { commands: string[] };

/** The space server's source, relative to the repository root. */
const SPACE_SOURCE = relative(REPO_ROOT, fileURLToPath(SPACE_SRC)).replace(/\/$/u, '');
/** Every entry the image runs: the server, then each offline command, as source files. */
const ENTRIES = ['dist-server/main.js', ...baseline.commands].map(
  (built) => `${SPACE_SOURCE}/${built.replace(/^dist-server\//u, '').replace(/\.js$/u, '.ts')}`
);

describe('the space image', () => {
  it.each(ENTRIES)('%s reaches no machine store, runtime SDK or terminal', async (entry) => {
    // Purpose: fails if anything the image runs imports, at any depth, better-sqlite3, the
    // machine store, a runtime SDK or node-pty.
    expect(await forbiddenReachedFrom(entry)).toEqual([]);
  });

  it('walks the whole graph, through workspace packages', async () => {
    // Purpose: fails if the walk stops early, which would make the check above pass on nothing.
    const { packages } = await walkImports(`${SPACE_SOURCE}/main.ts`);
    for (const name of ['pg', 'hono', 'better-auth', '@dorkos/shared'])
      expect(packages.has(name)).toBe(true);
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

  it('knows every forbidden name, also through another package or a computed load', async () => {
    // Purpose: fails if a forbidden name stops matching (a typo, a subpath such as
    // drizzle-orm/better-sqlite3 that loads the store through an allowed package), or a load by a
    // computed name goes unseen. Bare names never resolve, so nothing here needs installing.
    const found = await forbiddenReachedFrom({
      contents: [
        ...Object.keys(FORBIDDEN_IN_SPACE_IMAGE).map((name) => `import '${name}';`),
        "export { drizzle } from 'drizzle-orm/better-sqlite3';",
      ].join('\n'),
    });
    expect(found).toEqual([
      ...Object.entries(FORBIDDEN_IN_SPACE_IMAGE).map(
        ([name, why]) => `${name} (${why}), first from <stdin>`
      ),
      // The helper finds node-pty through createRequire; the walk names it as well.
      'a load by a computed name in packages/shared/src/node-pty-spawn-helper.ts',
    ]);
    // Through another package alone, the store is still found.
    expect(
      await forbiddenReachedFrom({
        contents: "export { drizzle } from 'drizzle-orm/better-sqlite3';",
      })
    ).toEqual(['better-sqlite3 (the machine store), first from <stdin>']);
  });

  it('refuses a load by a computed name', async () => {
    // Purpose: fails if `createRequire` or an `import()` of a computed name goes unseen; either
    // could load a forbidden package the walk cannot follow.
    const folder = mkdtempSync(join(tmpdir(), 'space-image-'));
    const entry = join(folder, 'entry.ts');
    writeFileSync(
      join(folder, 'computed.ts'),
      "const name = 'pg';\nexport const load = () => import(name);\n"
    );
    writeFileSync(
      join(folder, 'required.ts'),
      "import { createRequire } from 'node:module';\nexport const req = createRequire(import.meta.url);\n"
    );
    writeFileSync(
      entry,
      "import './computed.ts';\nimport './required.ts';\nimport('./computed.ts');\n"
    );
    const found = await forbiddenReachedFrom(entry);
    expect(found).toHaveLength(2);
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^a load by a computed name in .*computed\.ts$/u),
        expect.stringMatching(/^a load by a computed name in .*required\.ts$/u),
      ])
    );
  });
});
