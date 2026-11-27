/**
 * The app's simplest chat reads (DOR-4978), as capabilities the mount serves on
 * the paths the app always used (ADR 261123-170830, ADR 261125-114705):
 *
 * | Capability                  | Path                                  |
 * | --------------------------- | ------------------------------------- |
 * | `sessions.get_runtime_type` | `GET /api/sessions/{id}/runtime-type` |
 * | `sessions.get_settings`     | `GET /api/sessions/{id}/settings`     |
 *
 * The canvas document read (`GET /api/sessions/{id}/canvas/{documentId}`) stays
 * by hand until the widget definition can be described as JSON Schema.
 *
 * ## Who may read what: exactly the hand routes' readers
 *
 * The session read guard (`routes/session-read-guard.ts`) runs in front of every
 * hand route under `/api/sessions/:id`, never in front of a path the mount
 * serves, so each read folds it in, as `runs.chat_runs` does: an agent gets the
 * same `session_not_found` for a chat it may not read as for one that does not
 * exist. Anyone else (the app, a person's own key) reads every chat. A chat id
 * that does not parse is refused first, as the hand routes did.
 *
 * Each read writes nothing: `get_runtime_type` reports the registry's inference
 * for an unbound id without storing it (DOR-812), and `get_settings` answers the
 * stored row or `null` (DOR-2103).
 *
 * @module services/session/reads/session-read-capabilities
 */
import { z } from 'zod';
import {
  StoredSessionSettingsResponseSchema,
  type StoredSessionSettingsResponse,
} from '@dorkos/shared/schemas';
import type { CapabilityHandlerContext } from '../../core/capabilities/index.js';
import {
  CapabilityToolError,
  defineCapability,
  type CapabilityDomain,
} from '../../core/capabilities/capability-definition.js';
import { SESSION_READ_SENTENCES as S } from './session-read-refusals.js';

/**
 * What the chat reads take from other domains, handed in at the composition
 * root (`core/self-description/dorkos-registry.ts`) as the work graph's reads
 * are, so this folder imports no other domain. Each is called when a read
 * runs, never when this module loads.
 */
export interface SessionReadPorts {
  /** Whether this caller may read the chat: the session read guard's rule. */
  readonly mayRead: (context: CapabilityHandlerContext, chatId: string) => boolean;
  /** The runtime a chat runs on, inferred and never stored for an unbound id. */
  readonly runtimeTypeOf: (chatId: string) => Promise<string>;
  /** The settings stored for a chat id, or `null`. Never writes. */
  readonly settingsOf: (chatId: string) => Promise<StoredSessionSettingsResponse['settings']>;
}

/** A chat id as the path carries it: checked by the handler, so a bad one keeps its sentence. */
const ChatIdSchema = z.string().describe('The chat, by its session id.');

/** UUIDs, as `parseSessionId` (`lib/route-utils.ts`) accepts them for the hand routes. */
const UUID = z.string().uuid();

/**
 * The chat id, once it parses and the caller may read the chat: the session
 * read guard and the hand routes' id check, in their order.
 *
 * @param raw - The id from the path.
 * @param context - Who calls.
 * @param ports - See {@link SessionReadPorts}.
 * @throws `CHAT_ID_INVALID` for an id that does not parse, and
 *   `SESSION_NOT_FOUND` for a chat an agent may not read.
 */
function readableChatId(
  raw: string,
  context: CapabilityHandlerContext,
  ports: SessionReadPorts
): string {
  const parsed = UUID.safeParse(raw);
  if (!parsed.success) {
    throw new CapabilityToolError({ code: 'CHAT_ID_INVALID', error: S.invalidId });
  }
  const id = parsed.data;
  if (!ports.mayRead(context, id)) {
    throw new CapabilityToolError({ code: 'SESSION_NOT_FOUND', error: 'No chat with that id.' });
  }
  return id;
}

/** Why these reads need no permission area: reading a chat an agent may read is the point. */
const AREA_NOTE = 'reading';

/**
 * The app's chat reads on the capability mount.
 *
 * @param ports - What they take from other domains; see {@link SessionReadPorts}.
 */
export function createSessionReadsDomain(ports: SessionReadPorts): CapabilityDomain {
  return {
    name: 'sessions',
    capabilities: [
      defineCapability({
        id: 'sessions.get_runtime_type',
        title: 'Read which program runs a chat',
        description:
          'The runtime a chat runs on. For a chat that has not started, the one it would run on, ' +
          'which this read never stores. An agent reads only a chat it may read.',
        tier: 'observe',
        area: null,
        areaNote: AREA_NOTE,
        input: z.object({ id: ChatIdSchema }),
        output: z.object({ runtime: z.string() }),
        surfaces: { http: { method: 'get', path: '/api/sessions/{id}/runtime-type' } },
        invoke: async (_deps, input, context) => {
          const id = readableChatId(input.id, context, ports);
          return { runtime: await ports.runtimeTypeOf(id) };
        },
      }),
      defineCapability({
        id: 'sessions.get_settings',
        title: 'Read a chat’s stored settings',
        description:
          'The settings stored for a chat id, or `null` when none are, including for a chat ' +
          'that has not started yet. Never writes. An agent reads only a chat it may read.',
        tier: 'observe',
        area: null,
        areaNote: AREA_NOTE,
        input: z.object({ id: ChatIdSchema }),
        output: StoredSessionSettingsResponseSchema,
        surfaces: { http: { method: 'get', path: '/api/sessions/{id}/settings' } },
        invoke: async (_deps, input, context) => {
          const id = readableChatId(input.id, context, ports);
          // Under the id as asked: a chat that has not started has no runtime to hold an alias.
          return { settings: await ports.settingsOf(id) };
        },
      }),
    ],
  };
}
