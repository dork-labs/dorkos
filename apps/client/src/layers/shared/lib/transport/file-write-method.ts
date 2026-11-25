/** Preserve optional server receipts through the ordinary conditional file transport. */
import type { WriteFileOptions, WriteFileResult } from '@dorkos/shared/transport';
import { FileDocumentSaveReceiptSchema } from '@dorkos/shared/schemas';
import { fetchResponse } from './http-client';

/** Dispatch one original file operation; unknown failures are left visible to its owner. */
export async function writeFileOverHttp(
  baseUrl: string,
  cwd: string,
  filePath: string,
  content: string,
  options?: WriteFileOptions
): Promise<WriteFileResult> {
  let res: Response;
  try {
    // Reuse the transport's one normal deadline/auth policy, never a UI retry clock.
    res = await fetchResponse(baseUrl, '/files/content', {
      method: 'PUT',
      body: JSON.stringify({ cwd, path: filePath, content, ...options }),
    });
  } catch (error) {
    // `412 precondition_failed` with the file as it is now: the file changed
    // since it was read. Any other 412 (the file was replaced mid-save, a
    // reused save id) carries no current bytes and stays a thrown refusal.
    const refusal = error as { status?: number; code?: unknown; body?: unknown };
    if (refusal.status !== 412 || refusal.code !== 'precondition_failed') throw error;
    const data = refusal.body;
    if (
      !data ||
      typeof data !== 'object' ||
      !('currentHash' in data) ||
      typeof data.currentHash !== 'string' ||
      !('currentContent' in data) ||
      typeof data.currentContent !== 'string'
    )
      throw error;
    return {
      ok: false,
      conflict: { currentHash: data.currentHash, currentContent: data.currentContent },
    };
  }
  const data: unknown = await res.json();
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    !('ok' in data) ||
    data.ok !== true ||
    !('hash' in data) ||
    typeof data.hash !== 'string' ||
    !data.hash ||
    !('effect' in data) ||
    (data.effect !== 'changed' && data.effect !== 'no_op')
  )
    throw new Error('Invalid file save response');
  const receipt =
    'documentReceipt' in data
      ? FileDocumentSaveReceiptSchema.parse(data.documentReceipt)
      : undefined;
  return {
    ok: true,
    hash: data.hash,
    effect: data.effect,
    ...(receipt ? { documentReceipt: receipt } : {}),
  };
}
