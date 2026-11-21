/** Apply either compiler outcome consistently across the extension lifecycle. */
import type { ExtensionRecord } from '@dorkos/extension-api';
import type { ExtensionCompiler } from '../extension-compiler.js';
import { toRecordError } from '../extension-manager-types.js';
import { bundleDigestOf } from '../pin/extension-path-trust.js';

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
