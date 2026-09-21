import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const cli = require.resolve('@playwright/test/cli');
const timingModule = resolve(here, '../setup-timing.ts');

describe('global setup timing in real Playwright reports', () => {
  it.each(['passed', 'failed', 'interrupted'] as const)(
    'preserves setup boundaries when %s',
    (outcome) => {
      // Under this package so the isolated fixture resolves its own Playwright install.
      const fixture = mkdtempSync(resolve(here, '../.timing-proof-'));
      try {
        writeFileSync(
          join(fixture, 'server.cjs'),
          "require('node:http').createServer().listen(0, '127.0.0.1', () => console.log('TIMING_READY'));\n"
        );
        writeFileSync(
          join(fixture, 'setup.ts'),
          `
        import { measureGlobalSetup } from ${JSON.stringify(timingModule)};
        export default async function setup(config) {
          await measureGlobalSetup(config, async () => {
            ${outcome === 'failed' ? "throw new Error('intentional setup failure');" : outcome === 'interrupted' ? 'await new Promise(() => {});' : 'await Promise.resolve();'}
          });
        }
      `
        );
        writeFileSync(
          join(fixture, 'proof.spec.ts'),
          `
        import { test, expect } from '@playwright/test';
        test('runner proof needs no browser', () => expect(true).toBe(true));
      `
        );
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        writeFileSync(
          join(fixture, 'playwright.config.ts'),
          `
        export default {
          testDir: '.', testMatch: 'proof.spec.ts', workers: 1, retries: 0,
          globalTimeout: ${outcome === 'interrupted' ? 2000 : 10000},
          globalSetup: './setup.ts', metadata: { retained: 'existing metadata' },
          reporter: [['json', { outputFile: './results.json' }]],
          webServer: {
            command: ${JSON.stringify(`${quote(process.execPath)} server.cjs`)},
            cwd: ${JSON.stringify(fixture)}, wait: { stdout: /TIMING_READY/ },
            timeout: 10000,
          },
        };
      `
        );
        const result = spawnSync(
          process.execPath,
          [cli, 'test', '--config', 'playwright.config.ts'],
          {
            cwd: fixture,
            encoding: 'utf8',
            timeout: 20_000,
            // This tiny runner loads no app, auth, inference, or user configuration.
            env: { PATH: process.env.PATH, HOME: fixture, CI: '1' },
          }
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(outcome === 'passed' ? 0 : 1);
        const report = JSON.parse(readFileSync(join(fixture, 'results.json'), 'utf8'));
        const timing = report.config.metadata.globalSetupTiming;
        expect(report.config.metadata.retained).toBe('existing metadata');
        expect(timing.status).toBe(outcome === 'interrupted' ? 'running' : outcome);
        expect(Date.parse(timing.startedAt)).toBeGreaterThanOrEqual(
          Date.parse(report.stats.startTime)
        );
        if (outcome === 'interrupted') {
          expect(timing.finishedAt).toBeUndefined();
          expect(timing.durationMs).toBeUndefined();
          expect(report.errors.length).toBeGreaterThan(0);
          expect(report.stats.expected).toBe(0);
          return;
        }
        expect(Date.parse(timing.finishedAt)).toBeGreaterThanOrEqual(Date.parse(timing.startedAt));
        expect(timing.durationMs).toBeGreaterThanOrEqual(0);
        if (outcome === 'failed') {
          expect(
            report.errors.some((error: { message: string }) =>
              error.message.includes('intentional setup failure')
            )
          ).toBe(true);
          expect(report.stats.expected).toBe(0);
        } else {
          expect(report.errors).toEqual([]);
          expect(report.stats.expected).toBe(1);
          const first = report.suites[0].specs[0].tests[0].results[0];
          expect(Date.parse(first.startTime)).toBeGreaterThanOrEqual(Date.parse(timing.finishedAt));
        }
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
    30_000
  );
});
