/** The file editor's edit / finish toggle, which says why when editing is off. */
import { Check, Pencil } from 'lucide-react';
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/layers/shared/ui';

/**
 * Pencil to start editing, checkmark to finish.
 *
 * A disabled button takes no pointer events, so the tooltip hangs on a wrapper
 * (the same shape `PermissionModeItem` uses). The wrapper is always there, so
 * the button is never remounted when editing turns on or off; whenever a notice
 * shows, its sentence says why on screen as well.
 */
export function EditToggle({
  editing,
  off,
  observation,
  onClick,
}: {
  editing: boolean;
  /** Editing is not available right now. */
  off: boolean;
  observation: 'pending' | 'ready' | 'unavailable';
  onClick: () => void;
}) {
  return (
    <TooltipProvider>
      <Tooltip {...(off ? {} : { open: false })}>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              className="text-muted-foreground hover:text-foreground"
              onClick={onClick}
              aria-label={editing ? 'Finish editing' : 'Edit file'}
              disabled={off}
              data-document-save-observation={observation}
            >
              {editing ? <Check className="size-4" /> : <Pencil className="size-4" />}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Editing is off</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
