import { createContext, useContext, useMemo } from 'react';
import type { TextEffectConfig } from '@/layers/shared/lib';
import type { InteractiveToolHandle } from './types';

/**
 * Shared values provided to all message sub-components via React Context.
 * Eliminates prop drilling of session and interaction state.
 */
interface MessageContextValue {
  sessionId: string;
  isStreaming: boolean;
  /**
   * Whether no NEWER fence-bearing message exists (fence-based supersede,
   * DOR-302). Threaded to widget fences: only a newer widget fence stales one.
   */
  isLatestWidgetMessage: boolean;
  activeToolCallId: string | null;
  onToolRef: ((handle: InteractiveToolHandle | null) => void) | undefined;
  focusedOptionIndex: number;
  onToolDecided: ((toolCallId: string, answers?: Record<string, string>) => void) | undefined;
  onRetry?: () => void;
  /** Tool call ID being handled in the input zone, or null. */
  inputZoneToolCallId: string | null;
  /** Text animation effect for streaming text. When undefined, StreamingText uses its default. */
  textEffect?: TextEffectConfig;
  /**
   * Display name of the session's runtime (e.g. "Claude"), resolved once at the
   * panel level. Personalizes the auth-error copy in an inline error block.
   * Undefined when the session has no runtime row yet.
   */
  runtimeLabel?: string;
}

const MessageCtx = createContext<MessageContextValue | null>(null);

/**
 * Provider that wraps message sub-components with shared context values.
 * Uses field-level memoization to prevent re-renders when the parent
 * re-creates the value object but individual fields haven't changed.
 */
export function MessageProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: MessageContextValue;
}) {
  const memoized = useMemo(
    () => value,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      value.sessionId,
      value.isStreaming,
      value.isLatestWidgetMessage,
      value.activeToolCallId,
      value.onToolRef,
      value.focusedOptionIndex,
      value.onToolDecided,
      value.onRetry,
      value.inputZoneToolCallId,
      value.textEffect,
      value.runtimeLabel,
    ]
  );
  return <MessageCtx value={memoized}>{children}</MessageCtx>;
}

/**
 * Hook to consume MessageContext. Must be used within a MessageProvider.
 * Throws if called outside the provider boundary.
 */
export function useMessageContext(): MessageContextValue {
  const ctx = useContext(MessageCtx);
  if (!ctx) throw new Error('useMessageContext must be used within MessageProvider');
  return ctx;
}
