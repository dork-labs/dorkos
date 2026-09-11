// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const site = fileURLToPath(new URL('../../', import.meta.url));
const command = JSON.parse(readFileSync(join(site, 'vercel.json'), 'utf8')).ignoreCommand as string;
let root: string;
let base: string;

function write(path: string, value: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
}
function git(...args: string[]) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function commit() {
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-qm',
    'fixture'
  );
}
function run(previous: string | null = base, detectorExit = '0') {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${join(root, 'bin')}:${process.env.PATH}`,
    DETECTOR_EXIT: detectorExit,
  };
  if (previous === null) delete env.VERCEL_GIT_PREVIOUS_SHA;
  else env.VERCEL_GIT_PREVIOUS_SHA = previous;
  const [binary, ...args] = command.split(' ');
  return spawnSync(binary === 'node' ? process.execPath : binary, args, {
    cwd: join(root, 'apps/site'),
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'site-ignore-'));
  git('init', '-q');
  write('docs/guide.mdx', '# Guide\n');
  write('blog/post.mdx', '# Post\n');
  write('apps/site/package.json', '{"name":"@dorkos/site"}');
  write('bin/npx', '#!/bin/sh\nprintf called > ../../detector-called\nexit "$DETECTOR_EXIT"\n');
  chmodSync(join(root, 'bin/npx'), 0o755);
  mkdirSync(join(root, 'apps/site/scripts'), { recursive: true });
  copyFileSync(
    join(site, 'scripts/ignore-build.mjs'),
    join(root, 'apps/site/scripts/ignore-build.mjs')
  );
  commit();
  base = git('rev-parse', 'HEAD');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Vercel ignored build step', () => {
  it.each(['edit', 'add', 'delete', 'rename', 'blog'])(
    'builds for root content %s without the workspace detector',
    (change) => {
      if (change === 'edit') write('docs/guide.mdx', '# Updated\n');
      if (change === 'add') write('docs/new.mdx', '# New\n');
      if (change === 'delete') git('rm', 'docs/guide.mdx');
      if (change === 'rename') git('mv', 'docs/guide.mdx', 'docs/renamed.mdx');
      if (change === 'blog') write('blog/post.mdx', '# Updated\n');
      commit();
      expect(run().status).toBe(1);
      expect(existsSync(join(root, 'detector-called'))).toBe(false);
    }
  );
  it('compares the last deployed commit, not only the latest commit', () => {
    write('docs/guide.mdx', '# Updated\n');
    commit();
    write('specs/note.md', 'unrelated');
    commit();
    expect(run().status).toBe(1);
  });
  it('delegates unrelated changes and preserves a proven skip', () => {
    write('specs/note.md', 'unrelated');
    commit();
    expect(run().status).toBe(0);
    expect(readFileSync(join(root, 'detector-called'), 'utf8')).toBe('called');
  });
  it.each(['1', '2'])(
    'builds when the workspace detector reports changes or errors (%s)',
    (exit) => {
      expect(run(base, exit).status).toBe(1);
      expect(existsSync(join(root, 'detector-called'))).toBe(true);
    }
  );
  it.each([null, '', 'invalid', '0'.repeat(40), '--help'])(
    'builds when the deployment base cannot be trusted: %s',
    (previous) => {
      expect(run(previous).status).toBe(1);
      expect(existsSync(join(root, 'detector-called'))).toBe(false);
    }
  );
  it('includes both external content roots in the site cache inputs', () => {
    const config = readFileSync(join(site, 'turbo.json'), 'utf8');
    expect(config).toContain('"$TURBO_ROOT$/docs/**"');
    expect(config).toContain('"$TURBO_ROOT$/blog/**"');
  });
});
