import { useConfig } from '@/layers/entities/config';
import { TelemetryConsentBanner } from '@/layers/features/telemetry-consent';

import { BANNER_PRIORITY, type BannerDescriptor } from './banner-descriptor';
import { usePermissionBypassed } from './use-permission-bypassed';
import { PermissionBanner } from '../ui/PermissionBanner';

/**
 * Permission-bypass banner descriptor — warning severity, eligible only while the
 * active session runs with every permission bypassed.
 *
 * @param sessionId - The active session id, or null when none is selected.
 */
function usePermissionBannerDescriptor(sessionId: string | null): BannerDescriptor | null {
  const bypassed = usePermissionBypassed(sessionId);
  if (!bypassed) return null;
  return {
    id: 'permission-bypass',
    variant: 'warning',
    priority: BANNER_PRIORITY.warning,
    render: () => <PermissionBanner sessionId={sessionId} />,
  };
}

/**
 * First-run telemetry-consent descriptor — neutral severity, eligible until the
 * user makes an explicit telemetry choice. Mirrors the gate inside
 * {@link TelemetryConsentBanner} so an ineligible banner never suppresses others.
 */
function useTelemetryBannerDescriptor(): BannerDescriptor | null {
  const { data: config } = useConfig();
  if (config?.telemetry?.userHasDecided) return null;
  return {
    id: 'telemetry-consent',
    variant: 'neutral',
    priority: BANNER_PRIORITY.neutral,
    render: () => <TelemetryConsentBanner />,
  };
}

/**
 * Collects every eligible app banner for the current app state. The slot ranks
 * the result and shows the highest-priority one. Add a banner by writing a
 * descriptor hook and appending its result here — no other wiring is required.
 *
 * @param sessionId - The active session id, or null when none is selected.
 */
export function useAppBanners(sessionId: string | null): BannerDescriptor[] {
  const permission = usePermissionBannerDescriptor(sessionId);
  const telemetry = useTelemetryBannerDescriptor();
  return [permission, telemetry].filter((d): d is BannerDescriptor => d !== null);
}
