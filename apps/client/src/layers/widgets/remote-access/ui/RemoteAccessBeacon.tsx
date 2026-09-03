import { useEffect } from 'react';
import { Globe } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import {
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  ResponsivePopoverTrigger,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { useRemoteAccess } from '@/layers/entities/tunnel';
import { useConnectRipple } from '../model/use-connect-ripple';
import { RemoteAccessPanel } from './RemoteAccessPanel';

/** What a screen reader hears, in the tense of what is actually happening. */
function announcementFor(state: string, host: string | null): string {
  if (state === 'starting') return 'Remote access is connecting';
  if (state === 'reconnecting') return 'Remote access is reconnecting';
  return host ? `Remote access is on at ${host}` : 'Remote access is on';
}

/**
 * The button's accessible name: what is happening, then what pressing it does.
 *
 * The second half is not decoration — an icon-only control has to say what it
 * offers, and while the tunnel is still coming up it does not yet offer a link
 * or a code, so it must not claim to.
 */
function beaconLabel(state: string, host: string | null): string {
  const offer = state === 'starting' ? 'open remote access' : 'show link and QR';
  return `${announcementFor(state, host)} — ${offer}`;
}

/**
 * The beacon — a globe in the top bar, present only while remote access is
 * actually doing something (DOR-1743).
 *
 * ## What it is for
 *
 * Once a tunnel is up, the thing a person needs is not a settings screen: it is
 * the address, in their hand, on the phone they are about to pick up. So the
 * beacon is a one-click path to the link and the QR code, sitting beside the
 * Control Center glyph on every route and every viewport.
 *
 * ## What it does not do
 *
 * **It is not permanent chrome.** With remote access off — or failed — it draws
 * nothing at all. A feature nobody is using earns no pixels in the top bar, and
 * an icon that is grey most of the time teaches people to stop seeing it.
 *
 * **A steady tunnel is silent.** One ripple when the tunnel comes up, and then
 * stillness — no looping pulse, no rotating glyph. Motion here means "something
 * just changed", so a beacon that never stopped moving would be saying that
 * forever. Only the two unsettled states move at all: a low breath while
 * connecting, and a dimmed globe with an amber dot while ngrok re-establishes a
 * dropped session.
 *
 * `prefers-reduced-motion` removes every part of that — the breath through
 * `motion-safe:`, the ripple by not rendering it — and the states stay legible
 * because each one is also a colour and a sentence.
 */
export function RemoteAccessBeacon() {
  const remote = useRemoteAccess();
  const open = useAppStore((s) => s.remoteAccessBeaconOpen);
  const setOpen = useAppStore((s) => s.setRemoteAccessBeaconOpen);
  const reducedMotion = useReducedMotion();
  const connections = useConnectRipple(remote.state, remote.hasServerReport);

  // A flyout about a tunnel that has gone away is a flyout about nothing, and
  // its trigger is about to unmount from under it.
  useEffect(() => {
    if (!remote.isLive && open) setOpen(false);
  }, [remote.isLive, open, setOpen]);

  const announcement = remote.isLive ? announcementFor(remote.state, remote.host) : '';

  return (
    <>
      {/*
        Always mounted, deliberately: an `aria-live` region has to exist BEFORE
        its content changes for assistive tech to announce it, so a region that
        appeared together with its first message would often say nothing. Empty
        while remote access is off, which announces nothing and draws nothing.
      */}
      <span role="status" className="sr-only" data-testid="remote-access-announcement">
        {announcement}
      </span>

      {remote.isLive && (
        <ResponsivePopover open={open} onOpenChange={setOpen} modal>
          <ResponsivePopoverTrigger asChild>
            <button
              type="button"
              data-testid="remote-access-beacon"
              data-state-name={remote.state}
              aria-label={beaconLabel(remote.state, remote.host)}
              className={cn(
                'focus-ring text-muted-foreground hover:text-foreground relative inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors',
                // Dimmed while the session is being re-established: still on,
                // visibly not at its best.
                remote.state === 'reconnecting' && 'opacity-70'
              )}
            >
              <Globe
                className={cn('size-4', remote.state === 'starting' && 'motion-safe:animate-tasks')}
                aria-hidden
              />
              <span
                aria-hidden
                data-testid="remote-access-beacon-dot"
                className={cn(
                  'border-background absolute right-0.5 bottom-0.5 size-1.5 rounded-full border',
                  remote.state === 'connected' ? 'bg-status-success' : 'bg-status-warning-dot'
                )}
              />
              {connections > 0 && !reducedMotion && (
                <span
                  key={connections}
                  aria-hidden
                  data-testid="remote-access-beacon-ripple"
                  className="animate-beacon-ripple border-status-success pointer-events-none absolute inset-0 rounded-full border"
                />
              )}
            </button>
          </ResponsivePopoverTrigger>
          <ResponsivePopoverContent
            side="bottom"
            align="end"
            aria-label="Remote access"
            className="w-72 max-w-[calc(100vw-1.5rem)] p-3"
          >
            <ResponsivePopoverTitle>Remote access</ResponsivePopoverTitle>
            <RemoteAccessPanel onClose={() => setOpen(false)} />
          </ResponsivePopoverContent>
        </ResponsivePopover>
      )}
    </>
  );
}
