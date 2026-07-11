/**
 * The individual checks behind `dorkos doctor`.
 *
 * Each check returns a {@link CheckResult} — a plain, renderable verdict — and
 * never prints or exits. `doctor.ts` reads config, runs these, and formats the
 * checklist. Keeping the checks free of I/O formatting makes them testable and
 * keeps this file focused on "what is true about this machine?".
 *
 * @module commands/doctor-checks
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { checkNodeVersion } from '../startup-diagnostics.js';
import { checkCoreExtensions } from '../check-core-extensions.js';
import { checkExtensionCompilation } from '../check-extension-compilation.js';
import { claudeCliLaunches } from '../check-claude.js';

/** Outcome of a single doctor check. `fail` is the only status that affects the exit code. */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info';

/** A renderable verdict from one check. */
export interface CheckResult {
  /** Short, plain label shown on the checklist line. */
  label: string;
  /** Verdict. Only `fail` makes `dorkos doctor` exit non-zero. */
  status: CheckStatus;
  /** Optional one-line context shown dimmed under the label. */
  detail?: string;
  /** Optional next step, shown for `warn`/`fail`. */
  fix?: string;
}

/** How long to wait for a port probe before treating the port as free. */
const PORT_PROBE_TIMEOUT_MS = 500;

/** Node.js version meets the minimum DorkOS requires. */
export function checkNode(): CheckResult {
  const issue = checkNodeVersion();
  if (issue) {
    return { label: issue.headline, status: 'fail', detail: issue.detail, fix: issue.fix };
  }
  return { label: `Node.js ${process.versions.node}`, status: 'pass' };
}

/** The data directory exists and DorkOS can write to it. */
export function checkDorkHomeWritable(dorkHome: string): CheckResult {
  const probe = path.join(dorkHome, `.doctor-write-${process.pid}`);
  try {
    fs.mkdirSync(dorkHome, { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return { label: `Data directory is writable`, status: 'pass', detail: dorkHome };
  } catch (err) {
    return {
      label: 'Data directory is not writable',
      status: 'fail',
      detail: `${dorkHome}: ${(err as Error).message}`,
      fix: `Fix ownership of the DorkOS data directory:\n  sudo chown -R $(whoami) ${dorkHome}`,
    };
  }
}

/**
 * The configured port is free.
 *
 * A busy port is reported as `info`, not a failure — it usually means DorkOS is
 * already running there, which is fine.
 */
export async function checkPortFree(port: number): Promise<CheckResult> {
  const inUse = await isPortInUse(port);
  if (!inUse) {
    return { label: `Port ${port} is free`, status: 'pass' };
  }
  return {
    label: `Port ${port} is in use`,
    status: 'info',
    detail: 'DorkOS may already be running here. Start it on another port with --port if not.',
  };
}

/** A Claude Code binary is present and launches. */
export function checkClaudeCli(): CheckResult {
  if (claudeCliLaunches()) {
    return { label: 'Claude Code CLI found', status: 'pass' };
  }
  const installCmd =
    process.platform === 'win32'
      ? 'irm https://claude.ai/install.ps1 | iex'
      : 'curl -fsSL https://claude.ai/install.sh | bash';
  return {
    label: 'Claude Code CLI not found',
    status: 'warn',
    detail: 'Agent sessions need the Claude Code CLI. The cockpit still opens without it.',
    fix: `Install it, then sign in:\n  ${installCmd}`,
  };
}

/**
 * Whether the machine looks signed in to Claude.
 *
 * This is best-effort and informational: it only checks that Claude has left a
 * config directory behind (`~/.claude`). It never fails — real sign-in state can
 * live in the OS keychain, which we do not probe.
 */
export function checkClaudeAuth(homeDir: string): CheckResult {
  const claudeDir = path.join(homeDir, '.claude');
  if (fs.existsSync(claudeDir)) {
    return { label: 'Claude looks configured', status: 'info', detail: claudeDir };
  }
  return {
    label: 'Claude sign-in not detected',
    status: 'info',
    detail: 'Run `claude` once and sign in before starting agent sessions.',
  };
}

/** Config for the optional Codex and OpenCode runtimes (informational only). */
export interface RuntimeAuthContext {
  codexEnabled: boolean;
  codexCredentialRef: string | null;
  opencodeEnabled: boolean;
  opencodeProvider: string | null;
}

/** Report Codex/OpenCode credential presence. Always informational — both are optional. */
export function checkRuntimeAuth(ctx: RuntimeAuthContext): CheckResult[] {
  const results: CheckResult[] = [];

  results.push(
    ctx.codexEnabled && ctx.codexCredentialRef
      ? { label: 'Codex credentials configured', status: 'info' }
      : {
          label: 'Codex not configured',
          status: 'info',
          detail: 'Optional. Add a Codex runtime in Settings to use it.',
        }
  );

  results.push(
    ctx.opencodeEnabled && ctx.opencodeProvider
      ? { label: `OpenCode provider set (${ctx.opencodeProvider})`, status: 'info' }
      : {
          label: 'OpenCode not configured',
          status: 'info',
          detail: 'Optional. Pick a provider in Settings to use it.',
        }
  );

  return results;
}

/** Bundled extensions ship and actually compile at runtime. */
export async function checkExtensions(): Promise<CheckResult> {
  if (!checkCoreExtensions()) {
    return {
      label: 'Bundled extensions are missing',
      status: 'fail',
      detail: 'This install is incomplete — the core-extensions directory did not ship.',
      fix: 'Reinstall DorkOS:\n  npm install -g dorkos@latest',
    };
  }
  if (!(await checkExtensionCompilation())) {
    return {
      label: 'Extensions cannot compile',
      status: 'fail',
      detail: 'esbuild could not run, so server-capable extensions would fail to load.',
      fix: 'Reinstall DorkOS:\n  npm install -g dorkos@latest',
    };
  }
  return { label: 'Extensions compile', status: 'pass' };
}

/** Login config sanity: a required signing secret is present when login is on. */
export interface AuthConfigContext {
  authEnabled: boolean;
  secretFileExists: boolean;
  secretEnvSet: boolean;
}

/** Warn when login is enabled but no signing secret exists (first sign-in would 500). */
export function checkAuthConfig(ctx: AuthConfigContext): CheckResult {
  if (!ctx.authEnabled) {
    return { label: 'Login is off (localhost only)', status: 'pass' };
  }
  if (ctx.secretFileExists || ctx.secretEnvSet) {
    return { label: 'Login is on and has a signing secret', status: 'pass' };
  }
  return {
    label: 'Login is on but no signing secret was found',
    status: 'warn',
    detail: 'The first sign-in would fail without a secret to sign sessions.',
    fix: 'Create the owner account (writes the secret):\n  dorkos auth enable',
  };
}

/** Tunnel config sanity: a token is present when the tunnel is enabled. */
export interface TunnelConfigContext {
  tunnelEnabled: boolean;
  tokenConfigured: boolean;
}

/** Warn when the tunnel is enabled but has no ngrok token to start with. */
export function checkTunnelConfig(ctx: TunnelConfigContext): CheckResult {
  if (!ctx.tunnelEnabled) {
    return { label: 'Tunnel is off', status: 'pass' };
  }
  if (ctx.tokenConfigured) {
    return { label: 'Tunnel is on and has a token', status: 'pass' };
  }
  return {
    label: 'Tunnel is on but has no ngrok token',
    status: 'warn',
    detail: 'The tunnel cannot start without an ngrok auth token.',
    fix: 'Set a token:\n  dorkos config set tunnel.authtoken <token>\n  (or the NGROK_AUTHTOKEN env var)',
  };
}

/** Probe whether something is already listening on `port` at localhost. */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (inUse: boolean) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}
