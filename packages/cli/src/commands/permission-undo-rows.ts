/**
 * The rows `dorkos permissions undo` prints for what an Undo left alone or
 * found changed since: who, which setting, what it would set, and why.
 *
 * @module commands/permission-undo-rows
 */
import { chatModeWord, type PermissionUndoSkip } from '@dorkos/shared/permissions';

/** The words a recorded value is read with, by what its key is. */
export interface UndoRowLabels {
  /** Files & commands stops. */
  stop: Record<string, string>;
  /** Presets. */
  preset: Record<string, string>;
  /** Area and action states. */
  state: Record<string, string>;
}

/**
 * A recorded value as the undo report says it, read by what the key is: `ask`
 * is the state Ask for an area and the stop Ask first for Files & commands.
 */
function valueText(
  value: string | null,
  key: PermissionUndoSkip['change']['key'],
  labels: UndoRowLabels
): string {
  if (key.kind === 'chat') return chatModeWord(value);
  if (value === null) return 'not set';
  const words =
    key.kind === 'files' ? labels.stop : key.kind === 'preset' ? labels.preset : labels.state;
  return words[value] ?? value;
}

/** What a recorded change is about, as the SETTING column says it. */
function settingText(key: PermissionUndoSkip['change']['key']): string {
  switch (key.kind) {
    case 'area':
      return key.area;
    case 'action':
      return key.action;
    case 'files':
      return `files${key.runtime ? ` (${key.runtime})` : ''}`;
    case 'chat':
      return `chat ${key.sessionId.slice(0, 8)}`;
    case 'preset':
      return 'preset';
  }
}

/**
 * One skipped or conflicting change, as a table row.
 *
 * @param skip - The change the Undo left alone, and why.
 * @param labels - The words values are read with.
 */
export function skipRow(skip: PermissionUndoSkip, labels: UndoRowLabels): string[] {
  const { change } = skip;
  const who = change.target.kind === 'agent' ? change.target.agentName : 'Everyone';
  const why =
    skip.reason === 'changed-since'
      ? `changed since: now ${valueText(skip.current, change.key, labels)}`
      : skip.reason === 'floor'
        ? change.key.kind === 'chat'
          ? 'would loosen the chat'
          : 'would set something that always asks to Allowed'
        : 'no longer exists';
  return [who, settingText(change.key), valueText(change.before, change.key, labels), why];
}
