/**
 * A workspace hook runs project files, so it gets the person's environment
 * without any name DorkOS owns (DOR-5481), plus the ports DorkOS hands it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHooks } from '../hooks.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-hook-env-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a workspace hook’s environment', () => {
  it.skipIf(process.platform === 'win32')(
    'sees none of the server’s own names, and still runs with PATH and its ports',
    async () => {
      vi.stubEnv('MCP_API_KEY', 'fixture-mcp');
      vi.stubEnv('NANGO_ENCRYPTION_KEY', 'fixture-nango');
      vi.stubEnv('NGROK_AUTHTOKEN', 'fixture-ngrok');
      vi.stubEnv('BETTER_AUTH_SECRET', 'fixture-secret');
      vi.stubEnv('DORKOS_HUB_INSTANCE_KEY', 'fixture-hub');
      await runHooks(
        'after_create',
        {
          hooks: {
            after_create: ['env > hook-env.txt'],
            before_run: [],
            after_run: [],
            before_remove: [],
          },
        },
        { cwd: dir, env: { DORKOS_PORT: '6100' } }
      );
      const seen = fs.readFileSync(path.join(dir, 'hook-env.txt'), 'utf8');
      expect(seen).not.toMatch(/fixture-/);
      expect(seen).toMatch(/^DORKOS_PORT=6100$/m);
      expect(seen).toMatch(/^PATH=/m);
    }
  );
});
