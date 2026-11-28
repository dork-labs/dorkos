/**
 * How the agent registry's doors refuse over HTTP once the capability mount
 * serves them (DOR-4978): the codes, statuses and sentences the hand routes
 * answered with (`routes/mesh-problems.ts`).
 *
 * A capability refuses with a `CapabilityToolError`, whose problem comes from
 * a fixed table (`routes/capability-refusals.ts`, ADR 261123-170831), never the
 * handler's own words. So each refusal is one tool code here, with its fixed
 * sentence and, where the hand route answered something other than the code's
 * default, its status.
 *
 * @module services/mesh/doors/mesh-refusals
 */
import type { ProblemCode } from '@dorkos/shared/problem';
import type { ProblemStatus } from '@dorkos/http-kit';

import { CapabilityToolError } from '../../core/capabilities/mcp-envelope.js';
import {
  AGENT_DISPLAY_NAME_MAX,
  type AgentIdentityErrorCode,
} from '../normalize-agent-identity.js';

/** One refusal: its problem code, its fixed sentence and, when not the code's own, its status. */
export interface MeshToolRefusal {
  /** The problem code. */
  readonly code: ProblemCode;
  /** The sentence sent for this refusal. */
  readonly detail: string;
  /** Other sentences this refusal may say, each sent as it is. */
  readonly alsoSays?: readonly string[];
  /** The status, when the hand route answered another than the code's default. */
  readonly status?: ProblemStatus;
}

/** The sentence a blank name is refused with, word for word as the identity check says it. */
const BLANK_DISPLAY_NAME =
  'A display name cannot be blank. Omit it to take one from the name, or send the ' +
  'name you want people to read.';

/** The registry doors' entries in the refusal table, keyed by tool code. */
export const MESH_TOOL_REFUSALS: Readonly<Record<string, MeshToolRefusal>> = {
  MESH_AGENT_NOT_FOUND: { code: 'not_found', detail: 'No agent with that id.' },
  MESH_AGENT_FOLDER_UNKNOWN: { code: 'not_found', detail: 'This agent’s folder isn’t known.' },
  MESH_SCAN_ROOT_NOT_ANCESTOR: {
    code: 'invalid_request',
    detail: '`scanRoot` must be a folder that holds the agent’s folder.',
  },
  MESH_NAME_AND_RUNTIME_NEEDED: {
    code: 'invalid_request',
    detail: 'Send overrides.name and overrides.runtime: this folder has no agent.json yet.',
  },
  MESH_INVALID_NAME: {
    code: 'invalid_request',
    detail:
      'A name cannot be blank. Omit it to take the directory name, or send the ' +
      'address you want this agent to answer to.',
  },
  MESH_INVALID_DISPLAY_NAME: {
    code: 'invalid_request',
    detail: `A display name is at most ${AGENT_DISPLAY_NAME_MAX} characters. Send a shorter one.`,
    alsoSays: [BLANK_DISPLAY_NAME],
  },
  MESH_INVALID_ICON: {
    code: 'invalid_request',
    detail: 'An agent’s icon is exactly one emoji. Omit it to have one picked.',
  },
  MESH_INVALID_COLOR: {
    code: 'invalid_request',
    detail: 'Use a hex colour like "#ec4899". Omit it to have one picked.',
  },
  MESH_ROOM_FOLDER: {
    code: 'invalid_request',
    status: 422,
    detail: 'A room’s folder can’t be an agent’s home. Pick another folder.',
  },
  MESH_REGISTER_MANIFEST_UNREADABLE: {
    code: 'conflict',
    status: 422,
    detail: 'This folder’s .dork/agent.json can’t be read. Fix or remove it, then try again.',
  },
  MESH_REGISTER_REFUSED: {
    code: 'invalid_request',
    status: 422,
    detail: 'This folder couldn’t be registered as an agent.',
  },
  MESH_SYSTEM_AGENT_NOT_REMOVABLE: {
    code: 'forbidden',
    detail: 'A system agent can’t be removed.',
    alsoSays: ['A system agent can’t be deleted.'],
  },
  MESH_MANIFEST_GIT_TRACKED: {
    code: 'conflict',
    detail: 'Git tracks this agent’s files. Remove the agent without its data instead.',
  },
  MESH_DENY_REFUSED: {
    code: 'invalid_request',
    status: 422,
    detail: 'This folder couldn’t be hidden from discovery.',
  },
  MESH_DENIAL_PATH_MISSING: { code: 'invalid_request', detail: 'Send the folder as `path`.' },
  MESH_DENIAL_PATH_NOT_ALLOWED: { code: 'invalid_request', detail: 'That path isn’t allowed.' },
  MESH_ACCESS_RULE_REFUSED: { code: 'invalid_request', detail: 'That access rule isn’t allowed.' },
};

/** A tool code of {@link MESH_TOOL_REFUSALS}. */
export type MeshRefusalCode = keyof typeof MESH_TOOL_REFUSALS & string;

/**
 * A registry refusal, as the handler throws it.
 *
 * @param code - The tool code.
 * @param error - The sentence, when the entry lists more than one; else its own.
 */
export function meshRefusal(code: MeshRefusalCode, error?: string): CapabilityToolError {
  return new CapabilityToolError({ code, error: error ?? MESH_TOOL_REFUSALS[code]!.detail });
}

/** The tool code each identity refusal becomes. */
export const IDENTITY_REFUSAL: Readonly<Record<AgentIdentityErrorCode, MeshRefusalCode>> = {
  INVALID_NAME: 'MESH_INVALID_NAME',
  INVALID_DISPLAY_NAME: 'MESH_INVALID_DISPLAY_NAME',
  INVALID_ICON: 'MESH_INVALID_ICON',
  INVALID_COLOR: 'MESH_INVALID_COLOR',
};
