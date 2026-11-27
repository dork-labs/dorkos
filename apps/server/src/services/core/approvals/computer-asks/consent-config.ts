/**
 * The one door the space side writes standing consent decisions through: the
 * `harness` and `permissions` settings in `~/.dork/config.json` (spec
 * `computer-side-starts-alone` §5.4, §5.7). Computer-side code never writes
 * either section; it asks, or reports a decision, through the asks port.
 *
 * The config store and its write log are handed in ({@link setConsentConfigStore}):
 * the server's startup (`startup/computer-asks.ts`), harness boot and the CLI's
 * `harness` verbs fill it from `configManager` and `logConfigWrite`. Every write
 * is logged on the config-write log with the reason the caller gave.
 *
 * Unwired, it can never allow and never quietly skip a write: every writer
 * calls {@link requireConsentConfig} first, which throws
 * {@link ConsentConfigUnwiredError} naming the missing wiring, whether the write
 * is a yes, a pin, a no or a revoke. A read answers as nothing decided.
 *
 * @module services/core/approvals/computer-asks/consent-config
 */
import { UserConfigSchema, type UserConfig } from '@dorkos/shared/config-schema';

/** The two settings sections standing consent decisions live in. */
export type ConsentSection = 'harness' | 'permissions';

/** The config store the consent door reads and writes, and its write log. */
export interface ConsentConfigStore {
  /**
   * One section as stored now.
   *
   * @param section - Which section.
   */
  get<K extends ConsentSection>(section: K): UserConfig[K];
  /**
   * Replace one section.
   *
   * @param section - Which section.
   * @param value - The section as it should now read.
   */
  set<K extends ConsentSection>(section: K, value: UserConfig[K]): void;
  /**
   * Log one write on the config-write log (`logConfigWrite`).
   *
   * @param reason - What did the write, as a person would name it.
   * @param section - The section written.
   * @param before - The section before the write.
   * @param after - The section after it.
   */
  logWrite(reason: string, section: ConsentSection, before: unknown, after: unknown): void;
}

/** Thrown by every consent write before a config store is handed in. */
export class ConsentConfigUnwiredError extends Error {
  override readonly name = 'ConsentConfigUnwiredError';

  constructor() {
    super(
      'The consent config store is not wired: startup/computer-asks.ts (wireConsentWrites), harness boot or the CLI verb must hand one in before a consent decision is written.'
    );
  }
}

let store: ConsentConfigStore | undefined;

/**
 * Hand the consent door its config store, or clear it.
 *
 * @param next - The store, or `undefined` to clear it.
 */
export function setConsentConfigStore(next: ConsentConfigStore | undefined): void {
  store = next;
}

/**
 * The config store, for a writer: throws when none is wired, so no write is
 * ever skipped and nothing is ever allowed without one.
 *
 * @throws {@link ConsentConfigUnwiredError} when no store is wired.
 */
export function requireConsentConfig(): ConsentConfigStore {
  if (!store) throw new ConsentConfigUnwiredError();
  return store;
}

/**
 * One consent section as stored now; nothing decided when no store is wired.
 *
 * @param section - Which section.
 */
export function readConsent<K extends ConsentSection>(section: K): UserConfig[K] {
  if (!store) return UserConfigSchema.shape[section].parse(undefined) as UserConfig[K];
  return store.get(section);
}

/**
 * Replace one consent section and log the write.
 *
 * @param section - Which section.
 * @param reason - The config-write log line.
 * @param next - The section as it should now read.
 * @throws {@link ConsentConfigUnwiredError} when no store is wired.
 */
export function writeConsent<K extends ConsentSection>(
  section: K,
  reason: string,
  next: UserConfig[K]
): void {
  const wired = requireConsentConfig();
  const before = wired.get(section);
  wired.set(section, next);
  wired.logWrite(reason, section, before, wired.get(section));
}
