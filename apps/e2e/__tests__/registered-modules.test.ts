import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every module a spec registers tests from is listed in `REGISTERED_MODULES`,
 * and every listed module is still registered by some spec.
 *
 * `scripts/assert-browser-tests-executed.sh` proves the browser suite really
 * ran, and it holds a module like `chat/ref-link-chip.ts` (a plain `.ts` file a
 * spec imports `registerRefLinkChipTests` from) to the same standard as a spec
 * only when that module is in its `REGISTERED_MODULES` list. A module missing
 * from the list shows up in the report as an unknown file and fails the proof.
 * But the proof only runs on FULL browser runs (main, the canary, a release),
 * so a pull request that added such a module without listing it passed and
 * turned main red (#4334, fixed by #4444). This is the same check, read from the
 * source, on every pull request that touches apps/e2e. A change to the script
 * itself is a `scripts/**` change, which runs every suite
 * (`scripts/pr-test-plan.sh`), so this file runs then too.
 */
const E2E_ROOT = resolve(import.meta.dirname, '..');
const TESTS_DIR = join(E2E_ROOT, 'tests');
const PROOF_SCRIPT = resolve(E2E_ROOT, '../../scripts/assert-browser-tests-executed.sh');
const PROOF_SCRIPT_NAME = 'scripts/assert-browser-tests-executed.sh';

/**
 * A module a spec already registers whose REGISTERED_MODULES entry is in a
 * pull request that has not merged yet, mapped to that pull request.
 *
 * Tolerated in one direction only (a spec may import it while the list lacks
 * it), and never an error once the list has it, so the fix can merge before or
 * after this file. Delete the entry once that pull request is on main.
 */
const PENDING_IN_FLIGHT = new Map<string, string>([['chat/ref-link-chip.ts', '#4444']]);

/** The exported name a registered module's entry point carries. */
const REGISTER_NAME = /^register\w*Tests?$/;

/**
 * Read the `REGISTERED_MODULES=( … )` bash array out of the proof script.
 *
 * Strict on purpose: the array must open on its own line, close on its own
 * line, and hold only quoted paths, blank lines and comments. Anything else
 * (an expansion, two entries on a line, a missing close) throws, because a
 * parser that guesses would let this check pass on a list it misread.
 */
function parseRegisteredModules(script: string): string[] {
  const lines = script.split('\n');
  const start = lines.findIndex((line) => line === 'REGISTERED_MODULES=(');
  if (start === -1) {
    throw new Error(
      `${PROOF_SCRIPT_NAME} has no line that is exactly "REGISTERED_MODULES=(". ` +
        'This test reads that array; if it was renamed or reshaped, update parseRegisteredModules.'
    );
  }
  const entries: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === ')') {
      if (entries.length === 0) throw new Error('REGISTERED_MODULES is empty.');
      return entries;
    }
    if (line === '' || line.startsWith('#')) continue;
    const match = /^'([^'\s$`]+)'$/.exec(line) ?? /^"([^"\s$`]+)"$/.exec(line);
    if (!match) {
      throw new Error(
        `REGISTERED_MODULES line ${i + 1} is not one quoted path: ${JSON.stringify(lines[i])}. ` +
          "Write one entry per line, like 'chat/compaction.ts'."
      );
    }
    entries.push(match[1]);
  }
  throw new Error(`REGISTERED_MODULES=( on line ${start + 1} is never closed by a line ")".`);
}

/**
 * The relative module specifiers a spec imports a `register…Tests` function
 * from. Handles multi-line `{ … }` lists and `name as alias`.
 */
function registerImports(source: string): string[] {
  const found = new Set<string>();
  const imports = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const [, names, specifier] of source.matchAll(imports)) {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
    const imported = names
      .split(',')
      .map((name) =>
        name
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0]
          .trim()
      )
      .filter(Boolean);
    if (imported.some((name) => REGISTER_NAME.test(name))) found.add(specifier);
  }
  return [...found];
}

/** Resolve a specifier written in `fromFile` to the `.ts` file it loads. */
function resolveModule(fromFile: string, specifier: string): string {
  const target = resolve(dirname(fromFile), specifier);
  if (target.endsWith('.js')) return `${target.slice(0, -'.js'.length)}.ts`;
  if (target.endsWith('.ts')) return target;
  return `${target}.ts`;
}

/** Every `*.spec.ts` under `dir`. */
function specFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.spec.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !file.split(sep).includes('node_modules'))
    .sort();
}

/** A path under tests/, in the form REGISTERED_MODULES writes it. */
const testsRelative = (file: string) => relative(TESTS_DIR, file).split(sep).join(posix.sep);

/** Each registered module a spec imports, mapped to the specs importing it. */
function registeredBySpecs(): Map<string, string[]> {
  const modules = new Map<string, string[]>();
  for (const spec of specFiles(TESTS_DIR)) {
    for (const specifier of registerImports(readFileSync(spec, 'utf8'))) {
      const target = resolveModule(spec, specifier);
      if (target.endsWith('.spec.ts')) continue;
      const key = relative(TESTS_DIR, target).startsWith('..')
        ? relative(E2E_ROOT, target).split(sep).join(posix.sep)
        : testsRelative(target);
      modules.set(key, [...(modules.get(key) ?? []), testsRelative(spec)]);
    }
  }
  return modules;
}

describe('parseRegisteredModules', () => {
  it('reads quoted entries and skips comments and blank lines', () => {
    const sample = [
      'OTHER=(x)',
      'REGISTERED_MODULES=(',
      "  'chat/a.ts'",
      '  # a note',
      '',
      '  "b/c.ts"',
      ')',
    ].join('\n');
    expect(parseRegisteredModules(sample)).toEqual(['chat/a.ts', 'b/c.ts']);
  });

  it('throws when the array is missing, unclosed, empty or holds something else', () => {
    expect(() => parseRegisteredModules('OPT_IN_SPECS=(\n)')).toThrow(/no line/);
    expect(() => parseRegisteredModules("REGISTERED_MODULES=(\n  'a.ts'\n")).toThrow(
      /never closed/
    );
    expect(() => parseRegisteredModules('REGISTERED_MODULES=(\n)')).toThrow(/empty/);
    expect(() => parseRegisteredModules("REGISTERED_MODULES=(\n  'a.ts' 'b.ts'\n)")).toThrow(
      /not one quoted path/
    );
    expect(() => parseRegisteredModules('REGISTERED_MODULES=(\n  "$dir/a.ts"\n)')).toThrow(
      /not one quoted path/
    );
  });
});

describe('registerImports', () => {
  it('finds register imports in single-line, multi-line and extensionless forms', () => {
    const sample = [
      "import { test } from '../fixtures/base';",
      "import { registerFooTests } from './chat/foo.js';",
      "import { MOCK_API_URL, useMockServer } from './chat/mock-server.js';",
      'import {',
      '  registerBarTests,',
      '  registerBarFirstStepTests as firstStep,',
      "} from './bar.js';",
      "import { registerBazTest } from './baz';",
      "import { registerPkgTests } from '@dorkos/pkg';",
    ].join('\n');
    expect(registerImports(sample)).toEqual(['./chat/foo.js', './bar.js', './baz']);
  });
});

describe('REGISTERED_MODULES in the browser execution proof', () => {
  const listed = parseRegisteredModules(readFileSync(PROOF_SCRIPT, 'utf8'));
  const imported = registeredBySpecs();

  it('finds the registered modules the specs import', () => {
    // A scan that silently matched nothing would pass every check below.
    expect(imported.size).toBeGreaterThan(0);
  });

  it('lists every module a spec registers tests from', () => {
    const missing = [...imported]
      .filter(([module]) => !listed.includes(module) && !PENDING_IN_FLIGHT.has(module))
      .map(([module, specs]) => `  '${module}'   (registered by ${specs.join(', ')})`);
    expect(
      missing,
      `Add these lines to REGISTERED_MODULES in ${PROOF_SCRIPT_NAME}, in sorted order, ` +
        'with a comment above the array saying which spec registers each and why. ' +
        'Without them the browser execution proof on main reads each as an unknown file ' +
        'and fails:\n' +
        missing.join('\n')
    ).toEqual([]);
  });

  it('lists only modules that exist and that some spec still registers', () => {
    const stale = listed
      .filter((module) => !imported.has(module))
      .map((module) =>
        existsSync(join(TESTS_DIR, module))
          ? `  '${module}'   (exists, but no *.spec.ts imports a register…Tests function from it)`
          : `  '${module}'   (no such file under apps/e2e/tests)`
      );
    expect(
      stale,
      `Remove these lines from REGISTERED_MODULES in ${PROOF_SCRIPT_NAME} (and their note ` +
        'above the array), or restore the file and the spec import that registers it:\n' +
        stale.join('\n')
    ).toEqual([]);
  });

  it('lists each module once', () => {
    const repeated = listed.filter((module, i) => listed.indexOf(module) !== i);
    expect(
      repeated,
      `Remove the repeated REGISTERED_MODULES lines in ${PROOF_SCRIPT_NAME}`
    ).toEqual([]);
  });
});
