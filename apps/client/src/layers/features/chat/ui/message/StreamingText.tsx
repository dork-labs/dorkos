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
}

const linkSafety = {
  enabled: true,
  renderModal: (props: LinkSafetyModalProps) => <LinkSafetyModal {...props} />,
};

// Render ` ```dorkos-ui ` fences as native widgets instead of code blocks
// (ADR 260708-111500). Streamdown passes `isIncomplete` so the widget renders a
// skeleton while its fence is still streaming (D3).
const widgetPlugins = {
  renderers: [{ language: 'dorkos-ui', component: WidgetFence }],
};

/** Renders markdown content via Streamdown with link safety confirmation and a streaming cursor. */
export function StreamingText({
  content,
  isStreaming = false,
  textEffect = DEFAULT_TEXT_EFFECT,
}: StreamingTextProps) {
  const animatedConfig = resolveStreamdownAnimation(textEffect);

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
