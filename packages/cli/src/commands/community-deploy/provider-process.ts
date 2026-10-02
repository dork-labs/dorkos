/**
 * Bounded subprocess boundary for machine-readable provider commands.
 *
 * @module commands/community-deploy/provider-process
 */
import { spawn } from 'node:child_process';

const DEFAULT_MAX_BYTES = 1024 * 1024;
/** How much of stderr is held, in memory only, to recognise an access refusal. */
const REFUSAL_SCAN_BYTES = 4096;
// Terminal colour codes: flyctl colours its `Error: ` prefix when it thinks it has a terminal.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/gu;
/**
 * flyctl prints a Machines API refusal as `Error: <body.error>`, then any request and trace ids
 * (flyctl `internal/cli/cli.go` `printError`; fly-go `flaps/flaps.go` `handleAPIError`). A token
 * that may not act in an organization gets `unauthorized` (DOR-2170 L3, flyctl v0.4.110:
 * `Error: unauthorized (Request ID: …)`). Only the whole line counts, so a local error that merely
 * ends in "permission denied" (a file path, say) never matches.
 */
const FLY_REFUSAL =
  /^Error: (?:unauthorized|forbidden)(?: \(Request ID: [^)]*\))?(?: \(Trace ID: [^)]*\))?$/u;
/**
 * neonctl prints an API refusal's own message as `ERROR: <message>` (neonctl `src/index.ts`
 * `handleError`, `src/log.ts`). These are Neon's answers to a key that may not act there, seen
 * live in DOR-2170 L3: "not allowed to perform actions outside the project this key is scoped to"
 * and "project-scoped keys are not allowed to create projects".
 */
const NEON_REFUSAL =
  /^ERROR: (?:not allowed to |[a-z-]+ keys are not allowed to |permission denied\b)/u;

/**
 * Whether a provider CLI's error output is a definite access refusal: the service answered and
 * said this credential may not do that, so the request did nothing.
 *
 * Deliberately narrow. Anything else, including a refusal worded some other way, stays unknown,
 * because calling a lost or garbled answer a refusal could hide a resource that was made.
 *
 * @param stderr - The command's error output.
 * @returns True only for a line in one of the known refusal shapes.
 */
export function isProviderAccessRefusal(stderr: string): boolean {
  return stderr
    .replace(ANSI_ESCAPE, '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .some((line) => FLY_REFUSAL.test(line) || NEON_REFUSAL.test(line));
}

/**
 * Deadline for each Community launch service read: every `fly` and `neonctl` process and every Fly
 * GraphQL request. Writes get at least `PROVIDER_WRITE_TIMEOUT_MS` instead (`writeDeadline`). The
 * removal command's create windows are sized from both: see `uncertain-verdict.ts`.
 */
export const COMMUNITY_SERVICE_TIMEOUT_MS = 30_000;
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
  /** Operator cancellation shared by the complete guided launch. */
  signal?: AbortSignal;
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
  readonly code: 'SPAWN' | 'TIMEOUT' | 'OUTPUT_LIMIT' | 'EXIT' | 'INVALID_RESPONSE' | 'CANCELLED';
  /**
   * True only for an `EXIT` whose error output was a definite access refusal
   * ({@link isProviderAccessRefusal}). The output itself is never kept.
   */
  readonly refused: boolean;

  /**
   * Create a provider command error without raw stdout or stderr.
   *
   * @param code - Stable failure category.
   * @param refused - Whether the service definitely refused the credential.
   */
  constructor(code: ProviderCommandError['code'], refused = false) {
    super(`Provider command failed (${code})`);
    this.name = 'ProviderCommandError';
    this.code = code;
    this.refused = code === 'EXIT' && refused;
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
    // The start of stderr, held only to tell a refusal apart and zeroed once the command ends.
    const stderrHead: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let pendingError: ProviderCommandError | undefined;
    let terminationTimer: NodeJS.Timeout | undefined;

    const scrubStdout = (): void => {
      for (const chunk of [...stdout, ...stderrHead]) chunk.fill(0);
      stdout.length = 0;
      stderrHead.length = 0;
    };

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
    const cancel = () => failAfterClose(new ProviderCommandError('CANCELLED'));
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
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
      const held = Math.min(chunk.length, Math.max(0, REFUSAL_SCAN_BYTES - stderrBytes));
      if (held > 0) stderrHead.push(Buffer.from(chunk.subarray(0, held)));
      stderrBytes += chunk.length;
      if (stderrBytes > maxBytes) failAfterClose(new ProviderCommandError('OUTPUT_LIMIT'));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(terminationTimer);
      options.signal?.removeEventListener('abort', cancel);
      if (pendingError) {
        scrubStdout();
        return reject(pendingError);
      }
      if (code !== 0) {
        const errorOutput = Buffer.concat(stderrHead);
        const refused = isProviderAccessRefusal(errorOutput.toString('utf8'));
        errorOutput.fill(0);
        scrubStdout();
        return reject(new ProviderCommandError('EXIT', refused));
      }
      const output = Buffer.concat(stdout);
      try {
        resolve({ value: options.parse(output.toString('utf8')) });
      } catch {
        reject(new ProviderCommandError('INVALID_RESPONSE'));
      } finally {
        output.fill(0);
        scrubStdout();
      }
    });
    child.stdin.on('error', () => failAfterClose(new ProviderCommandError('EXIT')));
    child.stdin.end(options.stdin);
  });
}
