/**
 * The way further back into a long conversation (DOR-2889).
 *
 * @module widgets/session/ui/LoadEarlierRow
 */
import { Button, Spinner } from '@/layers/shared/ui';

interface LoadEarlierRowProps {
  /** True while the page is on its way. */
  loading: boolean;
  /** Read the page directly older than what is loaded. */
  onLoad: () => void;
}

/**
 * "Earlier messages", the first row of a conversation that opened on only its
 * newest messages.
 *
 * The same decisions as a room's "Older messages" row (`LoadOlderRow`): a press
 * rather than a scroll trigger, so reaching the top never pulls pages nobody
 * asked for, and a quiet ghost button inside the feed so it scrolls with the
 * history instead of floating over the newest line.
 */
export function LoadEarlierRow({ loading, onLoad }: LoadEarlierRowProps) {
  return (
    <div className="flex justify-center px-4 py-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onLoad}
        disabled={loading}
        data-testid="session-load-earlier"
        className="text-muted-foreground hover:text-foreground h-7 gap-2 text-xs"
      >
        {loading && <Spinner size="xs" />}
        {loading ? 'Loading earlier messages…' : 'Earlier messages'}
      </Button>
    </div>
  );
}
