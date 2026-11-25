/**
 * @vitest-environment node
 *
 * The free live OpenCode run can reach only a local model (DOR-4754). Offline:
 * no binary, no model, no network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOSTED_INPUTS, prepareFreeLocalRun, readLiveMode } from './free-local-run.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-free-local-'));
  homes.push(home);
  return home;
}

/** A machine whose own setup names hosted models and keys everywhere it can. */
function hostedMachine(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DORKOS_OPENCODE_LIVE: '1',
    OPENROUTER_API_KEY: 'sk-or-made-up',
    ANTHROPIC_API_KEY: 'sk-ant-made-up',
    OPENAI_API_KEY: 'sk-made-up',
    OPENAI_BASE_URL: 'https://api.example.com/v1',
    OPENCODE_CONFIG: '/Users/someone/.config/opencode/opencode.json',
    OPENCODE_CONFIG_DIR: '/Users/someone/.config/opencode',
    XDG_CONFIG_HOME: '/Users/someone/.config',
    XDG_DATA_HOME: '/Users/someone/.local/share',
    ...extra,
  };
}

describe('free OpenCode live run', () => {
  it('reaches only the local model, with no hosted key, login or config left', () => {
    const home = tempHome();
    const env = hostedMachine({ DORKOS_OPENCODE_LOCAL_MODEL: 'qwen2.5-coder:7b' });
    prepareFreeLocalRun(env, home);

    for (const name of HOSTED_INPUTS) expect(env[name]).toBeUndefined();
    // OpenCode reads its own config and stored logins from these folders.
    for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
      expect(env[name]!.startsWith(home)).toBe(true);
    }
    expect(env.OPENCODE_CONFIG!.startsWith(home)).toBe(true);
    expect(JSON.parse(fs.readFileSync(env.OPENCODE_CONFIG!, 'utf8'))).toEqual({
      enabled_providers: ['dorkos-local'],
      provider: {
        'dorkos-local': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Local model',
          options: { baseURL: 'http://127.0.0.1:11434/v1' },
          models: { 'qwen2.5-coder:7b': { limit: { context: 32_768, output: 4096 } } },
        },
      },
      model: 'dorkos-local/qwen2.5-coder:7b',
      small_model: 'dorkos-local/qwen2.5-coder:7b',
    });
  });

  it.each([
    ['no model is named', {}],
    ['the address is hosted', { DORKOS_OPENCODE_LOCAL_URL: 'https://openrouter.ai/api/v1' }],
    ['the address only looks local', { DORKOS_OPENCODE_LOCAL_URL: 'http://127.0.0.1.example.com' }],
    ['the address is not one', { DORKOS_OPENCODE_LOCAL_URL: 'not a url' }],
    ['the window is not a number', { DORKOS_OPENCODE_LOCAL_CONTEXT: 'big' }],
  ])('stops before anything changes when %s', (_label, extra) => {
    const model = Object.keys(extra).length > 0 ? { DORKOS_OPENCODE_LOCAL_MODEL: 'm' } : {};
    const env = hostedMachine({ ...model, ...extra });
    const before = { ...env };
    expect(() => prepareFreeLocalRun(env, tempHome())).toThrow();
    expect(env).toEqual(before);
  });

  it('keeps the paid arm behind its own flag and key, and never with the free one', () => {
    expect(readLiveMode({})).toEqual({ free: false, paid: false, live: false });
    expect(readLiveMode({ OPENROUTER_API_KEY: 'k' }).live).toBe(false);
    expect(() => readLiveMode({ DORKOS_OPENCODE_LIVE_PAID: '1' })).toThrow(/OPENROUTER_API_KEY/);
    expect(() =>
      readLiveMode({
        DORKOS_OPENCODE_LIVE: '1',
        DORKOS_OPENCODE_LIVE_PAID: '1',
        OPENROUTER_API_KEY: 'k',
      })
    ).toThrow(/Pick one/);
  });
});
