import { Button, Label } from '@dork-labs/ui';
import { useId, useState } from 'react';
import { FocusDialog } from '../components/FocusDialog.js';

/** How long a mute can last, in minutes, as the dialog offers it. */
export const MUTE_DURATIONS: readonly { minutes: number; label: string }[] = [
  { minutes: 10, label: '10 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 24 * 60, label: '1 day' },
  { minutes: 7 * 24 * 60, label: '1 week' },
];

/** Confirm a mute and choose how long it lasts. */
export function MuteDialog({
  name,
  busy,
  onMute,
  onClose,
}: {
  name: string;
  busy: boolean;
  onMute: (minutes: number) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [minutes, setMinutes] = useState(MUTE_DURATIONS[1]!.minutes);
  return (
    <FocusDialog title={`Mute ${name}?`} onClose={onClose}>
      <p>They and their agents can't post until the mute ends.</p>
      <div className="field">
        <Label htmlFor={`${id}-duration`}>For</Label>
        <select
          id={`${id}-duration`}
          value={minutes}
          onChange={(event) => setMinutes(Number(event.target.value))}
        >
          {MUTE_DURATIONS.map((choice) => (
            <option key={choice.minutes} value={choice.minutes}>
              {choice.label}
            </option>
          ))}
        </select>
      </div>
      <div className="row justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="destructive" disabled={busy} onClick={() => onMute(minutes)}>
          Mute
        </Button>
      </div>
    </FocusDialog>
  );
}
