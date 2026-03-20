import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useTransport } from '@/layers/shared/model';

const POLL_INTERVAL_MS = 1500;
const TIMEOUT_MS = 30_000;

interface ServerRestartOverlayProps {
  open: boolean;
  onDismiss: () => void;
}

/** Full-screen overlay that polls the server until it comes back online after a restart. */
export function ServerRestartOverlay({ open, onDismiss }: ServerRestartOverlayProps) {
  const [timedOut, setTimedOut] = useState(false);
  const transport = useTransport();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimers = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (pollRef.current) clearInterval(pollRef.current);
    timerRef.current = null;
    pollRef.current = null;
  }, []);

  const startPolling = useCallback(() => {
    setTimedOut(false);
    clearTimers();

    // Set the 30-second timeout
    timerRef.current = setTimeout(() => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      setTimedOut(true);
    }, TIMEOUT_MS);

    // Poll health endpoint
    pollRef.current = setInterval(async () => {
      try {
        await transport.health();
        // Server is back — reload
        clearTimers();
        window.location.reload();
      } catch {
        // Server still down, keep polling
      }
    }, POLL_INTERVAL_MS);
  }, [transport, clearTimers]);

  /* eslint-disable react-hooks/set-state-in-effect -- start server health polling when overlay opens */
  useEffect(() => {
    if (open) {
      startPolling();
    }
    return clearTimers;
  }, [open, startPolling, clearTimers]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!open) return null;

  const overlay = (
    <div
      className="bg-background/80 fixed inset-0 z-[100] flex items-center justify-center backdrop-blur-sm"
      data-testid="server-restart-overlay"
    >
      <div className="flex flex-col items-center gap-4 text-center">
        {timedOut ? (
          <>
            <p className="text-foreground text-sm font-medium">
              Server did not restart within 30 seconds.
            </p>
            <p className="text-muted-foreground text-sm">Check your terminal for errors.</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={startPolling}>
                Try Again
              </Button>
              <Button variant="outline" size="sm" onClick={onDismiss}>
                Dismiss
              </Button>
            </div>
          </>
        ) : (
          <>
            <Loader2 className="text-muted-foreground size-8 animate-spin" />
            <p className="text-foreground text-sm font-medium">Restarting server...</p>
            <p className="text-muted-foreground text-sm">Waiting for server to come back...</p>
          </>
        )}
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
