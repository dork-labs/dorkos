import { useMemo } from 'react';
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

/** Renders markdown content via Streamdown with link safety confirmation and a streaming cursor. */
export function StreamingText({
  content,
  isStreaming = false,
  textEffect = DEFAULT_TEXT_EFFECT,
  sessionId,
  isLatestMessage,
}: StreamingTextProps) {
  const animatedConfig = resolveStreamdownAnimation(textEffect);

  // Render ` ```dorkos-ui ` fences as native widgets instead of code blocks (ADR
  // 260708-111500). Streamdown passes `isIncomplete` so the widget renders a
  // skeleton while its fence streams (D3). The renderer is bound per-session so
  // `agent` widget actions can post back to THIS session (gen-ui §3), and it
  // knows whether this text is still streaming so a truncated-at-a-chunk-boundary
  // fence holds the skeleton instead of flashing the error card.
  const widgetPlugins = useMemo(
    () => ({
      renderers: [
        {
          language: 'dorkos-ui',
          component: (props: { code: string; isIncomplete: boolean }) => (
            <WidgetFence
              {...props}
              sessionId={sessionId}
              isLatestMessage={isLatestMessage}
              streaming={isStreaming}
            />
          ),
        },
      ],
    }),
    [sessionId, isLatestMessage, isStreaming]
  );

  return (
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
  );
}
