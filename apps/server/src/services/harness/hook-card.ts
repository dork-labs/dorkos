/** The hook card's rendering and loss checks, shared by asking and granting. */
import type { ProjectedHook } from '@dorkos/harness';
import type { HookProjectionRequest } from './hook-consent.js';
import type { HookCardOptions } from './hook-approval.js';
import { quoteSummaryValue, redactSecretsInText } from '../core/approvals/approval-summary.js';
import { describeHookScriptPins } from './hook-script-pins.js';

/**
 * How much of one command the card shows.
 *
 * Deliberately larger than {@link quoteSummaryValue}'s 80, which exists so a
 * padded ARGUMENT cannot crowd out the argument that decides how destructive an
 * action is. Here the shell command IS the decision, and 80 characters is enough
 * to hide the interesting half of `node ./hooks/setup.mjs && curl … | sh`.
 * Recognition is not the bar when what is being recognized is a command line.
 *
 * A command shortened here cannot be allowed. The producer records whether
 * every value survived, and the approval service checks the final stored text.
 */
const COMMAND_DISPLAY_MAX_LENGTH = 200;

/**
 * Render one command for the card: swept for secrets, shortened, then quoted and
 * escaped.
 *
 * The order matters and is the same one {@link quoteSummaryValue} documents:
 * shortening first can slice a token below the length its pattern matches, so
 * redaction has to run on the full string. `JSON.stringify` last both quotes the
 * value and flattens newlines, so a command cannot fake a second line of card.
 */
function renderCommandForCard(command: string): string {
  const safe = redactSecretsInText(command);
  const shortened =
    safe.length <= COMMAND_DISPLAY_MAX_LENGTH
      ? safe
      : `${safe.slice(0, COMMAND_DISPLAY_MAX_LENGTH - 1).trimEnd()}…`;
  return JSON.stringify(shortened);
}

/**
 * Say when a hook fires, in words rather than in event names.
 *
 * "Before every tool call" and "when a session ends" are materially different
 * permissions, and an event name like `PreToolUse` means nothing to a person who
 * has never read the harness docs. Unknown events fall back to their own name
 * rather than being dropped: an event DorkOS does not have a phrase for still has
 * to appear on the card.
 */
function describeHookTrigger(hook: ProjectedHook): string {
  const scope = hook.matcher && hook.matcher !== '*' ? ` matching ${hook.matcher}` : '';
  switch (hook.event) {
    case 'PreToolUse':
      return `before every tool call${scope}`;
    case 'PostToolUse':
      return `after every tool call${scope}`;
    case 'UserPromptSubmit':
      return 'every time you send a message';
    case 'SessionStart':
      return 'when a chat starts';
    case 'SessionEnd':
      return 'when a chat ends';
    case 'Stop':
      return 'when a turn finishes';
    case 'SubagentStop':
      return 'when a subagent finishes';
    case 'Notification':
      return 'on every notification';
    case 'PreCompact':
      return 'before the chat is compacted';
    default:
      return `on ${hook.event}${scope}`;
  }
}

/**
 * The sentence on the card.
 *
 * Leads with what will run and WHEN, because both are the decision — the same
 * command on `Stop` and on `PreToolUse` are not the same permission, and a card
 * that showed only the command would let the second inherit consent given for the
 * first. Every value is quoted, escaped and capped, so a command carrying its own
 * quotes and connectives cannot forge the rest of the sentence.
 *
 * @param request - The package, project, and hooks being asked about.
 * @param options - How the card is worded.
 * @returns One plain sentence.
 */
export function summariseHookProjection(
  request: HookProjectionRequest,
  options: HookCardOptions = {}
): string {
  const name = quoteSummaryValue(request.packageName);
  const where = quoteSummaryValue(request.projectPath);
  const hooks = request.hooks
    .map((hook) => `${renderCommandForCard(hook.command)} ${describeHookTrigger(hook)}`)
    .join('; ');
  const count = request.hooks.length;
  const commands = `${count} command${count === 1 ? '' : 's'}`;
  // The files the yes covers, with a short hash, ahead of the commands. Both
  // this clause and the whole sentence can be cut, which prevents Allow.
  // A reviewer can check the hash
  // against the copy they read, and an edit after the yes asks again (DOR-3403).
  const files = describeHookScriptPins(request.scripts ?? []);
  const running = files ? `, running ${quoteSummaryValue(files)}` : '';
  if (options.notInstalledByDorkos) {
    // On Full (DOR-3422): said first, because it is the reason this one asks
    // when nothing else on Full does.
    return (
      `Package ${name} found in ${where}, not installed by DorkOS. Allow it to run ` +
      `${commands} automatically${running}? ${hooks}`
    );
  }
  return `Let the installed package ${name} run ${commands} automatically in ${where}${running}: ${hooks}`;
}

/** Whether every value survives the card's per-value rendering without a cut. */
export function hookCardIsComplete(request: HookProjectionRequest): boolean {
  const values = [
    request.packageName,
    request.projectPath,
    describeHookScriptPins(request.scripts ?? []),
  ];
  return (
    values.every((value) => quoteSummaryValue(value) === JSON.stringify(value)) &&
    request.hooks.every(
      (hook) =>
        hook.command.length <= COMMAND_DISPLAY_MAX_LENGTH &&
        redactSecretsInText(hook.command) === hook.command
    )
  );
}
