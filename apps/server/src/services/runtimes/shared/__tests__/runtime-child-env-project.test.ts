/**
 * The project `.env` file can't change how DorkOS or its agents run
 * (DOR-5481): a project value reaches none of the turn kinds, however the
 * runtime's allow list reads, and its `DO_NOT_TRACK` still turns telemetry off.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SENTINEL = 'project-sentinel-5481';
/** Names on the runtimes' allow lists that the real environment leaves unset here. */
const PROJECT_NAMES = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'OPENAI_BASE_URL',
  'HTTPS_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'GIT_SSH_COMMAND',
  'GIT_CONFIG_GLOBAL',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'OPENCODE_CONFIG',
  'AWS_ACCESS_KEY_ID',
  'PROJECT_OWN_VARIABLE',
];

/** The CLI's loader, from its source. */
const CLI_LOADER = new URL(
  '../../../../../../../packages/cli/src/lib/project-env.ts',
  import.meta.url
).href;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-runtime-project-env-'));
  for (const name of [
    ...PROJECT_NAMES,
    'CLAUDE_CODE_USE_BEDROCK',
    'DO_NOT_TRACK',
    'DORKOS_TELEMETRY_DISABLED',
  ])
    vi.stubEnv(name, undefined);
  fs.writeFileSync(
    path.join(dir, '.env'),
    [
      ...PROJECT_NAMES.map((name) => `${name}=${SENTINEL}`),
      'CLAUDE_CODE_USE_BEDROCK=1',
      'DO_NOT_TRACK=1',
    ].join('\n')
  );
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Load the project `.env` the way the CLI does, then import the server side fresh. */
async function loadThenImport() {
  const { loadProjectEnv } = (await import(CLI_LOADER)) as {
    loadProjectEnv: (dir: string, warn: (message: string) => void) => unknown;
  };
  loadProjectEnv(dir, () => undefined);
  return import('../runtime-environment-config.js');
}

describe('a project .env and the runtimes', () => {
  it('reaches none of the five turn kinds, and leaves process.env alone', async () => {
    const { childEnvironment } = await loadThenImport();
    expect(Object.values(process.env)).not.toContain(SENTINEL);
    const kinds = {
      'claude-code': childEnvironment('claude-code'),
      codex: childEnvironment('codex'),
      opencode: childEnvironment('opencode'),
      doe: childEnvironment('doe'),
      'runtime-login (claude-code)': childEnvironment('runtime-login', 'claude-code'),
      'runtime-login (codex)': childEnvironment('runtime-login', 'codex'),
    };
    for (const [kind, env] of Object.entries(kinds)) {
      expect(JSON.stringify(env), kind).not.toContain(SENTINEL);
      for (const name of PROJECT_NAMES) expect(env, `${kind} ${name}`).not.toHaveProperty(name);
      // A project's Bedrock switch turns on no profile.
      expect(env, kind).not.toHaveProperty('CLAUDE_CODE_USE_BEDROCK');
    }
  });

  it('still turns telemetry off for every runtime child and for the server', async () => {
    const { childEnvironment } = await loadThenImport();
    for (const runtime of ['claude-code', 'codex', 'opencode', 'doe'] as const)
      expect(childEnvironment(runtime, 'warmup'), runtime).toMatchObject({
        DO_NOT_TRACK: '1',
      });
    const { env } = await import('../../../../env.js');
    expect(env.DO_NOT_TRACK).toBe('1');
    expect(process.env.DO_NOT_TRACK).toBeUndefined();
  });

  it('reaches no agent shell: OpenCode’s tools inherit the sidecar’s env', async () => {
    await loadThenImport();
    const { buildSidecarSpawnEnv } = await import('../../opencode/server-manager.js');
    const { OPENCODE_OWN_PLAN } = await import('../../opencode/credits-sidecar.js');
    const sidecar = buildSidecarSpawnEnv(OPENCODE_OWN_PLAN, 'fixture-password', {});
    expect(JSON.stringify(sidecar)).not.toContain(SENTINEL);
    for (const name of PROJECT_NAMES) expect(sidecar, name).not.toHaveProperty(name);
  });

  it('reaches no agent shell: Doe’s builder shell runs with the Doe turn projection', async () => {
    const { childEnvironment } = await loadThenImport();
    // The builder shell spawns with exactly the policy env this call builds.
    const source = fs.readFileSync(new URL('../../doe/execute-turn.ts', import.meta.url), 'utf8');
    expect(source).toMatch(
      /builderExecutionPolicy: \{[\s\S]*?environment: childEnvironment\('doe', 'turn',/
    );
    const builder = childEnvironment('doe', 'turn', { DORKOS_SESSION_ID: 'fixture-session' });
    expect(JSON.stringify(builder)).not.toContain(SENTINEL);
  });
});
