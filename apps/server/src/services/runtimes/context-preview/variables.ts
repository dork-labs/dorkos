/**
 * The documented variable set of the agent instructions template, and the two
 * things done with it: a context source whose facts ARE the tokens, so the real
 * builders write the template, and a one-pass fill for "Preview as…".
 *
 * Security ruling 3, held here:
 * - **Only this set.** {@link fillTemplate} replaces a token it knows and
 *   leaves every other `{{…}}` exactly as written.
 * - **Once, never re-expanded.** One regex pass over the template; a value that
 *   itself contains `{{agent.name}}` is pasted as text and never read again.
 * - **No room, web or connector text.** The variables that would carry it —
 *   a room's files, the agent's memory (room-influenceable), the fence code —
 *   are not fillable, so they stay chips even in a preview.
 *
 * @module services/runtimes/context-preview/variables
 */
import type { InstructionsVariable } from '@dorkos/shared/agent-instructions-schemas';
import type { MemorySnapshot } from '@dorkos/shared/memory-provider';
import type { AgentHome } from '../../core/agent-identity/index.js';
import {
  diskContextSource,
  type AgentContextSource,
  type ContextManifest,
} from '../shared/source/agent-context-source.js';
import { personaText, _sanitizeProfileValue } from '../shared/agent-context.js';

/** Every variable a template may carry, in the order a person reads them. */
export const INSTRUCTIONS_VARIABLES = [
  { id: 'agent.name', label: 'The agent’s name', fillable: true },
  { id: 'agent.id', label: 'The agent’s id', fillable: true },
  { id: 'agent.description', label: 'The agent’s description', fillable: true },
  { id: 'agent.capabilities', label: 'The agent’s capabilities', fillable: true },
  { id: 'agent.persona', label: 'SOUL.md, with traits applied', fillable: true },
  { id: 'agent.boundaries', label: 'NOPE.md', fillable: true },
  { id: 'agent.memory', label: 'MEMORY.md, read each turn', fillable: false },
  { id: 'agent.notes', label: 'A pointer to the agent’s notes files', fillable: false },
  { id: 'user.name', label: 'Your name', fillable: true },
  { id: 'user.work', label: 'Your work', fillable: true },
  { id: 'user.tools', label: 'Tools you use', fillable: true },
  { id: 'env.cwd', label: 'The working folder', fillable: true },
  { id: 'env.app', label: 'The install kind', fillable: true },
  { id: 'env.version', label: 'The DorkOS version', fillable: true },
  { id: 'env.port', label: 'The server port', fillable: true },
  { id: 'env.platform', label: 'The platform', fillable: true },
  { id: 'env.os_version', label: 'The OS version', fillable: true },
  { id: 'env.node', label: 'The Node.js version', fillable: true },
  { id: 'env.hostname', label: 'This computer’s name', fillable: true },
  { id: 'room.title', label: 'The room’s title', fillable: false },
  { id: 'room.commit', label: 'The room files’ commit', fillable: false },
  { id: 'room.conventions', label: 'The room’s ROOM.md', fillable: false },
  { id: 'task.name', label: 'The task’s name', fillable: false },
  { id: 'task.schedule', label: 'The task’s schedule', fillable: false },
  { id: 'task.run_id', label: 'The run’s id', fillable: false },
  { id: 'turn.nonce', label: 'A new fence code each turn', fillable: false },
] as const satisfies readonly InstructionsVariable[];

/** A documented variable id. */
export type InstructionsVariableId = (typeof INSTRUCTIONS_VARIABLES)[number]['id'];

/** The token for one variable, as it appears in a template. */
export function token(id: InstructionsVariableId): string {
  return `{{${id}}}`;
}

const KNOWN = new Set<string>(INSTRUCTIONS_VARIABLES.map((v) => v.id));
const TOKEN = /\{\{([a-z_]+\.[a-z_]+)\}\}/g;

/**
 * The documented variables a text carries, in first-seen order.
 *
 * @param text - A block's template text.
 */
export function variablesIn(text: string): InstructionsVariableId[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(TOKEN)) {
    if (KNOWN.has(match[1]!)) seen.add(match[1]!);
  }
  return [...seen] as InstructionsVariableId[];
}

/**
 * Fill a template's known, fillable tokens in one pass. Unknown tokens and
 * tokens with no value stay as written; a value is never read again, so a
 * value carrying a token cannot expand.
 *
 * @param template - The template text.
 * @param values - The values to fill, by variable id.
 */
export function fillTemplate(
  template: string,
  values: Partial<Record<InstructionsVariableId, string>>
): string {
  return template.replace(TOKEN, (whole, id: string) => {
    if (!KNOWN.has(id)) return whole;
    const value = values[id as InstructionsVariableId];
    return value === undefined ? whole : value;
  });
}

/** A stand-in home for the template: the template source never reads it. */
export const TEMPLATE_HOME = '{{agent.home}}' as AgentHome;

/** The working folder the template names. */
export const TEMPLATE_CWD = token('env.cwd');

/** The fence code a preview prints: a chip, because a turn mints its own. */
export const PREVIEW_NONCE = token('turn.nonce');

/** The memory facts a preview shows: chips, read each turn. */
const TEMPLATE_MEMORY: MemorySnapshot = {
  status: 'present',
  content: token('agent.memory'),
} as MemorySnapshot;

/** The manifest every agent has, as tokens. */
const TEMPLATE_MANIFEST: ContextManifest = {
  name: token('agent.name'),
  id: token('agent.id'),
  description: token('agent.description'),
  capabilities: [token('agent.capabilities')],
  mcpServers: [],
  conventions: { soul: true, nope: true, memory: true, dorkosKnowledge: true },
};

/**
 * The source the template is written from: every fact is its own token, and
 * every optional block is on, so the template shows everything an agent can
 * be told.
 */
export const templateContextSource: AgentContextSource = {
  manifest: async () => TEMPLATE_MANIFEST,
  conventionFile: async (_home, name) =>
    name === 'SOUL.md' ? token('agent.persona') : token('agent.boundaries'),
  memorySnapshot: async () => TEMPLATE_MEMORY,
  notesLine: async () => token('agent.notes'),
  profile: () => ({
    displayName: token('user.name'),
    roles: [token('user.work')],
    tools: [token('user.tools')],
  }),
  envFacts: () => ({
    cwd: token('env.cwd'),
    app: token('env.app'),
    version: token('env.version'),
    port: token('env.port'),
    platform: token('env.platform'),
    osVersion: token('env.os_version'),
    node: token('env.node'),
    hostname: token('env.hostname'),
  }),
  fenceNonce: PREVIEW_NONCE,
};

/**
 * The source one agent's preview is written from: its real files and this
 * host, except the per-turn facts, which stay chips — the memory (read fresh
 * each turn, and room-influenceable) and the fence code (minted per turn).
 */
export const previewContextSource: AgentContextSource = {
  ...diskContextSource,
  memorySnapshot: async (agentId, home) => {
    const real = await diskContextSource.memorySnapshot(agentId, home);
    return real.status === 'present' ? TEMPLATE_MEMORY : real;
  },
  notesLine: async (agentId, home) => {
    const real = await diskContextSource.notesLine(agentId, home);
    return real ? token('agent.notes') : '';
  },
  fenceNonce: PREVIEW_NONCE,
};

/**
 * The fillable values for one agent, read from the same source and through
 * the same helpers its preview's builders use.
 *
 * @param home - The agent's home.
 * @param cwd - The working folder the preview names.
 */
export async function variableValuesFor(
  home: AgentHome,
  cwd: string
): Promise<Partial<Record<InstructionsVariableId, string>>> {
  const source = previewContextSource;
  const manifest = await source.manifest(home);
  const facts = source.envFacts(cwd);
  let profile: ReturnType<AgentContextSource['profile']>;
  try {
    profile = source.profile();
  } catch {
    profile = null;
  }
  const soul = manifest ? await source.conventionFile(home, 'SOUL.md') : null;
  const nope = manifest ? await source.conventionFile(home, 'NOPE.md') : null;
  const values: Partial<Record<InstructionsVariableId, string>> = {
    'env.cwd': facts.cwd,
    'env.app': facts.app,
    'env.version': facts.version,
    'env.port': facts.port,
    'env.platform': facts.platform,
    'env.os_version': facts.osVersion,
    'env.node': facts.node,
    'env.hostname': facts.hostname,
  };
  if (manifest) {
    values['agent.name'] = manifest.name;
    values['agent.id'] = manifest.id;
    if (manifest.description) values['agent.description'] = manifest.description;
    if (manifest.capabilities.length > 0) {
      values['agent.capabilities'] = manifest.capabilities.join(', ');
    }
    if (soul) values['agent.persona'] = personaText(soul, manifest.traits);
    else if (manifest.personaEnabled !== false && manifest.persona) {
      values['agent.persona'] = manifest.persona;
    }
    if (nope) values['agent.boundaries'] = nope;
  }
  const name = profile?.displayName ? _sanitizeProfileValue(profile.displayName) : '';
  if (name) values['user.name'] = name;
  const roles = (profile?.roles ?? []).map(_sanitizeProfileValue).filter(Boolean);
  if (roles.length > 0) values['user.work'] = roles.join(', ');
  const tools = (profile?.tools ?? []).map(_sanitizeProfileValue).filter(Boolean);
  if (tools.length > 0) values['user.tools'] = tools.join(', ');
  return values;
}
