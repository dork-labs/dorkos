/**
 * The text-only lane's classifier (DOR-4834), pinned case by case.
 *
 * scripts/text-only-scope.mjs lets a change skip the test sweep and the browser
 * suites, on a pull request only (the merge queue always runs everything), when
 * it only rewrites strings, comments and Markdown. A wrong "text only" puts untested code on `main`, so
 * most of this file is refusals: every way a change can look like copy and be
 * code. The positives are the shapes the lane exists for, DOR-4833's address
 * change first. The git cases build real repositories, and the CLI cases run
 * the script as the workflows do, to show every failure answers "not text only".
 *
 * Reads .github/workflows/security-gate.yml through the classifier, so it is on
 * REPO_WIDE_SUITES (scripts/vitest.repo.config.ts).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import { classify, compareSource, toOutputs } from '../text-only-scope.mjs';

const SCRIPT = path.resolve(import.meta.dirname, '..', 'text-only-scope.mjs');
const LANE = path.resolve(import.meta.dirname, '..', 'text-only-tests.sh');
const WORKFLOWS = path.resolve(import.meta.dirname, '..', '..', '.github', 'workflows');

/** The refusal for one file's edit, or null when it is text only. */
function refusal(before: string, after: string, file = 'packages/shared/src/x.tsx') {
  return compareSource(ts, file, before, after).refusal ?? null;
}

describe('a changed file is text only when only its text changed', () => {
  it.each([
    [
      'a string value',
      `const a = { street: '6028 Toscana Ave' };`,
      `const a = { street: '605 W 9th Street, Unit #4144' };`,
    ],
    ['a comment', `// old note\nconst a = 1;`, `// new note, longer\nconst a = 1;`],
    [
      'a JSDoc block',
      `/** Old. */\nexport const a = 1;`,
      `/** New, and wrapped\n * over lines. */\nexport const a = 1;`,
    ],
    [
      'a template literal static part',
      'const a = `Saved ${n} files`;',
      'const a = `Stored ${n} files`;',
    ],
    ['JSX text', 'const a = <p>Save changes</p>;', 'const a = <p>Keep your changes</p>;'],
    [
      'an aria-label',
      'const a = <b aria-label="Close dialog" />;',
      'const a = <b aria-label="Dismiss the dialog" />;',
    ],
    [
      'a placeholder',
      'const a = <input placeholder="Search agents" />;',
      'const a = <input placeholder="Find an agent" />;',
    ],
    ['quote style and a reflow', `expect(x).toBe('a b');`, `expect(x).toBe(\n  "a b"\n);`],
    [
      'a default with ??',
      `const t = title ?? 'Untitled session';`,
      `const t = title ?? 'New session';`,
    ],
  ])('%s', (_name, before, after) => {
    expect(refusal(before, after)).toBeNull();
  });

  it('records the old and new text of each changed literal', () => {
    const { changes } = compareSource(
      ts,
      'a.ts',
      `f('Old copy', 'Same');`,
      `f('New copy', 'Same');`
    );
    expect(changes).toEqual([{ path: 'a.ts', old: 'Old copy', now: 'New copy' }]);
  });
});

describe('anything that is code is not text only', () => {
  it.each([
    ['a changed identifier', 'const a = b;', 'const a = c;', /an identifier changed/],
    ['a changed number', 'const a = 1;', 'const a = 2;', /a number changed/],
    ['an added import', `const a = 'x y';`, `import b from 'b';\nconst a = 'x y';`, /code changed/],
    ['let to const', `let a = 'x y';`, `const a = 'x y';`, /changed/],
    [
      'a URL literal',
      `const u = 'see https://dorkos.ai';`,
      `const u = 'see https://dorkos.ai/docs';`,
      /URL/,
    ],
    [
      'a template expression',
      'const a = `Saved ${n} files`;',
      'const a = `Saved ${m} files`;',
      /an identifier changed/,
    ],
    [
      'a JSX attribute that is code',
      'const a = <b className="px-2 py-1" />;',
      'const a = <b className="px-3 py-1" />;',
      /JSX attribute className/,
    ],
    [
      'a string inside a JSX attribute expression',
      `const a = <b onClick={() => log('Clicked it')} />;`,
      `const a = <b onClick={() => log('Pressed it')} />;`,
      /JSX attribute onClick/,
    ],
    [
      'a copy attribute given as an expression',
      `const a = <b title={'Close it'} />;`,
      `const a = <b title={'Shut it'} />;`,
      /JSX attribute title/,
    ],
    ['a module specifier', `import a from './a';`, `import a from './b';`, /module specifier/],
    ['a dynamic import', `await import('./a');`, `await import('./b');`, /module specifier/],
    [
      'a property name',
      `const a = { 'Old key': 1 };`,
      `const a = { 'New key': 1 };`,
      /property or binding name/,
    ],
    [
      'a comparison',
      `if (s === 'In progress') go();`,
      `if (s === 'In review') go();`,
      /comparison/,
    ],
    [
      'a less-than comparison',
      `if (s < 'Middle of the list') go();`,
      `if (s < 'End of the list') go();`,
      /comparison/,
    ],
    [
      'a case label',
      `switch (s) { case 'Draft copy': go(); }`,
      `switch (s) { case 'Final copy': go(); }`,
      /case label/,
    ],
    ['a type', `type A = 'Draft copy' | 'x';`, `type A = 'Final copy' | 'x';`, /type changed/],
    ['a directive', `'use client';\nconst a = 1;`, `'use server';\nconst a = 1;`, /directive/],
    [
      'a tagged template',
      'const q = sql`select one row`;',
      'const q = sql`select two rows`;',
      /tagged template/,
    ],
    [
      'an identifier-like string',
      `const k = 'pending';`,
      `const k = 'waiting';`,
      /identifier or an enum value/,
    ],
    [
      'a permission or scope name',
      `const s = 'repo:read';`,
      `const s = 'repo:write';`,
      /permission, scope/,
    ],
    ['a path', `const p = 'a/b.json';`, `const p = 'a/c.json';`, /path/],
    [
      'a shell command',
      `const c = 'pnpm install now';`,
      `const c = 'pnpm install --frozen-lockfile';`,
      /shell command/,
    ],
    [
      'a dropped placeholder',
      `const m = 'Hello {name}, welcome';`,
      `const m = 'Hello there, welcome';`,
      /placeholders/,
    ],
    ['a string emptied', `const m = 'Nothing yet';`, `const m = '';`, /empty/],
  ])('%s', (_name, before, after, why) => {
    expect(refusal(before, after)).toMatch(why);
  });

  it('a file that does not parse fails closed', () => {
    expect(refusal(`const a = 'x y';`, `const a = 'x y`)).toMatch(/does not parse/);
    expect(refusal(`const a = (`, `const a = (`)).toMatch(/does not parse/);
  });

  it('a TypeScript that no longer reports parse errors fails closed', () => {
    const blind = {
      ...ts,
      createSourceFile: (...args: Parameters<typeof ts.createSourceFile>) => {
        const sf = ts.createSourceFile(...args);
        delete (sf as { parseDiagnostics?: unknown }).parseDiagnostics;
        return sf;
      },
    };
    expect(compareSource(blind, 'a.ts', 'const a = 1;', 'const a = 1;').refusal).toMatch(
      /does not parse/
    );
  });
});

/** A git environment inherited from a hook would point every call at another repository. */
const GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);

/** A throwaway repository with one commit of `files`, and a helper to commit more. */
function repo(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'text-only-'));
  const run = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: GIT_ENV }).trim();
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'ci@example.com');
  run('config', 'user.name', 'ci');
  const write = (changes: Record<string, string | null>) => {
    for (const [file, text] of Object.entries(changes)) {
      const full = path.join(dir, file);
      if (text === null) rmSync(full);
      else {
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, text);
      }
    }
    run('add', '-A');
    run('commit', '-q', '--allow-empty', '-m', 'change');
    return run('rev-parse', 'HEAD');
  };
  const base = write(files);
  return { dir, base, write };
}

const COMPANY = `/** The company. */\nexport const company = {\n  address: { street: '6028 Toscana Ave', postalCode: '78724' },\n};\n`;
const COMPANY_TEST = `import { company } from '../company';\nit('has a street', () => {\n  expect(company.address.street).toBe('6028 Toscana Ave');\n});\n`;
const SITE_TEST = `it('renders the address', () => {\n  expect(text).toContain('144 Studio, LLC, 6028 Toscana Ave, Austin');\n});\n`;
const START = {
  'packages/shared/src/company.ts': COMPANY,
  'packages/shared/src/__tests__/company.test.ts': COMPANY_TEST,
  'apps/site/src/__tests__/terms.test.tsx': SITE_TEST,
  'apps/server/src/routes/copy.ts': `export const copy = 'Old route copy';\n`,
  'apps/e2e/tests/terms.spec.ts': `test('a', () => expect(page.getByText('Unrelated copy')).toBeVisible());\n`,
  'apps/e2e/pages/terms-page.ts': `export const heading = 'Terms heading';\n`,
  'packages/shared/README.md': '# Shared\n',
  'packages/shared/package.json': '{ "name": "@dorkos/shared" }\n',
  'packages/shared/src/theme.css': '.a { color: red; }\n',
  'apps/site/next.config.mjs': `export default { title: 'Old title here' };\n`,
  'apps/site/.env.example': 'A=1\n',
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function decide(changes: Record<string, string | null>) {
  const r = repo(START);
  dirs.push(r.dir);
  const head = r.write(changes);
  return classify(ts, r.base, head, { cwd: r.dir });
}

describe('classify over a real diff', () => {
  it("DOR-4833's shape: a string in company.ts, its test and a changelog fragment", () => {
    const d = decide({
      'packages/shared/src/company.ts': COMPANY.replace(
        '6028 Toscana Ave',
        '605 W 9th Street, Unit #4144'
      ),
      'packages/shared/src/__tests__/company.test.ts': COMPANY_TEST.replace(
        '6028 Toscana Ave',
        '605 W 9th Street, Unit #4144'
      ),
      'changelog/unreleased/261120-company-mailbox-address.md': '### Changed\n\n- A new address.\n',
    });
    expect(d.textOnly).toBe(true);
    // The site's test quotes the old street, in another package, so it runs by name.
    expect(d.vitestFiles).toEqual([
      'apps/site/src/__tests__/terms.test.tsx',
      'changelog/unreleased/261120-company-mailbox-address.md',
      'packages/shared/src/__tests__/company.test.ts',
      'packages/shared/src/company.ts',
    ]);
    expect(d.browser).toBe('none');
  });

  it('a comment-only change', () => {
    const d = decide({
      'packages/shared/src/company.ts': COMPANY.replace('The company.', 'Who makes DorkOS.'),
    });
    expect(d).toMatchObject({
      textOnly: true,
      browser: 'none',
      vitestFiles: ['packages/shared/src/company.ts'],
    });
  });

  it('a Markdown-only change', () => {
    const d = decide({ 'docs/notes.md': '# Notes\n' });
    expect(d).toMatchObject({ textOnly: true, browser: 'none', vitestFiles: ['docs/notes.md'] });
  });

  it('Markdown and a string together', () => {
    const d = decide({
      'packages/shared/src/company.ts': COMPANY.replace("'78724'", "'78701'"),
      'changelog/unreleased/fragment.md': '- New postal code.\n',
    });
    expect(d.textOnly).toBe(true);
    expect(d.vitestFiles).toContain('changelog/unreleased/fragment.md');
  });

  it('runs the browser specs that quote the old text, and only those', () => {
    const d = decide({
      'apps/e2e/tests/terms.spec.ts': START['apps/e2e/tests/terms.spec.ts'].replace(
        'Unrelated copy',
        'Other copy'
      ),
    });
    expect(d).toMatchObject({ textOnly: true, browser: 'specs', specs: ['tests/terms.spec.ts'] });
  });

  it('runs the whole browser suite when a page object quotes the old text', () => {
    const e = decide({ 'apps/e2e/pages/terms-page.ts': `export const heading = 'Terms title';\n` });
    expect(e).toMatchObject({ textOnly: true, browser: 'full' });
  });

  it.each([
    [
      'a security path',
      { 'apps/server/src/routes/copy.ts': `export const copy = 'New route copy';\n` },
      /security path/,
    ],
    [
      'an added code file',
      { 'packages/shared/src/new.ts': `export const a = 'x y';\n` },
      /was added/,
    ],
    ['a deleted code file', { 'packages/shared/src/company.ts': null }, /was deleted/],
    ['a deleted Markdown file', { 'packages/shared/README.md': null }, /was deleted/],
    [
      'a config file',
      { 'packages/shared/package.json': '{ "name": "@dorkos/shared", "private": true }\n' },
      /security path|configuration/,
    ],
    [
      'a *.config.* file',
      { 'apps/site/next.config.mjs': `export default { title: 'New title here' };\n` },
      /configuration/,
    ],
    ['an .env file', { 'apps/site/.env.example': 'A=2\n' }, /configuration/],
    [
      'another file type',
      { 'packages/shared/src/theme.css': '.a { color: blue; }\n' },
      /not a \.ts/,
    ],
    [
      'anything under .github/',
      { '.github/workflows/x.yml': 'on: push\n' },
      /security path|CI configuration/,
    ],
    ['a lockfile', { 'pnpm-lock.yaml': 'lockfileVersion: 9\n' }, /security path|lockfile/],
    [
      'a migration',
      { 'packages/store/migrations/0001.ts': `export const up = 'a b';\n` },
      /migration/,
    ],
    ['the empty diff', {}, /empty/],
  ])('refuses %s', (_name, changes, why) => {
    const d = decide(changes as Record<string, string | null>);
    expect(d.textOnly).toBe(false);
    expect(d.browser).toBe('full');
    expect(d.reason).toMatch(why);
  });

  it('refuses a mode change', () => {
    const r = repo(START);
    dirs.push(r.dir);
    execFileSync('git', ['update-index', '--chmod=+x', 'packages/shared/src/company.ts'], {
      cwd: r.dir,
    });
    execFileSync('git', ['commit', '-q', '-m', 'chmod'], { cwd: r.dir });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: r.dir,
      encoding: 'utf8',
    }).trim();
    expect(classify(ts, r.base, head, { cwd: r.dir }).reason).toMatch(/file mode/);
  });
});

describe('the CLI fails closed', () => {
  const cli = (args: string[], cwd: string) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });

  it('prints every output, text only, for a qualifying change', () => {
    const r = repo(START);
    dirs.push(r.dir);
    const head = r.write({ 'docs/a.md': 'a\n' });
    const out = cli([r.base, head], r.dir);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe(
      toOutputs({
        textOnly: true,
        reason: '0 code file(s) change only text, 1 Markdown file(s)',
        vitestFiles: ['docs/a.md'],
        browser: 'none',
        specs: [],
      }) + '\n'
    );
  });

  it.each([
    ['no arguments', []],
    ['one argument', ['HEAD']],
    ['a revision git cannot resolve', ['0000000000000000000000000000000000000000', 'HEAD']],
    ['a revision that is not a revision', ['--output=/tmp/x', 'HEAD']],
  ])('%s answers not text only', (_name, args) => {
    const r = repo(START);
    dirs.push(r.dir);
    const out = cli(args, r.dir);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/^text_only=false$/m);
    expect(out.stdout).toMatch(/^browser=full$/m);
  });
});

describe('text-only-tests.sh runs vitest related per package', () => {
  const lane = (list: string, cwd: string) =>
    spawnSync('bash', [LANE, list], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, BUILD_TEST_DEPS: 'echo build', VITEST: 'echo vitest' },
    });

  it('groups files by the package that owns them, and builds those packages first', () => {
    const r = repo(START);
    dirs.push(r.dir);
    writeFileSync(
      path.join(r.dir, 'packages/shared/package.json'),
      '{ "scripts": { "test": "vitest" } }'
    );
    const out = lane(
      '["changelog/a.md","packages/shared/src/company.ts","packages/shared/src/__tests__/company.test.ts"]',
      r.dir
    );
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('build --filter=./packages/shared');
    // A test file in the list drops --passWithNoTests, so a test vitest does not collect fails.
    expect(out.stdout).toContain(
      'vitest related --run --exclude=**/*.binary.test.ts src/company.ts src/__tests__/company.test.ts'
    );
  });

  // DOR-5024: #4110 changed only meta/, plans/ and research/ Markdown, and the
  // lane failed the required check with nothing wrong. No package suite can see
  // such a change, so the shards would run nothing for it either.
  it('passes, running nothing, when no named file belongs to a package suite', () => {
    const r = repo(START);
    dirs.push(r.dir);
    const out = lane('["meta/ROADMAP.md","plans/a.md","research/b.md"]', r.dir);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain(
      'text-only-tests: no named file belongs to a package with a test suite, so nothing runs here'
    );
    expect(out.stdout).not.toContain('build');
    expect(out.stdout).not.toContain('vitest');
  });

  it.each([
    ['an empty list', '[]'],
    ['a list that is not JSON', 'packages/shared/src/company.ts'],
    ['a list of something other than paths', '[1]'],
  ])('fails on %s rather than running nothing', (_name, list) => {
    const r = repo(START);
    dirs.push(r.dir);
    expect(lane(list, r.dir).status).not.toBe(0);
  });
});

/** A workflow's text, with full-line comments dropped. */
function workflowCode(name: string): string {
  return readFileSync(path.join(WORKFLOWS, name), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** The `run: |` body of the decision step in one workflow, dedented. */
function decisionRun(name: string): string {
  const lines = readFileSync(path.join(WORKFLOWS, name), 'utf8').split('\n');
  const at = lines.findIndex(
    (l) => l.trim() === '- name: Decide whether this change only rewrites text'
  );
  expect(at, `${name} has the decision step`).toBeGreaterThan(-1);
  const run = lines.findIndex((l, i) => i > at && l.trim() === 'run: |');
  const indent = lines[run + 1]!.match(/^ */)![0].length;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== '' && line.match(/^ */)![0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n').trimEnd() + '\n';
}

describe('the workflows take the text-only lane on a pull request only', () => {
  const both = ['test.yml', 'browser-test.yml'];

  it('keeps the decision step identical in test.yml and browser-test.yml', () => {
    expect(decisionRun('test.yml')).toBe(decisionRun('browser-test.yml'));
  });

  it('never reads a queue base: the step has nothing to diff a merge group against', () => {
    for (const name of both) {
      const lines = readFileSync(path.join(WORKFLOWS, name), 'utf8').split('\n');
      const at = lines.findIndex(
        (l) => l.trim() === '- name: Decide whether this change only rewrites text'
      );
      const step = lines
        .slice(at, lines.findIndex((l, i) => i > at && l.trim() === 'run: |') + 1)
        .join('\n');
      expect(step).toContain('EVENT:');
      expect(step).not.toContain('merge_group');
      expect(decisionRun(name)).not.toMatch(/QUEUE_BASE|git fetch/);
    }
  });

  it('runs browser-smoke, and its fan-in check, only on a pull request', () => {
    const code = workflowCode('browser-test.yml');
    const smoke = code
      .split('\n')
      .filter((l) => /^\s*if:.*text-only-scope\.outputs\.browser/.test(l));
    expect(smoke).toHaveLength(2);
    for (const line of smoke) {
      expect(line).toContain(
        "github.event_name == 'pull_request' && !startsWith(github.base_ref, 'release/')"
      );
      expect(line).not.toContain('merge_group');
    }
  });

  it('gates no full-suite condition on the text-only answer', () => {
    // The queue's sweep, binary suites, browser shards and first-run run on
    // exactly main's conditions, so no answer from the lane can stand them down.
    for (const name of both) {
      const full = workflowCode(name)
        .split('\n')
        .filter((l) => /^\s*if:/.test(l) && l.includes("github.event_name != 'pull_request'"));
      expect(full.length).toBeGreaterThan(0);
      for (const line of full) {
        expect(line).not.toMatch(/text_only|text-only-scope/);
      }
    }
  });

  // Runs the step's own script, as a runner would, over a test-merge commit
  // whose change qualifies. Stub `npm` and `node` mark that the classifier was
  // reached; the merge_group run must answer full without reaching it.
  function runDecision(name: string, event: string) {
    const r = repo({
      ...START,
      'package.json': JSON.stringify({ devDependencies: { typescript: '5.0.0' } }),
      'scripts/text-only-scope.mjs': '// the base classifier\n',
      '.github/scripts/x.sh': 'true\n',
      '.github/workflows/security-gate.yml': 'on: pull_request\n',
    });
    dirs.push(r.dir);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: r.dir, encoding: 'utf8', env: GIT_ENV }).trim();
    git('checkout', '-q', '-b', 'feature');
    r.write({
      'packages/shared/src/company.ts': COMPANY.replace('6028 Toscana Ave', '144 Studio Ln'),
    });
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', 'test merge', 'feature');

    const tmp = mkdtempSync(path.join(tmpdir(), 'text-only-step-'));
    dirs.push(tmp);
    const bin = path.join(tmp, 'bin');
    mkdirSync(bin);
    const marker = path.join(tmp, 'classifier-reached');
    for (const tool of ['npm', 'node']) {
      writeFileSync(path.join(bin, tool), `#!/bin/sh\necho ${tool} >> '${marker}'\nexit 1\n`);
      chmodSync(path.join(bin, tool), 0o755);
    }
    const script = path.join(tmp, 'step.sh');
    writeFileSync(script, decisionRun(name));
    const output = path.join(tmp, 'output');
    writeFileSync(output, '');
    const out = spawnSync('bash', [script], {
      cwd: r.dir,
      encoding: 'utf8',
      env: {
        ...GIT_ENV,
        PATH: `${bin}:${process.env.PATH}`,
        EVENT: event,
        GITHUB_OUTPUT: output,
        RUNNER_TEMP: tmp,
      },
    });
    return { out, outputs: readFileSync(output, 'utf8'), reached: existsSync(marker) };
  }

  it.each(both)(
    '%s: a merge_group build always takes the full lane, without running the classifier',
    (name) => {
      const { out, outputs, reached } = runDecision(name, 'merge_group');
      expect(out.status).toBe(0);
      expect(outputs).toBe('text_only=false\nvitest_files=[]\nbrowser=full\nspecs=[]\n');
      expect(out.stdout).toContain(
        'not text only (a merge queue build; the queue runs every suite)'
      );
      expect(reached).toBe(false);
    }
  );

  it.each(both)('%s: the same tree on a pull request does reach the base classifier', (name) => {
    // The contrast that makes the merge_group case mean something: with the
    // same test-merge commit, a pull request gets as far as installing the
    // base's TypeScript (stubbed to fail here, so it still answers full).
    const { out, outputs, reached } = runDecision(name, 'pull_request');
    expect(out.status).toBe(0);
    expect(reached).toBe(true);
    expect(out.stdout).toContain('not text only (typescript did not install)');
    expect(outputs).toBe('text_only=false\nvitest_files=[]\nbrowser=full\nspecs=[]\n');
  });

  it.each(['release_pull_request', 'schedule', 'workflow_dispatch', ''])(
    'event %j takes the full lane without running the classifier',
    (event) => {
      const { out, outputs, reached } = runDecision('test.yml', event);
      expect(out.status).toBe(0);
      expect(outputs).toMatch(/^text_only=false$/m);
      expect(outputs).toMatch(/^browser=full$/m);
      expect(reached).toBe(false);
    }
  );
});
