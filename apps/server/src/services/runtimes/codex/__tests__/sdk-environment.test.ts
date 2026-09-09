import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { buildCodexOptions } from '../codex-options.js';

vi.mock('../../../core/config-manager.js', () => ({
  configManager: { get: () => ({ environment: { inherit: { codex: [] } } }) },
}));
const sdkUrl = import.meta.resolve('@openai/codex-sdk');

describe('installed Codex SDK child environment', () => {
  it('never falls back to ambient authority for a no-Connections/no-extraEnv launch', () => {
    // The instrumented SDK child receives synthetic inputs only, including its home.
    for (const name of Object.keys(process.env)) vi.stubEnv(name, undefined);
    vi.stubEnv('HOME', '/synthetic/home');
    vi.stubEnv('USERPROFILE', '/synthetic/home');
    vi.stubEnv('NANGO_ENCRYPTION_KEY', 'synthetic-server-secret');
    vi.stubEnv('MCP_API_KEY', 'synthetic-override-secret');
    vi.stubEnv('CODEX_API_KEY', 'synthetic-model-key');
    vi.stubEnv('DO_NOT_TRACK', '1');
    try {
      const options = buildCodexOptions('/synthetic/codex');
      const script = `
        import fs from 'node:fs';
        import cp from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        const options = JSON.parse(fs.readFileSync(0, 'utf8'));
        let captured;
        cp.spawn = (command, args, opts) => {
          captured = { args, env: opts.env }; throw new Error('synthetic spawn intercepted');
        };
        syncBuiltinESMExports();
        const { Codex } = await import(${JSON.stringify(sdkUrl)});
        try { await new Codex(options).startThread().run('synthetic'); } catch {}
        if (!captured) process.exit(2);
        process.stdout.write(JSON.stringify(captured));
      `;
      const result = JSON.parse(
        execFileSync(process.execPath, ['--input-type=module', '-e', script], {
          input: JSON.stringify(options),
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            HOME: '/synthetic/home',
            USERPROFILE: '/synthetic/home',
            NANGO_ENCRYPTION_KEY: 'synthetic-server-secret',
            MCP_API_KEY: 'synthetic-override-secret',
          },
        })
      );
      expect(result.env.CODEX_API_KEY).toBe('synthetic-model-key');
      expect(result.env.DO_NOT_TRACK).toBe('1');
      expect(result.env).not.toHaveProperty('NANGO_ENCRYPTION_KEY');
      expect(result.env).not.toHaveProperty('MCP_API_KEY');
      expect(JSON.stringify(result.args)).not.toContain('synthetic-model-key');
      expect(JSON.stringify(result.args)).not.toContain('synthetic-server-secret');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
