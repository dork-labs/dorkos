import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readBinaryTestGlobs, runVerification } from '../verify-proof/cli.ts';
import { planPreopen, runPreopen, type PreopenStep } from '../verify-proof/preopen.ts';

const script = path.resolve(import.meta.dirname, '../verify-proof/cli.ts');
let repo: string;
let sha: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
const check = (...args: string[]) =>
  spawnSync(process.execPath, [script, 'check', sha, ...args], { cwd: repo, encoding: 'utf8' });
const refusal = () =>
  `no pnpm verify pass recorded for ${sha.slice(0, 12)}; run pnpm verify, or pass --no-verify-proof\n`;

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'verify-proof-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test Founder');
  git('config', 'user.email', 'founder@example.test');
  writeFileSync(path.join(repo, 'example.txt'), 'original');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  sha = git('rev-parse', 'HEAD');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('verification proof', () => {
  it('wires pnpm verify through the wrapper without changing the checks', () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')
    );
    expect(pkg.scripts.verify).toBe('node scripts/verify-proof/cli.ts run');
    expect(pkg.scripts['verify:checks']).toContain('pnpm test:scripts && pnpm lint:root');
  });

  it('runs the checks exactly once through the CLI and preserves a failed exit', () => {
    const bin = path.join(repo, '.git/bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      path.join(bin, 'pnpm'),
      '#!/bin/sh\necho "$*" >> .git/gate-runs\nexit "${PROOF_TEST_EXIT:-0}"\n',
      { mode: 0o755 }
    );
    const run = (status: string) =>
      spawnSync(process.execPath, [script, 'run'], {
        cwd: repo,
        encoding: 'utf8',
        // eslint-disable-next-line no-restricted-syntax -- scripts/ has no env.ts; child processes inherit PATH and git config
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROOF_TEST_EXIT: status },
      });
    // The host-binary suites are left to CI: every glob in the data file rides as an exclude.
    const globs = readBinaryTestGlobs(path.resolve(import.meta.dirname, '../..'));
    const gateRun = `run verify:checks ${globs.map((glob) => `--exclude=${glob}`).join(' ')}\n`;
    expect(run('0').status).toBe(0);
    expect(check().status).toBe(0);
    expect(readFileSync(path.join(repo, '.git/gate-runs'), 'utf8')).toBe(gateRun);
    const proof = JSON.parse(
      readFileSync(path.join(repo, '.git/dorkos-verify-proof', sha), 'utf8')
    );
    expect(proof.excluded).toEqual(globs);
    expect(run('8').status).toBe(8);
    expect(check().status).toBe(1);
    expect(readFileSync(path.join(repo, '.git/gate-runs'), 'utf8')).toBe(gateRun + gateRun);
  });

  it('records exactly the excludes it handed to the checks', () => {
    const excluded = ['**/fixture/**/*.binary.test.ts', '**/other/*.binary.test.ts'];
    let seen: readonly string[] | undefined;
    expect(
      runVerification(
        repo,
        (globs) => {
          seen = globs;
          return 0;
        },
        excluded
      )
    ).toBe(0);
    expect(seen).toEqual(excluded);
    const proof = JSON.parse(
      readFileSync(path.join(repo, '.git/dorkos-verify-proof', sha), 'utf8')
    );
    expect(proof).toEqual({
      sha,
      tree: git('rev-parse', `${sha}^{tree}`),
      level: 'full',
      excluded,
      passedAt: expect.any(String),
    });
    expect(check().status).toBe(0);
  });

  it('records an empty exclusion list when nothing was left out', () => {
    expect(runVerification(repo, () => 0)).toBe(0);
    const proof = JSON.parse(
      readFileSync(path.join(repo, '.git/dorkos-verify-proof', sha), 'utf8')
    );
    expect(proof.excluded).toEqual([]);
  });

  it('accepts an older proof with no exclusion list, since it left nothing out', () => {
    expect(runVerification(repo, () => 0)).toBe(0);
    const proof = path.join(repo, '.git/dorkos-verify-proof', sha);
    const { excluded: _excluded, ...older } = JSON.parse(readFileSync(proof, 'utf8'));
    writeFileSync(proof, JSON.stringify(older));
    expect(check().status).toBe(0);
  });

  it('reads globs one per line, skipping blank lines and comments', () => {
    mkdirSync(path.join(repo, 'scripts/ci'), { recursive: true });
    writeFileSync(
      path.join(repo, 'scripts/ci/binary-test-glob.txt'),
      '# why these are left to CI\n\n  **/a/*.binary.test.ts  \n**/b/*.binary.test.ts\n'
    );
    expect(readBinaryTestGlobs(repo)).toEqual(['**/a/*.binary.test.ts', '**/b/*.binary.test.ts']);
  });

  it('refuses extra arguments to run before any check starts', () => {
    const result = spawnSync(process.execPath, [script, 'run', '--force'], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^pnpm verify takes no arguments \(got: --force\);/);
    expect(existsSync(path.join(repo, '.git/dorkos-verify-proof'))).toBe(false);
  });

  it('refuses a missing record with exactly one actionable line', () => {
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(refusal());
    expect(result.stdout).toBe('');
  });

  it('refuses a record for another tree', () => {
    expect(runVerification(repo, () => 0)).toBe(0);
    const proof = path.join(repo, '.git/dorkos-verify-proof', sha);
    const record = JSON.parse(readFileSync(proof, 'utf8'));
    writeFileSync(proof, JSON.stringify({ ...record, tree: '0'.repeat(40) }));
    expect(check().status).toBe(1);
    expect(check().stderr).toBe(refusal());
  });

  it('allows a matching record and shares it with another worktree', () => {
    expect(runVerification(repo, () => 0)).toBe(0);
    expect(check().status).toBe(0);
    const sibling = path.join(repo, 'sibling');
    git('worktree', 'add', '--detach', sibling, sha);
    writeFileSync(path.join(sibling, 'other-work.txt'), 'unrelated work');
    const result = spawnSync(process.execPath, [script, 'check', sha], {
      cwd: sibling,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('allows the explicit escape and logs who, when, the full SHA, and its tree', () => {
    const escaped = spawnSync(process.execPath, [script, 'check', sha, '--no-verify-proof'], {
      cwd: repo,
      encoding: 'utf8',
      // eslint-disable-next-line no-restricted-syntax -- scripts/ has no env.ts; child processes inherit PATH and git config
      env: { ...process.env, USER: 'test-operator' },
    });
    expect(escaped.status).toBe(0);
    const log = readFileSync(path.join(repo, '.git/dorkos-verify-proof/escapes.jsonl'), 'utf8');
    const record = JSON.parse(log.trim());
    expect(record).toEqual({
      sha,
      tree: git('rev-parse', `${sha}^{tree}`),
      who: 'Test Founder',
      user: 'test-operator',
      when: expect.any(String),
    });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Number.isNaN(Date.parse(record.when))).toBe(false);
    expect(check().status).toBe(1);
  });

  it('refuses the escape when the git user is unknown, and logs nothing', () => {
    git('config', '--unset', 'user.name');
    const result = spawnSync(process.execPath, [script, 'check', sha, '--no-verify-proof'], {
      cwd: repo,
      encoding: 'utf8',
      // eslint-disable-next-line no-restricted-syntax -- scripts/ has no env.ts; child processes inherit PATH and git config
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(refusal());
    expect(existsSync(path.join(repo, '.git/dorkos-verify-proof/escapes.jsonl'))).toBe(false);
  });

  it.each([
    ['corrupt JSON', '{"sha":'],
    ['a JSON null', 'null'],
    ['an empty file', ''],
    [
      'an unparseable pass time',
      (record: object) => JSON.stringify({ ...record, passedAt: 'soon' }),
    ],
    ['another commit', (record: object) => JSON.stringify({ ...record, sha: 'f'.repeat(40) })],
    [
      'an exclusion list that is not a list of globs',
      (record: object) => JSON.stringify({ ...record, excluded: '**/*.binary.test.ts' }),
    ],
  ])('refuses a proof file holding %s', (_label, contents) => {
    expect(runVerification(repo, () => 0)).toBe(0);
    const proof = path.join(repo, '.git/dorkos-verify-proof', sha);
    const record = JSON.parse(readFileSync(proof, 'utf8'));
    writeFileSync(proof, typeof contents === 'string' ? contents : contents(record));
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(refusal());
  });

  it('refuses a proof path it cannot read as a file', () => {
    mkdirSync(path.join(repo, '.git/dorkos-verify-proof', sha), { recursive: true });
    expect(check().status).toBe(1);
    expect(check().stderr).toBe(refusal());
  });

  it('refuses a ref that is not a commit', () => {
    sha = 'not-a-ref';
    expect(check().status).toBe(1);
    expect(check().stderr).toBe(refusal());
  });

  it('judges valid proof the same from a checkout with unrelated edits', () => {
    expect(runVerification(repo, () => 0)).toBe(0);
    // The arm script checks from the main checkout, which carries other people's edits.
    writeFileSync(path.join(repo, 'example.txt'), 'someone else is mid-edit');
    writeFileSync(path.join(repo, 'scratch.txt'), 'untracked');
    const result = check();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('records nothing for a dirty starting tree even if checks clean it', () => {
    writeFileSync(path.join(repo, 'example.txt'), 'dirty');
    expect(
      runVerification(repo, () => {
        writeFileSync(path.join(repo, 'example.txt'), 'original');
        return 0;
      })
    ).toBe(0);
    expect(check().status).toBe(1);
  });

  it('records nothing if files change during checks', () => {
    expect(
      runVerification(repo, () => {
        writeFileSync(path.join(repo, 'example.txt'), 'changed');
        return 0;
      })
    ).toBe(0);
    writeFileSync(path.join(repo, 'example.txt'), 'original');
    expect(check().status).toBe(1);
  });

  it('records nothing if HEAD changes during checks', () => {
    expect(
      runVerification(repo, () => {
        git('commit', '--allow-empty', '-qm', 'new head');
        return 0;
      })
    ).toBe(0);
    expect(check().status).toBe(1);
    sha = git('rev-parse', 'HEAD');
    expect(check().status).toBe(1);
  });

  it('preserves failure and invalidates an older pass', () => {
    expect(runVerification(repo, () => 0)).toBe(0);
    expect(runVerification(repo, () => 7)).toBe(7);
    expect(check().status).toBe(1);
  });

  it('records no proof for untracked source and invalidates the older pass', () => {
    runVerification(repo, () => 0);
    writeFileSync(path.join(repo, 'untracked.txt'), 'new source');
    expect(runVerification(repo, () => 0)).toBe(0);
    expect(check().status).toBe(1);
    expect(check().stderr).toBe(refusal());
  });
});

const proofs = () => path.join(repo, '.git/dorkos-verify-proof');
const preopenRefusal = () =>
  `no pnpm verify:preopen or pnpm verify pass recorded for ${sha.slice(0, 12)}; ` +
  'run pnpm verify:preopen, or pass --no-verify-proof\n';

describe('the preopen level (DOR-4728)', () => {
  it('wires pnpm verify:preopen to the same wrapper, with its own flag', () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')
    );
    expect(pkg.scripts.verify).toBe('node scripts/verify-proof/cli.ts run');
    expect(pkg.scripts['verify:preopen']).toBe('node scripts/verify-proof/cli.ts run --preopen');
    expect(pkg.scripts['verify:preopen:turbo']).toContain('turbo run typecheck lint --affected');
    expect(pkg.scripts['verify:preopen:turbo']).not.toMatch(/turbo run test\b/);
  });

  it('records a preopen pass in its own file, which the default check never accepts', () => {
    expect(runVerification(repo, () => 0, [], 'preopen')).toBe(0);
    expect(existsSync(path.join(proofs(), sha))).toBe(false);
    const proof = JSON.parse(readFileSync(path.join(proofs(), `${sha}.preopen`), 'utf8'));
    expect(proof).toEqual({
      sha,
      tree: git('rev-parse', `${sha}^{tree}`),
      level: 'preopen',
      excluded: [],
      passedAt: expect.any(String),
    });
    expect(check().status).toBe(1);
    expect(check().stderr).toBe(refusal());
    expect(check('--level', 'full').status).toBe(1);
    expect(check('--level', 'preopen').status).toBe(0);
  });

  it('never touches an existing full proof, whether the preopen run passes or fails', () => {
    expect(runVerification(repo, () => 0)).toBe(0);
    const full = path.join(proofs(), sha);
    const bytes = readFileSync(full);
    expect(runVerification(repo, () => 0, [], 'preopen')).toBe(0);
    expect(readFileSync(full).equals(bytes)).toBe(true);
    expect(runVerification(repo, () => 7, [], 'preopen')).toBe(7);
    expect(readFileSync(full).equals(bytes)).toBe(true);
    // The failed rerun cleared its own earlier pass, and only that.
    expect(existsSync(path.join(proofs(), `${sha}.preopen`))).toBe(false);
    expect(check().status).toBe(0);
  });

  it('records a full pass at level full and leaves a preopen proof where it was', () => {
    expect(runVerification(repo, () => 0, [], 'preopen')).toBe(0);
    const preopen = readFileSync(path.join(proofs(), `${sha}.preopen`));
    expect(runVerification(repo, () => 0)).toBe(0);
    expect(JSON.parse(readFileSync(path.join(proofs(), sha), 'utf8')).level).toBe('full');
    expect(readFileSync(path.join(proofs(), `${sha}.preopen`)).equals(preopen)).toBe(true);
  });

  it.each(['preopen', 'quick', null, 1])(
    'refuses a full proof file whose level is %j at the default level',
    (level) => {
      expect(runVerification(repo, () => 0)).toBe(0);
      const full = path.join(proofs(), sha);
      writeFileSync(full, JSON.stringify({ ...JSON.parse(readFileSync(full, 'utf8')), level }));
      expect(check().status).toBe(1);
      expect(check().stderr).toBe(refusal());
      // Nor does a mislabelled full file pass as preopen: that level has one file name only.
      expect(check('--level', 'preopen').status).toBe(1);
      expect(check('--level', 'preopen').stderr).toBe(preopenRefusal());
    }
  );

  it('reads a proof with no level as full, so proofs from before DOR-4728 stay valid', () => {
    expect(runVerification(repo, () => 0)).toBe(0);
    const full = path.join(proofs(), sha);
    const { level: _level, ...older } = JSON.parse(readFileSync(full, 'utf8'));
    writeFileSync(full, JSON.stringify(older));
    expect(check().status).toBe(0);
    expect(check('--level', 'full').status).toBe(0);
    expect(check('--level', 'preopen').status).toBe(0);
  });

  it('accepts a full pass at the preopen level, since it covers more', () => {
    expect(runVerification(repo, () => 0)).toBe(0);
    expect(existsSync(path.join(proofs(), `${sha}.preopen`))).toBe(false);
    expect(check('--level', 'preopen').status).toBe(0);
  });

  it.each(['full', undefined])('refuses a preopen file that claims level %j', (level) => {
    expect(runVerification(repo, () => 0, [], 'preopen')).toBe(0);
    const file = path.join(proofs(), `${sha}.preopen`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), level }));
    expect(check('--level', 'preopen').status).toBe(1);
    expect(check('--level', 'preopen').stderr).toBe(preopenRefusal());
    expect(check().status).toBe(1);
  });

  it('refuses a preopen file for another tree', () => {
    expect(runVerification(repo, () => 0, [], 'preopen')).toBe(0);
    const file = path.join(proofs(), `${sha}.preopen`);
    const record = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...record, tree: '0'.repeat(40) }));
    expect(check('--level', 'preopen').status).toBe(1);
  });

  it('keeps the clean-tree and unchanged-HEAD rules for preopen runs', () => {
    writeFileSync(path.join(repo, 'example.txt'), 'dirty');
    expect(runVerification(repo, () => 0, [], 'preopen')).toBe(0);
    expect(check('--level', 'preopen').status).toBe(1);
    writeFileSync(path.join(repo, 'example.txt'), 'original');
    expect(
      runVerification(
        repo,
        () => {
          git('commit', '--allow-empty', '-qm', 'new head');
          return 0;
        },
        [],
        'preopen'
      )
    ).toBe(0);
    expect(check('--level', 'preopen').status).toBe(1);
  });

  it('runs the preopen steps through the CLI and records only the preopen proof', () => {
    const bin = path.join(repo, '.git/bin');
    const log = path.join(repo, '.git/preopen-runs');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'pnpm'), `#!/bin/sh\necho "$*" >> '${log}'\nexit 0\n`, {
      mode: 0o755,
    });
    const result = spawnSync(process.execPath, [script, 'run', '--preopen'], {
      cwd: repo,
      encoding: 'utf8',
      // eslint-disable-next-line no-restricted-syntax -- scripts/ has no env.ts; child processes inherit PATH and git config
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(result.status, result.stderr).toBe(0);
    // HEAD is main itself, so nothing changed: only the typecheck and lint step runs.
    expect(readFileSync(log, 'utf8')).toBe('run verify:preopen:turbo\n');
    expect(existsSync(path.join(proofs(), sha))).toBe(false);
    expect(check('--level', 'preopen').status).toBe(0);
    expect(check().status).toBe(1);
  });

  it.each([[['run', '--preopen', '--force']], [['run', '--force', '--preopen']]])(
    'refuses %j before any check starts',
    (args) => {
      const result = spawnSync(process.execPath, [script, ...args], {
        cwd: repo,
        encoding: 'utf8',
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/^pnpm verify takes no arguments/);
      expect(existsSync(proofs())).toBe(false);
    }
  );

  it.each([[['--level']], [['--level', 'quick']], [['--preopen']], [['--level', 'preopen', 'x']]])(
    'answers check %j with the usage line',
    (flags) => {
      const result = check(...flags);
      expect(result.status).toBe(2);
      expect(result.stderr).toBe(
        'usage: node scripts/verify-proof/cli.ts run [--preopen] | ' +
          'check <sha> [--level full|preopen] [--no-verify-proof]\n'
      );
    }
  );

  it('logs an escape at the preopen level as one', () => {
    const escaped = check('--level', 'preopen', '--no-verify-proof');
    expect(escaped.status).toBe(0);
    const record = JSON.parse(readFileSync(path.join(proofs(), 'escapes.jsonl'), 'utf8').trim());
    expect(record).toMatchObject({ sha, level: 'preopen' });
  });

  it('checks from a lone copy of the CLI, the way the arm script runs it', () => {
    expect(runVerification(repo, () => 0)).toBe(0);
    const lone = mkdtempSync(path.join(tmpdir(), 'verify-proof-lone-'));
    try {
      copyFileSync(script, path.join(lone, 'cli.ts'));
      const run = (...flags: string[]) =>
        spawnSync(process.execPath, [path.join(lone, 'cli.ts'), 'check', sha, ...flags], {
          cwd: repo,
          encoding: 'utf8',
        });
      expect(run().status, run().stderr).toBe(0);
      expect(run('--level', 'preopen').status).toBe(0);
    } finally {
      rmSync(lone, { recursive: true, force: true });
    }
  });
});

describe('what a preopen run checks (DOR-4728)', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const top = () => git('rev-parse', '--show-toplevel');
  /** Commit `files` on a topic branch off main, then plan. `null` deletes a file. */
  const planFor = (files: Record<string, string | null>): PreopenStep[] => {
    git('switch', '-qc', 'topic');
    for (const [file, contents] of Object.entries(files)) {
      const target = path.join(repo, file);
      if (contents === null) unlinkSync(target);
      else {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, contents);
      }
    }
    git('add', '-A');
    git('commit', '-qm', 'change');
    return planPreopen(repo, root);
  };
  const names = (steps: PreopenStep[]) => steps.map((step) => step.name);
  const lintArgs = (steps: PreopenStep[]) =>
    steps.find((step) => step.name === 'lint:changed')?.args;

  it.each([
    ['scripts/', 'scripts/check-thing.sh'],
    ['.agents/', '.agents/skills/some-skill/SKILL.md'],
    ['.claude/', '.claude/rules/some-rule.md'],
    ['.github/', '.github/workflows/some-workflow.yml'],
    ['the root package.json', 'package.json'],
    ['packages/shared/src, through the scope script', 'packages/shared/src/thing.md'],
    ['turbo.json, through the scope script', 'turbo.json'],
  ])('runs test:scripts for a change under %s', (_kind, file) => {
    expect(names(planFor({ [file]: 'changed' }))).toEqual(['test:scripts', 'typecheck-lint']);
  });

  it('skips test:scripts for a change only under apps/client/', () => {
    const steps = planFor({ 'apps/client/src/view.tsx': 'export {};' });
    expect(names(steps)).toEqual(['lint:changed', 'typecheck-lint']);
    expect(steps.at(-1)?.args).toEqual(['run', 'verify:preopen:turbo']);
  });

  it('lints only the changed files that still exist, are JS or TS, and live in the repo', () => {
    writeFileSync(path.join(repo, 'gone.ts'), 'export {};');
    git('add', '-A');
    git('commit', '-qm', 'base file');
    const outside = mkdtempSync(path.join(tmpdir(), 'verify-proof-outside-'));
    try {
      writeFileSync(path.join(outside, 'elsewhere.js'), '');
      git('switch', '-qc', 'topic');
      symlinkSync(path.join(outside, 'elsewhere.js'), path.join(repo, 'link-out.js'));
      const lintable = ['a.ts', 'b.tsx', 'c.mts', 'd.cts', 'e.js', 'f.jsx', 'g.mjs', 'h.cjs'];
      for (const file of [...lintable, 'notes.md', 'data.json', 'style.css']) {
        writeFileSync(path.join(repo, file), '');
      }
      unlinkSync(path.join(repo, 'gone.ts'));
      git('add', '-A');
      git('commit', '-qm', 'change');
      // An untracked file is part of the change too.
      writeFileSync(path.join(repo, 'untracked.ts'), '');
      expect(lintArgs(planPreopen(repo, root))).toEqual([
        'exec',
        'eslint',
        '--no-warn-ignored',
        ...[...lintable, 'untracked.ts'].sort().map((file) => path.join(top(), file)),
      ]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('skips the lint step when nothing lintable changed', () => {
    const steps = planFor({ 'apps/client/README.md': 'words', 'example.txt': null });
    expect(names(steps)).toEqual(['typecheck-lint']);
  });

  it('measures the change from origin/main when there is one, not from main', () => {
    // main is behind origin/main, whose extra commit touched scripts/.
    git('switch', '-qc', 'upstream');
    mkdirSync(path.join(repo, 'scripts'));
    writeFileSync(path.join(repo, 'scripts/upstream.sh'), 'echo');
    git('add', '-A');
    git('commit', '-qm', 'upstream');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeFileSync(path.join(repo, 'apps.txt'), 'mine');
    git('add', '-A');
    git('commit', '-qm', 'mine');
    expect(names(planPreopen(repo, root))).toEqual(['typecheck-lint']);
    git('update-ref', '-d', 'refs/remotes/origin/main');
    expect(names(planPreopen(repo, root))).toEqual(['test:scripts', 'typecheck-lint']);
  });

  it('stops at the first failing step and returns its exit code', () => {
    const steps: PreopenStep[] = [
      { name: 'test:scripts', args: ['run', 'test:scripts'] },
      { name: 'lint:changed', args: ['exec', 'eslint'] },
      { name: 'typecheck-lint', args: ['run', 'verify:preopen:turbo'] },
    ];
    const ran: string[] = [];
    const exec = (fail?: PreopenStep['name']) => (step: PreopenStep) => {
      ran.push(step.name);
      return step.name === fail ? 3 : 0;
    };
    expect(runPreopen(steps, exec('lint:changed'))).toBe(3);
    expect(ran).toEqual(['test:scripts', 'lint:changed']);
    ran.length = 0;
    expect(runPreopen(steps, exec())).toBe(0);
    expect(ran).toEqual(['test:scripts', 'lint:changed', 'typecheck-lint']);
  });
});
