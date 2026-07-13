/**
 * The exact weekly-heartbeat payload, shown verbatim on every consent surface
 * (first-run banner, onboarding step, Privacy & Data settings tab) so the user
 * can read every field before choosing. Kept in lockstep with the server payload
 * in `services/core/heartbeat-reporter.ts` and the public /telemetry page.
 *
 * Lives in the config entity — the lowest layer the consent features share — so
 * it is defined once and imported, never duplicated across features.
 */
export const HEARTBEAT_PAYLOAD_EXAMPLE = `{
  "instanceId": "a1b2c3d4-...",   // random, not you
  "dorkosVersion": "0.46.0",
  "os": "darwin-arm64",
  "runtimesConfigured": ["claude-code", "codex"],
  "tunnelEnabled": false,
  "cloudLinked": false,
  "counts": { "agents": 4, "tasks": 2, "relayAdapters": 1 }
}`;
