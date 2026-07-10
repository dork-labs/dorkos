import { createContext, useContext, useMemo } from 'react';
import { Streamdown } from 'streamdown';
import type { LinkSafetyModalProps } from 'streamdown';
import { cn, DEFAULT_TEXT_EFFECT, resolveStreamdownAnimation } from '@/layers/shared/lib';
import type { TextEffectConfig } from '@/layers/shared/lib';
import { LinkSafetyModal } from '@/layers/shared/ui';
import { WidgetFence } from '@/layers/features/gen-ui';
import 'streamdown/styles.css';

interface StreamingTextProps {
  content: string;
  isStreaming?: boolean;
  /** Text animation effect applied during streaming. Defaults to blur-in at word level. */
  textEffect?: TextEffectConfig;
  /**
   * The session this text belongs to. Threaded into `dorkos-ui` widget fences so
   * their `agent`-kind actions can POST back to the session (gen-ui §3). Omit off
   * a session (agent widget actions then render disabled).
   */
  sessionId?: string;
  /**
   * Whether the hosting message is the latest in the conversation. Threaded into
   * widget fences so a superseded board renders its `agent` actions inert.
   */
  isLatestMessage?: boolean;
}

const linkSafety = {
  enabled: true,
  renderModal: (props: LinkSafetyModalProps) => <LinkSafetyModal {...props} />,
};

/** The message-scoped values a `dorkos-ui` fence needs beyond its own code. */
interface FenceContextValue {
  sessionId?: string;
  isLatestMessage?: boolean;
  isStreaming: boolean;
}

/**
 * Carries the hosting message's session/supersede/streaming state to fence
 * renderers via context instead of closure props. The fence component's
 * IDENTITY must stay stable across renders: an inline closure recreated when
 * `isLatestMessage` or `isStreaming` changed made React unmount and remount the
 * entire widget tree at exactly the moments that matter — a click on a board
 * cell flips `isLatestMessage` (the optimistic user message supersedes the
 * widget), and the remount destroyed the in-flight dispatch state, erasing the
 * just-drawn optimistic mark and replaying every entrance animation.
 */
const FenceContext = createContext<FenceContextValue>({ isStreaming: false });

/**
 * Streamdown renderer for ` ```dorkos-ui ` fences — a module-scope component
 * (stable identity, see {@link FenceContext}) that merges the fence's own
 * props with the hosting message's context.
 */
function DorkosUiFence(props: { code: string; isIncomplete: boolean }) {
  const ctx = useContext(FenceContext);
  return <WidgetFence {...props} {...ctx} />;
}

/**
 * Render ` ```dorkos-ui ` fences as native widgets instead of code blocks (ADR
 * 260708-111500). Streamdown passes `isIncomplete` so the widget renders a
 * skeleton while its fence streams (D3); session binding, supersede state, and
 * streaming state arrive via {@link FenceContext}.
 */
const widgetPlugins = {
  renderers: [{ language: 'dorkos-ui', component: DorkosUiFence }],
};

/** Renders markdown content via Streamdown with link safety confirmation and a streaming cursor. */
export function StreamingText({
  content,
  isStreaming = false,
  textEffect = DEFAULT_TEXT_EFFECT,
  sessionId,
  isLatestMessage,
}: StreamingTextProps) {
  const animatedConfig = resolveStreamdownAnimation(textEffect);

  const fenceContext = useMemo<FenceContextValue>(
    () => ({ sessionId, isLatestMessage, isStreaming }),
    [sessionId, isLatestMessage, isStreaming]
  );

  return (
    <FenceContext.Provider value={fenceContext}>
      <div className={cn('relative', isStreaming && 'streaming-cursor')}>
        <Streamdown
          shikiTheme={['github-light', 'github-dark']}
          linkSafety={linkSafety}
          animated={animatedConfig}
          isAnimating={isStreaming}
          plugins={widgetPlugins}
        >
          {content}
        </Streamdown>
      </div>
    </FenceContext.Provider>
  );
}
