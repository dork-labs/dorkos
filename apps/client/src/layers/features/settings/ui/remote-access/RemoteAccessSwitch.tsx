import { useState } from 'react';
import { SwitchSettingRow } from '@/layers/shared/ui';

/** What the switch says under its label, by state. */
const DESCRIPTION = {
  on: 'Your other devices can reach DorkOS with an API key.',
  off: 'Off. Only this computer can reach DorkOS.',
  justOff: 'Off. Devices using it lose access on their next request.',
} as const;

/** Props for {@link RemoteAccessSwitch}. */
export interface RemoteAccessSwitchProps {
  /** Whether remote access is on. */
  enabled: boolean;
  /** A change is on its way to the server. */
  busy: boolean;
  /** Why the last change was refused, in the server's words. */
  error: string | null;
  /** Flip the switch. */
  onChange: (enabled: boolean) => void;
  /** Start as if a person just switched it off (the Dev Playground poses it). */
  initiallyJustOff?: boolean;
}

/**
 * The Remote access switch (DOR-3650): one row at the top of the Remote Access
 * tab that turns every way in from another device on or off. Off asks for no
 * confirm, since it only closes doors and the server refuses other devices on
 * their next request. Right after switching off, the line says so.
 */
export function RemoteAccessSwitch({
  enabled,
  busy,
  error,
  onChange,
  initiallyJustOff = false,
}: RemoteAccessSwitchProps) {
  const [justTurnedOff, setJustTurnedOff] = useState(initiallyJustOff);
  const description = enabled
    ? DESCRIPTION.on
    : justTurnedOff
      ? DESCRIPTION.justOff
      : DESCRIPTION.off;

  return (
    <div className="space-y-1">
      <SwitchSettingRow
        label="Remote access"
        description={description}
        checked={enabled}
        disabled={busy}
        onCheckedChange={(next) => {
          setJustTurnedOff(!next);
          onChange(next);
        }}
      />
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
