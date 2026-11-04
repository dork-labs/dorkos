/** Exercise the shipped receipt check: no binary or a skipped probe must stay red. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  path.resolve(import.meta.dirname, '../../.github/workflows/test.yml'),
  'utf8'
);
const job = workflow.split('\n  codex-sandbox:\n')[1]!.split('\n  test:\n')[0]!;
const check = job
  .split("          node --input-type=module <<'NODE'\n")[1]!
  .split('          NODE')[0]!
  .replace(/^ {10}/gm, '');
const probes = ['app-server', 'exec'].map((kind) => ({
  title: `protects fake secrets through ${kind} despite a loaded legacy Full setting`,
  status: 'passed',
}));
const binaryRoot = 'apps/server/src/services/runtimes/codex';
const files = readdirSync(path.resolve(import.meta.dirname, '../..', binaryRoot), {
  recursive: true,
  encoding: 'utf8',
})
  .map((file) => file.split(path.sep).join('/'))
  .filter((file) => file.endsWith('.binary.test.ts'))
  .sort();

function receiptPasses(tests: typeof probes, omitFile?: string): boolean {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-proof-receipt-'));
  try {
    writeFileSync(
      path.join(dir, 'vitest-shard-report.json'),
      JSON.stringify({
        testResults: files
          .filter((file) => file !== omitFile)
          .map((file) => ({
            name: '/repo/' + binaryRoot + '/' + file,
            assertionResults: file.endsWith('/app-server.binary.test.ts')
              ? tests
              : [{ title: 'native suite control', status: 'passed' }],
          })),
      })
    );
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', check], {
        cwd: dir,
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the hosted Codex proof receipt', () => {
  it('accepts both completed protected probes', () => {
    expect(receiptPasses(probes)).toBe(true);
  });
  it('refuses a missing binary that skips every test', () => {
    expect(receiptPasses(probes.map((test) => ({ ...test, status: 'pending' })))).toBe(false);
  });
  it('refuses a partially skipped or failed suite', () => {
    for (const status of ['pending', 'failed']) {
      expect(receiptPasses([probes[0]!, { ...probes[1]!, status }])).toBe(false);
    }
  });
  it('refuses empty collection and a missing legacy-setting probe', () => {
    expect(receiptPasses([])).toBe(false);
    expect(receiptPasses([probes[0]!])).toBe(false);
  });
  it('refuses an absent credits suite even when both protected probes pass', () => {
    expect(receiptPasses(probes, '__tests__/credits-provider.binary.test.ts')).toBe(false);
  });
  it('routes every Codex binary suite to the hosted job', () => {
    const routed = [
      ...job.matchAll(/apps\/server\/src\/services\/runtimes\/codex\/([^\s]+\.binary\.test\.ts)/g),
    ]
      .map((match) => match[1])
      .sort();
    expect([...new Set(routed)]).toEqual(files);
  });
  it('uses scoped distro prerequisites only in the probe job', () => {
    expect(job).toContain('runs-on: ubuntu-24.04');
    expect(job).toContain('contents: read');
    expect(job).toContain('persist-credentials: false');
    expect(job).not.toMatch(/secrets\.|sysctl|continue-on-error|passWithNoTests|curl|wget/);
    expect(job).toContain('sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict');
    expect(job).toContain('/usr/bin/bwrap --unshare-user --unshare-net');
    expect(job).toContain('strace -ff -e trace=execve,execveat');
    expect(workflow.match(/sudo apparmor_parser/g)).toHaveLength(1);
    expect(workflow).toContain(
      'needs: [test-shard, community-pg, community-packaged, codex-sandbox]'
    );
    expect(workflow).toContain('needs.codex-sandbox.result');
    expect(workflow.match(/--exclude='\*\*\/codex\/\*\*\/\*\.binary\.test\.ts'/g)).toHaveLength(2);
    expect(job).toContain(
      'pnpm vitest run apps/server/src/services/runtimes/codex/app-server/__tests__/app-server.binary.test.ts'
    );
  });
});

describe('the real bubblewrap executable witness', () => {
  const witness = path.resolve(import.meta.dirname, '../assert-codex-bwrap.mjs');
  function accepted(trace: string): boolean {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bwrap-witness-'));
    try {
      writeFileSync(path.join(dir, 'exec.123'), trace);
      try {
        execFileSync(process.execPath, [witness, dir], { stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  it('accepts the preflighted distro binary actually creating a namespace', () => {
    expect(
      accepted('execve("/usr/bin/bwrap", ["bwrap", "--unshare-net", "--cap-drop", "ALL"], 0x1) = 0')
    ).toBe(true);
  });
  it.each([
    '',
    'execve("/usr/bin/bwrap", ["bwrap", "--help"], 0x1) = 0',
    'execve("/usr/bin/bwrap", ["bwrap", "--unshare-net"], 0x1) = 0',
    'execve("/proc/self/fd/7", ["bwrap", "--unshare-net"], 0x1) = 0',
    'execve("/vendor/codex-resources/bwrap", ["bwrap", "--unshare-net"], 0x1) = 0',
    'execveat(7, "", ["bwrap", "--unshare-net"], 0x1, AT_EMPTY_PATH) = 0',
    'execve("/usr/bin/bwrap", ["bwrap", "--unshare-net"], 0x1) = -1 EPERM',
  ])('refuses absent, help-only, mismatched or unsuccessful execution: %s', (trace) => {
    expect(accepted(trace)).toBe(false);
  });
});
