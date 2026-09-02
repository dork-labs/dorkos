/**
 * The shared stripper, against the real corpus the two guards beside this file
 * scan.
 *
 * `gate-bypass-scan.test.ts` and `permission-mode-firewall.test.ts` both decide
 * what is a call and what is prose by lexing `apps/server/src` with
 * `scripts/lib/code-only.mjs`. Everything they can see, and everything they are
 * blind to, is a property of that lexing — so the lexing is asserted here,
 * against the same files, rather than only against fixtures.
 *
 * ## Why here and not beside the stripper
 *
 * The stripper's fixture suite lives in `scripts/__tests__/code-only.test.ts`,
 * run by the `scripts-test` workflow. That workflow's path filter covers
 * `scripts/**` and `.claude/hooks/**` — not `apps/server/src/**` — so corpus
 * assertions there would go unrun by the change most likely to break them: an
 * edit to a server source. It also has no `merge_group` trigger, so it never
 * reports to the merge queue. Here, both are solved by where the file sits:
 * turbo's affected-only run reaches it on any server change, and the full
 * monorepo sweep runs it as a required merge-queue check.
 *
 * ## What each assertion is worth
 *
 * Each one was run against a deliberately broken copy of the stripper, because
 * an assertion no mutation can kill is decoration. Over the 806 sources:
 *
 * - Spreading the source into code points instead of UTF-16 units (so every
 *   blank after an astral character starts late and runs into the code behind
 *   it) leaves a quote character standing in **7** files.
 * - Removing literal blanking altogether leaves one in **793**.
 * - Dropping the JSX retry leaves **1** file — `core-extensions/hello-world/
 *   index.ts` — with 33 parse errors and a literal map made of guesses.
 *
 * @vitest-environment node
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { lex } from '../../../../../../../scripts/lib/code-only.mjs';

/** `apps/server/src`, resolved from this file rather than from the cwd. */
const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Every `.ts` file under `dir`, excluding tests and declaration files.
 *
 * Deliberately its own copy rather than the guards' — a corpus test that
 * borrowed the walker it is checking could not notice the walker missing files,
 * and both would agree on a corpus neither had fully seen.
 *
 * @param dir - Absolute directory to walk.
 * @returns Absolute paths of the production sources found.
 */
async function productionSources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...(await productionSources(full)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

/** The corpus, read and lexed ONCE — the same work the guards beside this do. */
const LEXED = await Promise.all(
  (await productionSources(SERVER_SRC)).map(async (file) => ({
    relative: path.relative(SERVER_SRC, file),
    ...lex(await readFile(file, 'utf-8'), file),
  }))
);

describe('the stripper reads every source in the scanned corpus', () => {
  it('found the corpus', () => {
    // A property asserted over an empty list is vacuously true, which is the one
    // way this file could fail to do its job without saying so.
    expect(LEXED.length).toBeGreaterThan(100);
  });

  it('parses all of it — a file it cannot read is a file it cannot scan', () => {
    const unparsed = LEXED.filter((file) => file.parseErrors > 0).map(
      (file) => `${file.relative} (${file.parseErrors} parse errors)`
    );

    expect(
      unparsed,
      `\n${unparsed.join('\n')}\n\nThe stripper could not parse these, so what it calls a ` +
        `string and what it calls code in them is guesswork — and the guards that scan them ` +
        `report "no ungated caller" having seen very little of the file.\n\n` +
        `The known family is JSX inside a .ts file (core-extensions), which the stripper ` +
        `retries as TSX. A file here is a NEW family: find out what the parser is choking on ` +
        `and teach the stripper, rather than removing this assertion.`
    ).toEqual([]);
  });

  it('leaves no literal standing anywhere in it', () => {
    // A quote character in the output means a literal was blanked from the wrong
    // offsets — and the blank that missed the literal landed on the code beside
    // it instead. This is the assertion that fails when positions drift.
    const leaked = LEXED.filter((file) => /['"`]/.test(file.code)).map((file) => file.relative);

    expect(
      leaked,
      `\n${leaked.join('\n')}\n\nA string, template or regex literal survived stripping in ` +
        `these files. The blank that should have covered it landed somewhere else — on the ` +
        `code after it — so a call there is now invisible to every guard that uses this.`
    ).toEqual([]);
  });

  it('leaves every source with content — none is swallowed whole', () => {
    const emptied = LEXED.filter((file) => file.code.trim() === '').map((file) => file.relative);

    expect(
      emptied,
      `\n${emptied.join('\n')}\n\nThese files stripped to nothing. A scan over them is ` +
        `vacuously green: a fake comment or string span swallowed the whole file.`
    ).toEqual([]);
  });
});

describe('both scans over this corpus share the one stripper', () => {
  // The hook's half of this guard is asserted in `scripts/__tests__/
  // code-only.test.ts`, whose CI job the hook's own path filter triggers. This
  // half lives here for the same reason: a capability scan that regrew its own
  // regexes is a change to `apps/server`, and this is the suite that runs.
  const guards = ['gate-bypass-scan.test.ts', 'permission-mode-firewall.test.ts'];

  it.each(guards)('%s imports it, and carries no stripping regexes of its own', async (name) => {
    const text = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), name), {
      encoding: 'utf-8',
    });

    expect(text).toContain('code-only.mjs');
    // Every shape the hand-rolled stripping took across the three call sites: a
    // block-comment regex, a line-comment regex, and a whole-line `//` filter.
    // Each was blind in a different direction, and no order of them is correct.
    expect(text).not.toMatch(/replace\(\s*\/\\\/\\\*/);
    expect(text).not.toMatch(/replace\(\s*\/\\\/\\\//);
    expect(text).not.toMatch(/startsWith\(\s*['"]\/\//);
  });
});

// These cases name two real files by path, on purpose: they are the files the
// two live failures hid in, and a fixture copy of them would stop being the
// evidence. If either moves, follow it here rather than deleting the case.
describe('the two files the failures were found in', () => {
  /** One lexed source by its path relative to `apps/server/src`. */
  function lexed(relative: string): string {
    const file = LEXED.find((entry) => entry.relative === relative);
    if (!file) throw new Error(`${relative} is no longer in the corpus — update this test`);
    return file.code;
  }

  it("app.ts's router mount table survives its own route glob", () => {
    // Everything below `app.all('/api/auth/*splat', …)`, which line-comments-first
    // stripping lost to a fake block comment opened by that route string.
    const code = lexed('app.ts');

    expect(code).toContain('sessionGate');
    expect(code).toContain('resolveAgentIdentity');
    expect(code).toContain('sessionRoutes');
  });

  it("token.ts's code survives the apostrophe in its own TSDoc", () => {
    const code = lexed(path.join('services', 'workbench-serve', 'token.ts'));

    expect(code).toContain('createHmac');
    expect(code).toContain('export');
  });

  it('sees a call seeded inside the span app.ts used to hide', async () => {
    const file = path.join(SERVER_SRC, 'app.ts');
    const lines = (await readFile(file, 'utf-8')).split('\n');
    const glob = lines.findIndex((line) => line.includes('/api/auth/*splat'));
    expect(glob).toBeGreaterThan(-1);

    lines.splice(glob + 1, 0, "    applyShape('evil');");

    // The argument is a string literal and is blanked; the CALL is what the
    // gate-bypass scan matches on, and it has to survive.
    expect(lex(lines.join('\n'), file).code).toContain('applyShape(');
  });

  it('does not see the same call seeded inside a real comment in app.ts', async () => {
    const file = path.join(SERVER_SRC, 'app.ts');
    const lines = (await readFile(file, 'utf-8')).split('\n');
    const glob = lines.findIndex((line) => line.includes('/api/auth/*splat'));

    lines.splice(glob + 1, 0, "    // applyShape('evil');", "    /* applyShape('evil'); */");

    expect(lex(lines.join('\n'), file).code).not.toContain('applyShape');
  });
});
