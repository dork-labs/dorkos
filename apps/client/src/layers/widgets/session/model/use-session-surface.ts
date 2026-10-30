/**
 * How the session on screen is drawn: as a session, or as a direct message with
 * one agent (DOR-3074), and what the empty composer says either way.
 *
 * @module widgets/session/model/use-session-surface
 */
import { useMemo } from 'react';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { getAgentDisplayName } from '@/layers/shared/lib';
import { useConfig, useShowSessions } from '@/layers/entities/config';
import { useDirectMessageAgent, useDirectMessageView } from '@/layers/features/direct-message';
import type { MessageAuthorAgent } from '@/layers/features/chat';

/** What a chat drawn as a DM needs beyond what a session already reads. */
export interface DirectMessageSurface {
  /**
   * The agent this DM is with, for every reply's face and name. `null` until
   * its manifest arrives, when the transcript keeps its own resolution.
   */
  agent: MessageAuthorAgent | null;
  /**
   * What the person is called on their own messages, the way a room names them.
   * `null` when they have not given a name, and the row says "You".
   */
  humanName: string | null;
  /**
   * Whether this chat is a DM for certain. `false` while the server has not
   * said yet: the chat is drawn neutral (none of the session's chrome) but
   * keeps its own names, so nothing is renamed on the way to an answer.
   */
  settled: boolean;
}

/** The surface a session's conversation is drawn as. */
export interface SessionSurface {
  /**
   * Set while this chat reads as a DM, or might (`settled: false`); `null` for
   * a session like any other.
   */
  directMessage: DirectMessageSurface | null;
  /**
   * What the person is called on their own messages in any chat, DM or not
   * (FB-38/55). `null` when they have not given a name, and the row says "You".
   */
  humanName: string | null;
  /** The two above, as the transcript takes them: `<SessionTranscript {...transcriptNames} />`. */
  transcriptNames: Pick<SessionSurface, 'directMessage' | 'humanName'>;
  /** What the empty composer says. */
  placeholder: string;
  /**
   * Whether the line over the composer leaves out the turn's time and tokens:
   * session detail, which a DM keeps behind Show sessions.
   */
  quietTurnNumbers: boolean;
}

/**
 * Decide how the conversation on screen is drawn.
 *
 * With the DM view off (or for any chat that is not an agent's Direct chat,
 * or for the session view behind one) this is exactly what the chat panel
 * said before: no DM, and "Message <agent>…" for the agent at the folder.
 *
 * @param sessionId - The session on screen.
 * @param composerAgent - The agent registered at the working directory.
 */
export function useSessionSurface(
  sessionId: string | null,
  composerAgent: AgentManifest | null | undefined
): SessionSurface {
  const view = useDirectMessageView(sessionId);
  const isDm = view.mode === 'dm' && view.chat !== null;
  const pending = view.mode === 'pending';
  const dmAgent = useDirectMessageAgent(isDm ? view.chat!.agentPath : null);
  const { data: config } = useConfig();
  const showSessions = useShowSessions();
  const humanName = config?.profile?.displayName?.trim() || null;
  const composerName = composerAgent ? getAgentDisplayName(composerAgent) : null;
  const { id, name } = dmAgent;
  const emoji = dmAgent.visual?.emoji ?? null;
  const color = dmAgent.visual?.color ?? null;

  // One object per change of what it says, never per render: the transcript
  // keys its author resolver on it, and a fresh one each render would lay the
  // whole conversation out again on every streamed word (DOR-2912).
  const directMessage = useMemo<DirectMessageSurface | null>(() => {
    if (pending) return { agent: null, humanName: null, settled: false };
    if (!isDm) return null;
    return {
      // Keyed by the manifest id and faced from the manifest, exactly as the
      // transcript resolves the agent at the folder, so the two cannot differ.
      agent:
        id !== null && name !== null && emoji !== null && color !== null
          ? { id, displayName: name, emoji, color }
          : null,
      humanName,
      settled: true,
    };
  }, [pending, isDm, id, name, emoji, color, humanName]);

  if (directMessage === null) {
    return {
      directMessage: null,
      humanName,
      transcriptNames: { directMessage: null, humanName },
      placeholder: composerName ? `Message ${composerName}…` : 'Send a message…',
      quietTurnNumbers: false,
    };
  }
  const dmName = name ?? composerName;
  return {
    directMessage,
    humanName,
    transcriptNames: { directMessage, humanName },
    // A room's box names who it reaches, with no trailing ellipsis.
    placeholder: dmName ? `Message ${dmName}` : 'Send a message',
    quietTurnNumbers: !showSessions,
  };
}
