/**
 * `ci/space-server.env` is the one place that says where the space server lives
 * (DOR-3007), and it is read three ways: `source`d by bash, appended to
 * `$GITHUB_ENV` by the workflows (comments filtered out by a grep), and parsed
 * by `scripts/lib/space-server.mjs`. These hold the three readings together, so
 * a value one of them would read differently is refused before a job reads it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSpaceServerEnv, readSpaceServer } from '../lib/space-server.mjs';

const root = join(import.meta.dirname, '../..');
/** The grep both workflows run, as they run it. */
const WORKFLOW_FILTER = `grep -E '^SPACE_[A-Z_]*=.' ci/space-server.env`;
/** The whole read step: the grep, then a refusal when SPACE_DIR is missing or empty. */
const READ_STEP = `run: ${WORKFLOW_FILTER} >> "$GITHUB_ENV" && grep -qE '^SPACE_DIR=.' ci/space-server.env`;

describe('ci/space-server.env', () => {
  it('reads the same in bash, in $GITHUB_ENV and in the TypeScript reader', () => {
    const parsed = readSpaceServer(root);
    const sourced = execFileSync(
      'bash',
      [
        '-c',
        'source ci/space-server.env && printf "%s\\n" "$SPACE_DIR" "$SPACE_SRC_DIR" "$SPACE_WEB_DIR"',
      ],
      { cwd: root, encoding: 'utf8' }
    );
    expect(sourced).toBe(`${parsed.spaceDir}\n${parsed.spaceSrcDir}\n${parsed.spaceWebDir}\n`);

    const githubEnv = execFileSync('bash', ['-c', WORKFLOW_FILTER], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(githubEnv).toBe(
      `SPACE_DIR=${parsed.spaceDir}\nSPACE_SRC_DIR=${parsed.spaceSrcDir}\nSPACE_WEB_DIR=${parsed.spaceWebDir}\n`
    );
  });

  it('names a space server folder that exists, with the files the jobs read in it', () => {
    const { spaceDir } = readSpaceServer(root);
    for (const file of ['migrations', 'acceptance/run.sh', 'acceptance/Dockerfile']) {
      expect(existsSync(join(root, spaceDir, file)), `${spaceDir}/${file}`).toBe(true);
    }
  });

  it('reaches the workflows only through the file, never as a second copy of the folder', () => {
    const { spaceDir } = readSpaceServer(root);
    for (const workflow of ['test.yml', 'publish-community.yml']) {
      const yaml = readFileSync(join(root, '.github/workflows', workflow), 'utf8');
      expect(yaml, workflow).toContain(READ_STEP);
      // Comments may still name the folder; nothing a job runs or reads may.
      const code = yaml
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n');
      expect(code, workflow).not.toContain(spaceDir);
    }
  });

  it('fails the read step when SPACE_DIR is missing or empty', () => {
    const step = READ_STEP.slice('run: '.length);
    const run = (text: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'space-server-step-'));
      try {
        mkdirSync(join(dir, 'ci'));
        writeFileSync(join(dir, 'ci/space-server.env'), text);
        return spawnSync('bash', ['-c', step], {
          cwd: dir,
          env: { PATH: process.env.PATH, GITHUB_ENV: join(dir, 'github-env') },
        }).status;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    expect(run('SPACE_DIR=a/b\nSPACE_SRC_DIR=a/b/src\nSPACE_WEB_DIR=a/b/web\n')).toBe(0);
    expect(run('SPACE_DIR=\nSPACE_SRC_DIR=a/b/src\n')).not.toBe(0);
    expect(run('SPACE_SRC_DIR=a/b/src\n')).not.toBe(0);
  });
});

describe('parseSpaceServerEnv', () => {
  const good = 'SPACE_DIR=a/b\nSPACE_SRC_DIR=a/b/src\nSPACE_WEB_DIR=a/b/web\n';

  it('reads KEY=value lines and skips comments and blank lines', () => {
    expect(parseSpaceServerEnv(`# where it lives\n\n${good}`)).toEqual({
      spaceDir: 'a/b',
      spaceSrcDir: 'a/b/src',
      spaceWebDir: 'a/b/web',
    });
  });

  it('reads a checkout with Windows line endings the same way', () => {
    // Purpose: fails if a CRLF checkout (Git for Windows' default) makes every line unreadable.
    expect(parseSpaceServerEnv(`# where it lives\r\n\r\n${good.replaceAll('\n', '\r\n')}`)).toEqual(
      {
        spaceDir: 'a/b',
        spaceSrcDir: 'a/b/src',
        spaceWebDir: 'a/b/web',
      }
    );
  });

  it.each([
    ['a missing key', 'SPACE_DIR=a/b\nSPACE_SRC_DIR=a/b/src\n'],
    ['an empty value', good.replace('SPACE_SRC_DIR=a/b/src', 'SPACE_SRC_DIR=')],
    ['an absolute folder', good.replace('SPACE_DIR=a/b', 'SPACE_DIR=/a/b')],
    ['a trailing slash', good.replace('SPACE_DIR=a/b', 'SPACE_DIR=a/b/')],
    ['quotes', good.replace('SPACE_DIR=a/b', 'SPACE_DIR="a/b"')],
    ['an inline comment', good.replace('SPACE_DIR=a/b', 'SPACE_DIR=a/b # here')],
    ['a variable', good.replace('SPACE_DIR=a/b', 'SPACE_DIR=$HOME/b')],
    ['a parent segment', good.replace('SPACE_DIR=a/b', 'SPACE_DIR=a/../b')],
    ['a line that is not KEY=value', `export SPACE_DIR=a/b\n${good}`],
    // The workflows' grep would drop each of these while bash still reads it.
    ['an indented assignment', good.replace('SPACE_DIR=a/b', '  SPACE_DIR=a/b')],
    ['an indented comment', `  # note\n${good}`],
    ['a key outside SPACE_*', `OTHER_DIR=x\n${good}`],
    ['a key with a digit', `SPACE_DIR2=x\n${good}`],
  ])('refuses %s', (_label, text) => {
    expect(() => parseSpaceServerEnv(text)).toThrow();
  });
});
