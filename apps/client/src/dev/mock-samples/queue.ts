import type { QueueItem } from '@/layers/features/chat/model/use-message-queue';
import { queueDowngradeNotice } from '@/layers/features/chat/lib/queue-chips';
import { createQueueItem } from '../mock-factories';

/**
 * Composer queue fixtures — a plain queue, and one whose rows carry mixed
 * origins and a downgrade notice.
 *
 * @module dev/mock-samples/queue
 */
export const SAMPLE_QUEUE: QueueItem[] = [
  createQueueItem({ content: 'Then add error handling to the auth endpoint' }),
  createQueueItem({ content: 'Finally, update the API docs' }),
  createQueueItem({ content: '/test src/auth.test.ts' }),
];

/** A queue whose rows did not all come from this window, and one with a notice. */
export const SAMPLE_QUEUE_MIXED_ORIGINS: QueueItem[] = [
  createQueueItem({ content: 'Then add error handling to the auth endpoint' }),
  createQueueItem({ content: 'Finally, update the API docs', mine: false }),
  createQueueItem({
    content: 'And change course on the migration',
    // The real notice, through the real mapping — so the showcase shows exactly
    // what a person sees when a steer is queued because the runtime cannot steer.
    notice: queueDowngradeNotice({
      messageId: 'demo-downgraded',
      requested: 'steer',
      applied: 'queue',
      degradedBecause: 'unsupported',
    }),
  }),
];
