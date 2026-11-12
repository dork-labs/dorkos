import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../env.js';
import { resolveDorkHome } from '../dork-home.js';

/** Marker owned by demo-boot; it is never created by the server. */
export const REPLAY_HOME_MARKER = '.dorkos-recorded-demo';

let isolated = false;

/** Latch isolation before any startup work, including when only the marker remains. */
export function claimReplayIsolation(dorkHome: string): boolean {
  isolated ||=
    Boolean(env.DORKOS_REPLAY_RECORDING) || fs.existsSync(path.join(dorkHome, REPLAY_HOME_MARKER));
  return isolated;
}

/** Replay cannot turn outbound services back on by removing a flag or marker. */
export function isReplayIsolated(): boolean {
  return isolated || Boolean(env.DORKOS_REPLAY_RECORDING);
}

/** Refuse an outbound operation in a recorded demo, before constructing its client. */
export function refuseReplayOutbound(): void {
  if (isReplayIsolated()) throw new Error('Recorded demo: outside actions are off.');
}

/** The current home is read afresh at each turn, never cached from env validation. */
export function currentReplayHome(): string {
  return resolveDorkHome();
}
