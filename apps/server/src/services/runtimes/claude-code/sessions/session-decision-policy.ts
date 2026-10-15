import type { PermissionUpdate, PermissionUpdateDestination } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode } from '@dorkos/shared/types';
import { actsWithoutAsking } from '@dorkos/shared/permission-semantics';
import type { AgentSession } from '../agent-types.js';
import { CLAUDE_CODE_CAPABILITIES } from '../runtime-constants.js';
import { isPersonOnlyMode } from '../turn-permission.js';
import { SESSIONS } from '../../../../config/constants.js';

/**
 * Is this session holding a prompt somebody could still come back and answer?
 *
 * The one bounded answer for the whole runtime: record eviction here, and the
 * dispatch refusal and warm reap in `persistent-dispatch.ts`, which used the
 * pending map's raw size and so would have refused messages into a session with
 * a STRANDED entry forever.
 *
 * The exemption's bound is the wait a prompt actually allows, measured from when
 * it was raised: the park ceiling, after which the runtime would have refused it
 * anyway (spec `ask-parks-on-timeout` §7, §8). So a stranded entry ages out on
 * exactly that clock.
 *
 * There is no shorter bound for an unattended run any more, and none is needed:
 * such a session never holds a pending entry at all, because its asks are
 * refused before one is made (`messaging/interactive-handlers.ts`, spec
 * `unattended-session-permission-prompts`). An empty map answers `false` here on
 * the first line of the loop.
 *
 * @param session - The session to weigh.
 * @param now - Server epoch ms.
 */
export function isWaitingOnPerson(session: AgentSession, now: number): boolean {
  for (const pending of session.pendingInteractions.values()) {
    // On the awake clock when the entry has one (DOR-2717): a laptop asleep
    // overnight is not a person who never came back.
    const waited =
      pending.startedAwake !== undefined
        ? performance.now() - pending.startedAwake
        : now - pending.startedAt;
    if (waited < SESSIONS.INTERACTION_PARK_CEILING_MS) return true;
  }
  return false;
}

/**
 * The one permission-update scope DorkOS mirrors into its own session state.
 *
 * The SDK's other destinations name settings FILES — the operator's, the
 * project's, the machine-local override — and a mode written there outlives the
 * conversation the card was answered in. `'session'` is the only one whose
 * lifetime matches the row DorkOS keeps per session.
 */
const SESSION_SCOPED: PermissionUpdateDestination = 'session';

/**
 * The mode a batch of accepted permission suggestions leaves the session in, or
 * `undefined` when none of them touches the mode.
 *
 * Last one wins, for the same reason the SDK applies them in order: a batch that
 * names the mode twice ends at the second value, not the first.
 *
 * @param suggestions - The SDK permission updates being forwarded verbatim.
 */
export function sessionScopedMode(suggestions: PermissionUpdate[]): PermissionMode | undefined {
  let mode: PermissionMode | undefined;
  for (const update of suggestions) {
    if (update.type === 'setMode' && update.destination === SESSION_SCOPED) mode = update.mode;
  }
  return mode;
}

/**
 * Whether a suggested mode is one DorkOS may make DURABLE off a single click on
 * an approval card.
 *
 * Two questions, both asked of the runtime's own declaration rather than of the
 * id's name. Does claude-code declare this mode at all — persisting an
 * undeclared id would make the settings overlay display a posture the runtime
 * never adopted (`PATCH /api/sessions/:id`, same check). And does it act
 * without asking (`actsWithoutAsking`): a card that says "Always Allow" over one
 * Write is not a person choosing a session that never asks again; that is a
 * choice made on the dial.
 *
 * @param mode - The mode an accepted suggestion asks for.
 */
export function isAdoptableMode(mode: PermissionMode): boolean {
  // Nor "Never ask": a click that allowed one call is not a person choosing a
  // chat that refuses everything it would ask about (DOR-2838).
  if (isPersonOnlyMode(mode)) return false;
  const descriptor = CLAUDE_CODE_CAPABILITIES.permissionModes.values.find((d) => d.id === mode);
  return descriptor !== undefined && !actsWithoutAsking(descriptor);
}
