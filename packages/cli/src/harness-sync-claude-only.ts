/**
 * The "Installed in Claude Code only" part of `dorkos harness sync`'s report:
 * the plugins a person turned on in Claude Code that their other agent tools
 * cannot see, and what DorkOS can do about each.
 *
 * @module cli/harness-sync-claude-only
 */
import type { HarnessClaudeOnly } from '@dorkos/shared/harness-schemas';

/**
 * The "Installed in Claude Code only" block: the plugins a person turned on in
 * Claude Code's own settings, and what DorkOS can offer to do about each one.
 *
 * Assembled HERE, beside `formatDropList`'s output and never inside it. Putting
 * it in the engine would make `@dorkos/harness` read a home directory, which
 * three of its own module docs forbid by name (`inventory/index.ts`,
 * `inventory/types.ts`, `inventory/hooks.ts`).
 *
 * **Nothing is printed when there is nothing to say.** A block that always
 * appears is a block people learn to skip, so a machine with no plugins turned
 * on gets zero lines, heading included. An empty group is skipped the same way.
 *
 * **The root is printed on every run.** `$CLAUDE_CONFIG_DIR` is inherited, so a
 * run started inside an agent session can read a different root than the
 * person's own terminal — measured at 7 entries in one and 16 in the other on
 * the machine this was written on. Choosing the right resolver does not by
 * itself make the answer right; saying which file it came from does.
 *
 * "Turned on", never "installed": Claude Code's `defaultEnabled` falls back to
 * `true` and its public half cannot enumerate installs, so a plugin nobody
 * listed is a state DorkOS cannot compute and must not imply. "Agent tools"
 * rather than "harnesses", because a person did not install a harness.
 *
 * Nothing here installs anything. Every offer is a printed command into the
 * flow that already exists, with its own preview and its own approval.
 *
 * @param claudeOnly - what the settings read found.
 * @param repoRoot - the project's absolute path, for the install command.
 * @returns the lines to print, empty when there is nothing to say.
 */
export function formatClaudeOnly(claudeOnly: HarnessClaudeOnly, repoRoot: string): string[] {
  const { root, plugins, personalHookCommands: hooks } = claudeOnly;
  const HEADING = 'Installed in Claude Code only';

  if (claudeOnly.unreadable !== undefined) {
    return [
      '',
      HEADING,
      `  DorkOS could not read ${root}/settings.json, so it cannot tell you what Claude Code has. (${claudeOnly.unreadable})`,
      '  Nothing else in this report is affected.',
    ];
  }
  const notices = claudeOnly.unreadableParts.length + (claudeOnly.skippedEntries ?? 0);
  if (plugins.length === 0 && notices === 0) return [];

  // Where a plugin came from, in the strongest form the data supports. Neither
  // side carries a version DorkOS can compare, so a resolved repository is "the
  // same name from the same repository" and never "the same plugin"; an
  // unresolved one names only what Claude Code calls it.
  const from = (plugin: HarnessClaudeOnly['plugins'][number]): string =>
    plugin.repo === undefined
      ? `    - ${plugin.name} (from a source Claude Code calls "${plugin.marketplace}")`
      : `    - ${plugin.name} (from ${plugin.repo})`;

  const machineWide = plugins.filter((plugin) => plugin.settingsScope === 'user');
  const inGroup = (offer: HarnessClaudeOnly['plugins'][number]['offer']): typeof plugins =>
    machineWide.filter((plugin) => plugin.offer === offer);

  const lines: string[] = ['', HEADING, `  Read from ${root}`];
  if (plugins.length > 0) {
    lines.push(
      '',
      `  You turned on ${plugins.length} ${plugins.length === 1 ? 'plugin' : 'plugins'} in Claude Code. Your other agent tools cannot see them.`
    );
  }

  // What DorkOS could not read, said BEFORE the lists it affects, so nobody
  // reads a short list as a complete one. Each line names one key and says what
  // still holds, because "something went wrong" over a report full of confident
  // answers is worse than no line at all.
  for (const part of claudeOnly.unreadableParts) {
    lines.push(
      '',
      `  DorkOS could not read the ${part} part of ${root}/settings.json; the plugin list is still right.`
    );
  }
  const skipped = claudeOnly.skippedEntries ?? 0;
  if (skipped > 0) {
    lines.push(
      '',
      skipped === 1
        ? '  DorkOS could not read 1 of the entries in that file, so it is not listed.'
        : `  DorkOS could not read ${skipped} of the entries in that file, so they are not listed.`
    );
  }
  if (plugins.length === 0) return lines;

  if (hooks > 0) {
    lines.push(
      '',
      `  Your personal Claude Code settings run ${hooks} ${hooks === 1 ? 'command' : 'commands'} automatically. Only Claude Code runs ${hooks === 1 ? 'it' : 'them'}.`
    );
  }

  if (claudeOnly.sourcesUnreadable !== undefined) {
    // No offer can be made about anything, so none of the four group headings is
    // true. The plugins and their repositories still are, and the actual cause
    // is said once instead of being spread across every row as "DorkOS cannot
    // tell where these came from".
    lines.push(
      '',
      `  DorkOS could not read its own list of sources (${claudeOnly.sourcesUnreadable}), so it cannot offer installs right now.`,
      '',
      '  Turned on in Claude Code:',
      ...plugins.map(from),
      '',
      '  Your company can also turn plugins on or off, in a settings file DorkOS cannot read. So this list may',
      '  not be the whole story.'
    );
    return lines;
  }

  const canInstall = inGroup('install');
  if (canInstall.length > 0) {
    lines.push(
      '',
      '  DorkOS can install these for this project, so every agent tool here gets them:'
    );
    // The command sits beside its own package rather than after the whole list:
    // a name and the command that shares it are one thing to read, and eight
    // names followed by eight commands is not.
    for (const plugin of canInstall) {
      lines.push(from(plugin), `  Run: dorkos install ${plugin.name} --project ${repoRoot}`);
    }
    lines.push('  DorkOS has to be running, and it asks you to approve the install first.');
  }

  const needsSource = inGroup('add-source-then-install');
  if (needsSource.length > 0) {
    lines.push('', '  DorkOS does not have these sources yet:');
    for (const plugin of needsSource) {
      lines.push(
        from(plugin),
        `  Add the source first: dorkos marketplace add ${plugin.sourceUrl}`
      );
    }
  }

  const noPackage = inGroup('no-package');
  if (noPackage.length > 0) {
    lines.push('', '  DorkOS has that source but nothing by that name:', ...noPackage.map(from));
  }

  const unknownSource = inGroup('unknown-source');
  if (unknownSource.length > 0) {
    lines.push('', '  DorkOS cannot tell where these came from:', ...unknownSource.map(from));
  }

  const projectOnly = plugins.filter((plugin) => plugin.settingsScope === 'project');
  if (projectOnly.length > 0) {
    lines.push('', '  On for this project only:', ...projectOnly.map(from));
  }

  // Once, at the end. Managed settings may exist and DorkOS may not be allowed
  // to read them, so the report says the answer can be overridden rather than
  // answering as if the file were absent.
  lines.push(
    '',
    '  Your company can also turn plugins on or off, in a settings file DorkOS cannot read. So this list may',
    '  not be the whole story.'
  );
  return lines;
}
