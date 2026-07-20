/**
 * The curated emoji face set (v1) for the naming step's face picker.
 *
 * Generated avatars are a later non-goal; for now an agent's visual identity
 * is one emoji from this hand-picked, control-panel-flavored set — roles,
 * instruments, and creatures that read as a working agent rather than a toy.
 *
 * @module features/agent-creation/lib/agent-faces
 */

/** The face shown when nothing else seeds the picker (design-your-own default). */
export const DEFAULT_AGENT_FACE = '🤖';

/** The curated emoji faces, in picker order. */
export const AGENT_FACES = [
  '🤖',
  '🦾',
  '🧭',
  '🛰️',
  '📡',
  '🔭',
  '🗺️',
  '🧠',
  '🦉',
  '🦊',
  '🐝',
  '🐙',
  '🚀',
  '⚡',
  '🌟',
  '🔮',
  '🛠️',
  '🔧',
  '📊',
  '📋',
  '✅',
  '🗂️',
  '🔔',
  '🛡️',
] as const;
