// @vitest-environment node
/**
 * Every client test that renders declares the environment it runs in.
 *
 * The client's default Vitest environment is `node` (DOR-4190): jsdom costs
 * about 0.72 s of setup per file, and most logic tests never touch a DOM. A
 * file that renders a component has to opt in with
 * `// @vitest-environment jsdom`. The first version of that change was ejected
 * from the merge queue twice because two `.tsx` tests that landed on `main`
 * after it was written had no docblock, ran in node, and failed every case
 * (`extension-frame-host`, 37/37, and `browser-chrome`, 22/22). Nothing in a
 * pull request's own checks showed it: the client shards that would have run
 * them only run in the queue.
 *
 * This is the guard. Every `.tsx` test (the ones that almost always render),
 * and every `.ts` test that imports Testing Library or calls `render(` or
 * `renderHook(`, must name its environment in the comment block at the top of
 * the file, where Vitest reads it. Other `.ts` tests are not checked: most are
 * logic tests that rightly take the node default.
 *
 * @module __tests__/vitest-environment-guard
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it, expect } from 'vitest';

const SRC = join(__dirname, '..');

/** The environments a client test may declare. */
const KNOWN_ENVIRONMENTS = new Set(['jsdom', 'node']);

/** Every `.test.ts`/`.test.tsx` file under `apps/client/src`, keyed by its path from `src/`. */
function clientTests(): Map<string, string> {
  const walk = (dir: string): [string, string][] =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      if (!entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) return [];
      return [[relative(SRC, full).split(sep).join('/'), readFileSync(full, 'utf8')]] as [
        string,
        string,
      ][];
    });
  return new Map(walk(SRC));
}

/**
 * The comment block(s) at the very top of a file, before its first line of code.
 *
 * @param text - The file's source.
 */
function leadingComments(text: string): string {
  let rest = text.replace(/^\uFEFF/, '');
  let header = '';
  for (;;) {
    const trimmed = rest.replace(/^\s+/, '');
    const match = /^(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(trimmed);
    if (!match) return header;
    header += `${match[0]}\n`;
    rest = trimmed.slice(match[0].length);
  }
}

/**
 * The environment a file declares in its leading comments, or `null`.
 *
 * @param text - The file's source.
 */
function declaredEnvironment(text: string): string | null {
  return /@vitest-environment\s+([\w-]+)/.exec(leadingComments(text))?.[1] ?? null;
}

/**
 * Whether a test file renders, and so needs a DOM: every `.tsx` test, and any
 * `.ts` test that imports Testing Library or calls `render(`/`renderHook(`.
 *
 * @param file - The file's path from `src/`.
 * @param text - The file's source.
 */
function needsDeclaration(file: string, text: string): boolean {
  if (file.endsWith('.tsx')) return true;
  return /['"]@testing-library\//.test(text) || /(?<![\w$])(?:render|renderHook)\(/.test(text);
}

const CLIENT_TESTS = clientTests();

describe('client test environments (DOR-4190)', () => {
  it('walks a real, populated tree', () => {
    // A walk that silently found nothing would pass every assertion below.
    expect([...CLIENT_TESTS.keys()].filter((f) => f.endsWith('.tsx')).length).toBeGreaterThan(500);
    expect([...CLIENT_TESTS.keys()].filter((f) => f.endsWith('.ts')).length).toBeGreaterThan(500);
  });

  it('counts a .ts test as rendering only when it uses Testing Library or render', () => {
    expect(needsDeclaration('a.test.tsx', 'export {};')).toBe(true);
    expect(needsDeclaration('a.test.ts', "import { screen } from '@testing-library/react';")).toBe(
      true
    );
    expect(needsDeclaration('a.test.ts', 'const { result } = renderHook(() => useX());')).toBe(
      true
    );
    expect(needsDeclaration('a.test.ts', 'render(<X />);')).toBe(true);
    expect(needsDeclaration('a.test.ts', 'expect(prerender()).toBe(1); x.rendered(2);')).toBe(
      false
    );
    expect(needsDeclaration('a.test.ts', 'expect(sum(1, 2)).toBe(3);')).toBe(false);
  });

  it('reads the declaration only from the top of the file', () => {
    expect(declaredEnvironment('// @vitest-environment jsdom\nimport x from "x";')).toBe('jsdom');
    expect(declaredEnvironment('/**\n * @vitest-environment jsdom\n */\nimport x;')).toBe('jsdom');
    expect(declaredEnvironment('/** Header. */\n// @vitest-environment node\nx;')).toBe('node');
    expect(declaredEnvironment('import x from "x";\n// @vitest-environment jsdom\n')).toBeNull();
    expect(declaredEnvironment('import x from "x";\n')).toBeNull();
  });

  it('every test that renders declares its environment at the top of the file', () => {
    const missing = [...CLIENT_TESTS]
      .filter(([file, text]) => needsDeclaration(file, text) && declaredEnvironment(text) === null)
      .map(([file]) => file)
      .sort();

    expect(
      missing,
      'These client tests run in node because they do not declare an environment. ' +
        'Add `// @vitest-environment jsdom` as the first line of each one that ' +
        'renders or touches the DOM (or `// @vitest-environment node` if it truly ' +
        'needs none). Client tests default to node since DOR-4190.'
    ).toEqual([]);
  });

  it('declares only environments the client uses', () => {
    const unknown = [...CLIENT_TESTS]
      .map(([file, text]) => [file, declaredEnvironment(text)] as const)
      .filter(([, env]) => env !== null && !KNOWN_ENVIRONMENTS.has(env))
      .map(([file, env]) => `${file}: ${env}`)
      .sort();

    expect(unknown).toEqual([]);
  });
});
