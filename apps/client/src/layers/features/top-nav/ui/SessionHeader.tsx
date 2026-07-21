import { ChevronRight } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import type { SessionOrigin } from '@dorkos/shared/types';
import { getOriginDescriptor, OriginMark } from '@/layers/entities/session';
import { CommandPaletteTrigger } from './CommandPaletteTrigger';

interface SessionHeaderProps {
  /** Agent name to display in the breadcrumb, omitted when no agent is active. */
  agentName: string | undefined;
  /** Active session's resolved origin. Absent/`'user'` shows no chip. */
  origin?: SessionOrigin;
  /** Active session's own origin label, preferred over the descriptor's fallback. */
  originLabel?: string;
}

/**
 * Session route header — breadcrumb navigation, an origin chip for non-user
 * sessions, and the command palette trigger. The origin chip is a quiet,
 * breadcrumb-adjacent segment (icon + label) shown only when the session
 * did not start from you talking to the agent directly (session-origin-legibility).
 */
export function SessionHeader({ agentName, origin, originLabel }: SessionHeaderProps) {
  const descriptor = getOriginDescriptor(origin);
  const originText = originLabel ?? descriptor?.label;

  return (
    <>
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm">
        <Link
          to="/agents"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          Agents
        </Link>
        {agentName && (
          <>
            <ChevronRight className="text-muted-foreground/50 size-3" aria-hidden />
            <span className="font-medium">{agentName}</span>
          </>
        )}
        <ChevronRight className="text-muted-foreground/50 size-3" aria-hidden />
        <span className="text-muted-foreground">Session</span>
        {descriptor && (
          <>
            <ChevronRight className="text-muted-foreground/50 size-3" aria-hidden />
            <span className="text-muted-foreground flex items-center gap-1">
              <OriginMark origin={origin} label={originText} />
              {originText}
            </span>
          </>
        )}
      </nav>
      <div className="flex-1" />
      <div className="flex shrink-0 items-center gap-2">
        <CommandPaletteTrigger />
      </div>
    </>
  );
}
