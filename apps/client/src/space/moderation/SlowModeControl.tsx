import { Label } from '@dork-labs/ui';
import { useCallback, useEffect, useId, useState } from 'react';
import { request } from '../api.js';
import type { Perform } from '../components/members/SpaceMembers.js';

/** The waits a channel's slow mode offers, in seconds; 0 is off. */
export const SLOW_MODE_CHOICES: readonly { seconds: number; label: string }[] = [
  { seconds: 0, label: 'Off' },
  { seconds: 10, label: '10 seconds' },
  { seconds: 30, label: '30 seconds' },
  { seconds: 60, label: '1 minute' },
  { seconds: 300, label: '5 minutes' },
  { seconds: 900, label: '15 minutes' },
  { seconds: 3600, label: '1 hour' },
];

/** A wait in seconds as the words the choices use, or as minutes for any other wait. */
export function describeSlowMode(seconds: number): string {
  const choice = SLOW_MODE_CHOICES.find((option) => option.seconds === seconds);
  if (choice) return choice.label;
  return seconds < 60 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`;
}

/** Set how long each person waits between posts in one channel. Owners and admins never wait. */
export function SlowModeControl({
  channelId,
  busy,
  perform,
}: {
  channelId: string;
  busy: boolean;
  perform: Perform;
}) {
  const id = useId();
  const [seconds, setSeconds] = useState<number | null>(null);
  const read = useCallback(
    () =>
      request<{ seconds: number }>(`/api/v1/channels/${channelId}/slow-mode`)
        .then((body) => setSeconds(body.seconds))
        .catch(() => undefined),
    [channelId]
  );
  useEffect(() => {
    setSeconds(null);
    void read();
  }, [read]);
  // A wait set some other way (the API takes any) is shown as it is, never as a wrong choice.
  const choices =
    seconds === null || SLOW_MODE_CHOICES.some((choice) => choice.seconds === seconds)
      ? SLOW_MODE_CHOICES
      : [...SLOW_MODE_CHOICES, { seconds, label: describeSlowMode(seconds) }];
  return (
    <div className="field mt-3">
      <Label htmlFor={`${id}-slow`}>Slow mode</Label>
      <select
        id={`${id}-slow`}
        aria-describedby={`${id}-slow-hint`}
        disabled={busy || seconds === null}
        value={seconds ?? 0}
        onChange={(event) => {
          const next = Number(event.target.value);
          void perform(
            () => request(`/api/v1/channels/${channelId}`, 'PATCH', { slowModeSeconds: next }),
            next === 0 ? 'Slow mode off.' : `Slow mode set to ${describeSlowMode(next)}.`
          ).then(read);
        }}
      >
        {choices.map((choice) => (
          <option key={choice.seconds} value={choice.seconds}>
            {choice.label}
          </option>
        ))}
      </select>
      <span id={`${id}-slow-hint`} className="hint">
        Time each member waits between posts. Owners and admins don't wait.
      </span>
    </div>
  );
}
