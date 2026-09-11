import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { currentCliInvocation } from '../cli-invocation.js';
import { SERVER_VERSION } from '../../../../lib/version.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "dork-cli-'quote-"));
  roots.push(root);
  const entry = path.join(root, 'current cli.mjs');
  writeFileSync(entry, 'console.log("current:"+process.argv[2])');
  vi.spyOn(process, 'argv', 'get').mockReturnValue([process.execPath, entry]);
  vi.stubEnv('DORKOS_CLI_ENTRYPOINT', entry);
  vi.stubEnv('DORKOS_CLI_VERSION', SERVER_VERSION);
  return { root, entry };
}
describe('current distribution CLI invocation', () => {
  it('does not offer a PATH fallback without a bootstrap identity', () => {
    vi.stubEnv('DORKOS_CLI_ENTRYPOINT', '');
    expect(currentCliInvocation()).toBeUndefined();
  });
  it('rejects a different version or entrypoint and missing files', () => {
    const { entry } = fixture();
    vi.stubEnv('DORKOS_CLI_VERSION', '0.49.0');
    expect(currentCliInvocation()).toBeUndefined();
    vi.stubEnv('DORKOS_CLI_VERSION', SERVER_VERSION);
    vi.spyOn(process, 'argv', 'get').mockReturnValue([process.execPath, '/other/cli.js']);
    expect(currentCliInvocation()).toBeUndefined();
    vi.spyOn(process, 'argv', 'get').mockReturnValue([process.execPath, entry]);
    vi.stubEnv('DORKOS_CLI_ENTRYPOINT', '/missing/cli.js');
    expect(currentCliInvocation()).toBeUndefined();
  });
  it.skipIf(process.platform === 'win32')(
    'survives a login shell replacing PATH with a stale executable',
    () => {
      const { root } = fixture();
      const bin = path.join(root, 'bin');
      mkdirSync(bin);
      const marker = path.join(root, 'stale-called');
      writeFileSync(path.join(bin, 'dorkos'), '#!/bin/sh\nprintf stale > "$STALE_MARKER"\n', {
        mode: 0o755,
      });
      const config = path.join(root, 'config.json');
      writeFileSync(config, '{"auth":{"enabled":true},"futureSetting":true}');
      const before = readFileSync(config);
      const command = currentCliInvocation();
      expect(command).toBeTruthy();
      const run = spawnSync(
        '/bin/sh',
        ['-lc', `PATH="$HOSTILE_PATH"; export PATH; ${command} capabilities`],
        { encoding: 'utf8', env: { ...process.env, HOSTILE_PATH: bin, STALE_MARKER: marker } }
      );
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe('current:capabilities');
      expect(readFileSync(config)).toEqual(before);
      expect(() => readFileSync(marker)).toThrow();
    }
  );
});
