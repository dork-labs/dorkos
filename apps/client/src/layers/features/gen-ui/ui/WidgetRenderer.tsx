import { motion } from 'motion/react';
import type { WidgetDocument } from '@dorkos/shared/ui-widget';
import { WidgetActionProvider } from '../model/widget-context';
import { useWidgetMotion, widgetEntrance } from '../lib/widget-motion';
import { WidgetNodeView } from './WidgetNodeView';

interface WidgetRendererProps {
  /** A validated widget document (parse untrusted input with `parseWidget` first). */
  document: WidgetDocument;
  /**
   * The session that rendered this widget. Required to dispatch `agent`-kind
   * actions through the interactivity return channel; omit for surfaces with no
   * session target (e.g. the dev playground), where `agent` actions stay disabled.
   */
  sessionId?: string;
  /**
   * Whether this widget is rendered in the LATEST message of the conversation.
   * Defaults to `true`. `false` supersedes the widget: its `agent` actions
   * render inert so a stale board can't accept a move.
   */
  isLatestMessage?: boolean;
}

/**
 * Render a validated widget document. Wraps the tree in the action provider so
 * interactive nodes can dispatch `ui`/`url`/`agent` actions; the document `title`
 * labels the region for assistive tech and is forwarded to the agent on `agent`
 * actions so it knows which widget fired.
 *
 * @param document - A validated {@link WidgetDocument}
 * @param sessionId - Session that rendered the widget (enables `agent` actions)
 * @param isLatestMessage - Whether the widget is in the latest message (else superseded)
 */
export function WidgetRenderer({ document, sessionId, isLatestMessage }: WidgetRendererProps) {
  const motionOn = useWidgetMotion();
  return (
    <WidgetActionProvider
      sessionId={sessionId}
      widgetTitle={document.title}
      isLatestMessage={isLatestMessage}
    >
      <motion.section
        aria-label={document.title ?? 'Widget'}
        className="text-sm"
        variants={motionOn ? widgetEntrance : undefined}
        initial={motionOn ? 'hidden' : false}
        animate={motionOn ? 'visible' : false}
      >
        <WidgetNodeView node={document.root} />
      </motion.section>
    </WidgetActionProvider>
  );
}
