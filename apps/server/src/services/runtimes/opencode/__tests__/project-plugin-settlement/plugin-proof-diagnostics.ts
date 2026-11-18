import type { ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';

const STDERR_BYTES = 4096;
type Stage = 'getClient' | 'session.create' | 'mcp.status' | 'config.get' | 'provider.list';

/**
 * Fixture-only JSON records; diagnostics never change a request's outcome.
 *
 * @param write - Receives a JSON line containing no spawn environment or options.
 */
export function createPluginProofDiagnostics(write: (line: string) => void) {
  let nextNativeId = 0;
  const emit = (record: Record<string, unknown>) => {
    try {
      write(JSON.stringify({ atMs: performance.now(), ...record }));
    } catch {
      // A failed diagnostic consumer must not replace the original outcome.
    }
  };

  return {
    async call<T>(label: Stage, run: () => Promise<T>): Promise<T> {
      const started = performance.now();
      emit({ kind: 'call', phase: 'start', label });
      try {
        const value = await run();
        emit({ kind: 'call', phase: 'settled', label, elapsedMs: performance.now() - started });
        return value;
      } catch (reason) {
        emit({
          kind: 'call',
          phase: 'rejected',
          label,
          elapsedMs: performance.now() - started,
          reasonType: reason === null ? 'null' : typeof reason,
        });
        throw reason;
      }
    },

    native(child: ChildProcess, role: 'run' | 'serve' | 'other'): void {
      const nativeId = ++nextNativeId;
      let started = performance.now();
      let pid = child.pid ?? null;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const lines: { text: string; bytes: number }[] = [];
      let retainedBytes = 0;
      let pending: Buffer = Buffer.alloc(0);
      let oversized = false;
      const stderr = child.stderr;
      const finishLine = (newline: boolean) => {
        if (!oversized && (pending.length > 0 || newline)) {
          try {
            const line = decoder.decode(pending);
            const sensitive =
              /authorization|api[-_]?key|token|password|secret|process\.env|\benv\s*[:=]/i.test(
                line
              ) || /\b[A-Z][A-Z0-9_]{2,}\s*=/.test(line);
            const text =
              (sensitive ? '[credential-like stderr line omitted]' : line) + (newline ? '\n' : '');
            const bytes = Buffer.byteLength(text);
            if (bytes <= STDERR_BYTES) {
              while (retainedBytes + bytes > STDERR_BYTES) retainedBytes -= lines.shift()!.bytes;
              lines.push({ text, bytes });
              retainedBytes += bytes;
            }
          } catch {
            // Omit malformed/incomplete UTF-8 rather than render a damaged prefix.
          }
        }
        pending = Buffer.alloc(0);
        oversized = false;
      };
      const onData = (chunk: Buffer | string) => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        let offset = 0;
        while (offset < bytes.length) {
          const newline = bytes.indexOf(10, offset);
          const end = newline === -1 ? bytes.length : newline;
          if (!oversized) {
            if (pending.length + end - offset <= STDERR_BYTES) {
              pending = Buffer.concat([pending, bytes.subarray(offset, end)]);
            } else {
              // Discard the WHOLE raw line, never a suffix whose prefix was lost.
              pending = Buffer.alloc(0);
              oversized = true;
            }
          }
          if (newline === -1) break;
          finishLine(true);
          offset = newline + 1;
        }
      };
      stderr?.on('data', onData);
      child.once('spawn', () => {
        started = performance.now();
        pid = child.pid ?? null;
        emit({ kind: 'native', phase: 'start', nativeId, role, pid });
      });
      child.once('close', (code, signal) => {
        stderr?.off('data', onData);
        // EOF completes a bounded final line; retain only whole sanitized lines.
        finishLine(false);
        emit({
          kind: 'native',
          phase: 'close',
          nativeId,
          role,
          pid,
          code,
          signal,
          elapsedMs: performance.now() - started,
          stderrTail: lines.map((line) => line.text).join(''),
        });
      });
    },
  };
}
