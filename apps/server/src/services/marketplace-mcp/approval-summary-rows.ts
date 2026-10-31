/**
 * The rows of a Marketplace summary card (DOR-3070): one sentence per thing a
 * package can do, and, for an update, how each compares with what is
 * installed.
 *
 * Every sentence is composed here, on the server, with every value quoted,
 * escaped and its hidden characters shown, so a package cannot shape what the
 * card says about it. Commands are written out whole, exactly as the full
 * detail writes them: a cut command is a command nobody read.
 *
 * ## How an update is compared
 *
 * Each item has an identity (a hook's event, matcher and skill; a server's or
 * a schedule's name; a skill's file) and a value. Against the installed
 * version's disclosure:
 *
 * - the same identity and value is unchanged, and only counted;
 * - the same identity with another value is Broader, with `was`, unless the
 *   change is proven narrower (a skill that only lost tools);
 * - an identity with nothing installed is New;
 * - an installed identity with nothing new is Removed, except a hook that
 *   could block something, whose removal is Broader: a removed restriction
 *   gives more power, not less.
 *
 * With no baseline the caller can vouch for (`null`), every item is New: a
 * tampered or unreadable install must never make a change look unchanged.
 *
 * @module services/marketplace-mcp/approval-summary-rows
 */
import { stableStringify } from '@dorkos/shared/capabilities';
import {
  describeHookEvent,
  describeProgramLine,
  describeScheduleArrival,
  describeSchedulePermissionMode,
  revealHiddenCharacters,
  skillCommandKind,
  type DisclosedEffects,
} from '@dorkos/shared/marketplace-schemas';
import type { MarketplaceRisk, MarketplaceRiskKind } from '@dorkos/shared/approval-schemas';

/**
 * A value written out whole, quoted and escaped, with every hidden or
 * direction-changing character shown, so it cannot forge the text around it.
 */
export const whole = (value: string): string => revealHiddenCharacters(JSON.stringify(value));

/** The order rows sit in on a card: the most powerful kind first. */
export const RISK_KIND_ORDER: readonly MarketplaceRiskKind[] = [
  'extension',
  'unreadable',
  'hook',
  'skillCommand',
  'mcp',
  'lsp',
  'monitor',
  'executable',
  'schedule',
  'host',
  'secret',
  'skillTools',
  'dependency',
];

/**
 * The kinds that run code or reach out, which the in-chat cap counts (spec
 * v1.1 call 13). Skill tools and npm libraries are shown but not counted.
 */
export const CODE_RUNNING_KINDS: ReadonlySet<MarketplaceRiskKind> = new Set([
  'extension',
  'hook',
  'skillCommand',
  'mcp',
  'lsp',
  'monitor',
  'executable',
  'schedule',
  'host',
  'secret',
]);

/**
 * Hook events whose command can stop something from happening. Removing one
 * may lift a restriction, so its removal counts as Broader.
 */
const BLOCKING_HOOK_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PermissionRequest',
  'UserPromptSubmit',
]);

/** One disclosed item, ready to compare and to render. */
interface Item {
  kind: MarketplaceRiskKind;
  /** What makes it the same item across versions. */
  id: string;
  /** Its whole value, canonical, so equal values compare equal. */
  value: string;
  /** The row it shows as New. */
  row: Omit<MarketplaceRisk, 'change'>;
  /** What it was, in words, when a Broader row needs `was`. */
  was: string;
  /** Tools, for a skill, so a narrower change can be proven. */
  tools?: readonly string[];
  /** The event a hook runs on, so a removed guard can be told apart. */
  event?: string;
}

/** Every item one disclosure holds, in its own order. */
function itemsOf(effects: DisclosedEffects | null, where: string): Item[] {
  if (!effects) return [];
  const skillCommandOrdinal = new Map<string, number>();
  return [
    ...effects.hooks.map((hook): Item => {
      const when = describeHookEvent(hook.event, hook.matcher ?? undefined);
      const skill = hook.source ? `, while the skill in ${whole(hook.source)} is in use` : '';
      return {
        kind: 'hook',
        id: stableStringify(['hook', hook.event, hook.matcher, hook.source]),
        value: stableStringify(hook),
        row: { kind: 'hook', text: `Runs a command ${when}${skill}`, command: whole(hook.command) },
        was: whole(hook.command),
        event: hook.event,
      };
    }),
    ...effects.skillCommands.map((entry): Item => {
      const n = skillCommandOrdinal.get(entry.source) ?? 0;
      skillCommandOrdinal.set(entry.source, n + 1);
      const filled = entry.usesArguments ? ', with the text typed after it filled in' : '';
      return {
        kind: 'skillCommand',
        id: stableStringify(['skillCommand', entry.source, n]),
        value: stableStringify(entry),
        row: {
          kind: 'skillCommand',
          text: `Runs a command when the ${skillCommandKind(entry.source)} ${whole(entry.skill)} is used (${whole(entry.source)})${filled}`,
          command: whole(entry.command),
        },
        was: whole(entry.command),
      };
    }),
    ...effects.mcpServers.map((server): Item => {
      const local = server.command !== null;
      const text = local
        ? `Starts the MCP server ${whole(server.name)} (${where})`
        : `Connects to the remote MCP server ${whole(server.name)} (${where}) at ${whole(server.url ?? '')}`;
      const command = local ? describeProgramLine(server.command ?? '', server.args) : undefined;
      return {
        kind: 'mcp',
        id: stableStringify(['mcp', server.name]),
        value: stableStringify(server),
        row: { kind: 'mcp', text, ...(command !== undefined && { command }) },
        was: command ?? whole(server.url ?? ''),
      };
    }),
    ...effects.lspServers.map((server): Item =>
      programItem('lsp', 'language server', server, where)
    ),
    ...effects.monitors.map((monitor): Item =>
      programItem('monitor', 'background monitor', monitor, where)
    ),
    ...effects.executables.map((name): Item => ({
      kind: 'executable',
      id: stableStringify(['executable', name]),
      value: stableStringify(name),
      row: {
        kind: 'executable',
        text: `Adds the command ${whole(name)} to the agent's PATH (${where})`,
      },
      was: whole(name),
    })),
    ...effects.schedules.map((job): Item => {
      const text =
        `Scheduled job ${whole(job.name)}: ${job.cron ? `runs on ${whole(job.cron)}` : 'runs only when asked'}, ` +
        `${describeSchedulePermissionMode(job.permissionMode)}, ${describeScheduleArrival(job.startsEnabled)}`;
      return {
        kind: 'schedule',
        id: stableStringify(['schedule', job.name]),
        value: stableStringify(job),
        row: { kind: 'schedule', text },
        was: text,
      };
    }),
    ...effects.skillTools.map((entry): Item => ({
      kind: 'skillTools',
      id: stableStringify(['skillTools', entry.source]),
      value: stableStringify(entry),
      row: {
        kind: 'skillTools',
        text: `The ${skillCommandKind(entry.source)} ${whole(entry.skill)} may use these without asking`,
        items: entry.tools.map(whole),
      },
      was: entry.tools.map(whole).join(', '),
      tools: entry.tools,
    })),
  ];
}

/** A language server or a monitor, which read the same. */
function programItem(
  kind: 'lsp' | 'monitor',
  noun: string,
  program: { name: string; command: string; args: string[]; when: string | null },
  where: string
): Item {
  const command = describeProgramLine(program.command, program.args);
  const when = program.when ? `, ${whole(program.when)}` : '';
  return {
    kind,
    id: stableStringify([kind, program.name]),
    value: stableStringify(program),
    row: { kind, text: `Starts the ${noun} ${whole(program.name)} (${where}${when})`, command },
    was: command,
  };
}

/** The rows an update shows for one item that changed, or none when it only narrowed. */
function changedRows(next: Item, prev: Item): MarketplaceRisk[] {
  if (next.tools && prev.tools) {
    const before = new Set(prev.tools);
    const widened = next.tools.some((tool) => !before.has(tool));
    if (!widened) {
      const after = new Set(next.tools);
      const lost = prev.tools.filter((tool) => !after.has(tool)).map(whole);
      return lost.length > 0
        ? [
            {
              ...next.row,
              change: 'removed',
              text: next.row.text.replace(' may use these', ' may no longer use these'),
              items: lost,
            },
          ]
        : [];
    }
  }
  return [{ ...next.row, change: 'broader', was: prev.was }];
}

/** The row an installed item shows once the new version no longer has it. */
function removedRow(prev: Item): MarketplaceRisk {
  if (prev.kind === 'hook' && prev.event && BLOCKING_HOOK_EVENTS.has(prev.event)) {
    return {
      ...prev.row,
      change: 'broader',
      text: `${prev.row.text.replace(/^Runs/, 'No longer runs')}. If it blocked something, that is now allowed`,
    };
  }
  return { ...prev.row, change: 'removed' };
}

/** What one disclosure compares to: its rows and how many stay the same. */
export interface EffectRows {
  /** New and Broader rows, then Removed ones, in declaration order. */
  rows: MarketplaceRisk[];
  /** Items the new version runs exactly as the installed one does. */
  unchangedCount: number;
}

/**
 * The rows for what a package runs, compared with what is installed.
 *
 * @param next - What the new (or only) version runs.
 * @param baseline - What the installed version runs; `undefined` for an
 *   install, `null` when the installed copy cannot be vouched for. Either
 *   way every item is New.
 * @param where - When its own programs start, in words.
 * @returns Its rows, and how many items are unchanged.
 */
export function effectRows(
  next: DisclosedEffects | null,
  baseline: DisclosedEffects | null | undefined,
  where: string
): EffectRows {
  const nextItems = itemsOf(next, where);
  if (!baseline) {
    return { rows: nextItems.map((item) => ({ ...item.row, change: 'new' })), unchangedCount: 0 };
  }
  const prevItems = itemsOf(baseline, where);
  const used = new Set<number>();
  const take = (match: (prev: Item) => boolean): Item | undefined => {
    const i = prevItems.findIndex((prev, index) => !used.has(index) && match(prev));
    if (i === -1) return undefined;
    used.add(i);
    return prevItems[i];
  };
  let unchangedCount = 0;
  const pending: Item[] = [];
  for (const item of nextItems) {
    if (take((prev) => prev.kind === item.kind && prev.value === item.value)) unchangedCount += 1;
    else pending.push(item);
  }
  const rows: MarketplaceRisk[] = [];
  for (const item of pending) {
    const prev = take((p) => p.kind === item.kind && p.id === item.id);
    rows.push(...(prev ? changedRows(item, prev) : [{ ...item.row, change: 'new' as const }]));
  }
  const removed = prevItems.filter((_, index) => !used.has(index)).map(removedRow);
  return { rows: [...rows, ...removed], unchangedCount };
}

/**
 * Sort rows for the card: New and Broader before Removed, then by kind, most
 * powerful first, keeping each kind's own order.
 *
 * @param rows - The rows, in any order.
 * @returns A new, sorted array.
 */
export function sortRows(rows: readonly MarketplaceRisk[]): MarketplaceRisk[] {
  const rank = (row: MarketplaceRisk) =>
    (row.change === 'removed' ? RISK_KIND_ORDER.length : 0) + RISK_KIND_ORDER.indexOf(row.kind);
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
    .map(({ row }) => row);
}

/**
 * How many rows the in-chat cap counts: New or Broader rows that run code or
 * reach out.
 *
 * @param rows - Every row on the card.
 */
export function codeRowCount(rows: readonly MarketplaceRisk[]): number {
  return rows.filter((row) => row.change !== 'removed' && CODE_RUNNING_KINDS.has(row.kind)).length;
}
