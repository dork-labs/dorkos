import { ChevronRight, Folder } from 'lucide-react';
import { AgentAvatar } from '@/layers/entities/agent';
import { getOriginDescriptor, SessionOriginMark } from '@/layers/entities/session';
import { useOneBarState } from '../model/one-bar-context';
import { OneBar } from './OneBar';

/** What the bar calls a session the runtime has not titled yet. */
const NEW_SESSION_LABEL = 'New session';

/**
 * `/session` route bar — who you are talking to, and which conversation.
 *
 * This used to be a breadcrumb ("Team › DorkBot › Session"), which spent the
 * widest zone of the bar on two words that are true of every session and never
 * said which of your forty conversations you were reading. The identity is the
 * agent's face and name, then the session's own title (D1).
 *
 * **Nothing is fetched here.** The agent, its visual, the title and the origin
 * are all resolved once by the shell and ride `useOneBarState` — the title is
 * the same runtime-owned string the sidebar rows render, out of the same cache,
 * so the bar cannot disagree with the list you picked the session from. It also
 * means the title arriving after the first turn updates the bar in place: the
 * global session stream patches that cache, and this re-renders.
 *
 * The origin chip is a quiet, adjacent segment (icon + label) shown only when
 * the session did not start from you talking to the agent directly
 * (session-origin-legibility).
 */
export function SessionHeader() {
  const { agentName, agentVisual, sessionTitle, sessionDirectoryName, origin, originLabel } =
    useOneBarState();
  const descriptor = getOriginDescriptor(origin);
  const originText = originLabel ?? descriptor?.label;
  // A session with no registered agent is a bare directory, and the honest name
  // for it is the directory's (spec §5.3). The favicon's hash-a-face-from-cwd
  // fallback is deliberately NOT reached for: a face implies an agent.
  const name = agentName ?? sessionDirectoryName ?? 'Session';
  const title = sessionTitle?.trim() ? sessionTitle : NEW_SESSION_LABEL;

  return (
    <OneBar
      identity={
        <div className="flex min-w-0 items-center gap-1.5 text-sm">
          {agentVisual ? (
            // 18px is the same glyph slot the sidebar's session rows use, so the
            // face in the bar and the face in the list are the same size. No
            // badge: the Bot mark disambiguates a column of identities, and this
            // is one identity in a 36px row.
            <AgentAvatar
              color={agentVisual.color}
              emoji={agentVisual.emoji}
              size="xs"
              badge={null}
            />
          ) : (
            <Folder
              className="text-muted-foreground size-4 shrink-0"
              data-testid="session-directory-mark"
              aria-hidden
            />
          )}
          {/* The name holds its width and the title yields (I2): which agent you
              are talking to is the fact that survives a narrow bar. The cap is a
              guard against a pathologically long rename blowing the row open —
              it does not bite any plausible name. */}
          <span className="max-w-[20ch] shrink-0 truncate font-medium" title={name}>
            {name}
          </span>
          <ChevronRight className="text-muted-foreground/50 size-3 shrink-0" aria-hidden />
          <span className="text-muted-foreground min-w-0 truncate" title={title}>
            {title}
          </span>
        </div>
      }
      chips={
        descriptor ? (
          <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-sm">
            <SessionOriginMark origin={origin} label={originText} decorative />
            {originText}
          </span>
        ) : null
      }
    />
  );
}
