import type { QueueItem } from '@/layers/features/chat/model/use-message-queue';
import type { AgentQueueActions } from '@/layers/features/chat/model/messaging/use-agent-queue-actions';
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
  // From other chats (DOR-3060). A long chat title, to show the title
  // truncates while the agent's name does not.
  createQueueItem({
    content: 'Two packages in the lockfile have a fix waiting. Bump them before the cut.',
    mine: false,
    fromChat: true,
    sender: {
      agentName: 'Security',
      chatId: 'demo-chat-security',
      chatTitle: 'Dependency audit for the 0.126 release candidate',
      summary: 'Two lockfile fixes to bump before the cut',
    },
  }),
  // A sender whose chat could not be read: the row says it can't open. Its
  // long name wraps to a second line rather than truncating.
  createQueueItem({
    content: 'The docs for the queue panel are ready for a look.',
    mine: false,
    fromChat: true,
    sender: {
      agentName: 'Release Notes and Docs Writer for the Desktop App',
      chatId: 'demo-chat-unreadable',
    },
  }),
  // A sender that cannot be named at all: "Another chat".
  createQueueItem({
    content: 'Heads up: the nightly run finished with one warning.',
    mine: false,
    fromChat: true,
    sender: null,
  }),
];

/** Send now and Don't deliver that do nothing, for the queue showcase. */
export const SAMPLE_AGENT_ACTIONS: AgentQueueActions = {
  sendNow: () => {},
  dontDeliver: () => {},
  notices: {},
  sending: new Set(),
};

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
