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
 * `process.env` — and the `os.homedir()` that env resolves to — to a file and
 * exits, which is the only way to prove what the child received rather than what
 * the builder intended.
 *
 * `os.homedir()` is reported alongside the variables rather than inferred from
 * them because it is the value that actually matters: the server's Claude root
 * set unions in `~/.claude` unconditionally, so the sandboxed server's history
 * isolation rests on where the CHILD's `~` lands, not on which variable the
 * launcher happened to write (DOR-1779).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChildProcessLauncher } from '../child-process-launcher.js';

let root: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

/** What a launched child reported about the environment it was actually given. */
interface ChildView {
  /** The child's `process.env`. */
  env: Record<string, string>;
  /** What `os.homedir()` answers inside the child — the `~` its reads resolve. */
  homedir: string;
  /** The sandbox root this launch was pointed at (the parent of `DORK_HOME`). */
  sandboxRoot: string;
}

/**
 * Launch a fake "server" that writes its environment (and its resolved home) to
 * a file, and return what the child process actually saw.
 *
 * @param specEnv - The `spec.env` a case/credential would contribute.
 * @param opts.claudeConfigDir - The controlled config dir, when the run pinned one.
 * @returns The child's view of its own environment.
 */
async function envSeenByChild(
  specEnv: Record<string, string>,
  opts: { claudeConfigDir?: string } = {}
): Promise<ChildView> {
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
      'require("fs").writeFileSync(process.argv[1], JSON.stringify({ env: process.env, homedir: require("os").homedir() })); process.exit(0);',
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

  const reported = JSON.parse(await readFile(outFile, 'utf8')) as Omit<ChildView, 'sandboxRoot'>;
  return { ...reported, sandboxRoot };
}

describe('ChildProcessLauncher environment', () => {
  it('pins the sandbox boundary and home, and a case`s serverEnv cannot override them', async () => {
    const { env } = await envSeenByChild({
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
    const { env } = await envSeenByChild({
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
    const { env } = await envSeenByChild({ DORKOS_TEST_RUNTIME: 'true' });
    expect(env.DORKOS_TEST_RUNTIME).toBeUndefined();
    expect(env.DORKOS_TEST_RUNTIME_SECONDARY).toBeUndefined();
  });

  it('inherits PATH from the parent, which is how the local `claude` sign-in reaches the child', async () => {
    const { env } = await envSeenByChild({});
    // The whole local-credential path depends on this inheritance.
    expect(env.PATH).toBeTruthy();
  });

  it('pins CLAUDE_CONFIG_DIR to the sandbox, so a turn reads no user-level config of the operator`s', async () => {
    const sandboxConfigDir = '/private/var/folders/xy/dorkos-evals-AbC123/.claude';
    // Exactly the shape of the confound: the operator's own directory arrives on
    // the inherited environment AND a case tries to name one of its own.
    const { env } = await envSeenByChild(
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
    const { env } = await envSeenByChild({ CLAUDE_CONFIG_DIR: '/Users/someone/.claude2' });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/someone/.claude2');
  });
});

/**
 * The other half of the same pin (DOR-1779).
 *
 * `CLAUDE_CONFIG_DIR` answers what the MODEL reads. It does not answer what the
 * SERVER enumerates: `resolveClaudeRootSet()` keeps `~/.claude` in its union
 * unconditionally, so a sandboxed server pinned to a controlled config dir still
 * indexed, listed and searched the operator's real transcripts — measured before
 * this fix by booting the real server through this launcher against a fake
 * operator home and finding that home's private messages returned by the
 * sandbox's own `GET /api/search`.
 *
 * These assert the resolved `os.homedir()` of a real child, not just the
 * variable, because that is the value the union is built from — and because
 * which variable carries it is platform-dependent (`HOME` on POSIX,
 * `USERPROFILE` on Windows) while the resolved home is not.
 */
describe('ChildProcessLauncher home isolation', () => {
  /** A stand-in for the operator's real home, inherited by the launching process. */
  const OPERATOR_HOME = '/Users/someone';

  it('moves the child`s ~ onto the sandbox root when the run pinned a config dir', async () => {
    vi.stubEnv('HOME', OPERATOR_HOME);
    vi.stubEnv('USERPROFILE', OPERATOR_HOME);

    const { env, homedir, sandboxRoot } = await envSeenByChild(
      {},
      { claudeConfigDir: path.join('/private/var/folders/xy/dorkos-evals-AbC123', '.claude') }
    );

    // The claim, stated as the server resolves it rather than as the launcher
    // writes it: this child's `~` is the throwaway sandbox, so every candidate
    // in the root-set union lands inside a directory the eval owns.
    expect(homedir).toBe(sandboxRoot);
    expect(homedir).not.toBe(OPERATOR_HOME);
    // Both spellings are written, so the answer above holds on either platform.
    expect(env.HOME).toBe(sandboxRoot);
    expect(env.USERPROFILE).toBe(sandboxRoot);
    // The home stays INSIDE the server's own filesystem boundary. A server whose
    // `~` sits outside the tree it may read is incoherent, and it is what made
    // the leak invisible: DORK_HOME moved, the home it is named after did not.
    expect(env.DORKOS_BOUNDARY).toBe(sandboxRoot);
  });

  it('leaves the operator`s home alone when the run declined to pin a config dir', async () => {
    // The keychain row. A macOS `claude auth login` names its Keychain entry
    // after the config directory and is reached through that home, so the run
    // that keeps `CLAUDE_CONFIG_DIR` must keep `HOME` too — taking the home away
    // here would sign the run out while claiming to have taken nothing away.
    vi.stubEnv('HOME', OPERATOR_HOME);
    vi.stubEnv('USERPROFILE', OPERATOR_HOME);

    const { env, homedir, sandboxRoot } = await envSeenByChild({});

    expect(homedir).toBe(OPERATOR_HOME);
    expect(env.HOME).toBe(OPERATOR_HOME);
    expect(homedir).not.toBe(sandboxRoot);
  });

  it('does not let a case`s serverEnv put the child`s ~ back on the operator', async () => {
    // `HOME` is a placement variable like `DORK_HOME` and `DORKOS_BOUNDARY`: the
    // harness's to set, never a case's to reclaim.
    const { env, homedir, sandboxRoot } = await envSeenByChild(
      { HOME: OPERATOR_HOME, USERPROFILE: OPERATOR_HOME },
      { claudeConfigDir: '/private/var/folders/xy/dorkos-evals-AbC123/.claude' }
    );

    expect(homedir).toBe(sandboxRoot);
    expect(env.HOME).not.toBe(OPERATOR_HOME);
  });
});
