/**
 * The live gate's plain child-process step, and the published-version check built on it.
 *
 * Run as `pnpm test:community-live`, npm inherits pnpm's `npm_config_*` environment and warns
 * about the keys it does not know ("Unknown env config") on stderr. The gate used to merge stderr
 * into the output it parsed, so that warning broke the JSON `npm view` printed and the gate failed
 * before it did anything, naming no step. Only stdout is kept now, and output that still is not the
 * expected JSON fails as the `published-version` step. Both live here, with no provider boundary,
 * so they can be proven without contacting npm.
 */
import { spawn } from 'node:child_process';
import { CommunityLiveGateError } from './community-deploy-live-capture.js';

/** Bytes of stdout the gate keeps from one command; enough for any help or JSON it reads. */
const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Run one command to completion and return its stdout.
 *
 * Stderr is drained and discarded: it carries warnings and progress, never the answer the gate
 * reads, and it must not be mixed into output that is parsed.
 *
 * @param executable - Program to run, without a shell.
 * @param args - Its arguments.
 * @param environment - Its full environment.
 * @param step - Stable step name the failure is reported as.
 */
export function runCommunityLiveGateCommand(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  step: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let size = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_OUTPUT_BYTES) output += chunk.toString('utf8');
    });
    child.stderr.resume();
    child.once('error', () => reject(new CommunityLiveGateError(step)));
    child.once('close', (code) =>
      code === 0 ? resolve(output) : reject(new CommunityLiveGateError(step))
    );
  });
}

/**
 * Read the version `npm view <package>@<version> version --json` reported.
 *
 * @param stdout - The command's stdout.
 * @returns The parsed JSON value, for the caller to compare with the version it asked for.
 * @throws CommunityLiveGateError named `published-version` when stdout is not JSON.
 */
export function parsePublishedVersion(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new CommunityLiveGateError('published-version');
  }
}
