/** Existing read-only transcript projections, with caller resolution retained inside error handling. */
import type { TranscriptReader } from '../sessions/transcript-reader.js';
import { logger } from '../../../../lib/logger.js';

/** The transcript carries token count, never a known context window. */
export async function readTranscriptContextUsage(
  reader: Pick<TranscriptReader, 'getSession'>,
  resolve: () => { projectDir: string; historyId: string }
): Promise<{ contextTokens: number; contextMaxTokens: number } | null> {
  try {
    const { projectDir, historyId } = resolve();
    const session = await reader.getSession(projectDir, historyId);
    if (!session?.contextTokens) return null;
    return { contextTokens: session.contextTokens, contextMaxTokens: 0 };
  } catch {
    return null;
  }
}

/** Last actual user/assistant IDs, preserving existing null and warning behavior. */
export async function readTranscriptMessageIds(
  sessionId: string,
  reader: Pick<TranscriptReader, 'readTranscript'>,
  projectDirOf: () => string
): Promise<{ user: string; assistant: string } | null> {
  try {
    const projectDir = projectDirOf();
    const messages = await reader.readTranscript(projectDir, sessionId);
    if (!messages.length) return null;

    let lastUser: string | null = null;
    let lastAssistant: string | null = null;

    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!lastAssistant && m.role === 'assistant') lastAssistant = m.id;
      if (!lastUser && m.role === 'user') lastUser = m.id;
      if (lastUser && lastAssistant) break;
    }

    if (!lastUser || !lastAssistant) return null;
    return { user: lastUser, assistant: lastAssistant };
  } catch (err) {
    logger.warn('[getLastMessageIds] failed to read transcript', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
