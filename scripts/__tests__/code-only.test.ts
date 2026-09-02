/**
 * The stripper every source-scanning guard in this repo shares, pinned against
 * the failures that produced it.
 *
 * Three guards used to strip comments and strings with their own pair of
 * regexes, in three different orders, and each order was blind to another's
 * mirror case (DOR-642). Most cases below are real ones found in this repo's
 * own sources, not invented ones:
 *
 * 1. A `/*` inside a STRING (`app.ts`'s `/api/auth/*splat` route) opening a fake
 *    block comment that swallowed the router mount table.
 * 2. An APOSTROPHE inside prose (`token.ts`'s "the API's cookie/header") opening
 *    a fake string that swallowed the code below it in 216 of the 454 files
 *    there were when DOR-642 measured it.
 * 3. A `/*` inside a LINE comment (`index.ts:322`'s route glob) opening a fake
 *    comment that ran 1,530 lines.
 * 4. A `//` inside a BLOCK comment, on the same line as the comment's
 *    terminator, which survives literal-blanking but not this stripper.
 * 5. JSX inside a `.ts` file (`core-extensions/hello-world/index.ts`), where a
 *    closing tag's `/` opens a fake regular expression.
 * 6. An astral character above a literal, which slides every later blank onto
 *    real code if positions are counted in code points rather than UTF-16 units.
 *
 * Every case is a MUTATION TEST as much as an assertion: each one was run
 * against a deliberately broken copy of the stripper and confirmed to go red.
 * The corpus half of the suite — the same cases against the real 806 server
 * sources — lives in
 * `apps/server/src/services/core/capabilities/__tests__/code-only-corpus.test.ts`,
 * beside the guards that scan that corpus, so turbo's affected-only run reaches
 * it when those sources change. Nothing here reads outside `scripts/` and
 * `.claude/`, which is what this job's CI path filter covers.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { codeOnly, lex } from '../lib/code-only.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

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
    // leaves the block open to end of file. Measured against the implementation
    // this replaced: the whole fixture stripped to `/* note `.
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

  it('does not slide off a literal when an astral character sits above it', () => {
    // TypeScript reports positions in UTF-16 code units. Spreading the source
    // into code points instead leaves every index after an emoji one short, so
    // each blank starts late and runs off the end of its literal into the code
    // after it — the one over-blanking direction that can hide a call.
    //
    // The fixture is tuned so the slide reaches the CALL and not just some
    // spare punctuation: eight emoji shift by eight, and the literal that
    // follows is long enough to carry the blank across `applyConfigPatch(`.
    // Under the code-point spread the line comes out as
    // `label = 'aaaaaaa                onfigPatch(patch);` — the call sheared in
    // half, and a scan for it silently reports nothing.
    const code = codeOnly(
      [
        "const banner = '🎉🎉🎉🎉🎉🎉🎉🎉';",
        "const label = 'aaaaaaaaaaaaaa'; applyConfigPatch(patch);",
      ].join('\n'),
      'a.ts'
    );

    expect(code).toContain('applyConfigPatch(');
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

  it('reads JSX in a `.ts` file, where the extension lies', () => {
    // `apps/server/src/core-extensions/*/index.ts` is JSX in a `.ts` file by
    // design — the extension pipeline compiles it with esbuild at runtime, so it
    // never meets the server's tsc — and it is inside the gate-bypass scan's
    // corpus. Lexed as plain TS, the `/` of a closing tag opens a fake regular
    // expression that runs to the next `/`, so a call between two closing tags
    // is blanked away and the scan over that file reports nothing at all.
    // Without the TSX retry this exact line comes out as
    // `return <div><p>one<                                   ><     ;`.
    const source = [
      'export function View(api) {',
      '  return <div><p>one</p>{applyConfigPatch(api)}<p>two</p></div>;',
      '}',
    ].join('\n');

    expect(lex(source, 'index.ts').parseErrors).toBe(0);
    expect(codeOnly(source, 'index.ts')).toContain('applyConfigPatch(');
  });

  it('reports parse errors rather than pretending a broken file is empty', () => {
    // The honesty channel. A file the parser cannot read has a literal map made
    // of guesses, and it fails SILENTLY — a scan over it finds nothing and looks
    // exactly like a scan over a clean file. Genuinely broken source keeps its
    // errors; the JSX retry only rescues source that another kind can parse.
    expect(lex('export function f( {', 'a.ts').parseErrors).toBeGreaterThan(0);
    expect(lex('export const ok = 1;', 'a.ts').parseErrors).toBe(0);
  });
});

describe('the `any` hook uses the shared stripper rather than its own', () => {
  // The server-side half of this guard — the two capability scans — is asserted
  // in `code-only-corpus.test.ts` instead, because THIS job's path filter does
  // not cover `apps/server/**`: a guard that regrew its own regexes there would
  // not turn this suite red on the PR that did it. Each half is checked by the
  // suite that a change to it actually triggers.
  it('imports it, and carries no stripping regexes of its own', () => {
    const text = readFileSync(path.join(REPO_ROOT, '.claude/hooks/check-any-changed.mjs'), 'utf-8');

    expect(text).toContain('code-only.mjs');
    // Every shape the hand-rolled stripping took across the three call sites: a
    // block-comment regex, a line-comment regex, and a whole-line `//` filter.
    expect(text).not.toMatch(/replace\(\s*\/\\\/\\\*/);
    expect(text).not.toMatch(/replace\(\s*\/\\\/\\\//);
    expect(text).not.toMatch(/startsWith\(\s*['"]\/\//);
  });
});

describe('the `any` hook reads code, not prose', () => {
  const hook = path.join(REPO_ROOT, '.claude', 'hooks', 'check-any-changed.mjs');

  /** Run a hook over `source` written to a temp file, as Claude Code would. */
  function runHook(source: string, hookPath = hook, cwd = REPO_ROOT) {
    const dir = mkdtempSync(path.join(tmpdir(), 'check-any-'));
    const file = path.join(dir, 'subject.ts');
    writeFileSync(file, source);
    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({ tool_input: { file_path: file } }),
      encoding: 'utf-8',
      cwd,
    });
    return { status: result.status, stderr: result.stderr };
  }

  it('still finds a real `any`', () => {
    const { status, stderr } = runHook('export function f(x: any) {\n  return x;\n}\n');

    expect(status).toBe(2);
    expect(stderr).toContain('Line 1');
  });

  it('finds one an apostrophe in a TSDoc used to hide completely', () => {
    // Strings-first stripping opened a fake string literal at the apostrophe
    // that ran to the next quote — the one on the last line here — and blanked
    // the `any` between them. Measured against the pipeline this replaced: exit
    // 0, nothing reported, on this exact fixture.
    const { status, stderr } = runHook(
      [
        "/** Tokens cannot use the API's cookie/header auth. */",
        'export function f(x: any) {',
        '  return x;',
        '}',
        "export const label = 'a trailing string with a quote';",
      ].join('\n')
    );

    expect(status).toBe(2);
    expect(stderr).toContain('Line 2');
  });

  it('reports the line the violation is actually on, below a block comment', () => {
    // Deleting a multi-line block comment instead of blanking it pulled every
    // line below it up, so the hook named a line the violation was not on.
    // Measured against the pipeline this replaced, on a fixture of this shape:
    // reported "Line 2" and quoted an unrelated line of code.
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

  it('says so, loudly, when it cannot run at all', () => {
    // A checkout with no node_modules is a state this repo really reaches (a
    // fresh worktree, before `pnpm install`). The hook has to let the edit
    // through — one that blocks every edit in a new worktree gets switched off —
    // but a check that reports nothing while looking like a clean file is the
    // silent blind spot this whole ticket is about. So: exit 0, and say it.
    const dir = mkdtempSync(path.join(tmpdir(), 'check-any-bare-'));
    mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
    mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
    copyFileSync(hook, path.join(dir, '.claude', 'hooks', 'check-any-changed.mjs'));
    copyFileSync(
      path.join(REPO_ROOT, 'scripts', 'lib', 'code-only.mjs'),
      path.join(dir, 'scripts', 'lib', 'code-only.mjs')
    );

    const { status, stderr } = runHook(
      'export function f(x: any) {}',
      path.join(dir, '.claude', 'hooks', 'check-any-changed.mjs'),
      dir
    );

    expect(status).toBe(0);
    expect(stderr).toContain('DID NOT RUN');
    expect(stderr).toContain('pnpm install');
  });
});
