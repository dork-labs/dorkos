/**
 * How a plugin's install and data directories read inside generated text, and
 * the rewrite of Claude Code's plugin tokens to them. Re-exported from
 * `installed-projector`, so callers import from there.
 *
 * @module harness/plan/plugin-paths
 */
import { CLAUDE_PLUGIN_DATA_TOKEN, CLAUDE_PLUGIN_ROOT_TOKEN } from '../scan/scanner.js';

/**
 * The absolute install dir as it should read INSIDE generated text.
 *
 * A plugin writes the token with forward slashes around it —
 * `${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs` — while `join()` spells the install root
 * with backslashes on Windows. Substituting one into the other produced half of
 * each: `C:\Users\me\.dork\plugins\flow/hooks/x.mjs`, inside a shell command
 * and inside a JSON string, where every backslash then has to survive JSON
 * escaping and whatever shell the harness hands the command to. Measured on a
 * real `windows-latest` runner (DOR-1855); nothing in this repo had ever
 * generated one of these paths on Windows before.
 *
 * Forward slashes are read the same way by node, PowerShell and bash, so the
 * whole path is spelled the one way that means the same thing everywhere.
 *
 * POSIX is deliberately untouched, and the platform is a PARAMETER rather than a
 * read of `process.platform` inside: a POSIX filename may legitimately contain a
 * backslash, and passing the platform in is what lets the Windows branch be
 * tested from a Mac.
 *
 * @param absInstallDir - the plugin's absolute install directory.
 * @param platform - the running platform, i.e. `process.platform`.
 * @returns the install dir as it should appear in generated text.
 */
export function pluginRootText(absInstallDir: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? absInstallDir.split('\\').join('/') : absInstallDir;
}

/**
 * A plugin's data directory as it should read inside generated text: the
 * install's own `.dork/data` (ADR 260923-163515), spelled like
 * {@link pluginRootText}.
 *
 * @param absInstallDir - the plugin's absolute install directory.
 * @param platform - the running platform, i.e. `process.platform`.
 * @returns the data dir as it should appear in generated text.
 */
export function pluginDataText(absInstallDir: string, platform: NodeJS.Platform): string {
  return `${pluginRootText(absInstallDir, platform)}/.dork/data`;
}

/**
 * Rewrite both plugin tokens Claude Code expands, `${CLAUDE_PLUGIN_ROOT}` and
 * `${CLAUDE_PLUGIN_DATA}`, to the install's absolute paths.
 *
 * @param text - generated text still carrying the tokens.
 * @param absInstallDir - the plugin's absolute install directory.
 * @returns the text with both tokens resolved.
 */
export function rewritePluginTokens(text: string, absInstallDir: string): string {
  return text
    .split(CLAUDE_PLUGIN_ROOT_TOKEN)
    .join(pluginRootText(absInstallDir, process.platform))
    .split(CLAUDE_PLUGIN_DATA_TOKEN)
    .join(pluginDataText(absInstallDir, process.platform));
}

/** Single-quote a string for a POSIX shell (`'` becomes `'\''`). */
function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

/**
 * The prefix a projected Claude Code hook command carries so a script reading
 * `process.env.CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` gets the same paths
 * Claude Code would export to a plugin's own hook. A projected hook runs as a
 * PROJECT hook, where Claude Code sets neither variable (ADR 260923-163515).
 *
 * DorkOS's own addition, not the package's command: it is applied only where
 * the settings file is written (`toManagedHooks` in `installed-projector`), never in
 * `projectedHooks`, so it never enters the consent digest and a package a
 * person already approved stays approved. Claude Code runs hook commands
 * through a POSIX shell (Git Bash on Windows). The generated
 * Codex/Cursor/Copilot file does not get it: Copilot also runs PowerShell.
 *
 * @param absInstallDir - the plugin's absolute install directory.
 * @param platform - the running platform, i.e. `process.platform`.
 * @returns `export CLAUDE_PLUGIN_ROOT='…' CLAUDE_PLUGIN_DATA='…'; `
 */
export function pluginEnvPrefix(absInstallDir: string, platform: NodeJS.Platform): string {
  const root = shellQuote(pluginRootText(absInstallDir, platform));
  const data = shellQuote(pluginDataText(absInstallDir, platform));
  return `export CLAUDE_PLUGIN_ROOT=${root} CLAUDE_PLUGIN_DATA=${data}; `;
}
