/**
 * Which chats just picked their stream up from a cursor instead of a snapshot
 * (DOR-2913).
 *
 * A resumed stream replays what happened while the chat was closed, turn by
 * turn, and a replayed reply settling looks exactly like a live one. The
 * end-of-turn hook still reloads history for it (that is needed), but must not
 * ring "your reply is ready" for a reply that finished while the person was
 * elsewhere. This is how it hears that a resume happened.
 *
 * @module entities/session/model/stream/stream-resume-marks
 */
import { create } from 'zustand';

interface ResumeMarks {
  /** Per chat: how many resumes so far, to re-run effects keyed on it. */
  generations: Record<string, number>;
  /** Chats resumed since their hook last looked. */
  pending: Record<string, true>;
}

const useResumeMarks = create<ResumeMarks>(() => ({ generations: {}, pending: {} }));

/**
 * Record that a chat's stream is resuming from a cursor.
 *
 * @param sessionId - The chat.
 */
export function markStreamResumed(sessionId: string): void {
  useResumeMarks.setState((state) => ({
    generations: { ...state.generations, [sessionId]: (state.generations[sessionId] ?? 0) + 1 },
    pending: { ...state.pending, [sessionId]: true },
  }));
}

/**
 * Whether a chat resumed since this was last asked, clearing the answer.
 *
 * @param sessionId - The chat.
 */
export function takeStreamResume(sessionId: string): boolean {
  if (!useResumeMarks.getState().pending[sessionId]) return false;
  useResumeMarks.setState((state) => {
    const { [sessionId]: _taken, ...pending } = state.pending;
    return { pending };
  });
  return true;
}

/**
 * How many times a chat's stream has resumed, for effects to re-run on.
 *
 * @param sessionId - The chat, or null.
 */
export function useStreamResumeGeneration(sessionId: string | null): number {
  return useResumeMarks((state) => (sessionId ? (state.generations[sessionId] ?? 0) : 0));
}
