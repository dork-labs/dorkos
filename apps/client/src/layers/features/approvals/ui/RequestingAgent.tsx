import { agentAvatarVariants } from '@/layers/entities/agent';
import { cn, hashToHslColor } from '@/layers/shared/lib';

/** Glyph for a name with no letter or digit to draw an initial from. */
const FALLBACK_INITIAL = '?';

/** First letter or digit of a name, uppercased. */
function initialOf(name: string): string {
  const match = /\p{L}|\p{N}/u.exec(name);
  return match ? match[0].toUpperCase() : FALLBACK_INITIAL;
}

export interface RequestingAgentProps {
  /**
   * Who asked — an agent path, a display name, or whatever label the request
   * carried. Absent when the requester presented no identity.
   */
  requestedBy?: string;
  className?: string;
}

/**
 * The mark and name of whoever asked for approval.
 *
 * Same visual language as an author in the message list: a letter avatar tinted
 * with a color hashed from the requester's own identity, so one agent always
 * reads as the same color everywhere in the cockpit. An unattributed request —
 * a person on the CLI, an external MCP client with no agent token — says so
 * plainly rather than inventing an agent.
 */
export function RequestingAgent({ requestedBy, className }: RequestingAgentProps) {
  if (!requestedBy) {
    return (
      <span className={cn('text-muted-foreground text-xs', className)}>
        Requested without an agent identity
      </span>
    );
  }

  const label = requestedBy.split('/').filter(Boolean).pop() ?? requestedBy;

  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <span
        data-slot="requesting-agent-avatar"
        aria-hidden
        className={cn(agentAvatarVariants({ size: 'xs' }), 'text-[10px] font-medium')}
        // The tint mixes a per-agent hashed color Tailwind cannot know at build
        // time, the same reason AgentAvatar styles its background inline.
        style={{
          backgroundColor: `color-mix(in oklch, ${hashToHslColor(requestedBy)} 18%, transparent)`,
        }}
      >
        {initialOf(label)}
      </span>
      <span className="text-muted-foreground min-w-0 truncate text-xs">{label}</span>
    </span>
  );
}
