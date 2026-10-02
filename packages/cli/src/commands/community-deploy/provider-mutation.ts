/**
 * Shared classification for provider commands that may have completed remotely.
 *
 * @module commands/community-deploy/provider-mutation
 */
import { ProviderCommandError, runProviderCommand } from './provider-process.js';

/** Stable, secret-free failure from a provider mutation boundary. */
export class ProviderMutationError extends Error {
  /** Safe classification suitable for the launch journal. */
  readonly code:
    | 'INVALID_INPUT'
    | 'INVALID_RESPONSE'
    | 'PROVIDER_UNAVAILABLE'
    | 'ACCESS_DENIED'
    | 'CREATION_OUTCOME_UNCERTAIN';

  /** Create a mutation error without provider output. */
  constructor(code: ProviderMutationError['code']) {
    super(`Provider mutation failed (${code})`);
    this.name = 'ProviderMutationError';
    this.code = code;
  }
}

/**
 * Deadline for a provider write that is one API call: creating or destroying a Fly app, staging
 * Fly secrets, creating or deleting a Neon project, creating or deleting a storage bucket.
 *
 * These normally answer in seconds, and the 30-second deadline the reads share was enough in every
 * live run so far. But a write cut off by the launcher is not a failure, it is an unknown: the
 * provider may have done it, and the launch stops as uncertain for the operator to reconcile by
 * hand (DOR-2169). A slow answer costs a wait; a cut-off one costs that manual reconciliation. So
 * writes get two minutes, reads keep 30 seconds, and deploys get their own, longer deadline.
 */
export const PROVIDER_WRITE_TIMEOUT_MS = 2 * 60_000;

/**
 * The deadline for one provider write: the caller's, raised to {@link PROVIDER_WRITE_TIMEOUT_MS}.
 *
 * @param callerTimeoutMs - The deadline the caller passed for its reads.
 * @param minimumMs - The least this write may be given.
 * @returns The longer of the two.
 */
export function writeDeadline(
  callerTimeoutMs: number,
  minimumMs: number = PROVIDER_WRITE_TIMEOUT_MS
): number {
  return Math.max(callerTimeoutMs, minimumMs);
}

/** Options for a bounded provider mutation. */
export interface ProviderMutationOptions<T> {
  /** Executable path. */
  executable: string;
  /** Secret-free argument vector. */
  args: readonly string[];
  /** Minimal environment. */
  env: Readonly<Record<string, string>>;
  /** Deadline in milliseconds. */
  timeoutMs: number;
  /** Operator cancellation shared by the complete guided launch. */
  signal?: AbortSignal;
  /** Optional secret document passed only over stdin. */
  stdin?: string;
  /** Sanitizing parser for machine-readable output, or a constant receipt. */
  parse: (stdout: string) => T;
  /**
   * Report a definite access refusal as `ACCESS_DENIED` instead of uncertain. Set only for a
   * create that is one request, so a refusal proves nothing was made. Off by default.
   */
  refusalIsDefinite?: boolean;
}

/**
 * Run a mutation and classify every post-spawn failure as uncertain.
 *
 * A command can mutate remotely before its output is lost, its response becomes malformed, or the
 * local process exits. Only a local spawn failure proves that no provider request was made, and,
 * when the caller opts in with `refusalIsDefinite`, a service answer that refuses the credential
 * outright (`ACCESS_DENIED`). A timeout, a cut-off or garbled answer, or any other exit stays
 * uncertain.
 */
export async function runProviderMutation<T>(options: ProviderMutationOptions<T>): Promise<T> {
  const { refusalIsDefinite, ...command } = options;
  try {
    return (await runProviderCommand(command)).value;
  } catch (error) {
    if (error instanceof ProviderCommandError && error.code === 'SPAWN') {
      throw new ProviderMutationError('PROVIDER_UNAVAILABLE');
    }
    if (refusalIsDefinite && error instanceof ProviderCommandError && error.refused) {
      throw new ProviderMutationError('ACCESS_DENIED');
    }
    throw new ProviderMutationError('CREATION_OUTCOME_UNCERTAIN');
  }
}
