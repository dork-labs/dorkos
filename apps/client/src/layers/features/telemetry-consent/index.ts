/**
 * @module features/telemetry-consent
 *
 * First-run telemetry consent surface. Presents the shared opt-in choice
 * (weekly heartbeat + marketplace install events, both off by default) and the
 * exact heartbeat payload, then records the shared `telemetry.userHasDecided`
 * flag so the prompt never reappears. Mounted app-wide by the shell.
 */
export { TelemetryConsentBanner } from './ui/TelemetryConsentBanner';
