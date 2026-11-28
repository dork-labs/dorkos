/**
 * The CLI's real order (DOR-5481): it loads server modules (its config store
 * reaches `env.ts`) before it reads the project `.env`. One module graph, no
 * reset: the settings must still be seen when first read after the hand-off.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handProjectSettings } from '@dorkos/shared/project-environment';
// Loaded first, as the CLI's config store loads them.
import { env } from '../env.js';
import { childEnvironment } from '../services/runtimes/shared/runtime-environment-config.js';
import { loadProjectEnv } from '../../../../packages/cli/src/lib/project-env.js';

afterEach(() => handProjectSettings({ settings: {} }));

describe('the project .env, read after the server modules loaded', () => {
  it.skipIf(env.DO_NOT_TRACK !== undefined)(
    'still turns telemetry off for the server and its runtime children',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-order-'));
      try {
        fs.writeFileSync(path.join(dir, '.env'), 'DO_NOT_TRACK=1\n');
        loadProjectEnv(dir, () => undefined);
        expect(env.DO_NOT_TRACK).toBe('1');
        expect(childEnvironment('codex', 'warmup').DO_NOT_TRACK).toBe('1');
        // eslint-disable-next-line no-restricted-syntax -- the point: the value never enters process.env
        expect(process.env.DO_NOT_TRACK).toBeUndefined();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
