/**
 * The message a person reads when DorkOS could not read their settings and
 * stopped, split out of `config-manager.ts` (Hard Rule 9).
 *
 * @module services/core/config/unreadable-message
 */
/**
 * The text of a {@link ConfigUnreadableError}, in the two situations it covers.
 *
 * They have to be different, because the reassuring one would otherwise be a
 * lie. Corrupt-recovery copies the old file to `.bak` and deletes the original
 * before creating a replacement; if THAT creation is what the OS refuses, the
 * settings are neither untouched nor where the person left them. Sending them
 * to `config.json` at that point would point at the wrong file, when theirs is
 * sitting next to it under another name.
 *
 * ## What the plain branch may and may not claim
 *
 * It says DorkOS did not REPLACE OR DELETE anything, which is the guarantee
 * this module actually delivers, and it holds absolutely. It does not say the
 * bytes are untouched, because `conf` writes before DorkOS gets a verdict:
 * `#runMigrations` calls `_write(storeWithDefaults)` BEFORE `_migrate` runs, so
 * on any boot where the stored file is not already default-shaped — every
 * upgrade boot — the file has been rewritten with the defaults merged in
 * before this error is even constructed. Nothing is lost by that (the merge is
 * shallow and the stored value wins per top-level key), but a 131-byte config
 * can be 2429 bytes by the time a person reads this, so "nothing was changed"
 * was false wherever it mattered most.
 *
 * @param configPath - Absolute path of the config file.
 * @param why - One line describing the failure (`describeLoadError` in `config-manager.ts`).
 * @param advice - The next step, from `adviceFor` (`load-error-advice.ts`).
 * @param backupPath - Where the old settings were copied, if they were.
 */
export function unreadableMessage(
  configPath: string,
  why: string,
  advice: string,
  backupPath?: string
): string {
  const what = `  file: ${configPath}\n  why:  ${why}`;
  if (backupPath !== undefined) {
    return [
      `DorkOS could not finish repairing your settings.`,
      ``,
      what,
      ``,
      `Your old settings could not be used, so DorkOS copied them to the file`,
      `below and tried to start a new one. That did not work either.`,
      ``,
      `  ${backupPath}`,
      ``,
      `Your old settings are still in that file.`,
      advice,
    ].join('\n');
  }
  return [
    `DorkOS could not read your settings, so it stopped rather than replacing them.`,
    ``,
    what,
    ``,
    `DorkOS did not replace or delete your settings.`,
    advice,
  ].join('\n');
}
