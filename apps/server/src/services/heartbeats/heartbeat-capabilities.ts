/**
 * The `heartbeat` capability domain (spec `heartbeats` §8): `end_beat`, the one
 * way a beat's words reach a person, and `heartbeat_status` (§10 PR 6,
 * `measures/status-capability.ts`), which any agent may read for any agent.
 *
 * ## Only a beat may call it
 *
 * The caller must be a turn in the live beat-turn registry
 * (`beat-turns.ts`); anywhere else it refuses with `NOT_A_BEAT`, including a
 * person's own turn in the beat chat. A second call in the same turn refuses
 * with `ALREADY_ENDED`. Free text in the beat chat goes nowhere: a beat ends
 * with a tool call, not a magic word (canon §7.2).
 *
 * ## No permission area
 *
 * `area: null`, the carve-out the emergency levers use: it can be neither
 * Blocked nor set to Ask. A beat that could not end would be recorded
 * `no-end-beat` and corrupt the measures, and blocking it would hide what a
 * beat found from people without stopping any work.
 *
 * ## Counting what skipped it
 *
 * {@link withBeatBypassCount} wraps the registry's invocation observer so a
 * room post from a running beat turn counts as `bypass` and a chat message to
 * another agent is counted for the loop watcher (§11). Trusted by default
 * blocks neither; the count is how a person sees it.
 *
 * @module services/heartbeats/heartbeat-capabilities
 */
import { z } from 'zod';
import {
  defineCapability,
  type CapabilityDomain,
  type CapabilityInvocationObserver,
} from '../core/capabilities/index.js';
import { EndBeatInputSchema, type EndBeatInput } from '@dorkos/shared/heartbeat-schemas';
import { endBeatTurn, liveBeatTurn, noteBeatBypass, noteBeatChatSend } from './beat-turns.js';
import { heartbeatStatusCapability } from './measures/status-capability.js';

/** The MCP tool name, exported so prose that names it reads it from here. */
export const END_BEAT_TOOL = 'end_beat';

/** What `end_beat` answers. */
const EndBeatOutputSchema = z.union([
  z.object({ ok: z.literal(true), raises: z.number().int() }),
  z.object({ ok: z.literal(false), code: z.string(), error: z.string() }),
]);

/** Why a raise's `to` was refused. */
export type RecipientRefusal = { ok: false; code: string; error: string };

/** Resolves a raise's `to` to the account it names, or refuses it. */
export type RecipientCheck = (to: string) => { ok: true; accountId: string } | RecipientRefusal;

/** Set by the running server; absent, every `to` is taken as written. */
let recipientCheck: RecipientCheck | undefined;

/**
 * Teach `end_beat` how to check a raise's `to`.
 *
 * @param check - The check, or undefined to stop checking.
 */
export function setRaiseRecipientCheck(check: RecipientCheck | undefined): void {
  recipientCheck = check;
}

/**
 * The raises with every `to` resolved to the account it names, or the first
 * refusal. A refused `to` refuses the whole call and ends nothing, so the agent
 * can fix it and call again.
 *
 * @param input - The `end_beat` input.
 */
function resolveRecipients(input: EndBeatInput): EndBeatInput | RecipientRefusal {
  if (!recipientCheck || !input.raises) return input;
  const raises = [];
  for (const raise of input.raises) {
    if (!raise.to) {
      raises.push(raise);
      continue;
    }
    const resolved = recipientCheck(raise.to);
    if (!resolved.ok) return resolved;
    raises.push({ ...raise, to: resolved.accountId });
  }
  return { ...input, raises };
}

/** The plain sentence for each refusal. */
const REFUSALS = {
  NOT_A_BEAT:
    'This turn is not a heartbeat, so there is no beat to end. Reply in the chat as usual.',
  ALREADY_ENDED: 'This beat already ended. Nothing more was handed over.',
  NOT_A_REPORT_BEAT:
    'This is not a report beat, so `report` cannot be sent now. Leave it out, or put the ' +
    'news in a raise with rung `report` for your next report. Nothing was handed over.',
} as const;

/** The heartbeat domain. */
export const heartbeatDomain: CapabilityDomain = {
  name: 'heartbeat',
  capabilities: [
    defineCapability({
      id: 'heartbeat.end_beat',
      title: 'End a heartbeat',
      description:
        'Finish a heartbeat. Only works during one. `summary` is the record line, under 200 ' +
        'characters ("Sent Acme the second reminder." or "Checked 4 things. Nothing new."). ' +
        'Nothing else you write in a beat reaches anyone: to tell someone, add a raise. Each ' +
        'raise has `text` (written for a busy reader), `rung` (the quietest that still works: ' +
        '`report` for your next report, `room` to post in `roomId` now, `dm` for a direct ' +
        'message, `note` for a note outside the app), `to` (an account or agent id; absent means ' +
        'your manager), and `urgent: true` only when a person must act now: money or data still ' +
        'at risk, a security problem still open, a customer being harmed, or a hard deadline. A ' +
        'problem you already fixed is not urgent. Messages to people wait for their working ' +
        'hours unless urgent. `about` lists the change keys a raise is about. `pace` asks for a ' +
        'faster beat for a while (5 to 60 minutes, at most 12 hours). `report` is for report ' +
        'beats only: the report itself, or null to skip it this time. `resolved` lists keys of ' +
        'earlier raises that are settled. Call it once.',
      tier: 'act',
      area: null,
      areaNote: 'how a beat ends; blocking it would hide what a beat found without stopping work',
      input: EndBeatInputSchema,
      output: EndBeatOutputSchema,
      surfaces: {
        mcp: {
          toolName: END_BEAT_TOOL,
          servers: ['in-session'],
          annotations: { idempotentHint: false },
        },
      },
      invoke: async (_deps, input, context) => {
        if (!liveBeatTurn(context.sessionId)) {
          return { ok: false as const, code: 'NOT_A_BEAT', error: REFUSALS.NOT_A_BEAT };
        }
        const checked = resolveRecipients(input);
        if ('ok' in checked) return checked;
        const ended = endBeatTurn(context.sessionId, checked);
        if (!ended.ok) {
          return { ok: false as const, code: ended.code, error: REFUSALS[ended.code] };
        }
        return { ok: true as const, raises: input.raises?.length ?? 0 };
      },
    }),
    heartbeatStatusCapability,
  ],
};

/** Capabilities that put words in front of people without going through `end_beat`. */
const BYPASS_CAPABILITY_IDS: ReadonlySet<string> = new Set(['rooms.post']);

/** Capabilities that message another agent, counted for the loop watcher. */
const CHAT_SEND_CAPABILITY_IDS: ReadonlySet<string> = new Set(['chat.send']);

/**
 * Wrap an invocation observer so a beat turn's direct room posts are counted
 * as `bypass` and its chat messages to other agents are counted for the loop
 * watcher. Outside a beat it only forwards.
 *
 * @param inner - The observer boot already passes (the Activity attribution).
 */
export function withBeatBypassCount(
  inner?: CapabilityInvocationObserver
): CapabilityInvocationObserver {
  return (event) => {
    if (event.ok) {
      if (BYPASS_CAPABILITY_IDS.has(event.capability.id)) noteBeatBypass(event.context.sessionId);
      if (CHAT_SEND_CAPABILITY_IDS.has(event.capability.id)) {
        noteBeatChatSend(event.context.sessionId);
      }
    }
    inner?.(event);
  };
}
