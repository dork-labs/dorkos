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
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { codeOnly, lex, lexWithoutComments } from '../lib/code-only.mjs';

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

describe('lexWithoutComments keeps the literals and drops only the comments', () => {
  // The second question this module answers: "does this file SAY this word?"
  // The word usually lives in a literal, so `codeOnly` is the wrong tool for it
  // — and wrong in the silent direction, which is why these cases exist.

  /**
   * The comment-only strip of `text`, asserting it parsed.
   *
   * @param text - The fixture source.
   * @param fileName - Its name, which decides how it is lexed.
   * @returns The source with only its comments blanked.
   */
  function stripped(text: string, fileName = 'scan.ts'): string {
    const { code, parseErrors } = lexWithoutComments(text, fileName);
    expect(parseErrors, `${fileName} did not parse`).toBe(0);
    return code;
  }

  it('keeps a class name written inside a string, which codeOnly erases', () => {
    const source = "export const chip = <span className='bg-green-500' />;";

    expect(stripped(source, 'a.tsx')).toContain('bg-green-500');
    // The contrast is the point: run this guard through the other stripper and
    // its subject is gone, so every `not.toContain` passes over an unread file.
    expect(codeOnly(source, 'a.tsx')).not.toContain('bg-green-500');
  });

  it('still drops the comment that names the same thing', () => {
    const code = stripped(
      [
        '/** `bg-green-500` is retired — use HEALTH_DISPLAY. */',
        'const a = 1; // and never bg-green-500 again',
        "export const chip = 'bg-emerald-500';",
      ].join('\n')
    );

    expect(code).not.toContain('bg-green-500');
    expect(code).toContain('bg-emerald-500');
    expect(code).toContain('const a = 1;');
  });

  it('a comment delimiter inside a string opens nothing', () => {
    // The failure that killed the block-comment-first regex: `/*` in a route
    // string opened a fake comment that ran to the next real terminator and
    // swallowed the mount table in between. The last two lines are what make
    // this a mutation rather than a fixture — without a terminator below, the
    // broken pipeline finds no match and looks correct.
    const code = stripped(
      [
        "app.all('/api/auth/*splat', handler);",
        'app.use(sessionGate);',
        "app.use('/api/sessions', sessionRoutes);",
        '/** A real block comment, whose terminator closes the fake span above. */',
        "export const chip = 'bg-green-500';",
      ].join('\n')
    );

    expect(code).toContain('sessionGate');
    expect(code).toContain("'/api/sessions'");
    expect(code).toContain('bg-green-500');
    expect(code).not.toContain('A real block comment');
  });

  it('an apostrophe inside prose opens nothing', () => {
    // The mirror failure, from strings-first stripping: the apostrophe in
    // "API's" opened a fake string that ran to the next quote.
    const code = stripped(
      ["/** Cannot use the API's cookie/header auth. */", "export const key = 'keep-me';"].join(
        '\n'
      )
    );

    expect(code).toContain("'keep-me'");
    expect(code).not.toContain('cookie');
  });

  it('a URL in a string is not read as a line comment', () => {
    // What the `(^|[^:])//` guard in three of the converted call sites was for.
    // The parser never sees a comment here, so no such guard is needed.
    const code = stripped("export const docs = 'https://dorkos.ai/docs'; // link");

    expect(code).toContain("'https://dorkos.ai/docs'");
    expect(code).not.toContain('link');
  });

  it('a line comment inside a block comment does not eat the terminator', () => {
    const code = stripped("/* note // aside */ export const k = 'kept';");

    expect(code).toContain("'kept'");
    expect(code).not.toContain('aside');
  });

  it('preserves every position, so a reported line number is the real one', () => {
    // Three call sites report 1-based line numbers off this output. Deleting a
    // comment instead of blanking it would pull every line below it up.
    const source = [
      '/**',
      ' * A doc block spanning',
      ' * several lines.',
      ' */',
      "export const key = ['config'];",
    ].join('\n');
    const code = stripped(source);

    expect(code).toHaveLength(source.length);
    expect(code.split('\n')[4]).toBe("export const key = ['config'];");
  });

  it('keeps JSX prose in a .tsx, which is copy a reader sees', () => {
    const source = 'export const El = () => <p>All your agents. One place.</p>;';

    expect(stripped(source, 'a.tsx')).toContain('One place.');
    expect(codeOnly(source, 'a.tsx')).not.toContain('One place.');
  });

  it('reports parse errors rather than pretending a broken file is empty', () => {
    expect(lexWithoutComments('export function f( {', 'a.ts').parseErrors).toBeGreaterThan(0);
    expect(lexWithoutComments('export const ok = 1;', 'a.ts').parseErrors).toBe(0);
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

/**
 * The three retired JS/TS comment-stripper shapes, as source text.
 *
 * One entry per form that was really in this repo: the non-greedy block-comment
 * regex, the line-comment regex, and the whole-line `//` filter. Each was blind
 * in a different direction and no order of them is correct (DOR-642, DOR-1714).
 *
 * A DRIFT GUARD FOR THOSE THREE SHAPES, and not a general "somebody rolled
 * their own stripper" detector — which is worth stating plainly, because the
 * sweep's green does not mean what the broader reading would suggest. It cannot
 * see a stripper written some fourth way, and it deliberately does not look at
 * strippers for OTHER LANGUAGES: the two migration tests in
 * `packages/db/src/__tests__/` each carry a SQL double-dash line-comment regex,
 * which is correct code with nothing to migrate to. The shared stripper lexes
 * TypeScript and JavaScript; SQL and CSS are outside what it can parse, so a
 * scan over either has to strip its own comments and is not drift.
 *
 * (Naming that regex inline here would have ENDED THIS COMMENT — its `g` flag
 * sits right after a slash-star pair. Which is the module's whole thesis, met
 * in the file that documents it.)
 */
const RETIRED_STRIPPERS: [RegExp, string][] = [
  [/\[\\s\\S\]\*\?\\\*\\\//, 'a non-greedy block-comment regex'],
  [/\\\/\\\/\.\*\$/, 'a line-comment regex'],
  [/startsWith\(\s*['"`]\/\/['"`]\)/, 'a whole-line `//` filter'],
];

/**
 * This file, which plants each retired shape on purpose to prove the sweep sees
 * it. Excluded by path rather than allowlisted, because it does not strip
 * anything — the shapes here are fixtures, and an entry in the allowlist would
 * have to claim otherwise.
 */
const SELF = 'scripts/__tests__/code-only.test.ts';

/**
 * JS/TS files permitted to strip comments themselves, and why.
 *
 * Short and justified by construction: the shared stripper lexes TypeScript and
 * JavaScript, so a scan over a language it does not parse cannot use it. The
 * SQL strippers in `packages/db` need no entry — they match no shape above.
 */
const OWN_STRIPPER_ALLOWLIST: Record<string, string> = {
  'apps/client/src/__tests__/border-color-layering.test.ts':
    'strips CSS comments out of index.css — the shared stripper is a TS/JS lexer and does not parse CSS',
};

/** Directories with nothing authored in them. */
const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'test-results',
  '.next',
  '.turbo',
  '.temp',
]);

/**
 * Every source-scanning guard in the repo: files under a `__tests__` directory,
 * plus the hooks.
 *
 * Scoped that way on purpose. The defect class only exists where a file reads
 * OTHER source text and has to tell code from prose, and every such reader in
 * this repo is a test or a hook. A repo-wide sweep instead flags
 * `redirect-target.ts`, whose `startsWith('//')` is a protocol-relative-URL
 * check and has nothing to do with comments — and a guard that cries wolf is a
 * guard somebody widens an allowlist to silence.
 *
 * @param dir - Absolute directory to walk.
 * @param inTests - Whether `dir` is already inside a `__tests__` directory.
 * @param out - Accumulator of repo-relative paths.
 * @returns The paths found.
 */
function scanningGuards(dir: string, inTests: boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      scanningGuards(path.join(dir, entry.name), inTests || entry.name === '__tests__', out);
    } else if (inTests && /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(entry.name)) {
      out.push(path.relative(REPO_ROOT, path.join(dir, entry.name)));
    }
  }
  return out;
}

describe('no guard strips comments with regexes of its own', () => {
  // DOR-642 replaced the three capability scans and the `any` hook; DOR-1714
  // replaced the nine copy-and-naming guards that were left. This is the census
  // that keeps a tenth from growing back.
  //
  // A caveat worth knowing rather than hiding: this file's CI job is
  // path-filtered to `scripts/**` and `.claude/hooks/**`, so a regex regrown
  // under `apps/**` turns it red locally (`pnpm verify` runs `test:scripts`
  // first, always) but not on that PR in CI. The server half is therefore
  // ALSO asserted in `apps/server/src/services/core/capabilities/__tests__/
  // code-only-corpus.test.ts`, which turbo's affected-only run reaches on any
  // server change and which reports to the merge queue.
  const guards = [
    ...scanningGuards(path.join(REPO_ROOT, 'apps'), false),
    ...scanningGuards(path.join(REPO_ROOT, 'packages'), false),
    ...scanningGuards(path.join(REPO_ROOT, 'scripts'), false),
    ...scanningGuards(path.join(REPO_ROOT, '.claude', 'hooks'), true),
  ];

  it('found the guards to check', () => {
    // A walk that returned nothing would make the sweep below vacuously green.
    expect(guards.length).toBeGreaterThan(500);
    expect(guards).toContain('.claude/hooks/check-any-changed.mjs');
    expect(guards).toContain('apps/client/src/__tests__/one-config-query-key.test.ts');
    expect(guards).toContain(SELF);
  });

  it('carries none of the retired shapes outside the allowlist', () => {
    const offenders: string[] = [];
    for (const rel of guards) {
      if (rel === SELF || rel in OWN_STRIPPER_ALLOWLIST) continue;
      const text = readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
      for (const [shape, what] of RETIRED_STRIPPERS) {
        if (shape.test(text)) offenders.push(`${rel}: ${what}`);
      }
    }

    expect(
      offenders,
      `\n${offenders.join('\n')}\n\nThese strip JS/TS comments with one of the three retired ` +
        `regex shapes. No order of them is correct — import \`codeOnly\`/\`lex\` from ` +
        `\`scripts/lib/code-only.mjs\` when the question is "is this a call?", or ` +
        `\`lexWithoutComments\` when it is "does this file say this word?".`
    ).toEqual([]);
  });

  it('would see one if it came back', () => {
    // The sweep passes trivially against patterns that match nothing. Each shape
    // is made to fire on the exact text it is written about.
    const planted = [
      String.raw`const code = source.replace(/\/\*[\s\S]*?\*\//g, '');`,
      String.raw`const code = source.replace(/\/\/.*$/gm, '');`,
      `const code = lines.filter((line) => !line.trim().startsWith('//'));`,
    ];
    expect(RETIRED_STRIPPERS).toHaveLength(planted.length);
    for (const [index, [shape, what]] of RETIRED_STRIPPERS.entries()) {
      expect(shape.test(planted[index] as string), what).toBe(true);
    }
  });

  it('every allowlisted file still exists and still needs its exemption', () => {
    for (const [rel, reason] of Object.entries(OWN_STRIPPER_ALLOWLIST)) {
      expect(guards, `allowlisted file is gone, drop the entry: ${rel}`).toContain(rel);
      const text = readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
      expect(
        RETIRED_STRIPPERS.some(([shape]) => shape.test(text)),
        `${rel} no longer rolls its own stripper, drop the entry (${reason})`
      ).toBe(true);
    }
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
