/**
 * `dorkos --ref=<ref>` records the dorkos.ai install ref once, in the data
 * directory, and sends nothing (DOR-2862). Runs the real entry point the way
 * `install.sh` calls it: `dorkos --ref=<ref> --version`.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import { parseCliArgs } from '../parse-cli-args.js';

const require = createRequire(import.meta.url);
const entry = fileURLToPath(new URL('../cli.ts', import.meta.url));
const tsx = pathToFileURL(require.resolve('tsx/esm')).href;

/** Run the CLI entry with `args` against a throwaway data directory. */
function runCli(home: string, args: string[]) {
  const sourceRoot = new URL('../../../../apps/server/src/', import.meta.url).href;
  const code = `import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){if(specifier.includes('/server/')){const url=new URL(specifier,context.parentURL);const marker='/packages/cli/server/';if(url.pathname.includes(marker)){return next(new URL(url.pathname.split(marker)[1].replace(/\\.js$/,'.ts'),${JSON.stringify(sourceRoot)}).href,context);}}return next(specifier,context);}});globalThis.__CLI_VERSION__='0.74.0';process.argv=[process.execPath,${JSON.stringify(entry)},...${JSON.stringify(args)}];await import(${JSON.stringify(pathToFileURL(entry).href)});`;
  const runner = path.join(os.tmpdir(), `dorkos-ref-runner-${process.pid}-${Date.now()}.mjs`);
  writeFileSync(runner, code);
  try {
    return spawnSync(process.execPath, ['--import', tsx, runner], {
      encoding: 'utf8',
      timeout: 15000,
      // Telemetry forced off: recording the ref locally must not depend on it.
      env: { PATH: process.env.PATH, HOME: home, DORK_HOME: home, DO_NOT_TRACK: '1' },
    });
  } finally {
    rmSync(runner, { force: true });
  }
}

describe('parseCliArgs --ref', () => {
  it('accepts --ref=<value> and --ref <value>', () => {
    expect(parseCliArgs(['--ref=k3j4mnb8x2qa.hn']).values.ref).toBe('k3j4mnb8x2qa.hn');
    expect(parseCliArgs(['--ref', 'k3j4mnb8x2qa']).values.ref).toBe('k3j4mnb8x2qa');
  });
});

describe('dorkos --ref', () => {
  it('records a valid ref in the data directory and still prints the version', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'dorkos-ref-'));
    try {
      const result = runCli(home, ['--ref=k3j4mnb8x2qa.hn.launch', '--version']);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('0.74.0');
      const stored = JSON.parse(readFileSync(path.join(home, 'install-ref.json'), 'utf8'));
      expect(stored).toMatchObject({
        token: 'k3j4mnb8x2qa',
        utmSource: 'hn',
        utmCampaign: 'launch',
      });
      // Nothing but the ref file: no config, no instance id, no telemetry state.
      expect(readdirSync(home)).toEqual(['install-ref.json']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('ignores an invalid ref and writes nothing', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'dorkos-ref-'));
    try {
      const result = runCli(home, ['--ref=$(whoami)', '--version']);
      expect(result.status).toBe(0);
      expect(readdirSync(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
