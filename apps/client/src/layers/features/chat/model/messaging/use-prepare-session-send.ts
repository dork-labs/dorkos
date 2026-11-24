import { useCallback, useEffect, useRef } from 'react';
import { getPendingSessionSettings, useSessionChatStore } from '@/layers/entities/session';
import { useAgentBirthStore } from '@/layers/shared/model';
import type { ChatSessionOptions, TransportErrorInfo } from '../chat-types';

interface SendOptions {
  draft?: boolean;
  kickoff?: boolean;
  clearInput: boolean;
  transform: ChatSessionOptions['transformContent'];
}

/** Confirm draft settings and upload the files selected when Send was pressed. */
export function usePrepareSessionSend(
  sessionId: string | null,
  setError: (error: TransportErrorInfo) => void
) {
  const waiting = useRef<symbol | null>(null);
  useEffect(
    () => () => {
      waiting.current = null;
    },
    [sessionId]
  );

  return useCallback(
    (content: string, { draft, kickoff, clearInput, transform }: SendOptions) => {
      if (waiting.current) return null;
      const pending = draft && sessionId ? getPendingSessionSettings(sessionId) : undefined;
      const ready = (finalContent: string) => ({
        content: finalContent,
        // A settings round trip gives the person time to type their next message.
        clearInput:
          clearInput &&
          (!pending ||
            useSessionChatStore.getState().getSession(sessionId!).input.trim() === content),
      });

      // Finish the upload before adding a bubble, latching Stop, or clearing
      // the composer. A failed upload leaves the original text and files to retry.
      async function upload(transformContent: NonNullable<typeof transform>) {
        try {
          return ready(await transformContent(content));
        } catch (err) {
          setError({
            heading: 'Couldn’t send message',
            message: (err as Error).message || 'The attachment didn’t upload. Try again.',
            retryable: false,
          });
          return null;
        }
      }

      // Capture this render's transform: it holds the attachments selected at
      // Send, while a later render can already hold the next message's files.
      const prepare = () => (!kickoff && transform ? upload(transform) : ready(content));
      if (!pending) return prepare();

      const intent = Symbol();
      waiting.current = intent;
      async function afterSave(confirmation: Promise<boolean>) {
        try {
          let next: Promise<boolean> | undefined = confirmation;
          while (next) {
            const saved = await next;
            if (waiting.current !== intent) return null;
            if (!saved) {
              if (kickoff) {
                useAgentBirthStore.getState().markGreetingFailed(sessionId!);
              } else {
                setError({
                  heading: 'Chat settings didn’t save',
                  message: 'Check your settings, then send again.',
                  retryable: false,
                });
              }
              return null;
            }
            next = getPendingSessionSettings(sessionId!);
          }
          const prepared = await prepare();
          return waiting.current === intent ? prepared : null;
        } finally {
          if (waiting.current === intent) waiting.current = null;
        }
      }
      return afterSave(pending);
    },
    [sessionId, setError]
  );
}
