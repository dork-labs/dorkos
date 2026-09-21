/**
 * Bounded subprocess boundary for machine-readable provider commands.
 *
 * @module commands/community-deploy/provider-process
 */
import { spawn } from 'node:child_process';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const TERMINATION_GRACE_MS = 250;

/** Sanitized result from a provider response parser. */
export interface ProviderCommandResult<T> {
  /** Parsed value containing no provider credential or secret-bearing URL. */
  value: T;
}

/** Options for one bounded provider command. */
export interface ProviderCommandOptions<T> {
  /** Executable path. A shell is never used. */
  executable: string;
  /** Argument vector containing no secret. */
  args: readonly string[];
  /** Minimal environment needed by the provider CLI. */
  env: Readonly<Record<string, string>>;
  /** Maximum wall time in milliseconds. */
  timeoutMs: number;
  /** Maximum bytes accepted on either output stream. */
  maxBytes?: number;
  /** Optional secret document streamed to stdin. */
  stdin?: string;
  /** Parser that returns a sanitized value or rejects the response. */
  parse: (stdout: string) => T;
}

/** Generic safe provider error that never includes raw command output. */
export class ProviderCommandError extends Error {
  /** Stable failure category safe for logs and journals. */
  readonly code: 'SPAWN' | 'TIMEOUT' | 'OUTPUT_LIMIT' | 'EXIT' | 'INVALID_RESPONSE';

  /**
   * Create a provider command error without raw stdout or stderr.
   *
   * @param code - Stable failure category.
   */
  constructor(code: ProviderCommandError['code']) {
    super(`Provider command failed (${code})`);
    this.name = 'ProviderCommandError';
    this.code = code;
  }
}

/**
 * Run a provider executable without a shell and discard raw output after parsing.
 *
 * @param options - Bounded command and sanitizing parser.
 * @returns Only the parser's sanitized value.
 */
export function runProviderCommand<T>(
  options: ProviderCommandOptions<T>
): Promise<ProviderCommandResult<T>> {
  return new Promise((resolve, reject) => {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const child = spawn(options.executable, [...options.args], {
      env: { ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let pendingError: ProviderCommandError | undefined;
    let terminationTimer: NodeJS.Timeout | undefined;

    const failAfterClose = (error: ProviderCommandError): void => {
      if (settled || pendingError) return;
      pendingError = error;
      clearTimeout(timer);
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      terminationTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, TERMINATION_GRACE_MS);
    };

    const timer = setTimeout(
      () => failAfterClose(new ProviderCommandError('TIMEOUT')),
      options.timeoutMs
    );
    child.once('error', () => failAfterClose(new ProviderCommandError('SPAWN')));
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled || pendingError) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        failAfterClose(new ProviderCommandError('OUTPUT_LIMIT'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled || pendingError) return;
      stderrBytes += chunk.length;
      if (stderrBytes > maxBytes) failAfterClose(new ProviderCommandError('OUTPUT_LIMIT'));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(terminationTimer);
      if (pendingError) return reject(pendingError);
      if (code !== 0) return reject(new ProviderCommandError('EXIT'));
      try {
        resolve({ value: options.parse(Buffer.concat(stdout).toString('utf8')) });
      } catch {
        reject(new ProviderCommandError('INVALID_RESPONSE'));
      }
    });
    child.stdin.on('error', () => failAfterClose(new ProviderCommandError('EXIT')));
    child.stdin.end(options.stdin);
  });
}
