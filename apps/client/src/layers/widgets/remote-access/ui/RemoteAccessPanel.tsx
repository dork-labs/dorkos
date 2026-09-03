import type { ReactNode } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { Button, Switch } from '@/layers/shared/ui';
import { cn, createModalHandoff, useCopyFeedback } from '@/layers/shared/lib';
import { useAppStore, useIsMobile } from '@/layers/shared/model';
import {
  TunnelQrCode,
  friendlyErrorMessage,
  useRemoteAccess,
  useRemoteAccessActions,
} from '@/layers/entities/tunnel';
import { remoteAccessHeading } from '../model/remote-access-copy';

/** Props for {@link RemoteAccessPanel}. */
export interface RemoteAccessPanelProps {
  /** Dismiss the flyout — every action in here that leads elsewhere calls it. */
  onClose: () => void;
}

/**
 * The link, as a QR code, revealed by a 200ms sweep.
 *
 * A sweep rather than a fade because a QR code is a THING you point a camera
 * at: wiping it in reads as the code arriving, where a fade reads as the code
 * being out of focus.
 */
function QrBlock({ url }: { url: string }) {
  const reducedMotion = useReducedMotion();
  return (
    <div data-testid="remote-access-qr">
      <motion.div
        // `false` skips the animation outright rather than playing a shorter
        // one: a reader who asked for less motion gets the code already there.
        initial={reducedMotion ? false : { clipPath: 'inset(0 100% 0 0)' }}
        animate={{ clipPath: 'inset(0 0% 0 0)' }}
        transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
      >
        <TunnelQrCode url={url} size={168} />
      </motion.div>
      <p className="text-muted-foreground mt-2 text-center text-xs">Scan with your phone</p>
    </div>
  );
}

/** The address, with the one button that gets it off this screen. */
function LinkBlock({ url }: { url: string }) {
  const { copied, failed, copy } = useCopyFeedback();

  let icon: ReactNode;
  let label: string;
  if (copied) {
    icon = <Check className="size-3.5" />;
    label = 'Copied';
  } else if (failed) {
    icon = <X className="text-destructive size-3.5" />;
    label = "Couldn't copy";
  } else {
    icon = <Copy className="size-3.5" />;
    label = 'Copy link';
  }

  return (
    <div className="bg-muted/40 rounded-lg border p-2.5" data-testid="remote-access-link">
      <p className="text-foreground truncate font-mono text-xs" title={url}>
        {url}
      </p>
      <Button
        variant="outline"
        size="sm"
        className="mt-2 w-full gap-1.5"
        onClick={() => void copy(url)}
      >
        {icon}
        {label}
      </Button>
    </div>
  );
}

/**
 * What the beacon opens: the address, the QR code, an off switch, and the way
 * to the full dialog. Nothing else.
 *
 * **The order flips with the viewport, because the job does.** On a desktop the
 * thing you want is the code — the phone is in your other hand and the point is
 * to point it at the screen — so the QR leads. On a phone you ARE the other
 * device: there is nothing to scan, and what you want is the link in your
 * clipboard, so copy leads and the code follows for whoever is standing next to
 * you.
 *
 * **No latency, no domain, no token, no red.** Those belong to the Remote
 * Access dialog, one press away under "Manage…". This is a glance.
 */
export function RemoteAccessPanel({ onClose }: RemoteAccessPanelProps) {
  const remote = useRemoteAccess();
  const actions = useRemoteAccessActions();
  const isMobile = useIsMobile();
  const setRemoteAccessOpen = useAppStore((s) => s.setRemoteAccessOpen);
  // Dismisses this flyout before the dialog opens — the shared
  // `pointer-events` ordering, not a local one.
  const openAndClose = createModalHandoff(onClose);

  const url = remote.url;

  const link = url ? <LinkBlock key="link" url={url} /> : null;
  const qr = url ? <QrBlock key="qr" url={url} /> : null;
  const blocks = isMobile ? [link, qr] : [qr, link];

  return (
    <div className="flex flex-col gap-3" data-testid="remote-access-panel">
      {/* Desktop only. On a phone the drawer's own title says this sentence
          (`RemoteAccessBeacon` passes it), and two headings in one sheet is one
          heading too many — the same split `ControlCenter` makes. */}
      {!isMobile && (
        <header className="flex items-center gap-2">
          <span
            className={cn(
              'inline-block size-2 shrink-0 rounded-full',
              remote.state === 'connected' ? 'bg-status-success' : 'bg-status-warning-dot'
            )}
            aria-hidden
          />
          <h2 className="text-sm font-semibold">{remoteAccessHeading(remote.state)}</h2>
        </header>
      )}

      {/* The off switch below is itself a refusal site — a stop the server
          declines leaves remote access ON with a reason attached — so the
          reason has somewhere to land. `role="alert"` because it appears in
          response to something the person just pressed. */}
      {remote.error !== null && (
        <p
          role="alert"
          data-testid="remote-access-panel-error"
          className="text-destructive text-xs"
        >
          {friendlyErrorMessage(remote.error)}
        </p>
      )}

      {url === null && (
        <p className="text-muted-foreground text-xs">
          Opening a secure tunnel. Your link appears here as soon as it is ready.
        </p>
      )}

      {blocks}

      <div className="flex items-center justify-between gap-3 pt-1">
        {/* The visible words and the accessible name are the SAME words (WCAG
            2.5.3), and they are the row's words too — one vocabulary for one
            switch, wherever a person meets it. */}
        <span className="text-muted-foreground text-sm">Remote access</span>
        <Switch
          checked={remote.isChecked}
          disabled={remote.isTransitioning}
          aria-label="Remote access"
          onCheckedChange={(next) => void actions.toggle(next)}
        />
      </div>

      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-foreground -mx-1 justify-start"
        onClick={openAndClose(() => setRemoteAccessOpen(true))}
      >
        Manage…
      </Button>
    </div>
  );
}
