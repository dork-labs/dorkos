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
    'INVALID_INPUT' | 'INVALID_RESPONSE' | 'PROVIDER_UNAVAILABLE' | 'CREATION_OUTCOME_UNCERTAIN';

  /** Create a mutation error without provider output. */
  constructor(code: ProviderMutationError['code']) {
    super(`Provider mutation failed (${code})`);
    this.name = 'ProviderMutationError';
    this.code = code;
  }
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
}

/**
 * Run a mutation and classify every post-spawn failure as uncertain.
 *
 * A command can mutate remotely before its output is lost, its response becomes malformed, or the
 * local process exits. Only a local spawn failure proves that no provider request was made.
 */
export async function runProviderMutation<T>(options: ProviderMutationOptions<T>): Promise<T> {
  try {
    return (await runProviderCommand(options)).value;
  } catch (error) {
    if (error instanceof ProviderCommandError && error.code === 'SPAWN') {
      throw new ProviderMutationError('PROVIDER_UNAVAILABLE');
    }
    throw new ProviderMutationError('CREATION_OUTCOME_UNCERTAIN');
  }
}
