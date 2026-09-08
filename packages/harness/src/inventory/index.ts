/**
 * `inventory/` — one read-only pass over a repository's source tree, counting
 * every artifact a person authored, whatever the projector currently does with
 * it.
 *
 * The engine used to see only what it could already project. `ArtifactType` had
 * no `agent`, `rule` or `mcp`; `loadClaudeHooks` read one settings file of the
 * two Claude Code merges; skill-frontmatter `hooks:` were never parsed. On this
 * repository's own tree that made `dorkos harness sync --check` silent about 13
 * rules, 7 subagent definitions and a `.mcp.json` — not dropped with a reason,
 * not warned about: absent from the report entirely.
 *
 * This is the fix's first half. The inventory knows nothing about harnesses and
 * decides nothing; it just counts. Two consumers read it: the projector, which
 * turns every entry into an honest per-harness action or drop
 * (`plan/source-artifacts.ts`), and the completeness property P6, which asserts
 * that the plan names every entry for every enabled harness. VC-01's
 * `unmanaged (adoptable)` list is the third, when it is built.
 *
 * **It never throws.** A hostile tree is the normal case for a tool run in
 * somebody else's repository: a file where `.claude/agents` should be a
 * directory, a dangling link at `.claude/rules/x.md`, a half-written
 * `.mcp.json`, a `SKILL.md` whose frontmatter will not parse. Each becomes an
 * {@link UnreadableSource} carrying the path and the reason, in the spirit of
 * `plan/unreadable-hooks.ts`, and the walk keeps going.
 *
 * @module inventory
 */
import { inventorySkills } from './skills.js';
import { inventoryCommands } from './commands.js';
import { inventoryHooks } from './hooks.js';
import { inventoryAgents } from './agents.js';
import { inventoryRules } from './rules.js';
import { inventoryMcpServers } from './mcp.js';
import type { SourceInventory } from './types.js';

export * from './types.js';
export { inventorySkills } from './skills.js';
export { inventoryCommands } from './commands.js';
export { inventoryHooks } from './hooks.js';
export { inventoryAgents, CLAUDE_AGENTS_DIR } from './agents.js';
export { inventoryRules, CLAUDE_RULES_DIR } from './rules.js';
export { inventoryMcpServers, MCP_CONFIG_SOURCE } from './mcp.js';

/**
 * Walk one repository's source tree and record everything a person authored in
 * it, by kind.
 *
 * Pure and read-only: nothing here writes, and nothing reaches outside
 * `repoRoot` (user-scope roots such as `~/.claude/settings.json` are DOR-1857's
 * scope, and are deliberately not read).
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns every authored artifact by kind, plus every source that could not be read.
 */
export function inventorySourceTree(repoRoot: string): SourceInventory {
  const skills = inventorySkills(repoRoot);
  const commands = inventoryCommands(repoRoot);
  const hooks = inventoryHooks(repoRoot, skills.skills);
  const agents = inventoryAgents(repoRoot);
  const rules = inventoryRules(repoRoot);
  const mcp = inventoryMcpServers(repoRoot);

  return {
    skills: skills.skills,
    commands: commands.commands,
    hooks: hooks.hooks,
    agents: agents.agents,
    rules: rules.rules,
    mcpServers: mcp.mcpServers,
    unreadable: [
      ...skills.unreadable,
      ...commands.unreadable,
      ...hooks.unreadable,
      ...agents.unreadable,
      ...rules.unreadable,
      ...mcp.unreadable,
    ],
  };
}
