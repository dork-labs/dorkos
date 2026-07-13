/**
 * @module features/telemetry-consent
 *
 * First-run telemetry disclosure surface. Discloses the Tier 1 opt-out default
 * (daily anonymous heartbeat + marketplace install counts, both on by default)
 * and the exact heartbeat payload, then records the shared
 * `telemetry.userHasDecided` flag so the disclosure never reappears. Mounted
 * app-wide by the shell.
 */
export { TelemetryConsentBanner } from './ui/TelemetryConsentBanner';
