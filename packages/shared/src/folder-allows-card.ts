/**
 * The words on the card that asks a person to let an agent's own folder allow
 * list apply (DOR-3039), shared by both sides (spec `computer-side-starts-alone`
 * §5.7): the space side raises the card with them, and the computer side uses
 * them to judge, before it asks, whether a card could show the list whole.
 *
 * Node only, through `./approval-text.js`.
 *
 * @module shared/folder-allows-card
 */
import { quoteSummaryValue, storableSummary } from './approval-text.js';
import type { FolderAllowRequest } from './computer-asks.js';

/**
 * One rule for the card, whole, quoted so it cannot fake card text. Never
 * shortened: `judgeAllowRule` keeps only rules short enough to show in full.
 */
function renderRuleForCard(rule: string): string {
  return JSON.stringify(rule);
}

/** `1 command`, `2 commands`. */
function commands(count: number): string {
  return `${count} command${count === 1 ? '' : 's'}`;
}

/**
 * The sentence on the card (copy signed off by designer). A new list names
 * every rule; a changed one names what was added and removed. Rules are shown
 * exactly as written, quoted so a rule cannot fake card text.
 *
 * @param request - The agent, its rules, and the rules behind its last yes.
 */
export function summariseFolderAllows(request: FolderAllowRequest): string {
  const name = quoteSummaryValue(request.agentName);
  const list = (rules: readonly string[]) => rules.map(renderRuleForCard).join(', ');
  const parts: string[] = [];
  const previous = request.previousRules;
  if (previous) {
    const added = request.rules.filter((rule) => !previous.includes(rule));
    const removed = previous.filter((rule) => !request.rules.includes(rule));
    parts.push(`${name} changed the commands it can run without asking.`);
    if (added.length > 0) parts.push(`Added: ${list(added)}.`);
    if (removed.length > 0) parts.push(`Removed: ${list(removed)}.`);
  } else {
    parts.push(
      `Let ${name} run ${commands(request.rules.length)} without asking, as listed in its folder: ${list(request.rules)}.`
    );
  }
  parts.push('Applies from its next turn.');
  const dropped = request.dropped ?? 0;
  if (dropped > 0) {
    parts.push(
      `${dropped} rule${dropped === 1 ? '' : 's'} left out: DorkOS never applies wildcards or rules for its own tools.`
    );
  }
  return parts.join(' ');
}

/**
 * Whether the card would show this list exactly as written. The approval store
 * caps a summary's length and hides anything shaped like a secret; a list whose
 * card lost a word to either would be approved by a person who never saw all
 * of it, so it is never asked about (DOR-3039 review).
 *
 * @param request - The list a card would ask about.
 */
export function cardShowsWholeList(request: FolderAllowRequest): boolean {
  const summary = summariseFolderAllows(request);
  return storableSummary(summary) === summary;
}
