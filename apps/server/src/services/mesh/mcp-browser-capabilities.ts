/**
 * The agent-browser half of the `mcp.*` capability domain (spec
 * `agent-browser-sessions`): one `observe` read that tells a person or an agent
 * whether the operator has saved browser sign-ins, and hands back the exact
 * managed MCP server that gives an agent a browser starting from them.
 *
 * There is deliberately no write here. Giving an agent the browser goes
 * through `mcp.add` like any other server, so it lands behind the same
 * approval card that shows the exact command (ADR 260803-233420). This verb
 * only removes the guesswork about what to add.
 *
 * @module services/mesh/mcp-browser-capabilities
 */
import { z } from 'zod';
import { AgentBrowserPresetSchema } from '@dorkos/shared/agent-browser';

import { defineCapability, type CapabilityDefinition } from '../core/capabilities/index.js';
import { resolveDorkHome } from '../../lib/dork-home.js';
import { readAgentBrowserPreset } from './agent-browser-preset.js';

/** The agent-browser verb, spread into the `mcp` domain's capability list. */
export const mcpBrowserCapabilities: CapabilityDefinition[] = [
  defineCapability({
    id: 'mcp.browser_preset',
    title: 'Get the signed-in browser server',
    description:
      'Report whether the operator has saved browser sign-ins (the DorkOS agent browser), ' +
      'which websites they cover and until when, and the exact managed MCP server that gives ' +
      'an agent a browser starting signed in to them. To give an agent that browser, pass the ' +
      'two fields of the returned server object, unchanged, to mcp.add (a person approves ' +
      'it). Never returns a cookie or any other secret. When saved is false, or a site you ' +
      'need is missing, only the operator can fix it, by running the returned loginCommand ' +
      'with the site in a terminal; never ask them for a password.',
    tier: 'observe',
    input: z.object({}),
    output: AgentBrowserPresetSchema,
    // No MCP surface, on purpose: the list of sites is the shape of the
    // operator's accounts, and an ambient tool in every agent's session would
    // hand it to agents that were never given the browser. The Tools & MCP
    // card reads it through the invoke route; an agent that needs it asks with
    // `dorkos call mcp.browser_preset`, which is a deliberate step, not a tool
    // sitting in its list.
    surfaces: {},
    invoke: async () => readAgentBrowserPreset(resolveDorkHome()),
  }),
];
