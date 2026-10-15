import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const helper = join(root, 'scripts/typecheck-resource-sampler.mjs');
async function run(command: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data: Buffer) => {
    stdout += data.toString();
  });
  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString();
  });
  child.stdin.end();
  const timeout = setTimeout(() => child.kill('SIGKILL'), 3_000);
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolveRun, reject) => {
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        resolveRun({ code, stdout, stderr });
      });
    }
  );
}

describe('typecheck resource sampler lifecycle', () => {
  it('ends promptly on control EOF with explicit platform availability', async () => {
    const result = await run(process.execPath, [helper, String(process.pid)]);
    expect(result.code).toBe(process.platform === 'linux' ? 0 : 2);
    expect(result.stdout).toContain('control-eof');
    expect(result.stdout.length).toBeLessThan(256 * 1024);
  });
  it('reports missing parent identity as incomplete, without inventing counters', async () => {
    const result = await run(process.execPath, [helper, '0']);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('"observationComplete":false');
  });
});

describe.skipIf(process.platform !== 'linux')('actual Linux Bash compiler-step lifecycle', () => {
  async function fixture(
    primary: string,
    observer: string,
    controlWriterProbe?: 'closed' | 'leaked'
  ) {
    const directory = await mkdtemp(join(tmpdir(), 'typecheck-observation-'));
    try {
      await mkdir(join(directory, 'scripts'));
      const workflow = await readFile(join(root, '.github/workflows/typecheck.yml'), 'utf8');
      let wrapper = workflow
        .split('        run: |\n')
        .at(-1)
        ?.split('\n')
        .map((line) => line.slice(10))
        .join('\n');
      if (!wrapper?.includes('pnpm exec turbo typecheck --continue --concurrency=2'))
        throw new Error('Missing real compiler wrapper');
      if (controlWriterProbe) {
        const marker = 'finish_observation() {';
        if (!wrapper.includes(marker)) throw new Error('Missing sampler control capture seam');
        wrapper = wrapper.replace(
          marker,
          'export SAMPLER_TEST_CONTROL_PIPE="$(readlink "/proc/$$/fd/$sampler_control")"\n' + marker
        );
        if (controlWriterProbe === 'leaked') {
          const closeWriter =
            '  if [[ -n "$sampler_control" ]]; then exec {sampler_control}>&-; fi\n';
          if (!wrapper.includes(closeWriter)) throw new Error('Missing compiler writer close');
          wrapper = wrapper.replace(closeWriter, '');
        }
      }
      await writeFile(join(directory, 'scripts/typecheck-resource-sampler.mjs'), observer);
      await writeFile(
        join(directory, 'pnpm'),
        `#!/bin/bash\n[[ "$*" == 'exec turbo typecheck --continue --concurrency=2' ]] || { echo '[sampler-fixture] stage=compiler-argv' >&2; exit 88; }\n${primary}\n`,
        { mode: 0o755 }
      );
      return await run('/bin/bash', ['-e', '-o', 'pipefail', '-c', wrapper], directory, {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  const observer =
    "process.stdin.resume(); process.stdin.on('end', () => { console.log('sampler-clean-exit'); process.exit(0); });";
  it('keeps compiler success and waits for its own sampler cleanup', async () => {
    const result = await fixture('exit 0', observer);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('sampler-clean-exit');
  });
  it('preserves the original compiler failure status', async () => {
    const result = await fixture('exit 23', observer);
    expect(result.code).toBe(23);
    expect(result.stdout).toContain('sampler-clean-exit');
  });
  it('preserves compiler signal exit status and cleans up observation', async () => {
    const result = await fixture('kill -TERM $$', observer);
    expect(result.code).toBe(143);
    expect(result.stdout).toContain('sampler-clean-exit');
  });
  it('does not pass sampler control writers to compiler descendants', async () => {
    const probe = `node <<'CONTROL_WRITER_PROBE'
const { readFileSync, readdirSync, readlinkSync } = require('node:fs');
const target = process.env.SAMPLER_TEST_CONTROL_PIPE;
if (!target || !target.startsWith('pipe:[')) {
  console.error('[sampler-fixture] stage=control-target value=' + JSON.stringify(target ?? null).slice(0, 96));
  process.exit(88);
}
for (const descriptor of readdirSync('/proc/self/fd')) {
  try {
    if (readlinkSync('/proc/self/fd/' + descriptor) !== target) continue;
    const info = readFileSync('/proc/self/fdinfo/' + descriptor, 'utf8');
    const flags = info.match(/^flags:\\s+([0-7]+)$/m);
    if (!flags) {
      console.error('[sampler-fixture] stage=fd-flags descriptor=' + descriptor + ' value=' + JSON.stringify(info).slice(0, 256));
      process.exit(88);
    }
    if ((parseInt(flags[1], 8) & 3) !== 0) process.exit(89);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
CONTROL_WRITER_PROBE`;
    const result = await fixture(probe, observer, 'closed');
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('sampler-clean-exit');
    const leaked = await fixture(probe, observer, 'leaked');
    expect(leaked.code, leaked.stderr).toBe(89);
    expect(leaked.stdout).toContain('sampler-clean-exit');
  });
  it('fails visibly when only observation fails', async () => {
    const result = await fixture(
      'exit 0',
      "process.stdin.resume(); process.stdin.on('end', () => process.exit(17));"
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('::error::Typecheck resource observation failed');
  });
});
