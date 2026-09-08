import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { projectRuntimeEnvironment } from '../../shared/runtime-environment.js';

const sdkPath = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');

describe('installed Claude SDK environment boundary', () => {
  it('hands the actual spawn hook the complete projection without ambient secrets', () => {
    const env = projectRuntimeEnvironment({
      parent: {
        HOME: '/synthetic/home',
        USERPROFILE: '/synthetic/home',
        DO_NOT_TRACK: '1',
        ANTHROPIC_API_KEY: 'synthetic-model-key',
        NANGO_ENCRYPTION_KEY: 'synthetic-nango',
        MCP_API_KEY: 'synthetic-mcp',
      },
      runtime: 'claude-code',
      purpose: 'turn',
    });
    const script = `
      import fs from 'node:fs';
      const env = JSON.parse(fs.readFileSync(0, 'utf8'));
      const { query } = await import(${JSON.stringify(pathToFileURL(sdkPath).href)});
      let captured; let q;
      try {
        q = query({ prompt: 'synthetic', options: {
          env, settingSources: [], pathToClaudeCodeExecutable: '/synthetic/claude',
          spawnClaudeCodeProcess: (options) => {
            captured = { env: options.env, args: options.args };
            throw new Error('synthetic spawn intercepted');
          }
        }});
        await q.next();
      } catch {} finally { q?.close(); }
      if (!captured) process.exit(2);
      process.stdout.write(JSON.stringify(captured));
    `;
    const captured = JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        input: JSON.stringify(env),
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          HOME: '/synthetic/home',
          USERPROFILE: '/synthetic/home',
          NANGO_ENCRYPTION_KEY: 'synthetic-nango',
          MCP_API_KEY: 'synthetic-mcp',
        },
      })
    );
    expect(captured.env.ANTHROPIC_API_KEY).toBe('synthetic-model-key');
    expect(captured.env.DO_NOT_TRACK).toBe('1');
    expect(captured.env).not.toHaveProperty('NANGO_ENCRYPTION_KEY');
    expect(captured.env).not.toHaveProperty('MCP_API_KEY');
    expect(JSON.stringify(captured.args)).not.toContain('synthetic-model-key');
  });
  it('preserves universal opt-out according to the installed SDK telemetry predicate', () => {
    const source = readFileSync(sdkPath, 'utf8');
    const predicate = source.match(
      /function ([\w$]+)\(\)\{if\(process\.env\.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC\)[^}]+process\.env\.DO_NOT_TRACK[^}]+\}/
    )?.[0];
    expect(predicate).toBeDefined();
    const booleanName = predicate!.match(/if\(([\w$]+)\(process\.env\.DO_NOT_TRACK/)![1];
    const booleanFunction = source.match(
      new RegExp(`function ${booleanName}\\([^)]*\\)\\{[^}]+\\}`)
    )?.[0];
    expect(booleanFunction).toBeDefined();
    const name = predicate!.match(/function ([\w$]+)/)![1];
    const env = projectRuntimeEnvironment({
      parent: { DO_NOT_TRACK: '1' },
      runtime: 'claude-code',
      purpose: 'warmup',
    });
    const evaluate = (environment: Record<string, string>) =>
      runInNewContext(
        `${booleanFunction};${predicate};${name}()`,
        { process: { env: environment } },
        { timeout: 1000 }
      );
    expect(evaluate({})).toBe('default');
    expect(evaluate(env)).toBe('no-telemetry');
  });
});
