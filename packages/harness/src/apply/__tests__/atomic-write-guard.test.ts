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
 * Comment lines are skipped so the modules that EXPLAIN why a plain write is
 * wrong (this one included, and `generate-occupants.ts`, which names the EISDIR a
 * plain write throws) are not reported for saying so.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** `packages/harness/src`, three levels above this file. */
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
const FS_WRITE_CALL = /(?<![\w$])(writeFileSync|writeFile|appendFileSync|createWriteStream)\s*\(/;

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

/** The lines of a file that call an `fs` write, ignoring comment lines. */
function fsWriteCalls(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('*') && !line.startsWith('//') && !line.startsWith('/*'))
    .filter((line) => FS_WRITE_CALL.test(line));
}

describe('every generated file is written atomically', () => {
  const files = sourceFiles();

  it('is looking at the engine, so a clean result means something', () => {
    // A walk that found nothing — a moved directory, a wrong root — would report
    // a clean engine for ever.
    expect(files.length).toBeGreaterThan(30);
    expect(files).toContain(HELPER);
    // And the detector fires on the one file that legitimately does it.
    expect(fsWriteCalls(readFileSync(join(SRC, HELPER), 'utf8'))).not.toEqual([]);
  });

  it('routes every write through writeFileAtomic — nothing else touches fs directly', () => {
    const violations = files
      .filter((file) => file !== HELPER && !isTest(file))
      .flatMap((file) =>
        fsWriteCalls(readFileSync(join(SRC, file), 'utf8')).map((line) => `${file}: ${line}`)
      );

    expect(
      violations,
      `These write a file without going through \`writeFileAtomic\` (apply/atomic-write.ts), so a ` +
        `harness reading that path mid-sync can load an empty or half-written file (AP-10, ` +
        `DOR-1854). Import the helper instead — it creates the parent directory too.`
    ).toEqual([]);
  });

  it('catches the shapes a new write site would actually take', () => {
    expect(fsWriteCalls(`writeFileSync(abs, content);`)).toEqual(['writeFileSync(abs, content);']);
    expect(fsWriteCalls(`  fs.writeFileSync(abs, content);`)).toEqual([
      'fs.writeFileSync(abs, content);',
    ]);
    expect(fsWriteCalls(`await writeFile(abs, content);`)).toEqual([
      'await writeFile(abs, content);',
    ]);
    expect(fsWriteCalls(`appendFileSync(abs, line);`)).toEqual(['appendFileSync(abs, line);']);
    expect(fsWriteCalls(`createWriteStream(abs).end(content);`)).toEqual([
      'createWriteStream(abs).end(content);',
    ]);
  });

  it('does not fire on the helper being used, or on prose about the old way', () => {
    expect(fsWriteCalls(`writeFileAtomic(abs, content);`)).toEqual([]);
    expect(fsWriteCalls(` * \`writeFileSync\` fails with EISDIR here.`)).toEqual([]);
    expect(fsWriteCalls(`// writeFileSync(abs, content) would truncate first`)).toEqual([]);
  });
});
