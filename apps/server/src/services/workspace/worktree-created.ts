/**
 * The one event the workspace service raises when it makes a git worktree for
 * a chat (DOR-5265), so the work graph can record that the chat opened the
 * worktree and its branch without this domain importing it. Startup's
 * composition root subscribes the work graph (`startup/steps/work-graph.ts`).
 *
 * @module server/services/workspace/worktree-created
 */
import { logger } from '../../lib/logger.js';

/** A worktree the workspace service made for a chat. */
export interface WorktreeCreatedForChat {
  /** The chat it was made for, as its caller named it. */
  chatId: string;
  /** The worktree's folder name, never a path. */
  worktree: string;
  /** The branch it checked out, as given to `git worktree add -b`. */
  branch: string;
}

const listeners = new Set<(event: WorktreeCreatedForChat) => void>();

/**
 * Hear each worktree the workspace service makes for a chat, once it is
 * ready. A reused workspace, a clone, and a worktree made with no chat are not
 * heard. A listener that throws is logged and never fails the create.
 *
 * @param listener - Called once per new worktree made for a chat.
 * @returns A function that stops listening.
 */
export function onWorkspaceWorktreeCreated(
  listener: (event: WorktreeCreatedForChat) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Tell every listener a worktree was made for a chat. Never throws.
 *
 * @param event - The chat, the worktree's folder name and its branch.
 */
export function announceWorktreeCreated(event: WorktreeCreatedForChat): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      logger.warn('[workspace] a worktree listener failed; the worktree stands', {
        chatId: event.chatId,
        worktree: event.worktree,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
