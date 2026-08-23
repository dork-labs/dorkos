/**
 * @module features/telemetry-consent
 *
 * First-run telemetry disclosure surface. Discloses the Tier 1 opt-out default
 * (daily anonymous heartbeat + marketplace install counts, both off until you say yes)
 * and the exact heartbeat payload, then records the shared
 * `telemetry.userHasDecided` flag so the disclosure never reappears. Shown as a
 * one-time modal by the moments rail (`widgets/moments`); it used to be an
 * app-wide banner, which asked a yes/no question in a surface built for standing
 * conditions and could sit there unanswered for weeks.
 */
export { TelemetryConsentMoment } from './ui/TelemetryConsentMoment';
