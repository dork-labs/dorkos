/**
 * Pins scripts/playwright-apt-debs.sh and the browser-test.yml steps around it
 * (ledger 261112-190000): Chromium's OS packages install from a cache with no
 * Ubuntu server contacted, through apt with hash checks and never `dpkg -i`,
 * and only a scheduled run on main may save that cache.
 *
 * The script runs for real against fake `sudo`, `apt-get`, `pnpm` and `dpkg`
 * that log every call, so each case can say which commands ran and which did
 * not. Same approach as ci-apt-resilience.test.ts beside it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../..');
const script = path.join(repo, 'scripts/playwright-apt-debs.sh');
const workflowText = () =>
  readFileSync(path.join(repo, '.github/workflows/browser-test.yml'), 'utf8');

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PACKAGES = ['fonts-freefont-ttf', 'fonts-ipafont-gothic', 'xfonts-utils'];

// `apt-get` reads its archive dir from `-o Dir::Cache::archives=…`, answers
// --print-uris from the fixture pool, copies the pool for --download-only
// (unless APT_NET=down), and for --no-download insists every file is there.
const FAKE_APT = `
log "apt-get $*"
archives=""; mode=install; pkgs=()
for a in "$@"; do
  case "$a" in
    Dir::Cache::archives=*) archives="\${a#Dir::Cache::archives=}" ;;
    --print-uris) mode=uris ;;
    --download-only) mode=download ;;
    --no-download) mode=local ;;
    -*|install|-o) ;;
    *) pkgs+=("$a") ;;
  esac
done
case "$mode" in
  uris)
    [ -z "\${APT_LISTS_BROKEN:-}" ] || { echo "E: lists unreadable" >&2; exit 100; }
    echo "Reading package lists..."
    for p in "\${pkgs[@]}"; do
      f=$(cd "$POOL" && ls "\${p}"_*.deb)
      [ "$p" = "\${APT_DROP:-}" ] && continue
      echo "'https://archive.ubuntu.com/ubuntu/pool/$f' $f $(wc -c <"$POOL/$f" | tr -d ' ') SHA256:$(sha256sum "$POOL/$f" | cut -d' ' -f1)"
    done ;;
  download)
    [ "\${APT_NET:-up}" = up ] || { echo "E: Failed to fetch" >&2; exit 100; }
    cp "$POOL"/*.deb "$archives" ;;
  local)
    for p in "\${pkgs[@]}"; do ls "$archives\${p}"_*.deb >/dev/null || exit 100; done ;;
esac
`;

// `pnpm … playwright install chromium` downloads the browser; `install-deps`
// is the old apt-get update path, which fails when APT_NET=down.
const FAKE_PNPM = `
log "pnpm $*"
case " $* " in
  *" install-deps chromium "*) [ "\${APT_NET:-up}" = up ] || exit 1 ;;
esac
`;

interface Env {
  [key: string]: string | undefined;
}

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'playwright-apt-'));
  scratch.push(dir);
  const bin = path.join(dir, 'bin');
  const pool = path.join(dir, 'pool');
  mkdirSync(bin);
  mkdirSync(pool);
  const tool = (name: string, body: string) =>
    writeFileSync(
      path.join(bin, name),
      `#!/bin/bash\nset -eu\nlog() { echo "$1" >>"$LOG"; }\n${body}\n`,
      { mode: 0o755 }
    );
  tool('sudo', 'log "sudo $1"\nexec "$@"');
  tool('apt-get', FAKE_APT);
  tool('pnpm', FAKE_PNPM);
  tool('dpkg', 'log "dpkg $*"');
  tool('sleep', ':');
  for (const name of PACKAGES)
    writeFileSync(path.join(pool, `${name}_1.0-1_all.deb`), `deb bytes of ${name}\n`);
  const work = path.join(dir, 'work');
  const files = {
    log: path.join(dir, 'calls.log'),
    output: path.join(dir, 'github-output'),
  };
  writeFileSync(files.log, '');
  writeFileSync(files.output, '');

  const run = (args: string[], env: Env = {}) => {
    const result = spawnSync('/bin/bash', [script, ...args], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        LOG: files.log,
        POOL: pool,
        GITHUB_OUTPUT: files.output,
        ImageOS: 'ubuntu24',
        ...env,
      },
    });
    if (result.error) throw result.error;
    return result;
  };
  const dryRun = (text: string) => {
    const file = path.join(dir, 'dry-run.txt');
    writeFileSync(file, text);
    return file;
  };
  const missing = (names = PACKAGES) =>
    dryRun(
      `Missing system dependencies (${names.length}):\n${names.map((n) => `  ${n}`).join('\n')}\n`
    );
  const outputs = () =>
    Object.fromEntries(
      readFileSync(files.output, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(/=(.*)/s).slice(0, 2))
    ) as Record<string, string>;
  const calls = () => readFileSync(files.log, 'utf8');
  const resetLog = () => {
    writeFileSync(files.log, '');
    writeFileSync(files.output, '');
  };
  /** Plan, then copy the pool into the work dir the way a cache restore would. */
  const planAndRestore = () => {
    expect(run(['plan', missing(), work]).status).toBe(0);
    const debs = path.join(work, 'debs');
    mkdirSync(debs, { recursive: true });
    for (const name of PACKAGES) {
      const file = `${name}_1.0-1_all.deb`;
      writeFileSync(path.join(debs, file), readFileSync(path.join(pool, file)));
    }
    resetLog();
    return debs;
  };
  return { dir, pool, work, run, dryRun, missing, outputs, calls, resetLog, planAndRestore };
}

describe('plan: exact package files from the image lists, no network', () => {
  it('writes a manifest of exact files and keys the cache on its hash', () => {
    const box = sandbox();
    const result = box.run(['plan', box.missing(), box.work]);
    expect(result.status, result.stderr).toBe(0);
    const manifest = readFileSync(path.join(box.work, 'manifest.txt'), 'utf8');
    expect(manifest).toContain('fonts-freefont-ttf_1.0-1_all.deb');
    expect(manifest.trim().split('\n')).toHaveLength(3);
    const out = box.outputs();
    expect(out.mode).toBe('cache');
    const digest = createHash('sha256').update(manifest).digest('hex');
    expect(out.key).toMatch(new RegExp(`^playwright-apt-v1-ubuntu24-[^-]+-${digest}$`));
    // print-uris only, against a scratch archive dir: nothing fetched, no update.
    expect(box.calls()).toContain('--print-uris');
    expect(box.calls()).not.toMatch(/update|--download-only|install-deps/);
  });

  it('changes the key when one package version changes', () => {
    const box = sandbox();
    box.run(['plan', box.missing(), box.work]);
    const first = box.outputs().key;
    rmSync(path.join(box.pool, 'xfonts-utils_1.0-1_all.deb'));
    writeFileSync(path.join(box.pool, 'xfonts-utils_1.0-2_all.deb'), 'deb bytes of xfonts-utils\n');
    box.resetLog();
    box.run(['plan', box.missing(), box.work]);
    expect(box.outputs().key).not.toBe(first);
  });

  it('says none when every package is installed', () => {
    const box = sandbox();
    box.run(['plan', box.dryRun('All system dependencies are installed.\n'), box.work]);
    expect(box.outputs().mode).toBe('none');
    expect(box.calls()).toBe('');
  });

  it.each([
    ['an unknown dry-run format', () => 'sudo -- sh -c "apt-get update && apt-get install x"\n'],
    ['a count that does not match its list', () => 'Missing system dependencies (5):\n  a\n  b\n'],
  ])('falls back on %s', (_label, text) => {
    const box = sandbox();
    const result = box.run(['plan', box.dryRun(text()), box.work]);
    expect(result.status).toBe(0);
    expect(box.outputs().mode).toBe('fallback');
  });

  it('falls back when apt cannot read the lists, or lists fewer files', () => {
    const box = sandbox();
    box.run(['plan', box.missing(), box.work], { APT_LISTS_BROKEN: '1' });
    expect(box.outputs().mode).toBe('fallback');
    box.resetLog();
    box.run(['plan', box.missing(), box.work], { APT_DROP: 'xfonts-utils' });
    expect(box.outputs().mode).toBe('fallback');
  });
});

describe('install', () => {
  const hit = { APT_MODE: 'cache', APT_CACHE_HIT: 'true', BROWSER_CACHE_HIT: 'true' };

  it('on a cache hit, installs through apt --no-download with no network and no dpkg', () => {
    const box = sandbox();
    box.planAndRestore();
    const result = box.run(['install', box.work], { ...hit, APT_NET: 'down' });
    expect(result.status, result.stderr).toBe(0);
    const calls = box.calls();
    expect(calls).toMatch(/apt-get install .*--no-download/);
    expect(calls).not.toMatch(/update|--download-only|install-deps|dpkg|install chromium/);
    expect(box.outputs()['debs-ready']).toBe('true');
  });

  it('refuses a cached file that does not match the manifest, and downloads instead', () => {
    const box = sandbox();
    const debs = box.planAndRestore();
    writeFileSync(path.join(debs, 'fonts-ipafont-gothic_1.0-1_all.deb'), 'planted\n');
    const result = box.run(['install', box.work], hit);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('fonts-ipafont-gothic_1.0-1_all.deb does not match');
    expect(box.calls()).toMatch(/--download-only/);
    expect(readFileSync(path.join(debs, 'fonts-ipafont-gothic_1.0-1_all.deb'), 'utf8')).toBe(
      'deb bytes of fonts-ipafont-gothic\n'
    );
    expect(box.outputs()['debs-ready']).toBe('true');
  });

  it('on a miss, downloads the exact files without apt-get update, then installs them', () => {
    const box = sandbox();
    box.run(['plan', box.missing(), box.work]);
    box.resetLog();
    const result = box.run(['install', box.work], { APT_MODE: 'cache', APT_CACHE_HIT: '' });
    expect(result.status, result.stderr).toBe(0);
    const calls = box.calls();
    expect(calls).toContain('pnpm --filter @dorkos/e2e exec playwright install chromium');
    expect(calls).toMatch(/--download-only[\s\S]*--no-download/);
    expect(calls).not.toMatch(/update|install-deps|dpkg/);
    expect(box.outputs()['debs-ready']).toBe('true');
  });

  it('falls back to playwright install-deps when the download fails, and saves nothing', () => {
    const box = sandbox();
    box.run(['plan', box.missing(), box.work]);
    box.resetLog();
    const result = box.run(['install', box.work], {
      APT_MODE: 'cache',
      APT_CACHE_HIT: '',
      BROWSER_CACHE_HIT: 'true',
      APT_NET: 'down',
    });
    expect(result.status).not.toBe(0);
    const calls = box.calls();
    expect(calls).toContain('playwright install-deps chromium');
    expect(calls.match(/playwright install-deps chromium/g)).toHaveLength(2); // two attempts
    expect(box.outputs()['debs-ready']).toBeUndefined();
  });

  it('takes the old path when the plan fell back', () => {
    const box = sandbox();
    const result = box.run(['install', box.work], {
      APT_MODE: 'fallback',
      BROWSER_CACHE_HIT: 'true',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(box.calls()).toBe('pnpm --filter @dorkos/e2e exec playwright install-deps chromium\n');
  });

  it('installs nothing when nothing is missing', () => {
    const box = sandbox();
    const result = box.run(['install', box.work], { APT_MODE: 'none', BROWSER_CACHE_HIT: 'true' });
    expect(result.status, result.stderr).toBe(0);
    expect(box.calls()).toBe('');
  });
});

describe('browser-test.yml', () => {
  const steps = (text: string) => text.split(/\n(?= {6}- )/);

  it('saves the OS-package cache in one step, on a scheduled run on main only', () => {
    const text = workflowText();
    const savers = steps(text).filter((s) => /uses: actions\/cache\/save@/.test(s));
    expect(savers).toHaveLength(1);
    const condition = savers[0]?.match(/if: \$\{\{ (.*) \}\}/)?.[1] ?? '';
    expect(condition).toContain("github.event_name == 'schedule'");
    expect(condition).toContain("github.ref == 'refs/heads/main'");
    expect(condition).toContain("steps.install.outputs.debs-ready == 'true'");
    expect(condition).not.toContain('pull_request');
    // Nothing else may write the apt cache: the restores are restore-only.
    for (const step of steps(text).filter((s) => s.includes('playwright-apt/debs'))) {
      expect(step).toMatch(/uses: actions\/cache\/(restore|save)@/);
    }
    expect(steps(text).filter((s) => /uses: actions\/cache\/restore@/.test(s))).toHaveLength(3);
  });

  it('gives every Chromium install the same cap, retry and script', () => {
    const installs = steps(workflowText()).filter((s) => /- name: Install (the )?Chromium/.test(s));
    expect(installs).toHaveLength(3);
    for (const step of installs) {
      expect(step).toContain('timeout-minutes: 10');
      expect(step).toContain('bash scripts/playwright-apt-debs.sh install');
      expect(step).not.toContain('--with-deps');
      expect(step).not.toContain('dpkg');
    }
  });

  it('pins every action by full commit SHA', () => {
    const uses = workflowText().match(/uses: \S+/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use).toMatch(/@[0-9a-f]{40}$/);
  });
});
