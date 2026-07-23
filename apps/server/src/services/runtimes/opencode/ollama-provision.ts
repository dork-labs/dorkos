/**
 * Guided, password-free Ollama install (spec: opencode-connect-overhaul §13) —
 * the sibling of {@link provisionOpenCode} for Ollama.
 *
 * DorkOS installs Ollama only where it can succeed without a password prompt:
 * macOS via Homebrew when `brew` is on PATH, Windows via winget when `winget` is
 * present. Everywhere else — Linux, or a machine without a supported package
 * manager — there is no silent path (the official installer needs `sudo`), so the
 * capability is reported as `manual` and the client shows the official one-line
 * command to copy instead. DorkOS NEVER runs an install with elevated privileges
 * and never uses a shell: every install is an `execFile` with an args array.
 *
 * Like {@link provisionOpenCode}, this never throws — installer failures resolve
 * to an honest, condensed message for the Connect surface, never a raw stack. On
 * a successful macOS install it also attempts `brew services start ollama`
 * best-effort; failing to start is NOT an install failure and is reported
 * honestly via the terminal result's fresh detection re-probe.
 *
 * @module services/runtimes/opencode/ollama-provision
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RuntimeProvisionProgress } from '@dorkos/shared/transport';
import type {
  OllamaInstallMethod,
  OllamaProvisionResult,
  OllamaStatus,
} from '@dorkos/shared/runtime-connect';
import { detectOllama, resetOllamaCache } from './ollama.js';

const execFileAsync = promisify(execFile);

/**
 * winget package identifier for Ollama — the id winget resolves `winget install`
 * against. Verified against the Windows Package Manager community repository
 * (`winget install --id Ollama.Ollama`). Reversible: a rename in the winget repo
 * updates this one constant.
 */
export const OLLAMA_WINGET_ID = 'Ollama.Ollama';

/** Installs are slow (a multi-hundred-MB download + unpack); bound generously but never unbounded. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** Short bound on the PATH-existence probe — it must never hang a capability check. */
const COMMAND_PROBE_TIMEOUT_MS = 2_000;

/** Outcome of one installer command: success, or an honest failure detail (never a raw stack). */
interface CommandOutcome {
  ok: boolean;
  /** A short failure reason when `!ok` (stderr first line or the error message). */
  detail?: string;
}

/**
 * Injectable seams for {@link provisionOllama} / {@link detectOllamaInstallMethod}
 * so tests never shell out. Every field defaults to a real, bounded `execFile`.
 */
export interface OllamaProvisionDeps {
  /** Override the detected platform (defaults to `process.platform`). */
  platform?: NodeJS.Platform;
  /** Probe whether a command resolves on PATH (defaults to a bounded `which`/`where`). */
  commandExists?: (command: string) => Promise<boolean>;
  /** Run one installer command (defaults to a bounded `execFile`, args-only, no shell). */
  runCommand?: (command: string, args: string[]) => Promise<CommandOutcome>;
  /** Re-probe Ollama after install (defaults to {@link detectOllama}). */
  detectOllamaFn?: () => Promise<OllamaStatus>;
  /** Clear the detection cache before the post-install re-probe (defaults to {@link resetOllamaCache}). */
  resetDetectionCache?: () => void;
}

/** Default PATH-existence probe: `which <cmd>` (POSIX) / `where <cmd>` (Windows), bounded. */
async function commandExistsDefault(command: string, platform: NodeJS.Platform): Promise<boolean> {
  const probe = platform === 'win32' ? 'where' : 'which';
  try {
    await execFileAsync(probe, [command], { timeout: COMMAND_PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/** Default installer runner: a bounded `execFile` (args array only — never a shell, never sudo). */
async function runCommandDefault(command: string, args: string[]): Promise<CommandOutcome> {
  try {
    await execFileAsync(command, args, { timeout: INSTALL_TIMEOUT_MS, killSignal: 'SIGKILL' });
    return { ok: true };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr;
    const detail = (stderr && String(stderr)) || (err instanceof Error ? err.message : String(err));
    return { ok: false, detail };
  }
}

/** Condense an installer failure into an honest, non-raw Connect message (mirrors provision.ts). */
function honestInstallError(detail: string | undefined): string {
  const firstLine = (detail ?? '')
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim();
  const suffix = firstLine ? ` (${firstLine})` : '';
  return `Could not install Ollama${suffix}. Check your connection and try again.`;
}

/**
 * Detect how Ollama can be installed on this machine without a password prompt.
 *
 * macOS with `brew` on PATH ⇒ `brew`; Windows with `winget` on PATH ⇒ `winget`;
 * anything else (Linux, or a missing package manager) ⇒ `manual`. Bounded and
 * throw-free — a hung/absent probe resolves to `manual`.
 *
 * @param deps - Test seams (platform + command-existence probe).
 */
export async function detectOllamaInstallMethod(
  deps: OllamaProvisionDeps = {}
): Promise<OllamaInstallMethod> {
  const platform = deps.platform ?? process.platform;
  const commandExists = deps.commandExists ?? ((cmd) => commandExistsDefault(cmd, platform));
  if (platform === 'darwin' && (await commandExists('brew'))) return 'brew';
  if (platform === 'win32' && (await commandExists('winget'))) return 'winget';
  return 'manual';
}

/** The installer command for a one-click method (never called for `manual`). */
function installerCommand(method: 'brew' | 'winget'): { command: string; args: string[] } {
  if (method === 'brew') return { command: 'brew', args: ['install', 'ollama'] };
  return {
    command: 'winget',
    args: [
      'install',
      '--id',
      OLLAMA_WINGET_ID,
      '--accept-package-agreements',
      '--accept-source-agreements',
      '--silent',
    ],
  };
}

/**
 * Shared in-flight install promise. Concurrent callers (double-click, two tabs)
 * piggyback on one install rather than racing a second package-manager invocation
 * into the same machine. Cleared once the install settles.
 */
let inFlightProvision: Promise<OllamaProvisionResult> | null = null;

/**
 * Install Ollama on demand, password-free, and stream install progress.
 *
 * De-dupes concurrent calls. Resolves to the terminal {@link OllamaProvisionResult}
 * carrying the {@link OllamaInstallMethod} that ran and — on success — a fresh
 * detection re-probe so the caller knows whether Ollama is already running. When
 * no one-click path exists (`manual`) it resolves to `ok: false` without touching
 * the system (the client shows the copyable command instead). Never rejects.
 *
 * @param onProgress - Optional callback for streamed install progress frames.
 * @param deps - Test seams (platform, command probe, runner, detection).
 * @returns The terminal install result.
 */
export async function provisionOllama(
  onProgress?: (progress: RuntimeProvisionProgress) => void,
  deps: OllamaProvisionDeps = {}
): Promise<OllamaProvisionResult> {
  if (inFlightProvision) {
    onProgress?.({ stage: 'starting', message: 'Ollama install already in progress…' });
    return inFlightProvision;
  }
  const run = runProvisionOllama(onProgress, deps);
  inFlightProvision = run;
  try {
    return await run;
  } finally {
    inFlightProvision = null;
  }
}

/**
 * Perform one guided Ollama install. The concurrency guard lives in
 * {@link provisionOllama}; this does the work.
 *
 * @param onProgress - Optional callback for streamed install progress frames.
 * @param deps - Test seams (platform, command probe, runner, detection).
 */
async function runProvisionOllama(
  onProgress: ((progress: RuntimeProvisionProgress) => void) | undefined,
  deps: OllamaProvisionDeps
): Promise<OllamaProvisionResult> {
  const method = await detectOllamaInstallMethod(deps);
  if (method === 'manual') {
    return {
      ok: false,
      installMethod: 'manual',
      error:
        'One-click install is not available on this computer. Copy the command to install Ollama yourself.',
    };
  }

  const runCommand = deps.runCommand ?? runCommandDefault;
  const detect = deps.detectOllamaFn ?? (() => detectOllama());
  const resetDetectionCache = deps.resetDetectionCache ?? resetOllamaCache;

  onProgress?.({ stage: 'starting', message: 'Installing Ollama…' });
  const { command, args } = installerCommand(method);
  const install = await runCommand(command, args);
  if (!install.ok) {
    onProgress?.({ stage: 'error', message: install.detail ?? 'Install failed' });
    return { ok: false, installMethod: method, error: honestInstallError(install.detail) };
  }

  // Best-effort start on macOS: failing to start is NOT an install failure — the
  // fresh detection re-probe below tells the client honestly whether it is running.
  if (method === 'brew') {
    onProgress?.({ stage: 'installing', message: 'Starting Ollama…' });
    await runCommand('brew', ['services', 'start', 'ollama']);
  }

  onProgress?.({ stage: 'done', message: 'Ollama installed.' });
  // A fast install can finish inside detectOllama's short cache window, so a
  // stale probe would report running:false when Ollama is actually up. Clear the
  // cache first so the terminal status always re-probes for real.
  resetDetectionCache();
  const status = await detect();
  return { ok: true, installMethod: method, status };
}
