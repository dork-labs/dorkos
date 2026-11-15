/**
 * Refuse an OpenCode turn in a project that ships its own plugins (DOR-4394).
 *
 * The shared sidecar runs with `OPENCODE_DISABLE_PROJECT_CONFIG`, but the
 * pinned `opencode 1.19.3` has a second config loader (`@opencode/v2/Config`)
 * that ignores the switch and `import()`s a project's plugin modules, so their
 * top-level code runs inside the one process every OpenCode chat shares. Until
 * a person can allow a project's plugins (DOR-4399), DorkOS sends no turn for a
 * folder that has any, and the chat says why.
 *
 * Security's rule, a superset of OpenCode's own lookup (`Config` walks
 * `Filesystem.up` from the session folder to the worktree): every folder from
 * the session's up to the filesystem root, with `.git` ignored entirely, so an
 * empty `.git` file or a nested repo cannot end the walk below a plugin
 * (#3764, Security M1). In each folder on that walk, a project has plugins
 * when either holds:
 *
 * - `.opencode/plugin/` or `.opencode/plugins/` holds a code file;
 * - `opencode.json`, `opencode.jsonc`, `.opencode/opencode.json` or
 *   `.opencode/opencode.jsonc` has a non-empty `plugin` or `plugins` entry
 *   (a package name counts).
 *
 * Asked on every turn, never cached, so a plugin added mid-chat stops the
 * next turn. It fails closed: anything it cannot read or parse counts as a
 * plugin. The refusal is DorkOS's own words; nothing the project wrote reaches
 * the chat. The person's own `~/.config/opencode` plugins and DorkOS's
 * `OPENCODE_CONFIG_CONTENT` are not on the walk and keep loading.
 *
 * @module services/runtimes/opencode/messaging/project-plugin-guard
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { StreamEvent } from '@dorkos/shared/types';
import { OPENCODE_PROJECT_PLUGINS_ERROR_CODE } from '@dorkos/shared/run-outcome';

/** The largest config file read; a bigger one cannot be checked, so it counts. */
const MAX_CONFIG_BYTES = 256 * 1024;

/** A code file OpenCode could import from a plugin folder (wider than its `*.{ts,js}`, on purpose). */
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/i;

/** The config files OpenCode reads in a folder, and in its `.opencode/`. */
const CONFIG_NAMES = ['opencode.json', 'opencode.jsonc'];

/** The stable code the chat keys the refusal on. */
export const PROJECT_PLUGINS_CODE = OPENCODE_PROJECT_PLUGINS_ERROR_CODE;

/** What the chat says. Frozen copy; no project text. The app draws the same two lines. */
export const PROJECT_PLUGINS_MESSAGE =
  'OpenCode can’t run in this project. It has its own plugins. DorkOS won’t run a project’s code without your yes. Allowing your own projects comes next.';

/** Whether an error just means "nothing here". */
function isAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Every folder from `dir` up to the filesystem root. `.git` plays no part:
 * where OpenCode would stop is never a reason to look less.
 *
 * @param dir - The session's folder.
 */
export function pluginLookupChain(dir: string): string[] {
  const chain: string[] = [];
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    chain.push(at);
    if (path.dirname(at) === at) return chain;
  }
}

/** Whether a plugin folder holds a code file; a folder that will not list counts. */
function pluginFolderHasCode(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => CODE_FILE.test(name));
  } catch (err) {
    return !isAbsent(err);
  }
}

/** Whether a config entry names at least one plugin. */
function nonEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * JSONC as plain JSON: comments and trailing commas removed, strings kept.
 *
 * @param text - The file's text.
 */
function stripJsonc(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"') {
      const start = i;
      for (i += 1; i < text.length && text[i] !== '"'; i += 1) if (text[i] === '\\') i += 1;
      out += text.slice(start, i + 1);
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new SyntaxError('unterminated comment');
      i = end + 1;
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Whether a config file names a plugin; one that cannot be read or parsed counts. */
function configNamesPlugin(file: string): boolean {
  let text: string;
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return true;
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return !isAbsent(err);
  }
  try {
    const config: unknown = JSON.parse(stripJsonc(text));
    if (typeof config !== 'object' || config === null || Array.isArray(config)) return true;
    const { plugin, plugins } = config as { plugin?: unknown; plugins?: unknown };
    return nonEmpty(plugin) || nonEmpty(plugins);
  } catch {
    return true;
  }
}

/**
 * Whether the project around `dir` has plugins of its own. Never throws; any
 * doubt answers `true`.
 *
 * @param dir - The session's folder.
 */
export function projectHasPlugins(dir: string): boolean {
  try {
    for (const at of pluginLookupChain(dir)) {
      const dot = path.join(at, '.opencode');
      if (pluginFolderHasCode(path.join(dot, 'plugin'))) return true;
      if (pluginFolderHasCode(path.join(dot, 'plugins'))) return true;
      for (const base of [at, dot]) {
        if (CONFIG_NAMES.some((name) => configNamesPlugin(path.join(base, name)))) return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

/** Thrown to refuse a turn once the session's stored folder is known; carries the chat's event. */
export class ProjectPluginsRefusedError extends Error {
  /**
   * Build the refusal for one turn.
   *
   * @param event - The refusal the chat shows.
   */
  constructor(readonly event: StreamEvent) {
    super(PROJECT_PLUGINS_MESSAGE);
  }
}

/**
 * Throw {@link ProjectPluginsRefusedError} when any folder the turn would hand
 * the sidecar has plugins of its own.
 *
 * @param dirs - The turn's folder and the session's stored folder.
 */
export function assertNoProjectPlugins(...dirs: string[]): void {
  const refusal = projectPluginRefusal(...dirs);
  if (refusal) throw new ProjectPluginsRefusedError(refusal);
}

/**
 * The chat's refusal for a turn in a project with plugins of its own, or
 * `undefined` when the turn may run.
 *
 * @param dirs - Every folder the turn would hand the sidecar.
 */
export function projectPluginRefusal(...dirs: string[]): StreamEvent | undefined {
  if (!dirs.some((dir) => projectHasPlugins(dir))) return undefined;
  return {
    type: 'error',
    data: {
      message: PROJECT_PLUGINS_MESSAGE,
      code: PROJECT_PLUGINS_CODE,
      category: 'execution_error',
    },
  };
}
