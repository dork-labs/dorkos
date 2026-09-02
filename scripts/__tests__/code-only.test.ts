/**
 * The stripper every source-scanning guard in this repo shares, pinned against
 * the four failures that produced it.
 *
 * Three guards used to strip comments and strings with their own pair of
 * regexes, in three different orders, and each order was blind to another's
 * mirror case (DOR-642). Every case below is a real one that was found in this
 * repo's own sources, not an invented one:
 *
 * 1. A `/*` inside a STRING (`app.ts`'s `/api/auth/*splat` route) opening a fake
 *    block comment that swallowed the router mount table.
 * 2. An APOSTROPHE inside prose (`token.ts`'s "the API's cookie/header") opening
 *    a fake string that swallowed the code below it in 216 of 454 files.
 * 3. A `/*` inside a LINE comment (`index.ts:322`'s route glob) opening a fake
 *    comment that ran 1,530 lines.
 * 4. And the one that survives literal-blanking but not this stripper: a `//`
 *    inside a BLOCK comment, on the same line as the comment's terminator.
 *
 * The corpus cases run against the real `apps/server/src` tree rather than
 * fixtures, because the point of failures 1-3 is that they were invisible in
 * real code and obvious only once somebody looked at the file they hid in.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { codeOnly } from '../lib/code-only.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVER_SRC = path.join(REPO_ROOT, 'apps', 'server', 'src');

/** Every `.ts` file under `dir`, excluding tests and declaration files. */
function productionSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...productionSources(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('codeOnly keeps code and drops everything else', () => {
  it('a comment delimiter inside a string opens nothing', () => {
    const code = codeOnly(
      [
        "app.all('/api/auth/*splat', handler);",
        'app.use(sessionGate);',
        "app.use('/api/sessions', sessionRoutes);",
      ].join('\n')
    );

    expect(code).toContain('app.use(sessionGate)');
    expect(code).toContain('sessionRoutes');
  });

  it('an apostrophe inside prose opens nothing', () => {
    const code = codeOnly(
      [
        "/** Cannot use the API's cookie/header auth. */",
        "import { createHmac } from 'crypto';",
      ].join('\n')
    );

    expect(code).toContain('createHmac');
  });

  it('a comment delimiter inside a line comment opens nothing', () => {
    const code = codeOnly(
      ['// mounted at /api/auth/*', 'export function b() { return applyShape(1); }'].join('\n')
    );

    expect(code).toContain('applyShape(');
  });

  it('a line comment inside a block comment does not eat the terminator', () => {
    // The residual that two comment regexes still have after literal blanking:
    // a `//.*$` pass runs first, eats `*` + `/` with the rest of the line, and
    // leaves the block open to end of file.
    const code = codeOnly('/* note // aside */ applyShape(2);');

    expect(code).toContain('applyShape(');
  });

  it('still does its actual job: genuine comments are removed', () => {
    const code = codeOnly(
      [
        '/**',
        ' * Prose about applyShape( and how it works.',
        ' */',
        'const x = 1; // another mention of applyShape(',
        '/* block mention of applyShape( */',
        'export const y = 2;',
      ].join('\n')
    );

    expect(code).not.toContain('applyShape(');
    expect(code).toContain('const x = 1;');
    expect(code).toContain('export const y = 2;');
  });

  it('blanks a template literal, and keeps the code in its substitutions', () => {
    const code = codeOnly('const s = `text mentioning applyShape( ${realCall(1)} tail`;');

    expect(code).not.toContain('applyShape(');
    expect(code).toContain('realCall(1)');
  });

  it('blanks a regex literal without mistaking division for a comment', () => {
    const code = codeOnly(
      ['const re = /applyShape\\(|"/g;', 'const half = total / 2;', 'export { re, half };'].join(
        '\n'
      )
    );

    expect(code).not.toContain('applyShape');
    expect(code).toContain('const half = total / 2;');
  });

  it('is not knocked out of alignment by astral characters', () => {
    // TypeScript reports positions in UTF-16 code units. Spreading the source
    // into code points instead makes every index after an emoji one short, so
    // the blank slides past the literal and onto real code — the one
    // over-blanking direction that can hide a call.
    const code = codeOnly(
      ["const emoji = '🎉🎉🎉';", 'export const z = applyShape(3);'].join('\n')
    );

    expect(code).toContain('applyShape(3)');
  });

  it('preserves every position, so a hit maps back to its own line', () => {
    const source = [
      '/**',
      ' * A doc block spanning',
      ' * several lines.',
      ' */',
      'export const value: unknown = 1;',
    ].join('\n');
    const code = codeOnly(source);

    expect(code).toHaveLength(source.length);
    expect(code.split('\n')).toHaveLength(5);
    expect(code.split('\n')[4]).toBe('export const value: unknown = 1;');
  });

  it('lexes .tsx as TSX, so JSX prose is not read as code', () => {
    const code = codeOnly(
      'export const El = () => <p>a mention of applyShape( in prose</p>;',
      'a.tsx'
    );

    expect(code).not.toContain('applyShape(');
    expect(code).toContain('export const El');
  });
});

// These cases name two real files by path, on purpose: they are the files the
// two live failures hid in, and a fixture copy of them would stop being the
// evidence. If either moves, follow it here rather than deleting the case.
describe('codeOnly against the sources the failures were found in', () => {
  const sources = productionSources(SERVER_SRC);

  it('found the server sources to scan', () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  it('leaves every source with content — none is swallowed whole', () => {
    const emptied = sources
      .filter((file) => codeOnly(readFileSync(file, 'utf-8'), file).trim() === '')
      .map((file) => path.relative(SERVER_SRC, file));

    expect(
      emptied,
      `\n${emptied.join('\n')}\n\nThese files stripped to nothing. A scan over them is ` +
        `vacuously green: a fake comment or string span swallowed the whole file.`
    ).toEqual([]);
  });

  it("app.ts's router mount table survives its own route glob", () => {
    const file = path.join(SERVER_SRC, 'app.ts');
    const code = codeOnly(readFileSync(file, 'utf-8'), file);

    // Everything below `app.all('/api/auth/*splat', …)`, which line-comments-first
    // stripping lost to a fake block comment opened by that route string.
    expect(code).toContain('sessionGate');
    expect(code).toContain('resolveAgentIdentity');
    expect(code).toContain('sessionRoutes');
  });

  it("token.ts's code survives the apostrophe in its own TSDoc", () => {
    const file = path.join(SERVER_SRC, 'services', 'workbench-serve', 'token.ts');
    const code = codeOnly(readFileSync(file, 'utf-8'), file);

    expect(code).toContain('createHmac');
    expect(code).toContain('export');
  });

  it('sees a call seeded inside the span app.ts used to hide', () => {
    const file = path.join(SERVER_SRC, 'app.ts');
    const lines = readFileSync(file, 'utf-8').split('\n');
    const glob = lines.findIndex((line) => line.includes('/api/auth/*splat'));
    expect(glob).toBeGreaterThan(-1);

    lines.splice(glob + 1, 0, "    applyShape('evil');");
    const code = codeOnly(lines.join('\n'), file);

    // The argument is a string literal and is blanked; the CALL is what the
    // gate-bypass scan matches on, and it has to survive.
    expect(code).toContain('applyShape(');
  });

  it('does not see the same call seeded inside a real comment in app.ts', () => {
    const file = path.join(SERVER_SRC, 'app.ts');
    const lines = readFileSync(file, 'utf-8').split('\n');
    const glob = lines.findIndex((line) => line.includes('/api/auth/*splat'));

    lines.splice(glob + 1, 0, "    // applyShape('evil');", "    /* applyShape('evil'); */");
    const code = codeOnly(lines.join('\n'), file);

    expect(code).not.toContain('applyShape');
  });
});

describe('every source-scanning guard shares this one stripper', () => {
  const callSites = [
    'apps/server/src/services/core/capabilities/__tests__/gate-bypass-scan.test.ts',
    'apps/server/src/services/core/capabilities/__tests__/permission-mode-firewall.test.ts',
    '.claude/hooks/check-any-changed.mjs',
  ];

  it.each(callSites)('%s imports it rather than rolling its own', (relative) => {
    const text = readFileSync(path.join(REPO_ROOT, relative), 'utf-8');

    expect(text).toContain('code-only.mjs');
    // The regex pair this replaced, in any of its three orders. A guard that
    // grows its own again is back to being blind in one direction.
    expect(text).not.toMatch(/replace\(\s*\/\\\/\\\*/);
    expect(text).not.toMatch(/replace\(\s*\/\\\/\\\//);
  });
});

describe('the `any` hook reads code, not prose', () => {
  const hook = path.join(REPO_ROOT, '.claude', 'hooks', 'check-any-changed.mjs');

  /** Run the hook over `source` written to a temp file, as Claude Code would. */
  function runHook(source: string): { status: number | null; stderr: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'check-any-'));
    const file = path.join(dir, 'subject.ts');
    writeFileSync(file, source);
    const result = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ tool_input: { file_path: file } }),
      encoding: 'utf-8',
      cwd: REPO_ROOT,
    });
    return { status: result.status, stderr: result.stderr };
  }

  it('still finds a real `any`', () => {
    const { status, stderr } = runHook('export function f(x: any) {\n  return x;\n}\n');

    expect(status).toBe(2);
    expect(stderr).toContain('Line 1');
  });

  it('finds one below a TSDoc containing an apostrophe', () => {
    // Strings-first stripping opened a fake string literal at the apostrophe and
    // blanked everything up to the next quote, so the `any` two lines down was
    // invisible to the hook.
    const { status, stderr } = runHook(
      [
        "/** Cannot use the API’s twin: the API's cookie/header auth. */",
        "export const name = 'x';",
        'export function f(x: any) {',
        '  return x;',
        '}',
      ].join('\n')
    );

    expect(status).toBe(2);
    expect(stderr).toContain('Line 3');
  });

  it('reports the line the violation is actually on, below a block comment', () => {
    // Deleting a multi-line block comment instead of blanking it shifted every
    // line below it up, so the hook named the wrong line.
    const { status, stderr } = runHook(
      ['/**', ' * Four', ' * line', ' * doc.', ' */', 'export function f(x: any) {}'].join('\n')
    );

    expect(status).toBe(2);
    expect(stderr).toContain('Line 6');
  });

  it('is not tripped by `any` inside prose or a string', () => {
    const { status } = runHook(
      [
        '/** This function takes any value at all — `x: any` is what it refuses. */',
        "export const message = 'pass x: any and it throws';",
        'export function f(x: unknown) {',
        '  return x;',
        '}',
      ].join('\n')
    );

    expect(status).toBe(0);
  });
});
