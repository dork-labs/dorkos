/**
 * The `compact_my_session` capability: how an agent asks for its own
 * conversation to be summarized (DOR-2732).
 *
 * The decision logic lives in {@link AgentCompactionService}; this file is the
 * declaration every surface is generated from. Two choices in it are the whole
 * design and are written down here:
 *
 * - **No session argument.** The target is the session the call arrived from,
 *   which the in-session server reads off the verified turn. A tool that took a
 *   session id would be a tool that could summarize someone else's
 *   conversation; one that takes none cannot.
 * - **In-session only.** The external `/mcp` server has no session, so the verb
 *   would only ever refuse there. Listing it would be a tool that cannot work.
 *
 * ## Why a permission, and why an area of its own
 *
 * The owner decides, per agent, whether it may ask (default Allowed). That is
 * exactly what a permission is: a per-agent switch on the agent's permissions
 * page, stored in its `.dork/agent.json`, that only a person can change — the
 * `change_permission` path is in the Permissions floor area, which is never
 * Allowed, so an agent can at most ASK a person to change it. A new field beside
 * it would need its own writer, its own guard against the agent editing it, and
 * its own switch; the permission model already has all three.
 *
 * It is the only member of the Own chat area rather than an action filed under
 * a neighbour, because the resolver lets an area entry beat a preset's action
 * entry: filed under Other agents, setting that area to Ask or Blocked would
 * quietly decide this too. In an area of its own only a setting for THIS action
 * (per agent, or the install's default for the area) decides it, and the
 * permissions pages render the new row from `PERMISSION_AREAS` with no code of
 * their own. Allowed in every preset (`permission-presets.ts`).
 *
 * @module services/session/agent-compaction/compaction-capabilities
 */
import { z } from 'zod';
import { defineCapability, type CapabilityDeps } from '../../core/capabilities/index.js';
import type { CapabilityDomain } from '../../core/capabilities/index.js';
import type { AgentCompactionService } from './agent-compaction-service.js';

declare module '../../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** Present when the server can summarize sessions; gates the `session` domain. */
    sessionCompactionDeps?: {
      /** Decides and schedules an agent-requested summary. */
      compaction: Pick<AgentCompactionService, 'request'>;
    };
  }
}

/** The capability id, and the action id a per-agent permission is stored under. */
export const SESSION_COMPACT_CAPABILITY_ID = 'session.compact';

/**
 * The tool name the capability is registered under. Exported so the
 * `<context_warning>` note names it from here rather than spelling it again.
 */
export const COMPACT_MY_SESSION_TOOL_NAME = 'compact_my_session';

/**
 * The tool names to leave off a session's tool list because its runtime cannot
 * summarize on request (Codex on its exec transport, which only runs prompts;
 * every other runtime, and Codex on app-server, can). Listing it there would be a
 * tool that can only refuse — the reason it is not on the external `/mcp`
 * server either. Decided by the same capability flag the person's `/compact`
 * reads, never by runtime name.
 *
 * @param capabilities - The session's runtime capabilities.
 */
export function compactionToolsHiddenFor(capabilities: {
  commandIntents: { compact: { supported: boolean } };
}): readonly string[] {
  return capabilities.commandIntents.compact.supported ? [] : [COMPACT_MY_SESSION_TOOL_NAME];
}

/** What a request came to, as the agent reads it. */
const CompactionOutcomeSchema = z.object({
  status: z.enum(['scheduled', 'already-scheduled', 'refused']),
  /** Plain language, addressed to the caller. */
  message: z.string(),
  /** Which refusal, so a caller can tell a fact from something that passes. */
  code: z.enum(['no-session', 'unknown-session', 'unsupported', 'rate-limited']).optional(),
  /** When a rate-limited caller may ask again (ISO-8601). */
  retryAfter: z.string().optional(),
});

/**
 * Narrow the bag to the service, throwing if the registry was composed without
 * it (a wiring bug, caught at boot by `assertDeps`).
 *
 * @param deps - The capability bag.
 */
function requireCompactionDeps(deps: CapabilityDeps): Pick<AgentCompactionService, 'request'> {
  if (!deps.sessionCompactionDeps) {
    throw new Error(
      'Session capability invoked without sessionCompactionDeps in the registry bag.'
    );
  }
  return deps.sessionCompactionDeps.compaction;
}

/** The session domain: one capability, present when the server can summarize. */
export const sessionDomain: CapabilityDomain = {
  name: 'session',
  assertDeps: requireCompactionDeps,
  capabilities: [
    defineCapability({
      id: SESSION_COMPACT_CAPABILITY_ID,
      title: 'Summarize its own chat',
      description:
        'Ask for THIS conversation to be summarized so it has room again — use it when your ' +
        'context window is nearly full. It never runs mid-turn: the summary happens after the ' +
        'current turn ends, and the chat records that you asked. A summary drops detail for ' +
        'good, so FIRST save what matters to your memory: open work, session ids, pending ' +
        'decisions, anything you will need afterwards. Optional `note` says what the summary ' +
        'should keep; it is used as the focus where the runtime supports one. Works on your own ' +
        'conversation only, at most once an hour; a second call while one is scheduled does ' +
        'nothing more.',
      tier: 'act',
      area: 'own_chat',
      // What a card shows if the owner sets this to Ask: the note, if any.
      approvalDisplayFields: ['note'],
      input: z.object({
        note: z
          .string()
          .min(1)
          .max(2000)
          .optional()
          .describe(
            'What the summary should keep, e.g. "the open migration and the three failing tests".'
          ),
      }),
      output: CompactionOutcomeSchema,
      surfaces: {
        mcp: {
          toolName: COMPACT_MY_SESSION_TOOL_NAME,
          servers: ['in-session'],
          annotations: { idempotentHint: false },
        },
      },
      invoke: async (deps, input, context) =>
        requireCompactionDeps(deps).request({
          // The ONLY source of the target: the verified session the call came
          // from. There is no input field that could name another.
          ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
          // Whose permission the summary re-checks before it starts.
          ...(context.identity && !context.identity.inactive
            ? { agentPath: context.identity.agentPath }
            : {}),
        }),
    }),
  ],
};
