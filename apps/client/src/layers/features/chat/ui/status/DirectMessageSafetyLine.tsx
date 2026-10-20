/**
 * The two readings a chat drawn as a DM keeps under its box when the status
 * line is gone (DOR-3074): why every turn asks first on Wi-Fi, and a context
 * nearly full, with the way to compact it.
 *
 * @module features/chat/ui/status/DirectMessageSafetyLine
 */
import { WifiTurnCapPill } from '@/layers/features/status';

/** What the compaction warning needs, from the status section's own reading. */
export interface DirectMessageCompaction {
  /** Whether the warning applies right now: 85% full or more, idle, compactable. */
  visible: boolean;
  /** How full the context is, as a whole percent. */
  percent: number;
  /** Whether a compaction is already on its way. */
  pending: boolean;
  /** Compact the chat. */
  onCompact: () => void;
}

/**
 * Safety and limits stay in view in a DM, whatever Show sessions says. The
 * model, account, permission mode, usage and git are what move behind it.
 * Draws nothing at all when neither reading applies.
 *
 * @param props.compaction - The status section's compaction reading.
 */
export function DirectMessageSafetyLine({ compaction }: { compaction: DirectMessageCompaction }) {
  return (
    <div
      data-testid="dm-safety-line"
      className="text-muted-foreground flex items-center gap-2 pt-2 text-xs empty:hidden empty:p-0"
    >
      <WifiTurnCapPill compact={false} />
      {compaction.visible && (
        <span className="flex items-center gap-1.5" data-testid="dm-compact-warning">
          <span className="text-status-warning-fg">Context {compaction.percent}% full</span>
          <button
            type="button"
            onClick={compaction.onCompact}
            disabled={compaction.pending}
            className="focus-ring text-foreground/80 hover:text-foreground rounded-sm underline-offset-4 hover:underline disabled:opacity-50"
          >
            {compaction.pending ? 'Compacting…' : 'Compact chat'}
          </button>
        </span>
      )}
    </div>
  );
}
