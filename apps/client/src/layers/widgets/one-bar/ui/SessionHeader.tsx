import { ChevronRight, Folder } from 'lucide-react';
import { AgentAvatar } from '@/layers/entities/agent';
import {
  getOriginDescriptor,
  SessionOriginMark,
  sessionDisplayTitle,
} from '@/layers/entities/session';
import { useOneBarState } from '../model/one-bar-context';
import { useLastKnownAgent } from '../model/use-last-known-agent';
import { OneBar } from './OneBar';

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
 * the same runtime-owned string the sidebar rows render, out of the same cache
 * and through the same {@link sessionDisplayTitle} helper, so the bar cannot
 * disagree with the list you picked the session from. It also means the title
 * arriving after the first turn updates the bar in place: the global session
 * stream patches that cache, and this re-renders.
 *
 * **Truncation (I2), and the thing to get right here.** Three items compete for
 * one 36px row and all three are user-controlled: an agent's display name, a
 * session's title, and an origin label that arrives from a bridged Telegram or
 * Slack room. They yield in a fixed order — origin label first (it collapses to
 * its icon, which keeps its meaning in a tooltip), then the title, then the
 * name — and every one of them keeps a floor, because the failure this ordering
 * exists to prevent is not an ugly bar. It is `shrink-0` on all three at once,
 * which does not truncate anything: it overflows the row and paints the
 * identity straight through the chip.
 */
export function SessionHeader() {
  const {
    sessionId,
    agentName,
    agentVisual,
    sessionTitle,
    sessionDirectoryName,
    origin,
    originLabel,
  } = useOneBarState();
  // An agent deleted mid-session must not blink the bar over to a folder icon
  // and a directory name (spec §5.3). The conversation on screen is still the
  // one that agent was having, and its name is still the truest thing the bar
  // can say about it.
  const { name: heldName, visual: heldVisual } = useLastKnownAgent(
    sessionId,
    agentName,
    agentVisual
  );
  const descriptor = getOriginDescriptor(origin);
  const originText = originLabel ?? descriptor?.label;
  // A session with no registered agent — and none ever seen — is a bare
  // directory, and the honest name for it is the directory's. The favicon's
  // hash-a-face-from-cwd fallback is deliberately NOT reached for: a face
  // implies an agent.
  const name = heldName ?? sessionDirectoryName ?? 'Session';
  const title = sessionDisplayTitle(sessionTitle ?? '');

  return (
    <OneBar
      identity={
        <div className="flex min-w-0 shrink items-center gap-1.5 text-sm">
          {heldVisual ? (
            // 18px is the same glyph slot the sidebar's session rows use, so the
            // face in the bar and the face in the list are the same size. No
            // badge: the Bot mark disambiguates a column of identities, and this
            // is one identity in a 36px row.
            <AgentAvatar color={heldVisual.color} emoji={heldVisual.emoji} size="xs" badge={null} />
          ) : (
            <Folder
              className="text-muted-foreground size-4 shrink-0"
              data-testid="session-directory-mark"
              aria-hidden
            />
          )}
          {/* Shrink weights, not shrink-0: which agent you are talking to is the
              fact worth keeping, so the name yields last — but it still yields,
              and it still stops at a floor wide enough to read a few letters
              plus the ellipsis. */}
          <span
            className="min-w-[3.5rem] shrink truncate font-medium"
            data-testid="session-agent-name"
            title={name}
          >
            {name}
          </span>
          <ChevronRight className="text-muted-foreground/50 size-3 shrink-0" aria-hidden />
          <span
            className="text-muted-foreground min-w-[3rem] shrink-[9999] truncate"
            data-testid="session-title"
            title={title}
          >
            {title}
          </span>
        </div>
      }
      chips={
        descriptor ? (
          <span
            className="text-muted-foreground flex max-w-[12rem] min-w-0 shrink items-center gap-1 text-sm"
            data-testid="session-origin-chip"
          >
            {/* Not decorative below the threshold: once the words are gone the
                icon is the only origin signal left, so it has to carry the
                label itself — which is exactly the mode this component already
                has. Above the threshold the visible text would be announced
                twice, so it goes back to decorative. */}
            {/* `min-w-0` is load-bearing, not tidying. A flex item's automatic
                minimum size is its CONTENT, so without it this wrapper refuses
                to shrink, the `truncate` below never engages, and the label
                spills straight past the 12rem cap on its parent — measured at
                +182px, painting over the fixed cluster. The cap only caps a box
                that is allowed to get smaller. */}
            <span className="inline-flex min-w-0 items-center gap-1 @max-md/bar:hidden">
              <SessionOriginMark origin={origin} label={originText} decorative />
              <span className="min-w-0 truncate" title={originText}>
                {originText}
              </span>
            </span>
            <span className="hidden @max-md/bar:inline-flex">
              <SessionOriginMark origin={origin} label={originText} />
            </span>
          </span>
        ) : null
      }
    />
  );
}
