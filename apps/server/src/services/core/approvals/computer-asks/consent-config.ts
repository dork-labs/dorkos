/**
 * The one door the space side writes standing consent decisions through: the
 * `harness` and `permissions` settings in `~/.dork/config.json` (spec
 * `computer-side-starts-alone` §5.4, §5.7). Computer-side code never writes
 * either section; it asks, or reports a decision, through the asks port.
 *
 * Every write is logged on the config-write log with the reason the caller
 * gave, exactly as the computer-side writers it replaced logged it.
 *
 * @module services/core/approvals/computer-asks/consent-config
 */
import type { UserConfig } from '@dorkos/shared/config-schema';
import { configManager } from '../../config-manager.js';
import { logConfigWrite } from '../../operator/config-write.js';

/** The two settings sections standing consent decisions live in. */
export type ConsentSection = 'harness' | 'permissions';

/**
 * One consent section as stored now.
 *
 * @param section - Which section.
 */
export function readConsent<K extends ConsentSection>(section: K): UserConfig[K] {
  return configManager.get(section);
}

/**
 * Replace one consent section and log the write.
 *
 * @param section - Which section.
 * @param reason - The config-write log line.
 * @param next - The section as it should now read.
 */
export function writeConsent<K extends ConsentSection>(
  section: K,
  reason: string,
  next: UserConfig[K]
): void {
  const before = configManager.get(section);
  configManager.set(section, next);
  logConfigWrite(reason, section, before, configManager.get(section));
}
