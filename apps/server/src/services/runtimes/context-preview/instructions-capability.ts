/**
 * `instructions.read` (spec `context-viewer` phase 3, Security ruling 8):
 * what every agent is told, as a template, for an agent to read.
 *
 * - **Template mode only.** Variables stay `{{chips}}` with no values: not the
 *   caller's, and never another agent's.
 * - **No other agent's details.** No per-block override counts, no list of
 *   which agents override what. The person's Settings view keeps those.
 * - **Its own next turn, and only its own** (ruling 4's one exception):
 *   `scope: "my_next_turn"` narrows the template to the blocks the caller's own
 *   next turn carries, on its own runtime. There is no input naming another
 *   agent, so there is nothing to refuse.
 *
 * Tier `observe`, `area: null`: every agent already receives this text, so a
 * switch that blocked it would hide the agent's own instructions from it and
 * stop nothing.
 *
 * @module services/runtimes/context-preview/instructions-capability
 */
import { z } from 'zod';
import {
  InstructionsLevelSchema,
  InstructionsPlaceSchema,
  InstructionsRuntimeSchema,
  InstructionsViewSchema,
  type InstructionsRuntime,
} from '@dorkos/shared/agent-instructions-schemas';
import type { AgentRegistryPort } from '@dorkos/shared/agent-runtime';
import { defineCapability, type CapabilityDomain } from '../../core/capabilities/index.js';
import { homeOf, resolveAgentHome } from '../../core/agent-identity/index.js';

/** The MCP tool name. */
export const AGENT_INSTRUCTIONS_TOOL = 'agent_instructions';

/** What the running server teaches the capability to read. */
export interface InstructionsReader {
  /** The agent registry. */
  meshCore(): AgentRegistryPort | undefined;
  /** The runtime an agent at a folder runs on. */
  runtimeType(agentPath: string): Promise<string>;
}

let reader: InstructionsReader | undefined;

/**
 * Teach `instructions.read` where to find the caller's agent.
 *
 * @param next - The reader, or `undefined` at shutdown.
 */
export function setInstructionsReader(next: InstructionsReader | undefined): void {
  reader = next;
}

const RefusalSchema = z.object({ ok: z.literal(false), code: z.string(), error: z.string() });

const ViewResultSchema = z.object({ ok: z.literal(true), view: InstructionsViewSchema });

/** The capability. */
export const agentInstructionsCapability = defineCapability({
  id: 'instructions.read',
  title: 'Read what every agent is told',
  description:
    'Read the instructions DorkOS gives every agent, as a template: each block in model order, ' +
    'with its source, why it is included, whether it is locked, and a rough token count. ' +
    'Values stay as `{{variables}}`. `runtime` is claude-code, codex, opencode or doe; `place` ' +
    'is direct, room or task. Pass `scope: "my_next_turn"` to see only the blocks your own ' +
    'next turn carries, on your own runtime unless you name one.',
  tier: 'observe',
  area: null,
  areaNote: 'every agent already receives this text; blocking it would hide nothing real',
  input: z.object({
    scope: z
      .enum(['template', 'my_next_turn'])
      .optional()
      .describe('`template` (default) for every agent, `my_next_turn` for your own.'),
    runtime: InstructionsRuntimeSchema.optional().describe(
      'Which runtime to show. Defaults to Claude Code, or your own with my_next_turn.'
    ),
    place: InstructionsPlaceSchema.optional().describe('direct (default), room or task.'),
    level: InstructionsLevelSchema.optional().describe('ask, act (default) or autonomy.'),
  }),
  output: z.union([ViewResultSchema, RefusalSchema]),
  surfaces: {
    mcp: {
      toolName: AGENT_INSTRUCTIONS_TOOL,
      servers: ['in-session', 'external'],
      annotations: { idempotentHint: true },
    },
  },
  invoke: async (_deps, input, context) => {
    // Loaded on call: the preview reaches every runtime's builders, which this
    // domain must not pull into the registry's import graph at boot.
    const { buildInstructionsView, buildOwnNextTurnTemplate } = await import('./preview.js');
    const place = input.place ?? 'direct';
    const level = input.level ?? 'act';
    if (input.scope !== 'my_next_turn') {
      const view = await buildInstructionsView({
        runtime: input.runtime ?? 'claude-code',
        place,
        level,
        audience: 'agent',
      });
      return { ok: true as const, view };
    }
    if (!reader) {
      return { ok: false as const, code: 'NOT_READY', error: 'DorkOS is still starting.' };
    }
    const identity = context.identity && !context.identity.inactive ? context.identity : null;
    const meshCore = reader.meshCore();
    const agent = identity ? meshCore?.getByPath(identity.agentPath) : undefined;
    const home = identity ? homeOf(resolveAgentHome(identity.agentPath)) : undefined;
    if (!identity || !agent || !home) {
      return {
        ok: false as const,
        code: 'NO_AGENT',
        error: 'This chat is not one of your agents, so it has no next turn to show.',
      };
    }
    const own = InstructionsRuntimeSchema.safeParse(await reader.runtimeType(identity.agentPath));
    const runtime: InstructionsRuntime = input.runtime ?? (own.success ? own.data : 'claude-code');
    const view = await buildOwnNextTurnTemplate({
      runtime,
      place,
      level,
      audience: 'agent',
      agent: { id: agent.id, home, cwd: identity.agentPath },
      meshCore: meshCore ?? null,
    });
    return { ok: true as const, view };
  },
});

/** The domain: one read-only capability. */
export const instructionsDomain: CapabilityDomain = {
  name: 'instructions',
  capabilities: [agentInstructionsCapability],
};
