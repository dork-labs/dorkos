import { useSessionWorkLeft } from '@/layers/entities/session';

/**
 * Bring a Stop's line into view. The line is almost always in the latest turn,
 * which the conversation keeps drawn, so the plain DOM scroll reaches it.
 *
 * @param lineId - The line's DOM id.
 */
function scrollToLine(lineId: string): void {
  document.getElementById(lineId)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/** Props for {@link WorkLeftPill}. */
interface WorkLeftPillProps {
  /** The session the bar is showing, or `null` before one is chosen. */
  sessionId: string | null;
}

/**
 * The amber pill that says a Stop left commands running in this session
 * (DOR-3285). Pressing it scrolls to the line that names them, where each has
 * its own Stop. Draws nothing once every command has ended.
 */
export function WorkLeftPill({ sessionId }: WorkLeftPillProps) {
  const workLeft = useSessionWorkLeft(sessionId);
  if (!workLeft) return null;
  const label = workLeft.count === 1 ? '1 command running' : `${workLeft.count} commands running`;
  return (
    <button
      type="button"
      data-testid="work-left-pill"
      onClick={() => scrollToLine(workLeft.lineId)}
      className="text-2xs bg-status-warning-bg border-status-warning-border text-status-warning-fg inline-flex shrink-0 items-center rounded-full border px-2 py-0.5"
    >
      {label}
    </button>
  );
}
