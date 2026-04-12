import { ChevronRight } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { CommandPaletteTrigger } from './CommandPaletteTrigger';

interface SessionHeaderProps {
  /** Agent name to display in the breadcrumb, omitted when no agent is active. */
  agentName: string | undefined;
}

/** Session route header — breadcrumb navigation and command palette trigger. */
export function SessionHeader({ agentName }: SessionHeaderProps) {
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
      </nav>
      <div className="flex-1" />
      <div className="flex shrink-0 items-center gap-2">
        <CommandPaletteTrigger />
      </div>
    </>
  );
}
