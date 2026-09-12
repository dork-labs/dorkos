/**
 * The Streamdown registration that turns a ` ```dorkos-ui ` fence into a
 * rendered widget on a surface with no session behind it.
 *
 * A session's own transcript registers its own (`features/chat`'s
 * `StreamingText`), because there the fence has a session to post `agent`
 * actions into, a supersede rule, and a streaming state — three things that
 * travel by context and only exist in a session. A room message has none of
 * them: it is a settled, posted entry, so the widget it carries is read-only.
 * `ui` and `url` actions still run — they resolve inside this browser tab —
 * and `agent` actions render inert with the tooltip the action provider
 * already shows off a session ({@link WidgetActionProvider}), which is the
 * honest sentence rather than a second one invented for rooms.
 *
 * @module features/gen-ui/ui/widget-fence-renderers
 */
import type { CustomRenderer } from 'streamdown';
import { WIDGET_FENCE_LANGUAGE } from '../lib/find-latest-widget-fence';
import { WidgetFence } from './WidgetFence';

/**
 * A fence on a surface with no session: no `sessionId`, so `agent` actions are
 * unavailable, and no streaming state, because the body it sits in was posted
 * whole. Module scope, and a named function rather than an inline closure: the
 * component IDENTITY Streamdown is handed must be stable across renders, or
 * React remounts the whole widget tree every time the hosting row re-renders.
 *
 * @param props - The fence's raw body and whether it is still unclosed, from
 *   Streamdown. Its other renderer props (`language`, `meta`) are ignored.
 */
function ReadOnlyWidgetFence(props: { code: string; isIncomplete: boolean }) {
  return <WidgetFence code={props.code} isIncomplete={props.isIncomplete} />;
}

/**
 * Streamdown `plugins.renderers` entry for read-only widget fences — pass it to
 * a {@link MarkdownContent}'s `renderers` prop.
 *
 * A module-scope constant so every caller passes the SAME array reference:
 * Streamdown's top-level memo compares `plugins` by identity, and a fresh array
 * per render would re-render every markdown body on screen on every keystroke
 * elsewhere in the room.
 */
export const READ_ONLY_WIDGET_FENCE_RENDERERS: CustomRenderer[] = [
  { language: WIDGET_FENCE_LANGUAGE, component: ReadOnlyWidgetFence },
];
