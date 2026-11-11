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

function step(workflow: string, name: string): string {
  const text = readFileSync(path.join(repo, '.github/workflows', workflow), 'utf8');
  const block = text.split(`      - name: ${name}\n`)[1]?.split(/\n {6}- /)[0];
  const run = block?.split('        run: |\n')[1];
  if (!run) throw new Error(`Missing run block: ${name}`);
  return run.replace(/^ {10}/gm, '');
}

/** Run real workflow shell/helper code; only sudo/apt and tool executables are fake. */
function run(script: string, scenario = 'cached', preinstalled = false) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ci-apt-'));
  scratch.push(dir);
  const executable = (name: string, body: string) =>
    writeFileSync(path.join(dir, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
  executable('lsb_release', 'echo noble');
  executable('timeout', 'shift 2; exec "$@"');
  executable(
    'sudo',
    `
[[ "$1" == apt-get ]] || { echo "unexpected sudo" >&2; exit 90; }
shift
source_file=''
action=''
for arg in "$@"; do
  case "$arg" in
    Dir::Etc::sourcelist=*) source_file="\${arg#*=}" ;;
    update|install) action="$arg" ;;
  esac
done
source_text=default-security.ubuntu.com
if [[ -n "$source_file" ]]; then source_text=$(tr '\\n' ' ' < "$source_file"); fi
echo "$action $* $source_text" >> "$FIXTURE_DIR/apt.log"
if [[ "$action" == update ]]; then
  if [[ "$SCENARIO" == archive-down && "$source_text" == *azure.archive.ubuntu.com* ]]; then exit 0; fi
  echo "Temporary failure resolving mirror" >&2
  exit 100
fi
[[ "$action" == install ]] || exit 91
case "$SCENARIO" in
  cached|missing-tool) ;;
  stale) [[ -n "$source_file" ]] || exit 100 ;;
  archive-down) [[ "$source_text" == *azure.archive.ubuntu.com* ]] || exit 100 ;;
  all-down) exit 100 ;;
  *) exit 92 ;;
esac
if [[ "$SCENARIO" != missing-tool ]]; then touch "$FIXTURE_DIR/installed"; fi
`
  );
  for (const name of ['unzip', 'bsdtar', 'python3', 'gcc', 'g++', 'make']) {
    executable(
      name,
      `
if [[ "$0" == */bsdtar && ! -f "$FIXTURE_DIR/installed" ]]; then
  echo 'bsdtar missing' >&2; exit 127
fi
if [[ "$MISSING_BUILD_TOOL" == "\${0##*/}" ]]; then exit 127; fi
echo "\${0##*/} fixture 1.0"
`
    );
  }
  if (preinstalled) writeFileSync(path.join(dir, 'installed'), '');
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
  if [[ "$1" == -v && "$2" == bsdtar && ! -f "$FIXTURE_DIR/installed" ]]; then return 1; fi
  builtin command "$@"
}
${script}`,
    ],
    {
      cwd: repo,
      encoding: 'utf8',
      timeout: 5000,
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        TMPDIR: dir,
        FIXTURE_DIR: dir,
        SCENARIO: scenario,
        MISSING_BUILD_TOOL: scenario === 'missing-build-tool' ? 'gcc' : '',
      },
    }
  );
  if (result.error) throw result.error;
  let log = '';
  try {
    log = readFileSync(path.join(dir, 'apt.log'), 'utf8');
  } catch {
    /* No apt is a valid result. */
  }
  return { ...result, log };
}

const archiveStep = () =>
  step('test.yml', 'Install the unzip tools the archive cross-checks read with');

describe('CI tool installs during a mirror outage', () => {
  it('uses cached packages when refresh would fail on security.ubuntu.com', () => {
    const result = run(archiveStep());
    expect(result.status, result.stderr).toBe(0);
    expect(result.log).not.toMatch(/^update /m);
    expect(result.stdout).toContain('bsdtar fixture');
  });

  it('still tries installation when the scoped refresh fails', () => {
    const result = run(archiveStep(), 'stale');
    expect(result.status, result.stderr).toBe(0);
    expect(result.log).toMatch(/^update .*archive\.ubuntu\.com/m);
    expect(result.log).not.toContain('noble-security');
    expect(result.log).toContain('Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg');
  });

  it('falls back when the first archive host is down', () => {
    const result = run(archiveStep(), 'archive-down');
    expect(result.status, result.stderr).toBe(0);
    expect(result.log).toContain('azure.archive.ubuntu.com');
    expect(result.log.match(/^update /gm)).toHaveLength(2);
    expect(result.log).toContain('Acquire::https::Timeout=20');
  });

  it('fails loudly after the bounded attempts when no source can install', () => {
    const result = run(archiveStep(), 'all-down');
    expect(result.status).not.toBe(0);
    expect(result.log.match(/^update /gm)).toHaveLength(2);
    expect(result.stderr).toContain('Unable to install CI packages');
  });

  it('does not pass if apt claims success but the reader is missing', () => {
    const result = run(archiveStep(), 'missing-tool');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('bsdtar missing');
  });

  it('does not call apt when the readers are already installed', () => {
    const result = run(archiveStep(), 'all-down', true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.log).toBe('');
  });

  it('verifies runner build tools without contacting Ubuntu mirrors', () => {
    const result = run(step('cli-smoke-test.yml', 'Verify build tools'));
    expect(result.status, result.stderr).toBe(0);
    expect(result.log).toBe('');
    for (const tool of ['python3', 'gcc', 'g++', 'make'])
      expect(result.stdout).toContain(`${tool} fixture`);
  });

  it('fails when a runner build tool is missing', () => {
    const result = run(step('cli-smoke-test.yml', 'Verify build tools'), 'missing-build-tool');
    expect(result.status).not.toBe(0);
  });

  it('uses the same mirror fallback before loading the real sandbox profile', () => {
    const script = step(
      'test.yml',
      'Install distro bubblewrap and load its scoped AppArmor profile'
    );
    const result = run(script.split('sudo install -m 0644')[0]!, 'archive-down');
    expect(result.status, result.stderr).toBe(0);
    expect(result.log).toContain('bubblewrap apparmor-profiles apparmor-utils');
    expect(result.log).toContain('azure.archive.ubuntu.com');
  });
});
