import { ChevronRight } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { getOriginDescriptor, SessionOriginMark } from '@/layers/entities/session';
import { useOneBarState } from '../model/one-bar-context';
import { OneBar } from './OneBar';

/**
 * `/session` route bar — breadcrumb navigation and an origin chip for non-user
 * sessions.
 *
 * The origin chip is a quiet, breadcrumb-adjacent segment (icon + label) shown
 * only when the session did not start from you talking to the agent directly
 * (session-origin-legibility).
 *
 * This used to hand-roll the row's layout — its own spacer, its own copy of the
 * search button — which is exactly how a bar drifts out of step with every other
 * bar. It composes {@link OneBar} now, so the fixed cluster is the same object
 * here as everywhere else. The breadcrumb's *content* is unchanged; phase S1
 * replaces it with agent avatar › session title.
 */
export function SessionHeader() {
  const { agentName, origin, originLabel } = useOneBarState();
  const descriptor = getOriginDescriptor(origin);
  const originText = originLabel ?? descriptor?.label;

  return (
    <OneBar
      identity={
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
          <Link
            to="/team"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            Team
          </Link>
          {agentName && (
            <>
              <ChevronRight className="text-muted-foreground/50 size-3 shrink-0" aria-hidden />
              <span className="truncate font-medium">{agentName}</span>
            </>
          )}
          <ChevronRight className="text-muted-foreground/50 size-3 shrink-0" aria-hidden />
          <span className="text-muted-foreground">Session</span>
          {descriptor && (
            <>
              <ChevronRight className="text-muted-foreground/50 size-3 shrink-0" aria-hidden />
              <span className="text-muted-foreground flex shrink-0 items-center gap-1">
                <SessionOriginMark origin={origin} label={originText} decorative />
                {originText}
              </span>
            </>
          )}
        </nav>
      }
    />
  );
}
