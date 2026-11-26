/**
 * Adding and replacing an MCP server every agent gets (DOR-3213), as person-only
 * capabilities the mount serves on `/api/mcp-servers` (DOR-4978).
 *
 * **Confirm-first, behind the front-door bar** (ADR 261125-114705, decision 4).
 * Both set what a server runs in every agent's session, so each call is held
 * for "Confirm it's you" and runs only once the owner's password passed. The
 * bar is declared here, `front-door`: the owner, in person, through this
 * computer's own ingress, on the request that asks and again on the one that
 * confirms. With no owner yet there is no password to ask for, and the person
 * at this computer goes on with no sheet.
 *
 * **What the sheet shows** comes from `global-mcp-sheet.ts`: the hold binds
 * what runs with each secret by name only, and its sentence and notes name
 * only the server and the package a runner runs (Security t1j): no command,
 * argument, setting, header or address. What a password could not change (a taken name, a program that
 * can't run here) is refused before anything is held.
 *
 * **Person-only, every door** (`http.audience: 'person'`), with no MCP
 * surface: no agent adds a server every agent gets. An agent manages its OWN
 * servers with the `mcp.*` tools (`mcp-capabilities.ts`).
 *
 * Widening a server (`PATCH /api/mcp-servers/{name}`) stays a hand route: its
 * store decides inside its write queue whether a change widens, so its hold is
 * raised mid-write.
 *
 * @module services/mesh/global-mcp/global-mcp-write-capabilities
 */
import { z } from 'zod';
import {
  GlobalMcpServerInputSchema,
  GlobalMcpServerViewSchema,
  type GlobalMcpServerInput,
} from '@dorkos/shared/global-mcp-schemas';

import {
  CapabilityToolError,
  defineCapability,
  sealHeldState,
} from '../../core/capabilities/capability-definition.js';
import { logger } from '../../../lib/logger.js';
import { globalMcpDepsOf, globalMcpStoreRefusal } from './global-mcp-capability-support.js';
import { GLOBAL_MCP_STORE } from './global-mcp-refusals.js';
import {
  boundServerInput,
  confirmFirstNotes,
  confirmFirstWarnings,
  serverReason,
  type ServerChange,
} from './global-mcp-sheet.js';

/** What the front-door bar names in its refusal. */
const WRITE_SUBJECT = 'MCP servers for every agent';

/** Why these doors are closed to agents, for the catalog. */
const PERSON_ONLY_NOTE =
  'a person’s MCP servers for every agent; agents manage their own with mcp.*';

/** The step-up kind the sheet and the record name, as the hand routes held it. */
const KIND = 'mcp-server.allow-global';

/** What the sheet shows for an add or a replace: built from what runs, never a secret value. */
function sheetFor(change: Extract<ServerChange, 'add' | 'change'>, input: GlobalMcpServerInput) {
  return {
    target: input.name,
    reason: serverReason(change, input),
    notes: confirmFirstNotes(input, change === 'change'),
    warnings: confirmFirstWarnings(input),
    bound: boundServerInput(change, input),
  };
}

/** `mcp.add_global_server`: add a server for every agent, once the owner confirms. */
export const addGlobalServerCapability = defineCapability({
  id: 'mcp.add_global_server',
  title: 'Add an MCP server every agent gets',
  description:
    'Add a server to every agent, with its secret values. Held until the owner confirms it’s ' +
    'them, at this computer; secret values never come back out.',
  tier: 'act',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  confirmFirst: {
    bar: 'front-door',
    kind: KIND,
    subject: WRITE_SUBJECT,
    sheet: (deps, input) => {
      try {
        globalMcpDepsOf(deps).store.refuseAdd(input);
      } catch (err) {
        globalMcpStoreRefusal(err);
      }
      return sheetFor('add', input);
    },
  },
  input: GlobalMcpServerInputSchema,
  output: GlobalMcpServerViewSchema,
  surfaces: {
    http: { method: 'post', path: '/api/mcp-servers', success: 201, audience: 'person' },
  },
  invoke: async (deps, input) => {
    let server;
    try {
      server = await globalMcpDepsOf(deps).store.add(input);
    } catch (err) {
      globalMcpStoreRefusal(err);
    }
    logger.info('[mcp-servers] added a server for every agent', { name: server.name });
    return server;
  },
});

/** The server a replace names in its path, beside the server it sends. */
const ReplaceInputSchema = GlobalMcpServerInputSchema.extend({
  server: z.string().min(1).max(200).describe('The name of the server to replace.'),
});

/** `mcp.replace_global_server`: replace a server, secrets typed again, once the owner confirms. */
export const replaceGlobalServerCapability = defineCapability({
  id: 'mcp.replace_global_server',
  title: 'Replace an MCP server every agent gets',
  description:
    'Replace a server every agent gets; its secret values are typed again. Held until the ' +
    'owner confirms it’s them, at this computer. A change made while the sheet is up refuses it.',
  tier: 'act',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  confirmFirst: {
    bar: 'front-door',
    kind: KIND,
    subject: WRITE_SUBJECT,
    sheet: (deps, { server, ...input }) => {
      const { store } = globalMcpDepsOf(deps);
      let shown = '';
      try {
        store.refuseReplace(server, input);
        // The server as the sheet is shown: a change made while it is up, such
        // as keeping an agent from it, refuses the confirm rather than being undone.
        shown = store.fingerprint(server);
      } catch (err) {
        globalMcpStoreRefusal(err);
      }
      return { ...sheetFor('change', input), heldState: shown };
    },
  },
  input: ReplaceInputSchema,
  output: GlobalMcpServerViewSchema,
  surfaces: {
    http: {
      method: 'put',
      path: '/api/mcp-servers/{name}',
      params: { name: 'server' },
      audience: 'person',
    },
  },
  invoke: async (deps, { server, ...input }, context) => {
    const { store } = globalMcpDepsOf(deps);
    let replaced;
    try {
      // The server as it is now must be the one the sheet showed (sealed by the
      // registry, `context.heldState`); the store re-checks it in its write queue.
      const expect = store.fingerprint(server);
      if (context.heldState === undefined || sealHeldState(expect) !== context.heldState) {
        throw new CapabilityToolError({
          code: 'GLOBAL_MCP_CHANGED',
          error: GLOBAL_MCP_STORE.changed,
        });
      }
      replaced = await store.replace(server, input, { expect });
    } catch (err) {
      if (err instanceof CapabilityToolError) throw err;
      globalMcpStoreRefusal(err);
    }
    logger.info('[mcp-servers] replaced a server for every agent', { name: replaced.name });
    return replaced;
  },
});
