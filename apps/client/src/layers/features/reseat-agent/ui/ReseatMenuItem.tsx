/**
 * "Continue on another account…" as an entry in a room member's menu: the "…"
 * menu on desktop, a full-width button in the opened row on a phone. It asks
 * the server where the seat could move before it offers the move, so a seat
 * with nothing to move, or nowhere to go, says why instead of opening an empty
 * picker.
 *
 * @module features/reseat-agent/ui/ReseatMenuItem
 */
import type { ReseatOptions } from '@dorkos/shared/room-schemas';
import { Button, DropdownMenuItem } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useReseatOptions } from '../model/use-reseat-agent';
import { NOTHING_LEFT } from './ReseatAgentDialog';

/** The entry's label, the same in the menu and the opened row. */
const RESEAT_LABEL = 'Continue on another account…';

/** Whether the entry can be chosen, and the line saying why not. */
interface ReseatAvailability {
  enabled: boolean;
  hint: string | null;
}

/**
 * Decide the entry's state from the options read.
 *
 * Still asking: disabled, no hint. A read that failed stays choosable, so the
 * picker can say what went wrong rather than the menu going quiet.
 */
function availabilityOf(
  options: { data: ReseatOptions | undefined; isError: boolean },
  agentName: string
): ReseatAvailability {
  if (options.isError) return { enabled: true, hint: null };
  if (options.data === undefined) return { enabled: false, hint: null };
  // An answer without the expected shape is read like a failed one: choosable,
  // so the picker says what went wrong instead of the menu breaking.
  if (options.data === null || !Array.isArray(options.data.accounts)) {
    return { enabled: true, hint: null };
  }
  if (!options.data.seated) {
    return { enabled: false, hint: `${agentName} hasn’t answered here yet` };
  }
  if (!options.data.accounts.some((account) => account.eligible)) {
    return { enabled: false, hint: NOTHING_LEFT };
  }
  return { enabled: true, hint: null };
}

/** Props for {@link ReseatMenuItem}. */
export interface ReseatMenuItemProps {
  /** The room or DM. */
  roomId: string;
  /** The agent whose seat would move. */
  authorId: string;
  /** The agent's name, as the room shows it. */
  agentName: string;
  /** Open the picker. Called only when the entry can be chosen. */
  onRequested: () => void;
  /**
   * `menu` (default) is a dropdown item for the desktop "…" menu; `row` is the
   * full-width button in a member's opened row on a phone.
   */
  variant?: 'menu' | 'row';
}

/**
 * "Continue on another account…" for one agent in a room, disabled with a
 * reason when its seat has not run yet or no other account has usage left.
 *
 * Mount it only while it can be seen (an open menu, an opened row): it reads
 * the seat's options as soon as it mounts.
 *
 * @param props - See {@link ReseatMenuItemProps}.
 */
export function ReseatMenuItem({
  roomId,
  authorId,
  agentName,
  onRequested,
  variant = 'menu',
}: ReseatMenuItemProps) {
  const options = useReseatOptions(roomId, authorId, true);
  const { enabled, hint } = availabilityOf(options, agentName);

  // The hint takes no muted colour of its own: a disabled entry is already
  // drawn at half opacity, and muted on top of that is too faint to read.
  const content = (
    <span className="flex min-w-0 flex-col items-start text-left">
      <span>{RESEAT_LABEL}</span>
      {hint !== null && <span className="text-xs font-normal">{hint}</span>}
    </span>
  );

  if (variant === 'row') {
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={!enabled}
        onClick={onRequested}
        className={cn(
          'mt-1 w-full justify-start px-3',
          hint === null ? 'h-11' : 'h-auto min-h-11 py-1.5'
        )}
      >
        {content}
      </Button>
    );
  }

  return (
    <DropdownMenuItem disabled={!enabled} onSelect={onRequested}>
      {content}
    </DropdownMenuItem>
  );
}
