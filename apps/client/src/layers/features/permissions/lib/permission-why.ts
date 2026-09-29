/**
 * The "why?" line behind every permission state (spec `agent-permissions`,
 * task 4.2): where the state comes from, then who last changed it, when, and
 * where. One place, so every surface that shows a state explains it the same
 * way.
 *
 * The honesty rule of the history holds here too: with login off DorkOS cannot
 * tell the person at the keyboard from any other program running as them, so a
 * change is "someone on this computer", never "you", and the line says why.
 *
 * @module features/permissions/lib/permission-why
 */
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import type {
  FilesAndCommandsSource,
  PermissionLastChange,
  PermissionPreset,
  PermissionSource,
  PermissionState,
  PermissionSurface,
} from '@dorkos/shared/permissions';
import { stopLabel } from '@/layers/shared/ui';
import { PRESET_LABEL, STATE_LABEL } from './permission-copy';

/** What a state is explained from. */
export interface StateWhyInput {
  /** The state shown. */
  state: PermissionState;
  /** The layer that decided it. */
  source: PermissionSource;
  /** Set when the destructive rule turned an area's Allowed into Ask. */
  destructiveAsk?: true;
  /** The chosen preset, or `null` while none is chosen. */
  preset: PermissionPreset | null;
  /** The agent the state belongs to, named in lists that span agents. */
  agentName?: string;
}

/** "the default (Full power)", or "the default" while no preset is chosen. */
function theDefault(preset: PermissionPreset | null): string {
  return preset ? `the default (${PRESET_LABEL[preset]})` : 'the default';
}

/**
 * Where a state comes from, in one sentence, e.g. "Allowed, from the default
 * (Full power)." or "Ask. This is a locked area, so it can never be Allowed."
 *
 * @param input - The state and where it came from.
 */
export function stateWhy(input: StateWhyInput): string {
  const state = STATE_LABEL[input.state];
  const agent = input.agentName ?? 'this agent';
  switch (input.source) {
    case 'inactive':
      return "Blocked, because this agent's access was turned off.";
    case 'floor':
      return `${state}. This is a locked area, so it can never be Allowed.`;
    case 'unchanged':
      return `${state}. No preset is chosen yet, so it works as it did before.`;
    case 'always-asks':
      return `${state}. This always shows you what it would change before it runs, so it is never Allowed.`;
    default:
      break;
  }
  if (input.destructiveAsk) {
    return "Ask, because an action that can't be undone always asks unless you set it on its own.";
  }
  switch (input.source) {
    case 'agent-area':
      return `${state}, set for ${agent}.`;
    case 'agent-action':
      return `${state}, set for this one action on ${agent}.`;
    case 'default-area':
      return `${state} for everyone, changed from ${theDefault(input.preset)}.`;
    case 'default-action':
      return `${state} for everyone, set for this one action.`;
    case 'preset':
      return `${state}, from ${theDefault(input.preset)}.`;
  }
}

/**
 * Where a Files & commands stop comes from, in one sentence.
 *
 * @param stop - The stop shown, or `null` for the runtime's own behaviour.
 * @param source - Where it came from.
 * @param agentName - The agent, named in lists that span agents.
 */
export function filesWhy(
  stop: PermissionStop | null,
  source: FilesAndCommandsSource,
  agentName?: string
): string {
  const label = stop ? stopLabel(stop) : null;
  switch (source) {
    case 'agent':
      return `${label}, set for ${agentName ?? 'this agent'}.`;
    case 'runtime':
      return `${label}, set for its runtime in Settings → Runtimes.`;
    case 'default':
      return `${label}, the setting everyone has.`;
    case 'runtime-own':
      return 'Not set, so each runtime starts where it always has.';
  }
}

/** Where a change was made, as the end of a sentence. */
const SURFACE_PHRASE: Record<PermissionSurface, string> = {
  settings: ' in Settings',
  'agent-page': " on the agent's page",
  'control-center': ' in the Control Center',
  'request-card': ' from a request card',
  'first-run': ' during setup',
  'agent-request': " from an agent's request",
  api: ' through the API',
  cli: ' from the command line',
  upgrade: '',
  undo: ' with Undo',
  'file-edit': '',
};

/** "Sep 23" in the reader's own locale. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Who last changed the setting behind a state, when, and where, e.g. "Changed
 * by someone on this computer on Sep 23 in Settings. Login is off, so DorkOS
 * can't confirm who." `null` when no change is on record (a preset's own
 * value), so the line is left out rather than guessed.
 *
 * @param change - The last change, from the permissions read.
 */
export function lastChangeWhy(change: PermissionLastChange | undefined): string | null {
  if (!change) return null;
  const on = `on ${shortDate(change.occurredAt)}`;
  const where = SURFACE_PHRASE[change.surface];
  switch (change.attribution) {
    case 'signed-in': {
      // "You (signed in as Dorian)" reads mid-sentence as "you (signed in as Dorian)".
      const who = change.actorLabel.charAt(0).toLowerCase() + change.actorLabel.slice(1);
      return `Changed by ${who} ${on}${where}.`;
    }
    case 'local-trust':
      return `Changed by someone on this computer ${on}${where}. Login is off, so DorkOS can't confirm who.`;
    case 'agent-request-approved':
      return `Changed ${on}: ${change.actorLabel}.`;
    case 'upgrade':
      return `Set by an upgrade ${on}.`;
    case 'outside':
      return `Changed outside DorkOS ${on}, by an edit to the agent's settings file.`;
  }
}
