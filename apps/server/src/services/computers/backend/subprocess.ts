import { spawn } from 'node:child_process';
import type { CommandResult } from './types.js';

const OUTPUT_LIMIT = 1024 * 1024;
const MAX_DEADLINE = 600_000;
/** Run an explicit executable with bounded output, time and a minimal environment. */
export function runBounded(
  executable: string,
  argv: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...argv], {
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let failure: Error | undefined;
    const fail = (message: string) => {
      failure ??= new Error(message);
      child.kill('SIGKILL');
    };
    const timer = setTimeout(
      () => fail('Computer command deadline exceeded'),
      Math.min(options.timeoutMs ?? 30_000, MAX_DEADLINE)
    );
    const collect = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) {
        fail('Computer command output limit exceeded');
        return;
      }
      if (stream === 'stdout') stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}
