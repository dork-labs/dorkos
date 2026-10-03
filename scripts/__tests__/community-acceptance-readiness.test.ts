/**
 * The packaged Community runner must wait for PostgreSQL's TCP server, not its
 * temporary Unix-socket-only initialization server. The official Postgres
 * entrypoint starts that temporary process before the final TCP listener.
 */
import { describe, expect, it } from 'vitest';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE_RUNNER = join(REPO_ROOT, 'apps/community/acceptance/run.sh');
/**
 * The runner sweeps Docker objects left by killed predecessors before it creates
 * anything, so the fixture repo needs the real sweep script too. Omitting it
 * makes `run.sh` exit 127 before its first docker call, which reads here as a
 * readiness failure and hides whatever this suite was actually testing.
 */
const SOURCE_SWEEP = join(REPO_ROOT, 'scripts/sweep-ephemeral-docker.sh');

type Readiness = 'eventual-tcp' | 'never-tcp';

function fakeDocker(dir: string, readiness: Readiness): { bin: string; bashEnv: string } {
  const bin = join(dir, 'bin');
  const docker = join(bin, 'docker');
  const sleep = join(bin, 'sleep');
  const state = join(dir, 'state');
  const bashEnv = join(dir, 'fixture-shell.sh');
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  // The real Bash runner and sweep share cheap deterministic command functions.
  // PATH fallbacks keep the fixture isolated even if a function is unavailable.
  writeFileSync(
    bashEnv,
    `fixture_docker_log() { printf '%s\\n' "$*" >> "${state}/calls"; }
fixture_docker() {
local state="${state}" destination
fixture_docker_log "$*"
case "$1" in
  pull) return 0 ;;
  # The sweep runs first and must find nothing here: a fresh fixture repo has no
  # leftovers, so every listing is empty and nothing is removed. Answering it for
  # real (rather than letting \`docker info\` fail) keeps this suite honest about
  # run.sh and the sweep composing.
  info) return 0 ;;
  container)
    case "\${2:-}" in ls) return 0 ;; esac ;;
  volume)
    case "\${2:-}" in ls) return 0 ;; create) printf 'fake-volume\\n'; return 0 ;; rm) return 0 ;; esac ;;
  network)
    case "\${2:-}" in ls|create|rm) return 0 ;; inspect) printf 'true\\n'; return 0 ;; esac ;;
  run) printf 'fake-postgres\\n'; return 0 ;;
  exec)
    if [[ " $* " == *' pg_isready '* ]]; then
      if [[ " $* " == *' -h 127.0.0.1 '* ]]; then
        if [[ "${readiness}" == never-tcp ]]; then
          fixture_docker_log tcp-not-ready
          return 1
        fi
        if [[ ! -f "$state/tcp-attempted" ]]; then
          : > "$state/tcp-attempted"
          fixture_docker_log tcp-not-ready
          return 1
        fi
        : > "$state/tcp-ready"
        fixture_docker_log tcp-ready
        return 0
      fi
      fixture_docker_log unix-ready
      return 0
    fi
    return 0 ;;
  create)
    if [[ ! -f "$state/tcp-ready" ]]; then
      fixture_docker_log app-create-before-tcp
      return 97
    fi
    fixture_docker_log app-create
    printf 'fake-app\\n'
    return 0 ;;
  start) return 0 ;;
  inspect)
    if [[ " $* " == *'{{.Internal}}'* ]]; then printf 'true\\n';
    elif [[ " $* " == *'{{.State.ExitCode}}'* ]]; then printf '0\\n';
    else printf 'false\\n'; fi
    return 0 ;;
  cp)
    destination="\${!#}"
    if [[ " $* " == *playwright-artifacts* ]]; then mkdir -p "$destination"; else printf evidence > "$destination"; fi
    return 0 ;;
  rm) return 0 ;;
esac
printf 'unexpected docker command: %s\\n' "$*" >&2
return 98
}
docker() { fixture_docker "$@"; }
sleep() { return 0; }
`
  );
  writeFileSync(
    docker,
    '#!/usr/bin/env bash\nset -euo pipefail\nif ! declare -F fixture_docker >/dev/null; then printf "Community fixture shell is unavailable.\\n" >&2; exit 98; fi\nfixture_docker "$@"\n'
  );
  writeFileSync(sleep, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(docker, 0o755);
  chmodSync(sleep, 0o755);
  return { bin, bashEnv };
}

function fixtureRunner(dir: string): string {
  const runner = join(dir, 'apps/community/acceptance/run.sh');
  mkdirSync(dirname(runner), { recursive: true });
  copyFileSync(SOURCE_RUNNER, runner);
  chmodSync(runner, 0o755);

  const sweep = join(dir, 'scripts/sweep-ephemeral-docker.sh');
  mkdirSync(dirname(sweep), { recursive: true });
  copyFileSync(SOURCE_SWEEP, sweep);
  chmodSync(sweep, 0o755);
  return runner;
}

function runFixture(readiness: Readiness): { code: number; calls: string } {
  const dir = mkdtempSync(join(tmpdir(), 'community-pg-readiness-'));
  const { bin, bashEnv } = fakeDocker(dir, readiness);
  try {
    const result = spawnSync('bash', [fixtureRunner(dir), '--image', 'fixture-community-image'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        // eslint-disable-next-line no-restricted-syntax -- the fixture replaces docker through PATH.
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        BASH_ENV: bashEnv,
      },
    });
    return {
      code: result.status ?? 1,
      calls: readFileSync(join(dir, 'state', 'calls'), 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('packaged Community PostgreSQL readiness', () => {
  it('waits for the final TCP listener before starting the acceptance app', () => {
    const result = runFixture('eventual-tcp');

    expect(result.code, result.calls).toBe(0);
    expect(
      result.calls.match(/exec .*pg_isready -h 127\.0\.0\.1 -U postgres -d community/g)
    ).toHaveLength(2);
    expect(result.calls).toContain('tcp-not-ready');
    expect(result.calls).toContain('tcp-ready');
    expect(result.calls).toContain('app-create');
    expect(result.calls).not.toContain('app-create-before-tcp');
    expect(result.calls.indexOf('tcp-not-ready')).toBeLessThan(result.calls.indexOf('tcp-ready'));
    expect(result.calls.indexOf('tcp-ready')).toBeLessThan(result.calls.indexOf('app-create'));
  });

  it('fails closed without creating the acceptance app when TCP never becomes ready', () => {
    const result = runFixture('never-tcp');

    expect(result.code, result.calls).toBe(1);
    expect(
      result.calls.match(/exec .*pg_isready -h 127\.0\.0\.1 -U postgres -d community/g)
    ).toHaveLength(30);
    expect(result.calls).toContain('tcp-not-ready');
    expect(result.calls).not.toContain('app-create');
    expect(result.calls).not.toContain('app-create-before-tcp');
  });
});
