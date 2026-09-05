import { Wifi, WifiOff } from 'lucide-react';
import { Banner } from './banner';
import type { ConnectionState } from '@dorkos/shared/types';

interface ConnectionStatusBannerProps {
  connectionState: ConnectionState;
  failedAttempts?: number;
  maxAttempts?: number;
  className?: string;
}

/**
 * Displays a banner when an SSE connection is degraded or lost.
 *
 * A thin mapping onto {@link Banner}, which owns the severity ladder, the
 * colours and the announce role — a dropped link is `critical` and announces
 * assertively, a retry is `warning` and announces politely. The class ternary
 * this used to carry said the same thing a second time, in colours only this
 * file knew about, and said nothing at all to a screen reader.
 *
 * Says "Server link", not "Live updates": this banner rides the relay panel's
 * unified `/events` SSE stream (browser ↔ DorkOS server), a different surface
 * from the per-session stream `ConnectionItem`/`SessionInspector` report on.
 * Two banners, two honest names for two different links — not a duplicate of
 * the other family.
 */
export function ConnectionStatusBanner({
  connectionState,
  failedAttempts,
  maxAttempts,
  className,
}: ConnectionStatusBannerProps) {
  if (connectionState === 'connected' || connectionState === 'connecting') return null;

  const isDisconnected = connectionState === 'disconnected';
  const attemptText =
    failedAttempts && maxAttempts ? ` (attempt ${failedAttempts}/${maxAttempts})` : '';

  return (
    <Banner
      variant={isDisconnected ? 'critical' : 'warning'}
      icon={isDisconnected ? WifiOff : Wifi}
      className={className}
    >
      {isDisconnected ? 'Server link lost. Check your network.' : `Reconnecting...${attemptText}`}
    </Banner>
  );
}
