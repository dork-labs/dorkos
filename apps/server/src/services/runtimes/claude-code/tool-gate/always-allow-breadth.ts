/**
 * Which tools an "Always Allow" on an MCP tool's card covers (DOR-4101).
 *
 * The CLI may suggest a bare `mcp__{server}` rule for an MCP tool's card. That
 * rule allows every tool the server has, now and later, so the card has to say
 * so and let the person pick the one tool instead. This module tells the two
 * apart and, for "Just {tool}", narrows the rule before it reaches the SDK. It
 * changes no gate: only which rule an accepted Always Allow writes.
 *
 * @module runtimes/claude-code/tool-gate/always-allow-breadth
 */
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { AlwaysAllowBreadth } from '@dorkos/shared/types';

/** Whether `toolName` is an MCP tool's, `mcp__{server}__{tool}`. */
function isMcpTool(toolName: string): boolean {
  return /^mcp__.+?__.+$/.test(toolName);
}

/**
 * Whether one rule allows more than this tool, with nothing narrowing it.
 *
 * Read from the tool's own name rather than by parsing out a server, because a
 * server's name may itself hold `__` (DOR-4240): `mcp__a__b` and `mcp__a` both
 * reach past `mcp__a__b__c`. A rule ending in `*` (`mcp__{server}__*`, or
 * `mcp__*`) reaches every tool its prefix starts.
 */
function isWiderRule(rule: { toolName: string; ruleContent?: string }, toolName: string): boolean {
  if (rule.ruleContent || rule.toolName === toolName) return false;
  if (rule.toolName.endsWith('*')) {
    const prefix = rule.toolName.slice(0, -1);
    return prefix.startsWith('mcp__') && toolName.startsWith(prefix);
  }
  return /^mcp__.+$/.test(rule.toolName) && toolName.startsWith(`${rule.toolName}__`);
}

/**
 * Whether Always Allow on this card covers the one tool or its whole server.
 *
 * @param toolName - The tool the card is for.
 * @param suggestions - The SDK permission updates the card would forward.
 * @returns `server` when an allow rule reaches past the tool to its server,
 *   `tool` for any other MCP tool card with suggestions, and `undefined` for a
 *   card that is not an MCP tool's or offers no Always Allow.
 */
export function alwaysAllowBreadthOf(
  toolName: string,
  suggestions: readonly PermissionUpdate[] | undefined
): AlwaysAllowBreadth | undefined {
  if (!isMcpTool(toolName) || !suggestions?.length) return undefined;
  const wide = suggestions.some(
    (update) =>
      update.type === 'addRules' &&
      update.behavior === 'allow' &&
      update.rules.some((rule) => isWiderRule(rule, toolName))
  );
  return wide ? 'server' : 'tool';
}

/**
 * The same suggestions with every allow rule wider than the tool swapped for
 * the one tool's rule, so "Just {tool}" writes `mcp__{server}__{tool}`. A
 * suggestion with no wider rule is passed on as it was.
 *
 * @param toolName - The tool the card is for.
 * @param suggestions - The SDK permission updates the card would forward.
 */
export function narrowToTool(
  toolName: string,
  suggestions: readonly PermissionUpdate[]
): PermissionUpdate[] {
  if (!isMcpTool(toolName)) return [...suggestions];
  return suggestions.map((update) => {
    if (update.type !== 'addRules' || update.behavior !== 'allow') return update;
    if (!update.rules.some((rule) => isWiderRule(rule, toolName))) return update;
    const rules = update.rules.map((rule) => (isWiderRule(rule, toolName) ? { toolName } : rule));
    // One rule per tool: the wide rule and the tool's own may both have been offered.
    const unique = rules.filter(
      (rule, index) =>
        rules.findIndex(
          (r) => r.toolName === rule.toolName && r.ruleContent === rule.ruleContent
        ) === index
    );
    return { ...update, rules: unique };
  });
}
