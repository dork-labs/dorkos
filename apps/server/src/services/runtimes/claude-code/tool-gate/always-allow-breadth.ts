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

/** `mcp__{server}` for an MCP tool named `mcp__{server}__{tool}`, else `undefined`. */
function serverRuleOf(toolName: string): string | undefined {
  const match = /^(mcp__.+?)__.+$/.exec(toolName);
  return match?.[1];
}

/** Whether one rule names the tool's whole server, with nothing narrowing it. */
function isServerRule(
  rule: { toolName: string; ruleContent?: string },
  serverRule: string
): boolean {
  return rule.toolName === serverRule && !rule.ruleContent;
}

/**
 * Whether Always Allow on this card covers the one tool or its whole server.
 *
 * @param toolName - The tool the card is for.
 * @param suggestions - The SDK permission updates the card would forward.
 * @returns `server` when an allow rule names the bare server, `tool` for any
 *   other MCP tool card with suggestions, and `undefined` for a card that is not
 *   an MCP tool's or offers no Always Allow.
 */
export function alwaysAllowBreadthOf(
  toolName: string,
  suggestions: readonly PermissionUpdate[] | undefined
): AlwaysAllowBreadth | undefined {
  const serverRule = serverRuleOf(toolName);
  if (!serverRule || !suggestions?.length) return undefined;
  const wide = suggestions.some(
    (update) =>
      update.type === 'addRules' &&
      update.behavior === 'allow' &&
      update.rules.some((rule) => isServerRule(rule, serverRule))
  );
  return wide ? 'server' : 'tool';
}

/**
 * The same suggestions with every bare-server allow rule swapped for the one
 * tool's rule, so "Just {tool}" writes `mcp__{server}__{tool}`. A suggestion
 * that names no bare server is passed on as it was.
 *
 * @param toolName - The tool the card is for.
 * @param suggestions - The SDK permission updates the card would forward.
 */
export function narrowToTool(
  toolName: string,
  suggestions: readonly PermissionUpdate[]
): PermissionUpdate[] {
  const serverRule = serverRuleOf(toolName);
  if (!serverRule) return [...suggestions];
  return suggestions.map((update) => {
    if (update.type !== 'addRules' || update.behavior !== 'allow') return update;
    if (!update.rules.some((rule) => isServerRule(rule, serverRule))) return update;
    const rules = update.rules.map((rule) =>
      isServerRule(rule, serverRule) ? { toolName } : rule
    );
    // One rule per tool: the bare rule and the tool's own may both have been offered.
    const unique = rules.filter(
      (rule, index) =>
        rules.findIndex(
          (r) => r.toolName === rule.toolName && r.ruleContent === rule.ruleContent
        ) === index
    );
    return { ...update, rules: unique };
  });
}
