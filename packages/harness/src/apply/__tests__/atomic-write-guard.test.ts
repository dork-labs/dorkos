/**
 * Drift guard: every file this engine writes goes through `writeFileAtomic`.
 *
 * `atomic-write.test.ts` proves the helper closes the window a truncate-then-write
 * leaves open. This proves the engine USES it — which is the half a behaviour test
 * cannot reach, because a new write site added next month is green everywhere
 * until somebody happens to be reading that exact file at that exact millisecond.
 * The failure is invisible by construction, which is what a guard is for.
 *
 * It reads SOURCE rather than types, because `writeFileSync` from `node:fs`
 * compiles perfectly and looks like every other write in the file it is added to.
 *
 * Comments are removed by the repo's shared stripper, `scripts/lib/code-only.mjs`
 * — never by a regex of this file's own (`scripts/__tests__/code-only.test.ts`
 * fails any guard that grows one back). It matters here: the modules that EXPLAIN
 * why a plain write is wrong, this one and `generate-occupants.ts`, name
 * `writeFileSync` in prose, and a guard that reported them for saying so is a
 * guard somebody widens an allowlist to silence. `codeOnly` blanks non-code spans
 * without changing the file's length, so a hit still reports its real line.
 *
 * ## What it assumes, said out loud
 *
 * **The names are not aliased.** `import { writeFileSync as w }` and then `w(…)`
 * walks straight past this, and so does any indirection through a variable. That
 * is accepted rather than chased: catching it means resolving imports and
 * following bindings — a type-aware pass, not a scan — and the shape it would
 * catch is one nobody writes by accident. The guard is for the ordinary way a
 * write gets added, which is to type the function's name.
 *
 * **The list is the writes that actually land bytes at a path.** It grew
 * `copyFileSync` and `cpSync` in DOR-1854's review round because both are real
 * things somebody reaches for when the content is already in a file — and both
 * truncate the destination exactly like `writeFileSync`. It is deliberately NOT
 * every `node:fs` export: a regex widened past what the module can honestly
 * replace produces findings with no fix, which is how a guard gets disabled.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { codeOnly } from '../../../../../scripts/lib/code-only.mjs';

/** `packages/harness/src`, two levels above this file's directory. */
const SRC = join(import.meta.dirname, '..', '..');

/** The one module allowed to write a file the plain way — it is the helper. */
const HELPER = ['apply', 'atomic-write.ts'].join('/');

/**
 * Every way `node:fs` puts bytes in a file, as a call rather than a mention.
 *
 * The lookbehind is what keeps `fs.writeFileSync(...)` in scope while letting
 * `writeFileAtomic(...)` past: the name has to stand on its own, and a member
 * access on the `fs` namespace is exactly the shape a new site would take.
 */
const FS_WRITE_CALL =
  /(?<![\w$])(writeFileSync|writeFile|appendFileSync|createWriteStream|copyFileSync|cpSync)\s*\(/g;

/** Every `.ts` file under `packages/harness/src`, repo-relative with `/` separators. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.ts')) out.push(relative(SRC, abs).split(sep).join('/'));
    }
  };
  walk(SRC);
  return out.sort();
}

/**
 * Test files are exempt: a suite stages its own fixture tree, and a fixture is
 * not something another program reads while it is being written.
 */
function isTest(file: string): boolean {
  return file.includes('__tests__/') || file.endsWith('.test.ts');
}

/** The `<line>: <name>` of every `fs` write CALL in a file, comments excluded. */
function fsWriteCalls(source: string, fileName = 'scan.ts'): string[] {
  const code = codeOnly(source, fileName);
  return [...code.matchAll(FS_WRITE_CALL)].map(
    (match) => `${code.slice(0, match.index).split('\n').length}: ${match[1]}`
  );
}

describe('every generated file is written atomically', () => {
  const files = sourceFiles();

  it('is looking at the engine, so a clean result means something', () => {
    // A walk that found nothing — a moved directory, a wrong root — would report
    // a clean engine for ever.
    expect(files.length).toBeGreaterThan(30);
    expect(files).toContain(HELPER);
    // And the detector fires on the one file that legitimately does it.
    expect(fsWriteCalls(readFileSync(join(SRC, HELPER), 'utf8'), HELPER)).not.toEqual([]);
  });

  it('routes every write through writeFileAtomic — nothing else touches fs directly', () => {
    const violations = files
      .filter((file) => file !== HELPER && !isTest(file))
      .flatMap((file) =>
        fsWriteCalls(readFileSync(join(SRC, file), 'utf8'), file).map((hit) => `${file}:${hit}`)
      );

    expect(
      violations,
      `These write a file without going through \`writeFileAtomic\` (apply/atomic-write.ts), so a ` +
        `harness reading that path mid-sync can load an empty or half-written file (AP-10, ` +
        `DOR-1854). Import the helper instead — it creates the parent directory too.`
    ).toEqual([]);
  });

  it('catches the shapes a new write site would actually take', () => {
    expect(fsWriteCalls(`writeFileSync(abs, content);`)).toEqual(['1: writeFileSync']);
    expect(fsWriteCalls(`  fs.writeFileSync(abs, content);`)).toEqual(['1: writeFileSync']);
    expect(fsWriteCalls(`await writeFile(abs, content);`)).toEqual(['1: writeFile']);
    expect(fsWriteCalls(`appendFileSync(abs, line);`)).toEqual(['1: appendFileSync']);
    expect(fsWriteCalls(`createWriteStream(abs).end(content);`)).toEqual(['1: createWriteStream']);
    // Both land bytes at a path by truncating whatever is there — the same
    // window, reached by a different name.
    expect(fsWriteCalls(`copyFileSync(from, abs);`)).toEqual(['1: copyFileSync']);
    expect(fsWriteCalls(`cpSync(from, abs, { recursive: true });`)).toEqual(['1: cpSync']);
    // The line number is the real one, which is what `codeOnly` preserving
    // length buys: a stripper that deleted the comment would report line 1.
    expect(fsWriteCalls(`/* a\nlong\nnote */\nwriteFileSync(abs, x);`)).toEqual([
      '4: writeFileSync',
    ]);
  });

  it('does not fire on the helper being used, or on prose about the old way', () => {
    expect(fsWriteCalls(`writeFileAtomic(abs, content);`)).toEqual([]);
    expect(fsWriteCalls(` * \`writeFileSync\` fails with EISDIR here.`)).toEqual([]);
    expect(fsWriteCalls(`// writeFileSync(abs, content) would truncate first`)).toEqual([]);
    expect(fsWriteCalls(`/** writeFileSync(x) is what this replaced. */\nconst a = 1;`)).toEqual(
      []
    );
    // A string that merely names one is not a call either.
    expect(fsWriteCalls(`const hint = 'call writeFileSync(abs) instead';`)).toEqual([]);
  });

  it('is honest about the alias it cannot see', () => {
    // Pinned so the limitation is a decision somebody can find, not a surprise
    // the next person discovers by shipping past it. If this ever needs to
    // close, the tool is a type-aware pass, not a wider regex.
    expect(fsWriteCalls(`import { writeFileSync as w } from 'node:fs';\nw(abs, content);`)).toEqual(
      []
    );
  });
});
