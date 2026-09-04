/**
 * What the child-process tier ACTUALLY puts in the launched server's
 * environment, observed from a real spawned process rather than from reading
 * `buildEnv`.
 *
 * The four placement variables (`DORK_HOME`, `DORKOS_BOUNDARY`, `DORKOS_HOST`,
 * `DORKOS_PORT`) decide where the server lives and what filesystem it may touch,
 * so they are the harness's to set and must survive anything a case asks for.
 * `spec.env` carries `evalCase.serverEnv`, which means the losing ordering was
 * reachable from a case declaration: `serverEnv: { DORKOS_BOUNDARY: '/' }` once
 * won outright, pointing a real model-driven server at the whole filesystem
 * including the developer's own `~/.dork`. The docker tier already ordered these
 * the safe way; this pins the two tiers to the same answer.
 *
 * The launcher is driven for real. `nodeExecPath` + `execArgv` + `serverEntry`
 * are all injectable, so the "server" here is a one-liner that dumps its own
 * `process.env` to a file and exits — which is the only way to prove what the
 * child received rather than what the builder intended.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChildProcessLauncher } from '../child-process-launcher.js';

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

/**
 * Launch a fake "server" that writes its environment to a file, and return what
 * the child process actually saw.
 *
 * @param specEnv - The `spec.env` a case/credential would contribute.
 * @returns The child's environment.
 */
async function envSeenByChild(
  specEnv: Record<string, string>,
  opts: { claudeConfigDir?: string } = {}
): Promise<Record<string, string>> {
  root = await mkdtemp(path.join(tmpdir(), 'evals-cpl-'));
  const sandboxRoot = path.join(root, 'sandbox');
  const dorkHome = path.join(sandboxRoot, '.dork');
  await mkdir(dorkHome, { recursive: true });

  // `serverEntry` is the last argv entry, so it arrives as `process.argv[1]` —
  // used here as the output path, which keeps the fake server a single literal.
  const outFile = path.join(root, 'env.json');
  const launcher = new ChildProcessLauncher({
    nodeExecPath: process.execPath,
    execArgv: [
      '-e',
      'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.env)); process.exit(0);',
    ],
    serverEntry: outFile,
  });

  const launched = await launcher.launch({
    dorkHome,
    ...(opts.claudeConfigDir !== undefined ? { claudeConfigDir: opts.claudeConfigDir } : {}),
    host: '127.0.0.1',
    port: 54321,
    env: specEnv,
  });
  await launched.exited;

  return JSON.parse(await readFile(outFile, 'utf8')) as Record<string, string>;
}

describe('ChildProcessLauncher environment', () => {
  it('pins the sandbox boundary and home, and a case`s serverEnv cannot override them', async () => {
    const env = await envSeenByChild({
      // Exactly the shape a malicious or careless `evalCase.serverEnv` would have.
      DORKOS_BOUNDARY: '/',
      DORK_HOME: '/Users/someone/.dork',
      DORKOS_HOST: '0.0.0.0',
      DORKOS_PORT: '4242',
    });

    // The sandbox root is the parent of dorkHome; both must be inside the
    // throwaway directory this eval owns, never the operator's real home.
    expect(env.DORKOS_BOUNDARY).toBe(path.join(root ?? '', 'sandbox'));
    expect(env.DORK_HOME).toBe(path.join(root ?? '', 'sandbox', '.dork'));
    expect(env.DORKOS_HOST).toBe('127.0.0.1');
    expect(env.DORKOS_PORT).toBe('54321');
    expect(env.DORKOS_BOUNDARY).not.toBe('/');
  });

  it('still lets a case override its own server env (credentials, model, feature flags)', async () => {
    const env = await envSeenByChild({
      ANTHROPIC_MODEL: 'claude-haiku-4-5',
      ANTHROPIC_API_KEY: 'sk-test',
      // A real case knob: the approval-expiry governance case shortens the
      // decision window this way.
      DORKOS_APPROVAL_TTL_MS: '5000',
    });

    // Only the four placement variables are the harness's; everything else is
    // exactly what a case needs `serverEnv` for.
    expect(env.ANTHROPIC_MODEL).toBe('claude-haiku-4-5');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(env.DORKOS_APPROVAL_TTL_MS).toBe('5000');
  });

  it('strips the harness`s own test-mode flags so a credentialed boot never inherits them', async () => {
    const env = await envSeenByChild({ DORKOS_TEST_RUNTIME: 'true' });
    expect(env.DORKOS_TEST_RUNTIME).toBeUndefined();
    expect(env.DORKOS_TEST_RUNTIME_SECONDARY).toBeUndefined();
  });

  it('inherits PATH from the parent, which is how the local `claude` sign-in reaches the child', async () => {
    const env = await envSeenByChild({});
    // The whole local-credential path depends on this inheritance.
    expect(env.PATH).toBeTruthy();
  });

  it('pins CLAUDE_CONFIG_DIR to the sandbox, so a turn reads no user-level config of the operator`s', async () => {
    const sandboxConfigDir = '/private/var/folders/xy/dorkos-evals-AbC123/.claude';
    // Exactly the shape of the confound: the operator's own directory arrives on
    // the inherited environment AND a case tries to name one of its own.
    const env = await envSeenByChild(
      { CLAUDE_CONFIG_DIR: '/Users/someone/.claude2' },
      { claudeConfigDir: sandboxConfigDir }
    );

    expect(env.CLAUDE_CONFIG_DIR).toBe(sandboxConfigDir);
    // `settingSources` includes `'user'`, which resolves under this directory —
    // so this variable, not DORK_HOME, is what decides whether a measured turn
    // read the operator's CLAUDE.md, settings and skills (DOR-1712).
    expect(env.CLAUDE_CONFIG_DIR).not.toBe('/Users/someone/.claude2');
  });

  it('leaves an inherited CLAUDE_CONFIG_DIR alone when the run declined to pin one', async () => {
    // Declining is what a keychain-authenticated local sign-in gets: that exact
    // directory IS the credential, so erasing the variable here would sign the
    // run out — the failure this fix must not cause while removing a confound.
    const env = await envSeenByChild({ CLAUDE_CONFIG_DIR: '/Users/someone/.claude2' });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/someone/.claude2');
  });
});
