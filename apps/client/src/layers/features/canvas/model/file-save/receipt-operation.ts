/** Mounted-owner original save identity. This is not a cross-refresh recovery journal. */
import type { Transport, WriteFileOptions, WriteFileResult } from '@dorkos/shared/transport';
import {
  FileDocumentSaveReceiptSchema,
  type FileDocumentSaveReceipt,
} from '@dorkos/shared/schemas';
import {
  sameCanvasDocIncarnation,
  type CanvasDocIncarnation,
} from '@dorkos/shared/canvas-doc-frame-wire';

/** Inert server-observed birth plus a live read-current observation, never server authority. */
export interface FileSaveBinding {
  readonly incarnation: CanvasDocIncarnation;
  current(): boolean;
}
/** The response does not yet prove the original operation resolved. */
export class UnconfirmedFileSaveError extends Error {
  /** The previous original operation must be reviewed/retried before another request. */
  constructor() {
    super('The original save is not confirmed. Retry it before saving another draft.');
  }
}
/** The original document observation no longer permits a new live request. */
export class RetiredFileSaveError extends Error {}
type Pending = { cwd: string; path: string; content: string; options: WriteFileOptions };

/** Mint a UUID without requiring crypto.subtle or a secure-context-only randomUUID. */
function eventUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function provenPreEffectFailure(error: unknown): boolean {
  // Generic HTTP refusals can arrive after rename during currentness/receipt checks.
  // Only this server status attests its durable original failed before replacement.
  const failure = error as { status?: unknown; code?: unknown } | null;
  return failure?.status === 412 && failure.code === 'DOC_SAVE_FAILED';
}
/** The hook owns serialization; this object retains one exact uncertain original request. */
export class FileReceiptOperation {
  #pending?: Pending;
  #receipt?: FileDocumentSaveReceipt;
  /** Report uncertainty without exposing private draft/request storage. */
  get pending(): boolean {
    return this.#pending !== undefined;
  }
  /** Last validated receipt, distinct from an ordinary file/no-op acknowledgement. */
  get receipt(): FileDocumentSaveReceipt | undefined {
    return this.#receipt;
  }
  /** Start a fresh request only when no original response remains uncertain. */
  async write(
    transport: Transport,
    cwd: string,
    path: string,
    content: string,
    options: WriteFileOptions,
    binding?: FileSaveBinding,
    finalDrain = false
  ): Promise<WriteFileResult> {
    if (this.#pending) throw new UnconfirmedFileSaveError();
    this.#receipt = undefined;
    if (!binding) return transport.writeFile(cwd, path, content, options);
    if (!finalDrain && !binding.current()) throw new RetiredFileSaveError();
    const request: Pending = Object.freeze({
      cwd,
      path,
      content,
      options: Object.freeze({
        ...options,
        documentSave: Object.freeze({
          documentId: binding.incarnation.documentId,
          eventId: eventUuid(),
          incarnation: Object.freeze({ ...binding.incarnation }),
        }),
      }),
    });
    this.#pending = request;
    return this.#send(transport, request);
  }
  /** Retry exactly the original UUID, draft, conditional base and full birth. */
  async retry(
    transport: Transport,
    binding: FileSaveBinding
  ): Promise<{ result: WriteFileResult; content: string }> {
    const pending = this.#pending;
    if (
      !pending?.options.documentSave ||
      !binding.current() ||
      !sameCanvasDocIncarnation(pending.options.documentSave.incarnation, binding.incarnation)
    )
      throw new RetiredFileSaveError();
    return { result: await this.#send(transport, pending), content: pending.content };
  }
  async #send(transport: Transport, pending: Pending): Promise<WriteFileResult> {
    try {
      const result = await transport.writeFile(
        pending.cwd,
        pending.path,
        pending.content,
        pending.options
      );
      // Older/custom bridges may answer outside their declared TypeScript contract.
      // Malformed evidence must never release the original request's uncertainty.
      if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean')
        throw new UnconfirmedFileSaveError();
      if (!result.ok) {
        if (
          !result.conflict ||
          typeof result.conflict.currentHash !== 'string' ||
          !result.conflict.currentHash ||
          typeof result.conflict.currentContent !== 'string'
        )
          throw new UnconfirmedFileSaveError();
        this.#pending = undefined;
        return result;
      }
      if (
        typeof result.hash !== 'string' ||
        !result.hash ||
        (result.effect !== 'changed' && result.effect !== 'no_op')
      )
        throw new UnconfirmedFileSaveError();
      const parsed =
        'documentReceipt' in result
          ? FileDocumentSaveReceiptSchema.parse(result.documentReceipt)
          : undefined;
      const original = pending.options.documentSave!;
      if (!parsed && result.effect !== 'no_op') throw new UnconfirmedFileSaveError();
      if (
        parsed &&
        (parsed.documentId !== original.documentId ||
          parsed.eventId !== original.eventId ||
          !sameCanvasDocIncarnation(parsed.incarnation, original.incarnation) ||
          parsed.fileHash !== result.hash ||
          (parsed.status === 'accepted' ? result.effect !== 'changed' : result.effect !== 'no_op'))
      )
        throw new UnconfirmedFileSaveError();
      if (parsed?.status === 'duplicate') {
        // A duplicate proves the old operation, not today's file contents.
        const current = await transport.readFileContent(pending.cwd, pending.path);
        if (
          !current ||
          typeof current !== 'object' ||
          Array.isArray(current) ||
          typeof current.hash !== 'string' ||
          !current.hash ||
          typeof current.content !== 'string'
        )
          throw new UnconfirmedFileSaveError();
        if (current.hash !== parsed.fileHash || current.content !== pending.content) {
          this.#receipt = parsed;
          this.#pending = undefined;
          return {
            ok: false,
            conflict: { currentHash: current.hash, currentContent: current.content },
          };
        }
      }
      this.#receipt = parsed;
      this.#pending = undefined;
      return result;
    } catch (error) {
      if (provenPreEffectFailure(error)) this.#pending = undefined;
      throw error;
    }
  }
}
