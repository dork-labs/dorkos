/**
 * The world the test-mode scenarios run against, built from both sides (spec
 * `computer-side-starts-alone` §5.13).
 *
 * A scripted turn calls the real rooms, capability registries, session canvas,
 * heartbeat and test account world, the same objects a real turn reaches.
 * Composing them here, outside `services/`, is what lets the test-mode runtime
 * stay on the computer side: it is handed this object when it is registered
 * and imports none of it.
 *
 * Every read happens at call time, not here, so a service startup sets up after
 * the runtimes register is the one a scenario sees.
 *
 * @module startup/test-composition/scenario-world
 */
import {
  CapabilityImageResult,
  CapabilityToolError,
} from '../../services/core/capabilities/index.js';
import { composeRegistry } from '../../services/core/capabilities/registry.js';
import {
  homeOf,
  resolveAgentHome,
  turnAgentOf,
} from '../../services/core/agent-identity/agent-home.js';
import {
  peekCanvasService,
  sessionScope,
  SESSION_AGENT_AUTHOR,
} from '../../services/canvas/index.js';
import { renderDocEvents } from '../../services/canvas/doc-channel/prompt.js';
import { heartbeatDomain } from '../../services/heartbeats/heartbeat-capabilities.js';
import { getRoomService } from '../../services/rooms/index.js';
import { roomsDomain } from '../../services/rooms/room-capabilities.js';
import { forcedLimitScenario } from '../../services/rooms/reseat/forced-limit-turn.js';
import { setTestAccountWorld } from '../../services/rooms/reseat/test-account-world.js';
import { createLocalBrowserDomain } from '../../services/session/local-browser/capabilities.js';
import type {
  ScenarioInvoke,
  ScenarioWorld,
} from '../../services/runtimes/test-mode/scenario-world.js';

/** Scripted turns log nothing through the registry. */
const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Build the scenario world. One is enough for every test-mode runtime a server
 * registers.
 *
 * @returns The world, reading each service when a scenario calls it.
 */
export function composeScenarioWorld(): ScenarioWorld {
  // A fresh registry per call, over the rooms as they are at that moment.
  const invokeRooms: ScenarioInvoke = (id, input, context) => {
    const registry = composeRegistry([roomsDomain], {
      logger: SILENT,
      roomDeps: { rooms: getRoomService() },
    });
    return registry.invoke(id, input, context);
  };
  const invokeHeartbeat: ScenarioInvoke = (id, input, context) =>
    composeRegistry([heartbeatDomain], { logger: SILENT }).invoke(id, input, context);
  return {
    rooms: {
      authorOf: (authorId) => getRoomService().authorRegistry.getById(authorId) ?? undefined,
      agentNameOf: (agentPath) =>
        getRoomService().authorRegistry.agentNameOf(agentPath) ?? undefined,
      entriesAfter: (roomId, afterSeq) => getRoomService().entriesAfter(roomId, afterSeq),
      invoke: invokeRooms,
    },
    heartbeat: { invoke: invokeHeartbeat },
    localBrowserTools: (browser) => {
      const registry = composeRegistry([createLocalBrowserDomain(browser)], {
        logger: SILENT,
        localBrowserDeps: browser,
      });
      return (id, input, context) => registry.invoke(id, input, context);
    },
    imageOf: (result) => (result instanceof CapabilityImageResult ? result : undefined),
    refusalOf: (error) => (error instanceof CapabilityToolError ? error : undefined),
    agentHomeOf: (opts) => homeOf(resolveAgentHome(opts?.cwd, turnAgentOf(opts))),
    openSessionCanvas: (sessionId, content) => {
      peekCanvasService()?.open(sessionScope(sessionId), SESSION_AGENT_AUTHOR, content);
    },
    renderDocEvents: (context) => renderDocEvents(context),
    forcedLimitScenario: (sessionId, opts) => forcedLimitScenario(sessionId, opts),
    resetAccountWorld: () => setTestAccountWorld(null, true),
  };
}
