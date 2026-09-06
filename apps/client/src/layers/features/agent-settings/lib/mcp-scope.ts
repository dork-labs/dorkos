import type { McpServerEntry } from '@dorkos/shared/transport';

/**
 * Where a server on this surface came from, in the four words a person can act
 * on. Never status: a scope badge is neutral, always, because color on this card
 * means "how is it doing", not "where is it from".
 */
export type McpServerScope = 'agent' | 'project' | 'plugin' | 'computer';

/** The sentence a scope badge's tooltip expands to. */
const MCP_SCOPE_TOOLTIP: Record<McpServerScope, string> = {
  agent: 'Added to this agent through DorkOS',
  project: 'From this project, declared in its config files',
  plugin: 'Comes with a plugin',
  computer: 'From your computer-wide config',
};

/** The sentence a card shows for a server DorkOS does not manage. */
const MCP_SCOPE_SENTENCE: Record<McpServerScope, string> = {
  agent: 'Added to this agent through DorkOS.',
  project: 'From this project’s config. Add it to manage it here.',
  plugin: 'Comes with a plugin. Add it to manage it here.',
  computer: 'From your computer-wide config. Add it to manage it here.',
};

/**
 * A runtime-reported server name split into what a person reads and what the
 * runtime actually called it.
 */
export interface ParsedMcpServerName {
  /** The clean name for the card. Equal to the raw name when nothing matched. */
  displayName: string;
  /** The plugin the server ships with, when the name says so. */
  pluginName: string | null;
  /** The name exactly as the runtime gave it, for the Details raw-id row. */
  rawName: string;
}

/**
 * One runtime's convention for encoding a plugin into an MCP server name.
 *
 * A list rather than a regex so a second runtime is one entry, not a rewrite of
 * a growing alternation — and so each convention can say which capture is the
 * plugin and which is the server.
 */
interface PluginNameConvention {
  /** Which runtime writes names this way (documentation for the next author). */
  runtime: string;
  /** The shape, with exactly two captures. */
  pattern: RegExp;
  /** Read the two captures into a name pair. */
  read: (match: RegExpMatchArray) => { displayName: string; pluginName: string };
}

/**
 * The name conventions this surface knows, tried in order.
 *
 * Only Claude Code's `plugin:` prefix forms are here, because they are the only
 * ones OBSERVED. A `<server>@<plugin>` suffix rule was written and removed: `@`
 * is legal inside an ordinary server name, so it renamed `notion@v2` to `notion`
 * and claimed a "v2 plugin" that does not exist — a guess dressed as a fact, and
 * one that also overrode the runtime's own scope. A convention earns a row here
 * when a live build is seen writing it, never before. Anything that matches
 * nothing falls through to raw display — see {@link parseMcpServerName}.
 */
const PLUGIN_NAME_CONVENTIONS: readonly PluginNameConvention[] = [
  {
    runtime: 'claude-code',
    pattern: /^plugin:([^:]+):(.+)$/,
    read: (m) => ({ pluginName: m[1]!, displayName: m[2]! }),
  },
  {
    runtime: 'claude-code',
    pattern: /^plugin:(.+)$/,
    read: (m) => ({ pluginName: m[1]!, displayName: m[1]! }),
  },
];

/**
 * Split a runtime-reported server name into a readable name and the plugin it
 * came from.
 *
 * **The fall-through is the point.** A name that matches no known convention is
 * returned exactly as the runtime gave it, with no plugin — a surface that
 * guessed would mangle `my:server` into something its owner cannot find again.
 * Adding a runtime's convention means adding one entry to
 * {@link PLUGIN_NAME_CONVENTIONS}; it never means loosening this rule.
 *
 * @param rawName - The name as the runtime reported it.
 */
export function parseMcpServerName(rawName: string): ParsedMcpServerName {
  for (const convention of PLUGIN_NAME_CONVENTIONS) {
    const match = rawName.match(convention.pattern);
    if (!match) continue;
    const { displayName, pluginName } = convention.read(match);
    if (!displayName || !pluginName) continue;
    return { displayName, pluginName, rawName };
  }
  return { displayName: rawName, pluginName: null, rawName };
}

/**
 * Which scope a runtime-reported (non-managed) server belongs to, or `null` when
 * the runtime did not say and nothing else can prove it.
 *
 * A parsed plugin name wins outright: a plugin's server is the plugin's wherever
 * the config that loads it happens to live. Otherwise the runtime's own scope
 * decides — its two project-shaped values (`project` for the checked-in
 * `.mcp.json`, `local` for the untracked per-project override) both read as "this
 * project", because the distinction is a config-file detail rather than something
 * a person acts on here, and `user` is the computer-wide config.
 *
 * **An unrecognised or absent scope returns `null`, and the card then shows no
 * badge at all.** Defaulting it to `computer` was a guess that read as a
 * statement of fact: it told people a server their own project declares came from
 * their computer-wide config. Runtimes that report no scope (OpenCode) would have
 * had every server mislabelled the same way. Saying nothing is the honest answer,
 * and it is visibly different from the four answers that are earned.
 *
 * @param entry - The runtime's roster entry.
 * @param parsed - The entry's name, already split by {@link parseMcpServerName}.
 */
export function deriveDiscoveredScope(
  entry: McpServerEntry,
  parsed: ParsedMcpServerName
): McpServerScope | null {
  if (parsed.pluginName) return 'plugin';
  if (entry.scope === 'project' || entry.scope === 'local') return 'project';
  if (entry.scope === 'user') return 'computer';
  return null;
}

/** What a card says about an origin the runtime would not name. */
const UNKNOWN_SCOPE_SENTENCE = 'This agent’s runtime loads this server. Add it to manage it here.';

/**
 * The tooltip for a scope badge, with the plugin named when one is known.
 *
 * @param scope - The badge's scope.
 * @param pluginName - The plugin the server ships with, when known.
 */
export function scopeTooltip(scope: McpServerScope, pluginName: string | null): string {
  if (scope === 'plugin' && pluginName) return `Comes with the ${pluginName} plugin`;
  return MCP_SCOPE_TOOLTIP[scope];
}

/**
 * The card sentence for a server DorkOS does not manage, with the plugin named
 * when one is known and no origin claimed when the scope is unknown.
 *
 * @param scope - The card's scope, or `null` when the runtime did not say.
 * @param pluginName - The plugin the server ships with, when known.
 */
export function scopeSentence(scope: McpServerScope | null, pluginName: string | null): string {
  if (scope === null) return UNKNOWN_SCOPE_SENTENCE;
  if (scope === 'plugin' && pluginName) {
    return `Comes with the ${pluginName} plugin. Add it to manage it here.`;
  }
  return MCP_SCOPE_SENTENCE[scope];
}
