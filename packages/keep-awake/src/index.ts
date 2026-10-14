/**
 * `@dorkos/keep-awake` — keep the computer from idle-sleeping while work is in
 * flight, and let it sleep normally once the work is done.
 *
 * Knows nothing about DorkOS: callers open a {@link Hold} per piece of work and
 * release it when the work ends. One OS tool per platform holds the assertion
 * (`caffeinate` on macOS, `systemd-inhibit` on Linux, `SetThreadExecutionState`
 * through PowerShell on Windows), always tied to the owning process so a crash
 * can never leave the computer held awake. In a container, or on an operating
 * system with no adapter, holds are still counted and status says why nothing
 * is held. A hold may ask for the screen too, and {@link readPower} reads the
 * power source so a caller can stop holding on battery.
 *
 * @module keep-awake
 */
export { createKeepAwake } from './keep-awake.js';
export type {
  Hold,
  HoldOptions,
  KeepAwake,
  KeepAwakeLevel,
  KeepAwakeOptions,
  KeepAwakeStatus,
} from './keep-awake.js';
export { detectEnvironment, isContainer, holderCommandFor, holdsDisplay } from './environment.js';
export {
  readPower,
  parsePmsetBatt,
  parseWindowsPowerStatus,
  readLinuxPowerSupplies,
} from './power.js';
export type { PowerOptions, PowerReading } from './power.js';
export type { EnvironmentOptions, EnvironmentReport } from './environment.js';
export type {
  ChildLike,
  HolderCommand,
  HolderSpawnOptions,
  KeepAwakeLogger,
  Mechanism,
  SpawnLike,
  UnsupportedReason,
} from './holders/types.js';
