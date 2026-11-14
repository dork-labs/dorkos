import { useState } from 'react';
import { SwitchSettingRow } from '@/layers/shared/ui';

/** What the switch says under its label, by state. */
const DESCRIPTION = {
  on: 'Your other devices can reach DorkOS with an API key.',
  off: 'Off. Only this computer can reach DorkOS.',
  justOff: 'Off. Other devices are disconnected now.',
} as const;

/** What the switch does not touch, shown before it is flipped (Security, DOR-3650). */
const NOT_AFFECTED = 'Telegram, Slack and preview links aren’t affected.';

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
}

/**
 * The Remote access switch (DOR-3650): one row at the top of the Remote Access
 * tab that turns every way in from another device on or off. Off asks for no
 * confirm, since it only closes doors: the server disconnects other devices at
 * once and refuses them after. Right after switching off, the line says so.
 * What it does not touch (Telegram, Slack, preview links) shows in every state,
 * so a person sees it before choosing.
 */
export function RemoteAccessSwitch({ enabled, busy, error, onChange }: RemoteAccessSwitchProps) {
  const [justTurnedOff, setJustTurnedOff] = useState(false);
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
      <p className="text-muted-foreground text-xs">{NOT_AFFECTED}</p>
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
