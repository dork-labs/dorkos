import { cn } from '@/layers/shared/lib';
import { AGENT_FACES } from '../lib/agent-faces';

/** Props for {@link FacePicker}. */
export interface FacePickerProps {
  /** The currently selected emoji face. */
  value: string;
  /** Called with the picked emoji. */
  onChange: (face: string) => void;
}

/**
 * A curated grid of emoji faces for an agent's visual identity (M3). The
 * selected face is highlighted; picking one is a single click. Each face is a
 * labelled toggle button, so the whole set is keyboard-reachable.
 *
 * @param props - Selected face and change handler.
 */
export function FacePicker({ value, onChange }: FacePickerProps) {
  return (
    <div
      role="group"
      aria-label="Choose a face"
      className="flex flex-wrap gap-1.5"
      data-testid="face-picker"
    >
      {AGENT_FACES.map((face) => {
        const selected = face === value;
        return (
          <button
            key={face}
            type="button"
            aria-label={`Face ${face}`}
            aria-pressed={selected}
            onClick={() => onChange(face)}
            className={cn(
              'flex size-9 items-center justify-center rounded-md border text-lg transition-colors',
              'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
              selected
                ? 'border-primary bg-primary/10'
                : 'hover:border-border hover:bg-accent border-transparent'
            )}
            data-testid={`face-${face}`}
          >
            <span aria-hidden>{face}</span>
          </button>
        );
      })}
    </div>
  );
}
