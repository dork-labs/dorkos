/**
 * The one place the persistent-session opt-in is read
 * (`runtimes.claudeCode.persistentSession`; spec `persistent-session-runtime`
 * §P3, task 3.8 / DOR-1173).
 *
 * ## What the setting means
 *
 * Off — how it ships — a Claude Code chat starts a fresh agent process for every
 * message and lets it exit when the turn ends, which is what DorkOS has always
 * done. On, the session's pump holds that process open between messages, so the
 * next message reaches an agent that is already running.
 *
 * ## Why a reader rather than a value
 *
 * The opt-in is per SESSION, not per host, and this function is what makes that
 * true: it is called when a session's pump is ACQUIRED, so a chat that is
 * already running keeps the path it started on until its process is replaced.
 * Two sessions on one machine can therefore be on different paths at the same
 * time, which is the only way to compare them on the same workload — and the
 * resume path stays live underneath, because it is also the recovery route.
 *
 * The consumption point is `SessionPumpRegistry.acquire`, alongside the warm
 * ceiling that is read at the same moment and for the same reason (see that
 * module's docs). Task 3.10 wires it there when the pump joins the dispatch
 * path; until then nothing launches a pump, so the setting changes nothing.
 *
 * @module services/runtimes/claude-code/persistent-session-optin
 */
import type { UserConfig } from '@dorkos/shared/config-schema';
import { logger } from '../../../lib/logger.js';
import { configManager } from '../../core/config-manager.js';

/** Minimal read surface of the config manager (injectable for tests). */
type ConfigReader = { get<K extends keyof UserConfig>(key: K): UserConfig[K] };

/**
 * Whether a claude-code session launching now should hold its process open
 * between messages.
 *
 * Never throws, and never guesses ON. The config singleton is undefined before
 * `initConfigManager()` runs (a unit test, an early boot step), and a config
 * written before this field existed has no value at that path at all; both
 * answer `false`, which is today's behavior. Reading a launch decision must not
 * be able to fail a launch, and an unreadable config is not consent.
 *
 * @param config - Config reader (defaults to the module singleton).
 * @returns `true` only when the operator has turned the setting on.
 */
export function isPersistentSessionEnabled(config: ConfigReader = configManager): boolean {
  try {
    return config.get('runtimes')?.claudeCode?.persistentSession ?? false;
  } catch (err) {
    logger.debug('[persistent-session-optin] config unavailable, staying on the resume path', {
      err: String(err),
    });
    return false;
  }
}
