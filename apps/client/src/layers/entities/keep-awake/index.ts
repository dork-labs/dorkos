/**
 * Keep-awake entity — whether DorkOS is keeping this computer awake while agents
 * work, and the shared words for saying so (spec `keep-awake`).
 *
 * Read by the top-bar cup, the Control Center line and Settings → Tools →
 * Sleep. {@link useKeepAwakeSync} is mounted exactly once, by the app shell.
 *
 * @module entities/keep-awake
 */
export { useKeepAwake, useKeepAwakeSync, KEEP_AWAKE_KEY } from './model/use-keep-awake';
export {
  describeKeepAwakeWork,
  isKeepingAwake,
  KEEP_AWAKE_CAVEAT,
  SLEEP_SETTINGS,
  UNSUPPORTED_COPY,
} from './lib/keep-awake-copy';
