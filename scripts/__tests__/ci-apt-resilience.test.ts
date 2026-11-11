import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../..');
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function step(workflow: string, ...names: string[]): string {
  const text = readFileSync(path.join(repo, '.github/workflows', workflow), 'utf8');
  for (const name of names) {
    const block = text.split(`      - name: ${name}\n`)[1]?.split(/\n {6}- /)[0];
    const run = block?.split('        run: |\n')[1];
    if (run) return run.replace(/^ {10}/gm, '');
  }
  throw new Error(`Missing run block: ${names.join(', ')}`);
}

/** Run the workflow shell with fake tools and an apt command that always fails. */
function run(script: string, missing: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ci-offline-tools-'));
  scratch.push(dir);
  const executable = (name: string, body: string) =>
    writeFileSync(path.join(dir, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
  executable('lsb_release', 'echo noble');
  executable('timeout', 'shift 2; exec "$@"');
  executable('sudo', 'echo "apt unavailable" >&2; exit 100');
  for (const name of ['unzip', 'bsdtar', '7z', '7zz', 'python3', 'gcc', 'g++', 'make']) {
    executable(
      name,
      `case " $MISSING " in *" ${name} "*) echo "${name} missing" >&2; exit 127;; esac\necho "${name} fixture 1.0"`
    );
  }
  const result = spawnSync(
    '/bin/bash',
    [
      '--noprofile',
      '--norc',
      '-e',
      '-o',
      'pipefail',
      '-c',
      `
command() {
  if [[ "$1" == -v ]]; then
    case " $MISSING " in *" $2 "*) return 1;; esac
  fi
  builtin command "$@"
}
${script}`,
    ],
    {
      cwd: repo,
      encoding: 'utf8',
      timeout: 5000,
      env: { PATH: `${dir}:/usr/bin:/bin`, MISSING: missing.join(' '), TMPDIR: dir },
    }
  );
  if (result.error) throw result.error;
  return result;
}

const archiveStep = () =>
  step(
    'test.yml',
    'Verify the unzip tools the archive cross-checks read with',
    'Install the unzip tools the archive cross-checks read with'
  );

describe('CI prerequisites without Ubuntu mirrors', () => {
  it('uses preinstalled 7z when bsdtar is absent, with apt unavailable', () => {
    const result = run(archiveStep(), ['bsdtar', '7zz']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('7z fixture');
    expect(result.stderr).not.toContain('apt unavailable');
  });

  it('accepts the upstream 7zz executable name', () => {
    const result = run(archiveStep(), ['bsdtar', '7z']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('7zz fixture');
  });

  it('keeps bsdtar when it is installed', () => {
    const result = run(archiveStep(), ['7z', '7zz']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('bsdtar fixture');
  });

  it('fails loudly when no independent reader is installed', () => {
    const result = run(archiveStep(), ['bsdtar', '7z', '7zz']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('bsdtar, 7z or 7zz is required');
    expect(result.stderr).not.toContain('apt unavailable');
  });

  it.each(['unzip', 'python3'])('fails if %s is missing', (tool) => {
    const result = run(archiveStep(), [tool]);
    expect(result.status).not.toBe(0);
  });

  it('verifies the smoke build tools without apt', () => {
    const result = run(step('cli-smoke-test.yml', 'Verify build tools'), []);
    expect(result.status, result.stderr).toBe(0);
    for (const tool of ['python3', 'gcc', 'g++', 'make'])
      expect(result.stdout).toContain(`${tool} fixture`);
  });

  it('fails when a smoke build tool is missing', () => {
    expect(run(step('cli-smoke-test.yml', 'Verify build tools'), ['gcc']).status).not.toBe(0);
  });
});
