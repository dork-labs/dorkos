/**
 * The agent instructions views (spec `context-viewer` phase 3): what every
 * agent is told, as a template, and what one agent will be told, per runtime.
 *
 * **Both are written by the real builders.** Each runtime's view calls the
 * function that runtime's turn calls — `buildSystemPromptAppend` for Claude
 * Code, `buildCodexPrompt` behind the context gate's input for Codex,
 * `buildOpenCodeSystem` for OpenCode, `buildDoeContextParts` for Doe — handing
 * it a context source instead of the disk (`shared/source/agent-context-source.ts`).
 * The template's source answers every fact with its own `{{token}}`; a
 * preview's answers with the agent's files, keeping only per-turn facts as
 * tokens. Then the output is split into blocks and annotated from the
 * registry. Nothing here writes prompt text.
 *
 * @module services/runtimes/context-preview/preview
 */
import type {
  InstructionsBlock,
  InstructionsLevel,
  InstructionsPlace,
  InstructionsRuntime,
  InstructionsView,
} from '@dorkos/shared/agent-instructions-schemas';
import type { AgentRegistryPort } from '@dorkos/shared/agent-runtime';
import type { Task, TaskRun } from '@dorkos/shared/types';
import type { AgentHome } from '../../core/agent-identity/index.js';
import type { AgentContextSource } from '../shared/source/agent-context-source.js';
import { buildAgentContextAppend } from '../shared/agent-context.js';
import {
  renderBlockedAreaLines,
  resolveToolVisibilityFor,
} from '../shared/permission-tool-filter.js';
import { loadsAgentToAgentTools } from '../shared/tools/tool-exposure-policy.js';
import { joinFitted } from '../shared/window/context-fit.js';
import { buildSystemPromptAppend } from '../claude-code/messaging/context-builder.js';
import { toolDocGates, type ToolDocGates } from '../claude-code/messaging/tool-doc-gates.js';
import { buildCodexAgentContext } from '../codex/agent-context.js';
import { buildCodexPrompt } from '../codex/turn-input.js';
import { buildOpenCodeTurnParts } from '../opencode/messaging/turn-context.js';
import { buildOpenCodeSystem } from '../opencode/messaging/turn-input.js';
import { buildDoeContextParts } from '../doe/context.js';
import { buildTaskAppend } from '../../tasks/task-append.js';
import { renderRoomConventions } from '../../rooms/repo/room-conventions.js';
import {
  SESSION_BLOCKS,
  TURN_BLOCKS,
  sessionBlockFor,
  type ContextBlockSpec,
} from './block-registry.js';
import {
  INSTRUCTIONS_VARIABLES,
  TEMPLATE_CWD,
  TEMPLATE_HOME,
  previewContextSource,
  templateContextSource,
  token,
  variablesIn,
} from './variables.js';
import { splitBlocks } from './split-blocks.js';

/** What a runtime does that DorkOS cannot show, in app copy (at most 15 words each). */
const RUNTIME_NOTES: Record<InstructionsRuntime, string[]> = {
  'claude-code': [
    'Claude Code adds its own built-in instructions, not visible to DorkOS.',
    'Claude Code also loads CLAUDE.md and skills itself.',
  ],
  codex: [
    'Codex: sent once at start, then again only when it changes.',
    'Memory, room tools and each turn’s list ride every turn.',
  ],
  opencode: [
    'OpenCode sends this on its system channel every turn.',
    'OpenCode adds its own prompt and tool list.',
  ],
  doe: ['Doe sends this on its system channel every turn.'],
};

/** What a level changes, in app copy. */
const LEVEL_NOTE = 'Levels change which actions ask first, not these words.';

/** Who reads a view: the person sees override counts; an agent never does (ruling 8). */
export type InstructionsAudience = 'person' | 'agent';

/** One agent, resolved: who it is and where it lives. */
export interface PreviewAgent {
  /** Its Mesh id. */
  id: string;
  /** Its registered home. */
  home: AgentHome;
  /** The folder its turns run in. */
  cwd: string;
}

/** What a view is asked for. */
export interface InstructionsViewRequest {
  runtime: InstructionsRuntime;
  place: InstructionsPlace;
  level: InstructionsLevel;
  audience: InstructionsAudience;
  /** The agent to preview; absent for the template. */
  agent?: PreviewAgent;
  /** The agent registry, for whether a preview's session is an agent's. */
  meshCore?: AgentRegistryPort | null;
}

/**
 * A task as the template names it: every field is its variable, except the
 * agent, which a preview names.
 *
 * @param agentId - The previewed agent's id, or the token for the template.
 */
function templateTask(agentId: string): Task {
  return { name: token('task.name'), cron: token('task.schedule'), agentId } as Task;
}

/** A run as the template names it: a scheduled fire, the unattended case. */
const TEMPLATE_RUN = { id: token('task.run_id'), trigger: 'scheduled' } as TaskRun;

/**
 * What the turn's caller adds after the base append, for one place. Room and
 * task facts are never an agent's own, so they stay tokens in a preview too.
 *
 * @param place - Where the turn happens.
 * @param agentId - The previewed agent's manifest id, when there is one.
 */
function callerAppendFor(place: InstructionsPlace, agentId?: string): string {
  if (place === 'task') {
    return buildTaskAppend(templateTask(agentId ?? token('agent.id')), TEMPLATE_RUN);
  }
  if (place === 'room') {
    return renderRoomConventions(
      token('room.title'),
      token('room.commit'),
      token('room.conventions')
    );
  }
  return '';
}

/** Every tool-doc gate open: the template shows every block an agent can get. */
function allGatesOpen(): ToolDocGates {
  const gates = toolDocGates([]);
  return Object.fromEntries(
    Object.keys(gates).map((key) => [key, true])
  ) as unknown as ToolDocGates;
}

/** The facts a runtime's builders are handed for one view. */
interface BuildInput {
  source: AgentContextSource;
  home: AgentHome;
  cwd: string;
  place: InstructionsPlace;
  callerAppend: string;
  /** `undefined` for the template: every gate open, no area blocked. */
  agent?: PreviewAgent;
  meshCore?: AgentRegistryPort | null;
}

/** What one runtime's builders wrote, and which of it rides once. */
interface Built {
  text: string;
  /** The text that rides once per conversation, for Codex; `''` elsewhere. */
  once: string;
}

/**
 * Run the Claude Code launch's builders, as `launch-resolver.ts` runs them.
 *
 * @param input - The view's facts.
 */
async function buildClaudeCode(input: BuildInput): Promise<Built> {
  const visibility = input.agent ? await resolveToolVisibilityFor(input.home) : undefined;
  const append = await buildSystemPromptAppend(
    input.home,
    input.cwd,
    visibility ? toolDocGates(visibility.blockedAreas) : allGatesOpen(),
    {
      agentSession: input.agent
        ? loadsAgentToAgentTools(!!input.meshCore?.getByPath(input.home))
        : true,
      blockedAreaLines: visibility ? renderBlockedAreaLines(visibility.blockedAreas) : '',
      source: input.source,
    }
  );
  return {
    text: input.callerAppend ? `${append.text}\n\n${input.callerAppend}` : append.text,
    once: '',
  };
}

/**
 * Run a Codex turn's builders: the neutral append the context gate selects
 * from, the per-turn room verbs, then the prompt.
 *
 * @param input - The view's facts.
 */
async function buildCodex(input: BuildInput): Promise<Built> {
  const append = await buildAgentContextAppend(input.home, input.cwd, input.source);
  const agentContext = await buildCodexAgentContext(
    append.text,
    true,
    input.agent ? input.home : undefined
  );
  const prompt = buildCodexPrompt(
    '',
    input.callerAppend ? { systemPromptAppend: input.callerAppend } : undefined,
    agentContext
  );
  return { text: prompt.trim(), once: append.stable };
}

/**
 * Run an OpenCode turn's builders: its turn parts, then its system body.
 *
 * @param input - The view's facts.
 */
async function buildOpenCode(input: BuildInput): Promise<Built> {
  const parts = await buildOpenCodeTurnParts(
    input.cwd,
    true,
    input.agent ? input.home : TEMPLATE_HOME,
    input.place === 'room',
    input.source
  );
  const system = buildOpenCodeSystem(
    input.callerAppend ? { systemPromptAppend: input.callerAppend } : undefined,
    parts
  );
  return { text: system ?? '', once: '' };
}

/**
 * Run a Doe turn's builders.
 *
 * @param input - The view's facts.
 */
async function buildDoe(input: BuildInput): Promise<Built> {
  const parts = await buildDoeContextParts({
    cwd: input.cwd,
    agentPath: input.home,
    hostConnected: true,
    agentToAgent: input.agent ? !!input.meshCore?.getByPath(input.home) : true,
    source: input.source,
    ...(input.callerAppend ? { opts: { systemPromptAppend: input.callerAppend } } : {}),
  });
  return { text: joinFitted(parts, []), once: '' };
}

const BUILDERS: Record<InstructionsRuntime, (input: BuildInput) => Promise<Built>> = {
  'claude-code': buildClaudeCode,
  codex: buildCodex,
  opencode: buildOpenCode,
  doe: buildDoe,
};

/** A rough token count: characters over four, rounded up. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * One registry entry as a view block.
 *
 * @param spec - The registry entry.
 * @param layer - Which list it rides.
 * @param text - What the builders wrote, or `null` for a per-turn block.
 * @param once - Whether it rides once per conversation.
 * @param audience - Who reads the view.
 */
function toBlock(
  spec: ContextBlockSpec,
  layer: 'session' | 'turn',
  text: string | null,
  once: boolean,
  audience: InstructionsAudience
): InstructionsBlock {
  return {
    id: spec.id,
    title: spec.title,
    layer,
    source: spec.source,
    condition: spec.condition,
    conditionNote: spec.conditionNote,
    locked: spec.locked,
    editIn: spec.editIn ?? null,
    delivery: once ? 'once' : 'every-turn',
    text,
    variables: text ? variablesIn(text) : [],
    tokens: text ? estimateTokens(text) : 0,
    // No override exists before phase 5's editing lands, so the count is a
    // true zero. It is the person's alone: an agent's view never carries it.
    ...(audience === 'person' ? { overrideCount: 0 } : {}),
  };
}

/**
 * The block a segment is, or a refusal to guess. A segment the registry does
 * not name is a builder that grew a block nobody described, which
 * `block-registry.test.ts` turns red; at runtime it is shown, unlocked never.
 *
 * @param segment - One top-level segment of the builders' output.
 */
function specFor(segment: string): ContextBlockSpec {
  return (
    sessionBlockFor(segment) ?? {
      id: /^<([a-z_]+)/.exec(segment)?.[1] ?? 'unnamed',
      title: 'Unnamed block',
      source: 'Unknown',
      condition: 'always',
      conditionNote: 'Always.',
      locked: true,
      runtimes: [],
    }
  );
}

/**
 * Build one view.
 *
 * @param request - The runtime, place and level, who reads it, and the agent
 *   for a preview.
 */
export async function buildInstructionsView(
  request: InstructionsViewRequest
): Promise<InstructionsView> {
  const { runtime, place, level, audience, agent } = request;
  const built = await BUILDERS[runtime]({
    source: agent ? previewContextSource : templateContextSource,
    home: agent ? agent.home : TEMPLATE_HOME,
    cwd: agent ? agent.cwd : TEMPLATE_CWD,
    place,
    callerAppend: callerAppendFor(place, agent?.id),
    ...(agent ? { agent } : {}),
    meshCore: request.meshCore ?? null,
  });

  const seen = new Set<string>();
  const blocks: InstructionsBlock[] = splitBlocks(built.text).map((segment) => {
    const spec = specFor(segment);
    seen.add(spec.id);
    const once = built.once !== '' && built.once.includes(segment);
    return toBlock(spec, 'session', segment, once, audience);
  });

  const notIncluded: InstructionsBlock[] = SESSION_BLOCKS.filter(
    (spec) => spec.runtimes.includes(runtime) && !seen.has(spec.id)
  ).map((spec) => toBlock(spec, 'session', null, false, audience));

  for (const spec of TURN_BLOCKS) {
    const here = !spec.places || spec.places.includes(place);
    (here ? blocks : notIncluded).push(toBlock(spec, 'turn', null, false, audience));
  }

  return {
    mode: agent ? 'preview' : 'template',
    runtime,
    place,
    level,
    agentId: agent?.id ?? null,
    runtimeNotes: RUNTIME_NOTES[runtime],
    levelNote: LEVEL_NOTE,
    blocks,
    notIncluded,
    variables: INSTRUCTIONS_VARIABLES.map((variable) => ({ ...variable })),
    tokens: blocks.reduce((sum, block) => sum + block.tokens, 0),
  };
}

/**
 * What an agent may read about its own next turn (Security rulings 4 and 8):
 * the template's blocks, in template mode with no values, narrowed to the
 * blocks its own next turn would carry, on its own runtime.
 *
 * Built by previewing the agent first and keeping only the ids that preview
 * wrote. The preview's text is never returned.
 *
 * @param request - The caller agent and its runtime; `audience` is forced to
 *   `agent`.
 */
export async function buildOwnNextTurnTemplate(
  request: InstructionsViewRequest & { agent: PreviewAgent }
): Promise<InstructionsView> {
  const preview = await buildInstructionsView({ ...request, audience: 'agent' });
  const own = new Set(preview.blocks.map((block) => `${block.layer}:${block.id}`));
  const { agent: _agent, ...templateRequest } = request;
  const template = await buildInstructionsView({ ...templateRequest, audience: 'agent' });
  const blocks = template.blocks.filter((block) => own.has(`${block.layer}:${block.id}`));
  return {
    ...template,
    agentId: null,
    blocks,
    notIncluded: [
      ...template.notIncluded,
      ...template.blocks.filter((block) => !own.has(`${block.layer}:${block.id}`)),
    ].map((block) => ({ ...block, text: null, variables: [], tokens: 0 })),
    tokens: blocks.reduce((sum, block) => sum + block.tokens, 0),
  };
}
