import { MonitorSmartphone } from 'lucide-react';
import { useState } from 'react';
import {
  Button,
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  ResponsivePopoverTrigger,
  useResponsivePopover,
} from '@/layers/shared/ui';
import { formatRelativeTime } from '@/layers/shared/lib';
import { useRemotePresence } from '../model/use-remote-presence';
import { DeviceList } from './SeenDevices';

/** The popover's heading: the sheet's title on a phone, a plain line on a desktop. */
function Heading() {
  const { isDesktop } = useResponsivePopover();
  const text = 'In use from the web';
  if (!isDesktop) {
    return <ResponsivePopoverTitle className="text-sm font-medium">{text}</ResponsivePopoverTitle>;
  }
  return <p className="text-sm font-medium">{text}</p>;
}

/**
 * A small mark in the top bar, present only while someone is using this
 * computer from the web: the relay is connected and a chat of this computer
 * is open on the hub (step B3, DOR-2946). Its popover lists the browsers seen
 * since then and, at this computer only, "End now", which closes the relay
 * and pauses the link.
 *
 * Calm like the keep-awake cup beside it: no animation, no colour. It
 * appears, says what is happening, and goes.
 */
export function RemoteSessionIndicator() {
  const { presence, atThisComputer, end, ending, error } = useRemotePresence();
  const [open, setOpen] = useState(false);
  if (!presence?.active) return null;

  return (
    <ResponsivePopover open={open} onOpenChange={setOpen}>
      <ResponsivePopoverTrigger asChild>
        <button
          type="button"
          data-testid="remote-session-indicator"
          aria-label="In use from the web. Show details"
          className="focus-ring text-muted-foreground hover:text-foreground inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors"
        >
          <MonitorSmartphone className="size-4" aria-hidden />
        </button>
      </ResponsivePopoverTrigger>
      <ResponsivePopoverContent
        side="bottom"
        align="end"
        aria-label="In use from the web"
        className="w-72 max-w-[calc(100vw-1.5rem)] space-y-3 p-3"
      >
        <div className="space-y-0.5">
          <Heading />
          {presence.since && (
            <p className="text-muted-foreground text-xs">
              Someone is chatting here from the web. Started {formatRelativeTime(presence.since)}.
            </p>
          )}
        </div>
        {presence.devices.length > 0 ? (
          <DeviceList devices={presence.devices} />
        ) : (
          <p className="text-muted-foreground text-xs">No device named yet.</p>
        )}
        {atThisComputer ? (
          <div className="space-y-1">
            <Button variant="outline" size="sm" disabled={ending} onClick={end}>
              End now
            </Button>
            <p className="text-muted-foreground text-xs">This also pauses chat from the web.</p>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">End it on the computer DorkOS runs on.</p>
        )}
        {error && (
          <p className="text-destructive text-xs" role="alert">
            {error}
          </p>
        )}
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}
