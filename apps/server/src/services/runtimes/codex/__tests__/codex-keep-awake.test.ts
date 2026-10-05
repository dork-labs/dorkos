/**
 * Codex's own sleep inhibitor as a second layer under DorkOS's hold (spec
 * `keep-awake`): on exactly while the setting is on and the computer can be
 * held awake, and spelled the way the installed SDK puts it on the command line.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Codex } from '@openai/codex-sdk';
import { keepAwakeService } from '../../../core/keep-awake/index.js';
import { buildCodexOptions } from '../codex-options.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Codex prevent_idle_sleep', () => {
  it('is absent while keep-awake does not apply', () => {
    vi.spyOn(keepAwakeService, 'preventsIdleSleep').mockReturnValue(false);
    expect(buildCodexOptions('/bin/codex')).not.toHaveProperty('config');
  });

  it('is set beside the MCP servers while keep-awake applies', () => {
    vi.spyOn(keepAwakeService, 'preventsIdleSleep').mockReturnValue(true);
    expect(buildCodexOptions('/bin/codex').config).toEqual({
      features: { prevent_idle_sleep: true },
    });
    const managed = { servers: { files: { command: 'npx' } }, env: {} };
    expect(buildCodexOptions('/bin/codex', undefined, managed).config).toEqual({
      mcp_servers: { files: { command: 'npx' } },
      features: { prevent_idle_sleep: true },
    });
  });

  it.skipIf(process.platform === 'win32')(
    'reaches the codex command line as --config features.prevent_idle_sleep=true',
    async () => {
      // The REAL SDK, pointed at a stand-in binary that records its argv: this
      // pins the flattening the installed SDK actually does, not our guess at it.
      vi.spyOn(keepAwakeService, 'preventsIdleSleep').mockReturnValue(true);
      const dir = await mkdtemp(path.join(tmpdir(), 'codex-argv-'));
      try {
        const fake = path.join(dir, 'codex');
        await writeFile(fake, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$0.argv"\n');
        await chmod(fake, 0o755);

        const thread = new Codex(buildCodexOptions(fake)).startThread();
        await thread.run('hello').catch(() => undefined);

        const argv = (await readFile(`${fake}.argv`, 'utf8')).split('\n');
        const flag = argv.indexOf('features.prevent_idle_sleep=true');
        expect(flag).toBeGreaterThan(0);
        expect(argv[flag - 1]).toBe('--config');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );
});
