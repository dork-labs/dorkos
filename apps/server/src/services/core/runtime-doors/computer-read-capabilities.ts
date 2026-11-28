/**
 * This computer's own reads as capabilities the mount serves, on the paths the
 * app and the CLI always used (ADR 261123-170830, DOR-4978):
 *
 * | Capability                          | Path                                                |
 * | ----------------------------------- | --------------------------------------------------- |
 * | `debug.auto_mode_stops`             | `GET /api/debug/auto-mode-stops`                    |
 * | `debug.chat_spine`                  | `GET /api/debug/sessions/{sessionId}`               |
 * | `system.requirements`               | `GET /api/system/requirements`                      |
 * | `system.memory`                     | `GET /api/system/memory`                            |
 * | `system.shell_check`                | `GET /api/system/shell-check`                       |
 * | `keep-awake.status`                 | `GET /api/keep-awake`                               |
 * | `git.status`                        | `GET /api/git/status`                               |
 * | `runtimes.openrouter_sign_in_status`| `GET /api/runtimes/opencode/openrouter/oauth/status`|
 *
 * ## Who may read them: the hand routes' readers
 *
 * None of the hand routes asked who was calling, so none of these is
 * person-only: an agent reads them as it could before, now also through
 * `dorkos call`, and gets no MCP tool for them. Each answer is counts, settings
 * or statuses DorkOS wrote. The chat read folds in the session read guard, as
 * the hand route did: an agent gets `session_not_found` for a chat it may not
 * read. The OpenRouter sign-in read stays at this computer, from the mount's
 * yes/no fact (`context.request`), never a header. That fact also turns away a
 * program key at this computer, as the other runtime setup reads do.
 *
 * The reads run on the computer side and are wired in by the composition layer
 * ({@link setComputerReader}), so this front-door module imports no runtime,
 * session or memory code. They refuse with the hand routes' codes and
 * sentences, kept in `runtime-read-refusals.ts`.
 *
 * @module services/core/runtime-doors/computer-read-capabilities
 */
import { z } from 'zod';
import { CAPABILITY_TIERS } from '@dorkos/shared/capabilities';
import {
  GitStatusErrorSchema,
  GitStatusResponseSchema,
  KeepAwakeStatusSchema,
  type GitStatusError,
  type GitStatusResponse,
  type KeepAwakeStatus,
} from '@dorkos/shared/schemas';

import {
  CapabilityToolError,
  defineCapability,
  type CapabilityDomain,
} from '../capabilities/capability-definition.js';
import type { CapabilityHandlerContext } from '../capabilities/index.js';
import {
  COMPUTER_READ_SENTENCES as SAYS,
  RUNTIME_READ_SENTENCES,
} from './runtime-read-refusals.js';

/** What auto mode stopped since this process started, beside the notes DorkOS attached. */
const AutoModeStopStatsSchema = z.object({
  stops: z.number().int().describe('Approval cards auto mode caused on a DorkOS tool.'),
  stopsByTool: z.record(z.string(), z.number().int()).describe('Stops per qualified tool name.'),
  stopSessions: z.number().int().describe('Distinct chats that saw at least one stop.'),
  assertions: z.number().int().describe('Notes DorkOS attached to a finished DorkOS tool call.'),
  assertionsByTier: z.record(z.enum(CAPABILITY_TIERS), z.number().int()),
  since: z.string().describe('When this process started counting (ISO 8601).'),
});

/** One chat's live spine, as the diagnostic read reports it: counts and states, never words. */
const ChatSpineSchema = z.object({
  sessionId: z.string(),
  runtime: z.string().nullable().describe('The runtime, or null when the read failed.'),
  runtimeBound: z
    .boolean()
    .nullable()
    .describe('False when `runtime` is the inference, not a recorded owner; null on failure.'),
  lifecycle: z.string().nullable(),
  seq: z.number().int().nullable(),
  subscribers: z.number().int().nullable(),
  waiters: z.number().int().nullable(),
  eventLogSize: z.number().int().optional(),
  ringSize: z.number().int().optional(),
  persistence: z.string().optional(),
  projectorLive: z.boolean(),
  lockHeldBy: z.string().nullable(),
  lockAcquiredAt: z.string().nullable(),
  pendingInteractions: z.array(
    z.object({
      kind: z.string(),
      toolName: z.string().optional(),
      startedAt: z.string(),
      remainingMs: z.number(),
    })
  ),
  durableEvents: z.object({ total: z.number().int(), byType: z.record(z.string(), z.number()) }),
});

/** One runtime's dependencies and readiness, as `GET /api/system/requirements` reports it. */
const RuntimeRequirementsSchema = z.object({
  dependencies: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      status: z.enum(['satisfied', 'missing', 'outdated', 'unknown']),
      reason: z.literal('credentials_unreadable').optional(),
      version: z.string().optional(),
      requiredVersion: z.string().optional(),
      installHint: z.string().optional(),
      infoUrl: z.string().optional(),
      expiresAt: z.string().optional(),
    })
  ),
  state: z.enum(['ready', 'connect', 'unknown']).optional(),
  connect: z
    .object({ kind: z.enum(['install', 'login', 'provider-picker']), label: z.string() })
    .optional(),
  provider: z.string().optional(),
});

/** Every registered runtime's dependencies and readiness, by runtime type. */
const SystemRequirementsSchema = z.object({
  runtimes: z.record(z.string(), RuntimeRequirementsSchema),
});

/** Which memory backend is configured, which one serves, and why they differ. */
const MemoryProviderStatusSchema = z.object({
  configuredId: z.string(),
  activeId: z.string(),
  benched: z.boolean(),
  benchReason: z.string().nullable(),
});

/** DorkOS's check on agents' shell commands, as the app shows it. */
const ShellCheckStatusSchema = z.object({
  down: z.boolean(),
  full: z.boolean(),
  canContinue: z.boolean(),
  continuing: z.boolean(),
});

/** An OpenRouter sign-in in flight, by its `state`. */
const OpenRouterSignInStatusSchema = z.object({
  status: z.enum(['pending', 'connected', 'error']),
  error: z.string().optional(),
});

/**
 * What the reads ask this computer. Each answers content-free; the git read
 * throws the shared path refusal for a folder DorkOS may not use.
 */
export interface ComputerReader {
  /** What auto mode stopped since this process started. */
  autoModeStops(): z.infer<typeof AutoModeStopStatsSchema>;
  /**
   * Whether this caller may read the chat: the session read guard's rule.
   *
   * @param context - Who calls.
   * @param chatId - The chat.
   */
  mayReadChat(context: CapabilityHandlerContext, chatId: string): boolean;
  /**
   * One chat's live spine.
   *
   * @param chatId - A chat id that parsed.
   */
  chatSpine(chatId: string): Promise<z.infer<typeof ChatSpineSchema>>;
  /** Every registered runtime's dependencies, probed concurrently. */
  requirements(): Promise<z.infer<typeof SystemRequirementsSchema>>;
  /** Which memory backend is configured and which one serves. */
  memory(): z.infer<typeof MemoryProviderStatusSchema>;
  /** The shell check's state. */
  shellCheck(): z.infer<typeof ShellCheckStatusSchema>;
  /** Whether this computer is being kept awake, and for what. */
  keepAwake(): KeepAwakeStatus;
  /**
   * A folder's git status, or `not_git_repo`.
   *
   * @param dir - A folder, or undefined for the default one.
   */
  gitStatus(dir: string | undefined): Promise<GitStatusResponse | GitStatusError>;
  /**
   * An OpenRouter sign-in's status; an unknown `state` reads as an expired link.
   *
   * @param state - The flow's state, or empty.
   */
  openRouterSignIn(state: string): z.infer<typeof OpenRouterSignInStatusSchema>;
}

/** Set by the running server; absent, every read says DorkOS is still starting. */
let reader: ComputerReader | undefined;

/**
 * Teach this computer's reads where to read.
 *
 * @param next - The reader; `undefined` leaves the reads answering that DorkOS is starting.
 */
export function setComputerReader(next: ComputerReader | undefined): void {
  reader = next;
}

/** The reader, or the refusal for a server that has not wired one. */
function readerOf(): ComputerReader {
  if (!reader) {
    throw new CapabilityToolError({ code: 'COMPUTER_READS_UNAVAILABLE', error: SAYS.notReady });
  }
  return reader;
}

/** Why these reads need no permission area. */
const AREA_NOTE = 'reading this computer’s own counts and statuses';

/** UUIDs, as `parseSessionId` (`lib/route-utils.ts`) accepts them for the hand route. */
const UUID = z.string().uuid();

/** `debug.auto_mode_stops`: how often auto mode stopped an agent on a DorkOS tool. */
const autoModeStopsCapability = defineCapability({
  id: 'debug.auto_mode_stops',
  title: 'Read how often auto mode stopped an agent',
  description:
    'How often auto mode stopped the agent on a DorkOS tool since this process started, ' +
    'beside how many notes DorkOS attached to DorkOS tool calls in the same window. Counts only.',
  tier: 'observe',
  area: null,
  areaNote: AREA_NOTE,
  input: z.object({}),
  output: AutoModeStopStatsSchema,
  surfaces: { http: { method: 'get', path: '/api/debug/auto-mode-stops' } },
  invoke: async () => readerOf().autoModeStops(),
});

/** `debug.chat_spine`: one chat's live spine, for a diagnosis. */
const chatSpineCapability = defineCapability({
  id: 'debug.chat_spine',
  title: 'Read one chat’s live state',
  description:
    'One chat’s runtime, its live stream (lifecycle, counters, subscribers), who holds its ' +
    'lock, what it waits on, and how many durable events it recorded by type. Counts, ' +
    'states and ids only, never a message. An agent reads only a chat it may read.',
  tier: 'observe',
  area: null,
  areaNote: AREA_NOTE,
  input: z.object({ sessionId: z.string().describe('The chat, by its session id.') }),
  output: ChatSpineSchema,
  surfaces: { http: { method: 'get', path: '/api/debug/sessions/{sessionId}' } },
  invoke: async (_deps, { sessionId }, context) => {
    const parsed = UUID.safeParse(sessionId);
    if (!parsed.success) {
      throw new CapabilityToolError({ code: 'DEBUG_CHAT_ID_INVALID', error: SAYS.chatIdInvalid });
    }
    const read = readerOf();
    if (!read.mayReadChat(context, parsed.data)) {
      throw new CapabilityToolError({ code: 'DEBUG_CHAT_NOT_FOUND', error: SAYS.chatNotFound });
    }
    return read.chatSpine(parsed.data);
  },
});

/** `system.requirements`: what each runtime needs, and whether it is ready. */
const requirementsCapability = defineCapability({
  id: 'system.requirements',
  title: 'Read what each runtime needs',
  description:
    'Every registered runtime’s dependency checks and whether it is ready or needs ' +
    'connecting, probed concurrently and time-bounded per runtime.',
  tier: 'observe',
  area: null,
  areaNote: AREA_NOTE,
  input: z.object({}),
  output: SystemRequirementsSchema,
  surfaces: { http: { method: 'get', path: '/api/system/requirements' } },
  invoke: async () => readerOf().requirements(),
});

/** `system.memory`: which memory backend serves agents' notes. */
const memoryStatusCapability = defineCapability({
  id: 'system.memory',
  title: 'Read which memory backend serves',
  description:
    'Which memory backend is configured, which one is serving agent calls right now, and ' +
    'why they differ when one was benched.',
  tier: 'observe',
  area: null,
  areaNote: AREA_NOTE,
  input: z.object({}),
  output: MemoryProviderStatusSchema,
  surfaces: { http: { method: 'get', path: '/api/system/memory' } },
  invoke: async () => readerOf().memory(),
});

/** `system.shell_check`: the state of DorkOS's check on agents' shell commands. */
const shellCheckCapability = defineCapability({
  id: 'system.shell_check',
  title: 'Read the shell check’s state',
  description:
    'Whether DorkOS’s check on agents’ shell commands is down, whether a person may go on ' +
    'without it, and whether one chose to until restart.',
  tier: 'observe',
  area: null,
  areaNote: AREA_NOTE,
  input: z.object({}),
  output: ShellCheckStatusSchema,
  surfaces: { http: { method: 'get', path: '/api/system/shell-check' } },
  invoke: async () => readerOf().shellCheck(),
});

/** `keep-awake.status`: whether this computer is being kept awake, and for what. */
const keepAwakeCapability = defineCapability({
  id: 'keep-awake.status',
  title: 'Read whether this computer is kept awake',
  description:
    'Whether DorkOS is keeping this computer from idle-sleeping right now, what is keeping it ' +
    'awake (chats, room replies and task runs, each counted once), the setting, and why it ' +
    'cannot when it cannot. The same payload is pushed as `keep_awake_status` on ' +
    '`GET /api/events` whenever it changes.',
  tier: 'observe',
  area: null,
  areaNote: AREA_NOTE,
  input: z.object({}),
  output: KeepAwakeStatusSchema,
  surfaces: { http: { method: 'get', path: '/api/keep-awake' } },
  invoke: async () => readerOf().keepAwake(),
});

/** `git.status`: a folder's branch and change counts. */
const gitStatusCapability = defineCapability({
  id: 'git.status',
  title: 'Read a folder’s git status',
  description:
    'A folder’s branch, its tracking branch, ahead and behind counts, and how many files are ' +
    'modified, staged, untracked or conflicted; `{ "error": "not_git_repo" }` for a folder ' +
    'that is not in a git checkout. Leave out `dir` for the default folder.',
  tier: 'observe',
  area: null,
  areaNote: AREA_NOTE,
  input: z.object({
    dir: z.string().optional().describe('A folder inside the ones DorkOS may use.'),
  }),
  output: z.union([GitStatusResponseSchema, GitStatusErrorSchema]),
  surfaces: { http: { method: 'get', path: '/api/git/status' } },
  invoke: async (_deps, { dir }) => readerOf().gitStatus(dir || undefined),
});

/** `runtimes.openrouter_sign_in_status`: an OpenRouter sign-in in flight. */
const openRouterSignInStatusCapability = defineCapability({
  id: 'runtimes.openrouter_sign_in_status',
  title: 'Read an OpenRouter sign-in’s status',
  description:
    'Whether the OpenRouter sign-in started with `state` is pending, connected or failed. An ' +
    'unknown or expired `state` reads as an error. Only at this computer.',
  tier: 'observe',
  area: null,
  areaNote: AREA_NOTE,
  input: z.object({ state: z.string().optional().describe('The sign-in’s state.') }),
  output: OpenRouterSignInStatusSchema,
  surfaces: { http: { method: 'get', path: '/api/runtimes/opencode/openrouter/oauth/status' } },
  invoke: async (_deps, { state }, context) => {
    if (!context.request?.atThisComputerWithoutProgramKey) {
      throw new CapabilityToolError({
        code: 'RUNTIMES_NOT_LOCAL',
        error: RUNTIME_READ_SENTENCES.connectNotLocal,
      });
    }
    return readerOf().openRouterSignIn(state ?? '');
  },
});

/**
 * This computer's own reads, one domain per id prefix; on every server. In this
 * order the mount serves them.
 */
export const computerReadsDomains: readonly CapabilityDomain[] = [
  { name: 'debug', capabilities: [autoModeStopsCapability, chatSpineCapability] },
  {
    name: 'system',
    capabilities: [requirementsCapability, memoryStatusCapability, shellCheckCapability],
  },
  { name: 'keep-awake', capabilities: [keepAwakeCapability] },
  { name: 'git', capabilities: [gitStatusCapability] },
  { name: 'runtimes', capabilities: [openRouterSignInStatusCapability] },
];
