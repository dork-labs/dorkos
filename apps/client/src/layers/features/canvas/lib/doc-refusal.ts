/**
 * Reading a refusal from the canvas document routes (`/api/canvas/docs`).
 *
 * The routes answer a problem document whose `detail` is a sentence written
 * for a person, naming which of the document channel's refusals it was. Its
 * `code` is `precondition_failed` when what the person reviewed changed, so
 * the review is read again.
 *
 * @module features/canvas/lib/doc-refusal
 */
import { serverSentence } from '@/layers/shared/lib';

/**
 * Whether a refusal means what the person reviewed changed since.
 *
 * @param error - The error the transport threw.
 */
export function isDocReviewChanged(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === 'precondition_failed';
}

/**
 * What to tell a person when a document request was refused: the server's
 * own sentence, else a line for a request that never reached DorkOS, else
 * the caller's fallback.
 *
 * @param error - The error the transport threw.
 * @param fallback - The line for a failure with no sentence of its own.
 */
export function docRefusalSentence(error: unknown, fallback: string): string {
  const said = serverSentence(error);
  if (said !== null && (error as { code?: unknown }).code !== 'internal_error') return said;
  if (error instanceof TypeError) return 'Couldn’t reach DorkOS. Check your connection.';
  return fallback;
}
