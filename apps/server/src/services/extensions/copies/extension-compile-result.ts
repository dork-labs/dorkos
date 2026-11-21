/** Apply either compiler outcome consistently across the extension lifecycle. */
import type { ExtensionRecord } from '@dorkos/extension-api';
import type { ExtensionCompiler } from '../extension-compiler.js';
import { toRecordError } from '../extension-manager-types.js';
import { bundleDigestOf } from '../pin/extension-path-trust.js';
import { logger } from '../../../lib/logger.js';

/** Update a record after compilation and return whether a bundle is ready. */
export function applyCompileResult(
  record: ExtensionRecord,
  result: Awaited<ReturnType<ExtensionCompiler['compile']>>
): boolean {
  if ('error' in result) {
    record.status = 'compile_error';
    record.error = toRecordError(result.error);
    record.sourceHash = result.sourceHash;
    record.bundleReady = false;
    record.clientDigest = undefined;
    return false;
  }
  record.status = 'compiled';
  record.sourceHash = result.sourceHash;
  record.bundleReady = true;
  record.clientDigest = bundleDigestOf(result.code);
  record.error = undefined;
  return true;
}

/**
 * Compile every enabled record in turn, updating each with its result.
 *
 * An unexpected throw from `compiler.compile()` for one extension must not
 * abort compilation for every extension after it. `compile()` itself degrades
 * most known failures (an unreadable entry file, a cache directory it can't
 * create) to an `{ error }` result rather than throwing; this `try` is the
 * remaining backstop for anything that doesn't. Moved out of
 * `extension-manager.ts` (Hard Rule 9).
 *
 * @param records - Every record the scan chose; only `enabled` ones compile.
 * @param compiler - The manager's compiler.
 */
export async function compileEnabledRecords(
  records: Iterable<ExtensionRecord>,
  compiler: Pick<ExtensionCompiler, 'compile'>
): Promise<void> {
  const enabled = Array.from(records).filter((r) => r.status === 'enabled');
  for (const record of enabled) {
    try {
      applyCompileResult(record, await compiler.compile(record));
    } catch (err) {
      logger.error(
        `[Extensions] Compile threw an unexpected error for ${record.id} — skipping it and continuing with the rest`,
        err
      );
      record.status = 'compile_error';
      record.error = {
        code: 'compilation_failed',
        message: err instanceof Error ? err.message : String(err),
      };
      record.bundleReady = false;
    }
  }
}
