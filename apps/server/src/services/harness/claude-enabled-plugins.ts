/**
 * What Claude Code alone has — the plugins a person turned on in Claude Code's
 * own settings, and what DorkOS can offer to do about each one.
 *
 * Two file kinds are opened and nothing is ever written: `<claudeRoot>/settings.json`
 * and the project's `.claude/settings.json` and `.claude/settings.local.json`.
 * Claude Code's plugin cache under `<claudeRoot>/plugins/` is NEVER read — it is
 * private, versioned and has already changed format once, and projecting out of
 * it would break the one rule the engine's sweep depends on (contract position
 * D4). `known_marketplaces.json` and `plugin-catalog-cache.json` are private for
 * the same reason and are not read either.
 *
 * **A failure is a record, never a throw.** The model is the engine's own
 * `inventory/read.ts`: absent is silent, present-and-unreadable carries the path
 * and the reason, and the rest of the report survives. A read of somebody's home
 * directory must not be able to take `dorkos harness sync` down, and a torn read
 * while Claude Code rewrites the file is the ordinary case rather than the
 * exotic one.
 *
 * **Nothing from that file is written anywhere, projected, or sent off the
 * machine.** The only values that leave here are plugin names, marketplace names
 * and repositories, and counts. The hooks schema below deliberately never names
 * `command`, so no shell text a person wrote is ever bound to a value.
 *
 * @module services/harness/claude-enabled-plugins
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { HarnessClaudeOnly, HarnessClaudeOnlyPlugin } from '@dorkos/shared/harness-schemas';
import { inheritedClaudeRoot } from '../runtimes/claude-code/claude-config-dir.js';
import { MarketplaceCache } from '../marketplace/marketplace-cache.js';
import { MarketplaceSourceManager } from '../marketplace/marketplace-source-manager.js';
import { marketplaceRepoKey } from '../marketplace/lib/marketplace-repo-key.js';

/**
 * The slice of a Claude Code settings file DorkOS reads.
 *
 * `.passthrough()` at both levels on purpose: this is somebody else's file and
 * the vendor adds keys to it. Every field named here is documented (Claude
 * Code's settings reference and plugin-marketplaces reference, both read
 * 2026-09-08); everything else is carried through untouched and never inspected.
 */
const ClaudeSettingsSliceSchema = z
  .object({
    /**
     * `"<plugin-name>@<marketplace-name>"` to whether the person turned it on.
     *
     * The ONE key this feature is about, and the only one whose shape is checked
     * here: a `enabledPlugins` that is not an object at all is a settings file
     * DorkOS cannot answer from, so it becomes the unreadable record. The
     * ENTRIES inside it are checked separately and one at a time
     * ({@link readEnabledPlugins}) — a single non-boolean value costs its own
     * line and nothing else.
     */
    enabledPlugins: z.record(z.string(), z.unknown()).optional(),
    /**
     * Marketplace local name to where it came from, and the hooks block, both
     * read with NO shape declared.
     *
     * Strictness here is a liability rather than a safeguard. Both are somebody
     * else's keys in somebody else's file, neither is what the person came for,
     * and a schema that rejected one would take the whole plugin list down with
     * it: a bare-string `extraKnownMarketplaces.x.source` or one bad byte under
     * `hooks.Stop` used to answer "DorkOS could not read your settings" for a
     * file whose `enabledPlugins` was perfectly readable. Each is now walked
     * defensively for exactly what it is worth — a repository slug and a count —
     * and a shape neither walk recognises costs that one key's answer and says
     * so.
     */
    extraKnownMarketplaces: z.unknown().optional(),
    /**
     * Hooks — COUNTED, never read.
     *
     * `z.unknown()` for the reason above, and the walk that counts it
     * ({@link countHookCommands}) never touches a `command`, so no shell text a
     * person wrote is ever bound to a value. Array lengths are the whole of it.
     */
    hooks: z.unknown().optional(),
  })
  .passthrough();

/** One settings file's parsed slice. @see {@link ClaudeSettingsSliceSchema} */
type ClaudeSettingsSlice = z.infer<typeof ClaudeSettingsSliceSchema>;

/** A key whose own shape defeated its walk, while the rest of the file read fine. */
export type ClaudeSettingsPart = 'extraKnownMarketplaces' | 'hooks';

/** What one settings file read produced: its slice, or the reason there is none. */
interface SettingsRead {
  /** The parsed slice. Empty when the file is absent, absent when it is unreadable. */
  slice?: ClaudeSettingsSlice;
  /** Set when the file is there and could not be turned into a slice. */
  unreadable?: string;
}

/** The message a failed read carries, from whatever the filesystem threw. */
function causeOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True for a plain JSON object — the shape every walk below expects. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Say what is wrong with a settings file's SHAPE without repeating anything
 * written in it.
 *
 * Zod's own messages quote the value they rejected, and this file belongs to a
 * person: a reason that echoed it would put a line of somebody's private
 * settings into a terminal report, which is the one thing this whole module is
 * careful not to do. The key path is enough to find the problem and names only
 * plugin and marketplace names, which the report prints anyway.
 *
 * @param error - the failed parse.
 * @returns a reason safe to print, naming where and not what.
 */
function describeShape(error: z.ZodError): string {
  const first = error.issues[0];
  const where = first && first.path.length > 0 ? first.path.join('.') : 'the file itself';
  const more = error.issues.length - 1;
  return `${where} is not a shape DorkOS can read${more > 0 ? `, and ${more} more` : ''}`;
}

/**
 * What a person is told when the file is not JSON at all.
 *
 * A FIXED sentence, and the reason is not tidiness. V8's `SyntaxError` quotes
 * about ten bytes of the input back at you — measured, a settings file whose
 * first bytes were an API key produced `Unexpected token 's', "sk-ant-api"... is
 * not valid JSON`, and this string is printed to a terminal and sent on the
 * wire in `claudeOnly.unreadable`. The position is the useful half and it names
 * nothing, so that is the half that survives.
 */
const NOT_JSON = 'the file is not valid JSON';

/**
 * Read and parse one Claude Code settings file.
 *
 * Absent is silent and empty — a machine where Claude Code has never written
 * settings has nothing to report. Anything else that stops the read (a
 * permission error, a directory in the file's place, invalid JSON, an
 * `enabledPlugins` that is not an object) becomes a reason, and the caller
 * decides what to do with it. Never throws.
 *
 * @param file - absolute path of the settings file.
 * @returns the slice, or the reason there is none.
 */
async function readSettingsSlice(file: string): Promise<SettingsRead> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { slice: {} };
    // A filesystem error names a path and a code, never a byte of the file.
    return { unreadable: causeOf(err) };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // The error itself is deliberately dropped — see {@link NOT_JSON}.
    return { unreadable: NOT_JSON };
  }

  const parsed = ClaudeSettingsSliceSchema.safeParse(json);
  // Zod, not `JSON.parse` with a cast. The counter-example in this tree is
  // `loadClaudeHooks`, which casts and throws; a cast here would let a settings
  // file whose `enabledPlugins` is a string walk into the classifier as if it
  // were a map.
  if (!parsed.success) return { unreadable: describeShape(parsed.error) };
  return { slice: parsed.data };
}

/**
 * The boolean entries of one file's `enabledPlugins`, and how many were not.
 *
 * A value that is not a boolean is skipped rather than fatal. Claude Code writes
 * this map, a person edits it, and one hand-typed `"true"` in a file with twenty
 * good entries must not turn nineteen answers into none — but it must not be
 * silent either, so the count is carried up and the report says how many.
 *
 * @param raw - the file's `enabledPlugins`, already known to be an object.
 * @returns the boolean entries, and the number of entries that were not.
 */
function readEnabledPlugins(raw: Record<string, unknown> | undefined): {
  entries: Record<string, boolean>;
  skipped: number;
} {
  const entries: Record<string, boolean> = {};
  let skipped = 0;
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (typeof value === 'boolean') entries[key] = value;
    else skipped += 1;
  }
  return { entries, skipped };
}

/**
 * The `owner/name` slug each declared marketplace resolves to, walked
 * defensively.
 *
 * Every step is checked because the vendor owns this shape and a person can
 * hand-edit it: an entry that is not an object, a `source` that is a bare string
 * rather than the documented object, a `repo` that is a number. None of those is
 * a reason to stop resolving the OTHER marketplaces, so each one simply
 * contributes no key.
 *
 * @param raw - the file's `extraKnownMarketplaces`.
 * @returns each marketplace name mapped to `owner/name`, or `null` when the key
 *   itself is not an object DorkOS can walk at all.
 */
function readMarketplaces(raw: unknown): Record<string, string | null> | null {
  if (raw === undefined) return {};
  if (!isRecord(raw)) return null;
  const resolved: Record<string, string | null> = {};
  for (const [name, entry] of Object.entries(raw)) {
    const source = isRecord(entry) ? entry.source : undefined;
    if (!isRecord(source) || typeof source.source !== 'string') {
      resolved[name] = null;
      continue;
    }
    resolved[name] = marketplaceRepoKey({
      kind: 'claude-source',
      source: source.source,
      repo: typeof source.repo === 'string' ? source.repo : undefined,
    });
  }
  return resolved;
}

/** The three settings scopes DorkOS can read, lowest precedence first. */
interface MergedSettings {
  /** The user file's own `enabledPlugins`, before anything overrode it. */
  user: Record<string, boolean>;
  /** `enabledPlugins` merged per key: local over project over user. */
  enabled: Record<string, boolean>;
  /** Marketplace name to `owner/name`, merged per key, same precedence. */
  marketplaces: Record<string, string | null>;
  /** How many `enabledPlugins` entries were skipped for not being booleans. */
  skipped: number;
  /** Keys whose own shape defeated their walk, while the rest of the file read fine. */
  unreadableParts: ClaudeSettingsPart[];
}

/**
 * Merge the readable settings files per key, under Claude Code's documented
 * precedence: local over project over user.
 *
 * Reading only the user half would make the report wrong in the most ordinary
 * case there is — a plugin somebody turned off FOR THIS REPO would be listed as
 * something they are missing, with an install command beside it.
 *
 * @param scopes - the user, project and local slices, in that order.
 * @returns the user file's own entries, the merged view of all three, and what
 *   could not be walked along the way.
 */
function mergeSettings(scopes: readonly ClaudeSettingsSlice[]): MergedSettings {
  const enabled: Record<string, boolean> = {};
  const marketplaces: Record<string, string | null> = {};
  let skipped = 0;
  let marketplacesUnreadable = false;
  for (const slice of scopes) {
    const own = readEnabledPlugins(slice.enabledPlugins);
    Object.assign(enabled, own.entries);
    skipped += own.skipped;
    const known = readMarketplaces(slice.extraKnownMarketplaces);
    if (known === null) marketplacesUnreadable = true;
    else Object.assign(marketplaces, known);
  }
  return {
    user: readEnabledPlugins(scopes[0]?.enabledPlugins).entries,
    enabled,
    marketplaces,
    skipped,
    unreadableParts: marketplacesUnreadable ? ['extraKnownMarketplaces'] : [],
  };
}

/**
 * How many commands a settings file's `hooks` block would run.
 *
 * The count is entries, not matcher groups: one `Stop` group holding three
 * commands runs three commands, and saying "1" there would understate exactly
 * the thing the line exists to disclose.
 *
 * Walked defensively rather than schema-checked, and it never reads a value:
 * only `Array.isArray` and `.length` are asked of anything. A group that is not
 * an array, or an entry whose `hooks` is not one, contributes zero rather than
 * failing the file — but a `hooks` key that is not an object at all is reported,
 * because "0 commands" and "DorkOS could not look" are different answers.
 *
 * @param raw - the user settings slice's `hooks`.
 * @returns the total across every matcher group, or `null` when it cannot be walked.
 */
function countHookCommands(raw: unknown): number | null {
  if (raw === undefined) return 0;
  if (!isRecord(raw)) return null;
  let total = 0;
  for (const group of Object.values(raw)) {
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      if (isRecord(entry) && Array.isArray(entry.hooks)) total += entry.hooks.length;
    }
  }
  return total;
}

/**
 * Split `"<plugin>@<marketplace>"` into its two halves.
 *
 * The marketplace name is the part after the LAST `@`, so a scoped plugin name
 * keeps its own.
 *
 * @param key - one `enabledPlugins` key.
 * @returns the plugin and marketplace names, or `null` when the key has no `@`.
 */
function splitPluginKey(key: string): { name: string; marketplace: string } | null {
  const at = key.lastIndexOf('@');
  if (at <= 0 || at === key.length - 1) return null;
  return { name: key.slice(0, at), marketplace: key.slice(at + 1) };
}

/** What DorkOS knows about its own configured marketplace sources. */
interface DorkosSources {
  /** Repository key to the source that points at it. First configured wins. */
  byRepo: Map<string, string>;
  /**
   * Package names a source's cached listing carries, by source name.
   *
   * A source with no cached listing is ABSENT from this map, and that is load
   * bearing: "DorkOS has that source but nothing by that name" is only sayable
   * when a listing was actually read. Guessing it from a cold cache would tell
   * somebody a package does not exist when nobody has looked.
   */
  packages: Map<string, Set<string>>;
}

/**
 * Read DorkOS's own configured sources and whatever listings the cache already
 * holds for them.
 *
 * Called only when there is at least one plugin to classify, so a run with
 * nothing to report never opens `marketplaces.json` at all.
 *
 * **`list()` seeds the shipped defaults when that file does not exist yet**, so
 * on a machine DorkOS has never run this read creates it. Stated rather than
 * hidden, and it is the right answer anyway: without it every plugin would be
 * told to add a source DorkOS already ships. (`dorkos marketplace add` would
 * take that duplicate URL, under a second name — it refuses a duplicate NAME,
 * not a duplicate address — so the cost is a confusing second source rather than
 * an error.) The write is inside `<dorkHome>`, DorkOS's own directory, and
 * `dorkos harness sync --check` still touches nothing in the person's project.
 *
 * @param dorkHome - the resolved DorkOS data directory.
 * @returns the sources by repository key, or the path DorkOS could not read.
 */
async function readDorkosSources(
  dorkHome: string
): Promise<DorkosSources | { unreadable: string }> {
  let sources: { name: string; source: string }[];
  const sourcesPath = path.join(dorkHome, 'marketplaces.json');
  try {
    sources = await new MarketplaceSourceManager(dorkHome).list();
  } catch {
    // DorkOS's OWN list is unreadable, which is a different answer from "Claude
    // Code did not say where this came from" and has to read differently. The
    // caller keeps every repository it resolved and says, once, that it cannot
    // offer installs until this file is fixed. The reason is dropped and only
    // the path kept: the parse error can quote a line of the file.
    return { unreadable: sourcesPath };
  }

  const cache = new MarketplaceCache(dorkHome);
  const byRepo = new Map<string, string>();
  const packages = new Map<string, Set<string>>();
  for (const source of sources) {
    const key = marketplaceRepoKey({ kind: 'url', url: source.source });
    if (key !== null && !byRepo.has(key)) byRepo.set(key, source.name);
    try {
      const cached = await cache.readMarketplace(source.name);
      if (cached) {
        packages.set(source.name, new Set(cached.json.plugins.map((plugin) => plugin.name)));
      }
    } catch {
      // A cache entry that cannot be read is a cache entry nobody looked in.
    }
  }
  return { byRepo, packages };
}

/**
 * Decide which of the five rungs one plugin comes to rest on.
 *
 * Rung 5 is a copy rule rather than a branch: neither side carries a version
 * DorkOS can compare, so rungs 1 and 2 may only ever claim a package of the same
 * name from the same repository.
 *
 * `sources-unreadable` is the fifth value and it is NOT a rung: it says nothing
 * about the plugin and everything about DorkOS. It exists because the honest
 * alternative was worse — every plugin used to fall to `unknown-source` here,
 * so the report said "DorkOS cannot tell where these came from" on the line
 * above the repository it had just named, and the actual cause was never
 * mentioned at all.
 *
 * @param repo - the repository key, or `null` when Claude Code's settings did
 *   not name one this can compare.
 * @param name - the plugin's name.
 * @param dorkos - DorkOS's own sources, or the path it could not read.
 * @returns the offer, and the source URL to add when there is one.
 */
function classifyOffer(
  repo: string | null,
  name: string,
  dorkos: DorkosSources | { unreadable: string }
): Pick<HarnessClaudeOnlyPlugin, 'offer' | 'sourceUrl'> {
  if ('unreadable' in dorkos) return { offer: 'sources-unreadable' };
  if (repo === null) return { offer: 'unknown-source' };
  const sourceName = dorkos.byRepo.get(repo);
  if (sourceName === undefined) {
    return { offer: 'add-source-then-install', sourceUrl: `https://github.com/${repo}` };
  }
  const listed = dorkos.packages.get(sourceName);
  if (listed !== undefined && !listed.has(name)) return { offer: 'no-package' };
  return { offer: 'install' };
}

/** What {@link readClaudeOnlyPlugins} needs, with no resolver of its own. */
export interface ClaudeOnlyPluginsInput {
  /** The Claude root to open. Resolve it with {@link inheritedClaudeRoot}. */
  claudeRoot: string;
  /** The project whose `.claude/settings*.json` take part in the merge. */
  projectPath: string;
  /** The resolved DorkOS data directory, for the marketplace sources. */
  dorkHome: string;
}

/**
 * Read Claude Code's own settings and classify every plugin a person turned on.
 *
 * Takes both roots as arguments and calls no resolver, so a test stages two temp
 * directories and no home directory is ever read.
 *
 * A plugin is reported when its value MERGED across the three readable settings
 * files is `true`. One turned off is not something anybody is missing, and one
 * with no entry anywhere is not reportable at all: Claude Code's `defaultEnabled`
 * falls back to `true`, and the public half of its state cannot enumerate
 * installs — which is why every sentence built from this says "turned on"
 * rather than "installed".
 *
 * Managed settings are not read. They may be unreadable to DorkOS, so the answer
 * carries `mayBeOverridden` rather than pretending the file is absent.
 *
 * @param input - the two roots and the DorkOS data directory.
 * @returns what Claude Code alone has, or the reason its settings could not be read.
 */
export async function readClaudeOnlyPlugins(
  input: ClaudeOnlyPluginsInput
): Promise<HarnessClaudeOnly> {
  const { claudeRoot, projectPath, dorkHome } = input;
  const base = { root: claudeRoot, readAt: new Date().toISOString(), mayBeOverridden: true };

  const user = await readSettingsSlice(path.join(claudeRoot, 'settings.json'));
  if (user.slice === undefined) {
    return {
      ...base,
      unreadable: user.unreadable ?? 'unknown',
      unreadableParts: [],
      plugins: [],
      personalHookCommands: 0,
    };
  }

  // A project settings file that cannot be parsed contributes nothing here and
  // is not this block's story to tell: the engine opens the same path for hooks
  // and reports it in its own words, so a second sentence about it would be a
  // duplicate written from the wrong place.
  const project = await readSettingsSlice(path.join(projectPath, '.claude', 'settings.json'));
  const local = await readSettingsSlice(path.join(projectPath, '.claude', 'settings.local.json'));
  const merged = mergeSettings([user.slice, project.slice ?? {}, local.slice ?? {}]);

  const hooks = countHookCommands(user.slice.hooks);
  const partial = {
    ...(merged.skipped > 0 ? { skippedEntries: merged.skipped } : {}),
    unreadableParts: [...merged.unreadableParts, ...(hooks === null ? (['hooks'] as const) : [])],
    personalHookCommands: hooks ?? 0,
  };

  const turnedOn = Object.entries(merged.enabled).filter(([, on]) => on === true);
  if (turnedOn.length === 0) return { ...base, ...partial, plugins: [] };

  const dorkos = await readDorkosSources(dorkHome);
  const plugins: HarnessClaudeOnlyPlugin[] = [];
  for (const [key] of turnedOn) {
    const split = splitPluginKey(key);
    if (split === null) continue;
    const repo = merged.marketplaces[split.marketplace] ?? null;
    plugins.push({
      name: split.name,
      marketplace: split.marketplace,
      ...(repo === null ? {} : { repo }),
      // `user` means on machine-wide. A plugin the user file turns OFF and the
      // project turns ON is on for this repository only, which is what the
      // reader needs to know, so the test is the user file's own value rather
      // than the mere presence of a key.
      settingsScope: merged.user[key] === true ? 'user' : 'project',
      ...classifyOffer(repo, split.name, dorkos),
    });
  }

  return {
    ...base,
    ...partial,
    ...('unreadable' in dorkos ? { sourcesUnreadable: dorkos.unreadable } : {}),
    plugins,
  };
}

/**
 * {@link readClaudeOnlyPlugins} against the Claude root a bare `claude` uses.
 *
 * The one call site of {@link inheritedClaudeRoot} outside its own module, and
 * the reason it is exported: `$CLAUDE_CONFIG_DIR` else `~/.claude` is the Claude
 * Code the person typed `/plugin install` into. `resolveActiveClaudeRoot()`
 * answers which account DorkOS runs and bills on, and `resolveClaudeRootSet()`
 * enumerates accounts nobody is running — reporting plugins from those would
 * describe sessions the person is not having.
 *
 * **Total**: every failure becomes the record, including one nobody predicted.
 * Its two callers are a person's terminal report and a read-only HTTP route, and
 * neither may be taken down by what is in somebody's home directory — a `500`
 * there would lose the whole status answer over a file this field is a footnote
 * about. The root is resolved OUTSIDE the guard because the record has to carry
 * one either way, and `inheritedClaudeRoot()` only reads an env var and joins a
 * path.
 *
 * @param input - the project and the DorkOS data directory.
 * @returns what Claude Code alone has, read from the inherited root.
 */
export async function collectClaudeOnlyPlugins(
  input: Omit<ClaudeOnlyPluginsInput, 'claudeRoot'>
): Promise<HarnessClaudeOnly> {
  const claudeRoot = inheritedClaudeRoot();
  try {
    return await readClaudeOnlyPlugins({ ...input, claudeRoot });
  } catch (err) {
    return {
      root: claudeRoot,
      readAt: new Date().toISOString(),
      unreadable: causeOf(err),
      mayBeOverridden: true,
      unreadableParts: [],
      plugins: [],
      personalHookCommands: 0,
    };
  }
}
