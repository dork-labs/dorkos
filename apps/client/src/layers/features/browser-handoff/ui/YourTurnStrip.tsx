import { Hand } from 'lucide-react';
import { cardAgentName } from '../lib/agent-name';

/** Props for {@link YourTurnStrip}. */
export interface YourTurnStripProps {
  /** The asking agent's name, or null when the call carried no identity. */
  agentName: string | null;
}

/**
 * "Your turn: {agent} can't see or use this window." One strip for the handoff card
 * and the Agent browser panel, so both say the same words (DOR-3111). Neutral, never
 * orange: orange means an agent is driving. True because the server refuses every
 * browser tool for that chat until the person hands it back.
 */
export function YourTurnStrip({ agentName }: YourTurnStripProps) {
  return (
    <p
      data-slot="your-turn-strip"
      className="bg-muted flex items-start gap-2 rounded-md px-3 py-2 text-sm"
    >
      {/* The hand gives the strip weight in light, where the grey alone reads faint. */}
      <Hand className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0">
        <strong className="font-medium">Your turn:</strong> {cardAgentName(agentName)} can’t see or
        use this window.
      </span>
    </p>
  );
}
