/**
 * The source-tree inventory's shapes — one record per artifact a person
 * AUTHORED in this repository, whatever the projector currently does with it.
 *
 * The inventory answers a different question from the scanner and the projector.
 * The scanner asks "what does the planner need?", the projector asks "where does
 * each artifact go?"; this asks "what is in this tree at all?" — so that a kind
 * the projector has never heard of is still counted, and the completeness check
 * can say the plan went silent about it. That is the whole point: `ArtifactType`
 * had no `agent`, `rule` or `mcp` until DOR-1845, so 13 rules, 7 subagent files
 * and a `.mcp.json` in this repo's own tree reached no list at all.
 *
 * Two boundaries keep the inventory honest:
 *
 * - **Sources only, never the engine's own output.** A managed installed-plugin
 *   projection (`<pkg>__<name>` **and** a symlink, per `scan/scanner.ts`) is
 *   something DorkOS wrote; its source is the plugin directory the installed
 *   projector already names. Inventorying it would make the completeness check
 *   demand that the plan account for a path the plan produced. Same for the
 *   symlinks under `.claude/skills`, the marker-bearing command wrappers, and the
 *   `_dorkosHarness` hook groups in `.claude/settings.local.json`.
 * - **Project scope only.** `~/.claude/settings.json`, `~/.claude/skills` and
 *   every other user-scope root are out of scope here; DOR-1857 owns global
 *   scope. Nothing in this directory reads a home directory.
 *
 * @module inventory/types
 */
import type { ArtifactType, Provenance } from '../plan/types.js';

/** The fields every inventory entry carries, whatever kind it is. */
export interface InventoryEntryBase {
  /** The kind of agent file. */
  kind: ArtifactType;
  /** The artifact's name — the identifier a person would recognize it by. */
  name: string;
  /** Repo-relative source path, forward slashes on every platform. */
  source: string;
  /** Where the artifact came from. Always `authored`: the inventory walks a source tree. */
  provenance: Provenance;
}

/**
 * The skills roots another agent tool reads and DorkOS neither owns nor writes
 * into — the folders an OpenCode-first or Cursor-first repository keeps its own
 * skills in (DOR-1902).
 *
 * Every entry is a `readPaths.project` cell of `vendor-facts/index.ts`, and the
 * comment on each names the row it comes from. **A root with no vendor fact is
 * not scanned**: the list is pinned against
 * {@link ../vendor-facts/index.js#PROJECT_SKILL_ROOT_READERS} by
 * `vendor-facts/__tests__/vendor-facts.test.ts`, so a root invented here without
 * a cell reds, and a cell added to the table without a root here reds too.
 *
 * The two roots DorkOS itself owns are deliberately absent: `.agents/skills` is
 * the canonical layer and `.claude/skills` is where the engine projects, and both
 * are walked on their own terms above.
 */
export const HARNESS_NATIVE_SKILL_ROOTS = [
  // `cursor.skills.readPaths.project` — Cursor reads `.codex/skills` as one of
  // its four compatibility paths. Codex's own row does not list it.
  '.codex/skills',
  // `cursor.skills.readPaths.project`.
  '.cursor/skills',
  // `gemini.skills.readPaths.project`.
  '.gemini/skills',
  // `copilot.skills.readPaths.project`.
  '.github/skills',
  // `opencode.skills.readPaths.project`.
  '.opencode/skills',
] as const;

/** One of the {@link HARNESS_NATIVE_SKILL_ROOTS}. */
export type HarnessNativeSkillRoot = (typeof HARNESS_NATIVE_SKILL_ROOTS)[number];

/**
 * The roots a skill can be authored in: the two DorkOS knows by name, plus every
 * {@link HARNESS_NATIVE_SKILL_ROOTS} entry.
 */
export type SkillRoot = '.agents/skills' | '.claude/skills' | HarnessNativeSkillRoot;

/** One authored skill directory. */
export interface SkillInventoryEntry extends InventoryEntryBase {
  /** Skills. */
  kind: 'skill';
  /** Whether the directory is reached through a symlink (a skill kept outside the repo). */
  isSymlink: boolean;
  /** Which authored root it was found in. */
  root: SkillRoot;
  /**
   * The `SKILL.md`'s frontmatter `name`, trimmed — absent when it declares none.
   *
   * Carried because three harnesses key a skill by it and two require it to
   * match the directory, so the projector cannot decide whether a skill in
   * `.claude/skills` is really loadable without it
   * (`vendor-facts/skill-rules.ts`).
   */
  frontmatterName?: string;
}

/** One authored slash command under `.claude/commands`. */
export interface CommandInventoryEntry extends InventoryEntryBase {
  /** Commands. */
  kind: 'command';
}

/** Where a hook declaration was read from. */
export type HookOrigin = 'claude-settings' | 'claude-settings-local' | 'skill-frontmatter';

/** One hook event declared in one source file. */
export interface HookInventoryEntry extends InventoryEntryBase {
  /** Hooks. */
  kind: 'hook';
  /** Which of the three authored hook sources declared it. */
  origin: HookOrigin;
  /** The Claude event name the declaration is keyed by. */
  event: string;
  /**
   * The skill whose frontmatter declared it — set only for
   * `origin: 'skill-frontmatter'`, where the file alone does not name the skill
   * a person would recognize.
   */
  skill?: string;
}

/** One subagent definition under `.claude/agents`. */
export interface AgentInventoryEntry extends InventoryEntryBase {
  /** Subagent definitions. */
  kind: 'agent';
}

/** One path-scoped rule under `.claude/rules`. */
export interface RuleInventoryEntry extends InventoryEntryBase {
  /** Path-scoped rules. */
  kind: 'rule';
  /**
   * The rule's `paths:` frontmatter globs, when it declares any.
   *
   * Present because the two harnesses that have the same idea key on it —
   * Cursor's `globs:` and Copilot's `applyTo:` — so a projection built on this
   * inventory has the globs it needs without re-reading the file (IN-07).
   */
  paths?: readonly string[];
}

/** One MCP server declared in the repo's authored `.mcp.json`. */
export interface McpInventoryEntry extends InventoryEntryBase {
  /** MCP server definitions. */
  kind: 'mcp';
}

/**
 * An MCP config file that belongs to another agent tool, and how many servers it
 * declares (DOR-1902).
 *
 * NOT an {@link InventoryEntry}, on purpose. An entry is something the engine
 * has to account for per harness — that is what the completeness check quantifies
 * over — and this is the opposite: a whole file DorkOS carries nothing out of,
 * for every harness at once. So it travels beside {@link UnreadableSource}, is
 * reported once rather than once per harness, and reaches the report as a
 * project-level drop.
 *
 * **A count, never a name and never a value.** These files hold the same live
 * API keys `.mcp.json` does, and this record is printed by `dorkos harness sync`
 * and served over an API. The readers in `inventory/foreign-mcp.ts` parse each
 * shape only far enough to count its servers, and nothing below the top level of
 * a server's declaration is ever read.
 */
export interface ForeignMcpConfig {
  /** Repo-relative path of the config file, forward slashes on every platform. */
  source: string;
  /** How many MCP servers the file declares. */
  serverCount: number;
}

/** Any one inventory entry. */
export type InventoryEntry =
  | SkillInventoryEntry
  | CommandInventoryEntry
  | HookInventoryEntry
  | AgentInventoryEntry
  | RuleInventoryEntry
  | McpInventoryEntry;

/**
 * A source the inventory saw and could not read.
 *
 * The shape is `plan/unreadable-hooks.ts`'s: something is plainly there, the
 * engine cannot use it, and saying nothing would be the same silence the
 * inventory exists to end. A hostile tree — a file where `.claude/agents` should
 * be a directory, a dangling link at `.claude/rules/x.md`, a `.mcp.json` holding
 * invalid JSON, a `SKILL.md` whose frontmatter will not parse — produces these
 * and never a throw.
 */
export interface UnreadableSource {
  /** The kind of artifact the unreadable source would have held. */
  kind: ArtifactType;
  /** Repo-relative path of the source, forward slashes. */
  source: string;
  /** Why it could not be read, in words a person can act on. */
  reason: string;
}

/** Everything one repository's source tree holds, by kind. */
export interface SourceInventory {
  /** Authored skills in `.agents/skills` and real skill directories in `.claude/skills`. */
  skills: SkillInventoryEntry[];
  /** Authored slash commands under `.claude/commands`. */
  commands: CommandInventoryEntry[];
  /** Hook events from both project settings files and from skill frontmatter. */
  hooks: HookInventoryEntry[];
  /** Subagent definitions under `.claude/agents`. */
  agents: AgentInventoryEntry[];
  /** Path-scoped rules under `.claude/rules`. */
  rules: RuleInventoryEntry[];
  /** MCP servers declared in the authored `.mcp.json`. */
  mcpServers: McpInventoryEntry[];
  /** MCP config files belonging to another agent tool, which DorkOS carries nothing out of. */
  foreignMcpConfigs: ForeignMcpConfig[];
  /** Sources that are plainly there and could not be read. */
  unreadable: UnreadableSource[];
}

/**
 * Every entry in an inventory as one flat list, in a stable kind order.
 *
 * The completeness check reads this: its subject is "every inventoried
 * artifact", not "every skill and then every rule".
 *
 * @param inventory - the inventory to flatten.
 * @returns every entry, skills first and MCP servers last.
 */
export function allEntries(inventory: SourceInventory): InventoryEntry[] {
  return [
    ...inventory.skills,
    ...inventory.commands,
    ...inventory.hooks,
    ...inventory.agents,
    ...inventory.rules,
    ...inventory.mcpServers,
  ];
}

/** An inventory holding nothing — the honest reading for a caller that has not looked. */
export const EMPTY_INVENTORY: SourceInventory = {
  skills: [],
  commands: [],
  hooks: [],
  agents: [],
  rules: [],
  mcpServers: [],
  foreignMcpConfigs: [],
  unreadable: [],
};
