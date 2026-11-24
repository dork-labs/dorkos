import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  devChildAt,
  getChildProcessMock,
  getElectronMock,
  startReadyServer,
  startupError,
  stubPackagedPaths,
  useServerProcessHarness,
  utilityChildAt,
} from './server-process.fixtures';
import type { MockServerProcess } from './server-child-mock';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-log', () => import('./electron-log-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

useServerProcessHarness();

describe('the environment handed to the server child', () => {
  /**
   * A DORK_HOME the *test process* exports, so these assertions are about what
   * `buildServerEnv` contributes rather than about the developer's shell. The
   * child inherits `process.env` wholesale, so asserting "undefined" here
   * would go red for anyone who has DORK_HOME set.
   */
  const INHERITED_DORK_HOME = '/tmp/dor-533-inherited-dork-home';

  beforeEach(() => {
    vi.stubEnv('DORK_HOME', INHERITED_DORK_HOME);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('hands the child the port the resolver chose, not one the OS picked', async () => {
    // The end-to-end half of `server-port.test.ts`: whatever
    // `resolvePreferredPort` settles on has to reach `DORKOS_PORT`. Driven
    // through DORKOS_PORT (the top of that precedence) so the assertion does
    // not depend on 4242 being free on the machine running the suite.
    const { findAvailablePort } = await import('../server-port');
    const asked = await findAvailablePort(45_678, 20);
    vi.stubEnv('DORKOS_PORT', String(asked));
    const { startServer } = await import('../server-process');

    const { port, child } = await startReadyServer(startServer);

    expect(port).toBe(asked);
    expect(child.env.DORKOS_PORT).toBe(String(asked));
  });

  it("puts the server's refusal to share a data directory in front of the user", async () => {
    // The argument this whole design rests on: the port scan is silent, so the
    // one start-up conflict a person is ever shown is the one that actually
    // stopped them — the single-instance lock (ADR 260726-234122), in the
    // server's own words. That only holds if the relay works end to end, from
    // the child's stderr to the dialog `index.ts` raises.
    const { startServer } = await import('../server-process');

    const started = startServer();
    const child = await devChildAt(0);
    for (const line of [
      'Another DorkOS instance is already using this data directory (/Users/kai/.dork).',
      'It is running as process 8123 on port 4242 (DorkOS 0.56.0).',
      'Stop it first (`kill 8123`), or start this one against a different directory.',
    ]) {
      child.emitStderr(line);
    }
    child.emitExit(1);

    const message = (await startupError(started)).message;
    // `~/.dork`, not `/Users/kai/.dork`: the tail abbreviates home paths on its
    // way to a dialog someone may screenshot. The actionable part survives.
    expect(message).toContain('already using this data directory (~/.dork)');
    expect(message).toContain('process 8123 on port 4242');
    expect(message).toContain('kill 8123');
    // Nothing in the relay may reframe it as a port problem: this conflict is
    // about the directory, and the two stories must not compete.
    expect(message).not.toMatch(/next free port|will not quietly move/i);
  });

  it('marks the server as desktop-managed so it refuses to restart itself', async () => {
    const { startServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);

    expect(child.env.DORKOS_MANAGED_BY).toBe('desktop');
  });

  it('binds the server to the host the shell dials, whatever the shell inherited (DOR-4294)', async () => {
    // An inherited DORKOS_HOST (a dev `.env`, a shell export) would move the
    // server off the host the event stream and Ask answers dial.
    vi.stubEnv('DORKOS_HOST', '0.0.0.0');
    const { startServer } = await import('../server-process');
    const { SERVER_BIND_HOST } = await import('../../shared/server-address');

    const { child } = await startReadyServer(startServer);

    expect(child.env.DORKOS_HOST).toBe(SERVER_BIND_HOST);
  });

  it('leaves DORK_HOME alone in dev, so the child picks its own dev data dir (M3)', async () => {
    const { startServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);

    // Overriding DORK_HOME in dev pointed the dev build at the production
    // ~/.dork and applied unreleased migrations to it. Whatever the
    // environment already said is passed through untouched.
    expect(child.env.DORK_HOME).toBe(INHERITED_DORK_HOME);
    expect(child.env.NODE_ENV).toBe('development');
  });

  it('hands the dev child this process id to watch, and no pid when packaged', async () => {
    const { startServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);

    // The child cannot derive this itself — tsx runs it as a grandchild, so
    // its own ppid is the tsx wrapper. See server-entry.ts's exitWhenOrphaned.
    expect(child.env.DORKOS_PARENT_PID).toBe(String(process.pid));
    // DOR-552: rides alongside the pid so the watchdog can corroborate it
    // against a recycled pid instead of trusting a bare liveness check
    // forever. Captured at spawn time (this test's own process is a real,
    // running one `ps` can see), not asserted to a specific value — only
    // that it's present and parses.
    expect(child.env.DORKOS_PARENT_STARTED_AT).toBeDefined();
    expect(Number.isNaN(Date.parse(child.env.DORKOS_PARENT_STARTED_AT as string))).toBe(false);
  });

  it('pins DORK_HOME to ~/.dork in a packaged build, spawned as a UtilityProcess', async () => {
    const restorePaths = stubPackagedPaths();
    try {
      const { app, utilityProcess } = await getElectronMock();
      app.isPackaged = true;
      const { startServer } = await import('../server-process');

      const started = startServer();
      const child = await utilityChildAt(0);
      child.emitReady();
      await started;

      expect(utilityProcess.fork).toHaveBeenCalledTimes(1);
      expect(child.env.DORK_HOME).toBe(join(app.getPath('home'), '.dork'));
      expect(child.env.NODE_ENV).toBe('production');
      expect(child.env.DORKOS_MANAGED_BY).toBe('desktop');
      // The server turns this into the Mac or Windows app for agents.
      expect(child.env.DORKOS_DISTRIBUTION).toBe('desktop');
      expect(child.env.DORKOS_DESKTOP_VERSION).toBe('0.1.0');
      // Electron tears a UtilityProcess down with the app; no watchdog needed.
      expect(child.env.DORKOS_PARENT_PID).toBeUndefined();
      expect(child.env.DORKOS_PARENT_STARTED_AT).toBeUndefined();
    } finally {
      restorePaths();
    }
  });

  it('never hands an exported CA variable to the packaged server, so no agent inherits it (DOR-3361)', async () => {
    const restorePaths = stubPackagedPaths();
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '/tmp/planted-ca.pem');
    vi.stubEnv('SSL_CERT_FILE', '/tmp/planted-ca.pem');
    try {
      const { app } = await getElectronMock();
      app.isPackaged = true;
      const { startServer } = await import('../server-process');

      const started = startServer();
      const child = await utilityChildAt(0);
      child.emitReady();
      await started;

      expect(child.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
      expect(child.env.SSL_CERT_FILE).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      restorePaths();
    }
  });
});

describe('what a packaged server child is told about the machine it runs on', () => {
  /**
   * A throwaway `.app` payload: a home directory the app pretends to own, and
   * a `Contents/Resources` tree with the unpacked binaries a real build ships.
   *
   * Real files, because every path under test is guarded by an `existsSync` —
   * the whole point of handing the server these paths is that they are files
   * that actually exist, and a stub could only ever agree with itself.
   */
  let home: string;
  let resources: string;
  let restorePaths: () => void;

  /** Where the packaged esbuild binary lives for the platform running the suite. */
  function esbuildBinaryPath(): string {
    const leaf = process.platform === 'win32' ? ['esbuild.exe'] : ['bin', 'esbuild'];
    return join(
      resources,
      'app.asar.unpacked',
      'node_modules',
      '@esbuild',
      `${process.platform}-${process.arch}`,
      ...leaf
    );
  }

  beforeEach(async () => {
    // Canonicalized: the working-directory resolver returns realpaths (it has
    // to, because the server's boundary check compares canonical paths), and
    // macOS hands out temp directories under `/var`, which is a symlink to
    // `/private/var`. Realpathing the fixture keeps these assertions about the
    // shell rather than about that symlink.
    home = realpathSync(mkdtempSync(join(tmpdir(), 'dorkos-packaged-home-')));
    mkdirSync(join(home, '.dork'), { recursive: true });
    resources = mkdtempSync(join(tmpdir(), 'dorkos-packaged-resources-'));
    mkdirSync(dirname(esbuildBinaryPath()), { recursive: true });
    writeFileSync(esbuildBinaryPath(), '#!/bin/sh\n', 'utf8');
    restorePaths = stubPackagedPaths(resources);
    // Unset, not blank: both now steer the resolver, and a blank one would
    // still be spread into the child's environment by `...process.env`.
    vi.stubEnv('DORKOS_DEFAULT_CWD', undefined);
    vi.stubEnv('DORKOS_BOUNDARY', undefined);

    const { app } = await getElectronMock();
    app.isPackaged = true;
    app.getPath = vi.fn(() => home);
  });

  afterEach(() => {
    restorePaths();
    rmSync(home, { recursive: true, force: true });
    rmSync(resources, { recursive: true, force: true });
  });

  /** Start a packaged server and hand back the child it forked. */
  async function startPackagedServer(): Promise<MockServerProcess> {
    const { startServer } = await import('../server-process');
    const started = startServer();
    const child = await utilityChildAt(0);
    child.emitReady();
    await started;
    return child;
  }

  it('opens in the home directory, and starts the process there too', async () => {
    // Left unset, the server derived its default working directory from its own
    // file location — `…/DorkOS.app/Contents/Resources`, outside the boundary —
    // so every boot logged "Access denied: path outside directory boundary" and
    // the session list came up empty (DOR-1335). `process.cwd()` was no better:
    // a Finder-launched app inherits `/`.
    const child = await startPackagedServer();

    expect(child.env.DORKOS_DEFAULT_CWD).toBe(home);
    expect(child.options.cwd).toBe(home);
    // The server defaults the boundary to home on its own; saying so here would
    // turn its default into a setting somebody made.
    expect(child.env.DORKOS_BOUNDARY).toBeUndefined();
  });

  it('honours server.cwd from config.json, and passes a configured boundary through', async () => {
    const projects = join(home, 'projects');
    mkdirSync(projects);
    writeFileSync(
      join(home, '.dork', 'config.json'),
      JSON.stringify({ server: { cwd: projects, boundary: home } }),
      'utf8'
    );

    const child = await startPackagedServer();

    expect(child.env.DORKOS_DEFAULT_CWD).toBe(projects);
    expect(child.options.cwd).toBe(projects);
    expect(child.env.DORKOS_BOUNDARY).toBe(home);
  });

  it('hands over the login-shell PATH, not the four directories launchd gave it', async () => {
    const { spawnSync } = await getChildProcessMock();
    const { LOGIN_SHELL_PATH_MARKER } = await import('../../shared/login-shell-path');
    const loginPath = `${home}/.local/bin:/opt/homebrew/bin:/usr/bin:/bin`;
    // The probe asks the shell for its whole `env`, so the answer is a dump
    // with the PATH one line among several — see PROBE_SCRIPT in shell-path.ts.
    const dump = `SHLVL=1\nPATH=${loginPath}\nHOME=${home}\n`;
    spawnSync.mockReturnValue({
      status: 0,
      signal: null,
      stdout: `${LOGIN_SHELL_PATH_MARKER}${dump}${LOGIN_SHELL_PATH_MARKER}`,
      stderr: '',
    });
    vi.stubEnv('SHELL', '/bin/zsh');
    vi.stubEnv('PATH', '/usr/bin:/bin:/usr/sbin:/sbin');

    const child = await startPackagedServer();

    // The tester's `claude` and `codex` both lived in ~/.local/bin, which the
    // packaged app could not see at all.
    expect(child.env.PATH).toBe(`${loginPath}:/usr/sbin:/sbin`);
  });

  it.each([
    ['DO_NOT_TRACK=1\n', { DO_NOT_TRACK: '1', DORKOS_TELEMETRY_DISABLED: undefined }],
    [
      'DORKOS_TELEMETRY_DISABLED=true\n',
      { DO_NOT_TRACK: undefined, DORKOS_TELEMETRY_DISABLED: 'true' },
    ],
    ['', { DO_NOT_TRACK: undefined, DORKOS_TELEMETRY_DISABLED: undefined }],
  ])('hands over the telemetry switch the login shell exports: %j', async (line, expected) => {
    const { spawnSync } = await getChildProcessMock();
    const { LOGIN_SHELL_PATH_MARKER } = await import('../../shared/login-shell-path');
    const dump = `SHLVL=1\nPATH=/opt/homebrew/bin:/usr/bin\n${line}HOME=${home}\n`;
    spawnSync.mockReturnValue({
      status: 0,
      signal: null,
      stdout: `${LOGIN_SHELL_PATH_MARKER}${dump}${LOGIN_SHELL_PATH_MARKER}`,
      stderr: '',
    });
    vi.stubEnv('SHELL', '/bin/zsh');
    vi.stubEnv('DO_NOT_TRACK', undefined);
    vi.stubEnv('DORKOS_TELEMETRY_DISABLED', undefined);

    const child = await startPackagedServer();

    expect(child.env.DO_NOT_TRACK).toBe(expected.DO_NOT_TRACK);
    expect(child.env.DORKOS_TELEMETRY_DISABLED).toBe(expected.DORKOS_TELEMETRY_DISABLED);
  });

  it('keeps a telemetry switch the app was started with over the shell one', async () => {
    const { spawnSync } = await getChildProcessMock();
    const { LOGIN_SHELL_PATH_MARKER } = await import('../../shared/login-shell-path');
    const dump = `PATH=/usr/bin\nDO_NOT_TRACK=1\n`;
    spawnSync.mockReturnValue({
      status: 0,
      signal: null,
      stdout: `${LOGIN_SHELL_PATH_MARKER}${dump}${LOGIN_SHELL_PATH_MARKER}`,
      stderr: '',
    });
    vi.stubEnv('SHELL', '/bin/zsh');
    vi.stubEnv('DO_NOT_TRACK', '0');

    const child = await startPackagedServer();

    expect(child.env.DO_NOT_TRACK).toBe('0');
  });

  it('points the extension compiler at the unpacked esbuild binary', async () => {
    // esbuild finds its own binary by require.resolve, which inside a packaged
    // app answers with an app.asar path — and spawning one of those fails with
    // ENOTDIR, because Electron's asar shim covers execFile but not spawn. That
    // is why the bundled marketplace extension failed to compile on every boot.
    const child = await startPackagedServer();

    expect(child.env.ESBUILD_BINARY_PATH).toBe(esbuildBinaryPath());
  });
});
